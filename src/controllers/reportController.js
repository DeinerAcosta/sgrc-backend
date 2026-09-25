import { prisma } from '../lib/prisma.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { generarPDF, generarExcel } from '../services/exportService.js'
import { errors } from '../lib/errors.js'
import { getSemanaActual } from '../lib/week.js'
import { withCache, keyDeQuery } from '../lib/cache.js'
import {
  hhmmAMinutos,
  horasDeFranja,
  horasEfectivasFranja,
  horasUnionPorDia,
  minutosUnion,
  JORNADA_LEGAL_SEMANAL,
} from '../lib/workHours.js'
import {
  cargarBaseHoraria,
  cargarFestivosDelRango,
  esDomingoOFestivo,
  minutosBaseSemana,
  BASE_MINUTOS_SEMANA_TEORICA,
} from '../lib/calendario.js'
import { TIPOS_INCAPACIDAD_QUE_NO_PENALIZAN, whereAusenciasIncapacidadEnRango } from '../lib/absences.js'

/**
 * Días HÁBILES que cubre una ausencia: excluye domingos y festivos.
 *
 * Sep-2026 · decisión de dirección. Antes se reportaban días calendario
 * (`fin - inicio + 1`), así que unas vacaciones de dos semanas contaban 14 días
 * aunque la sede solo opere 12. Los sábados SÍ cuentan: la operación es de
 * lunes a sábado.
 *
 * Se calcula al vuelo en el informe, no se guarda: así los registros históricos
 * quedan corregidos sin tener que reprocesar nada.
 */
/** Carga de una sola vez los festivos que cubren todas las ausencias del lote. */
async function festivosDeAusencias(ausencias) {
  if (!ausencias || ausencias.length === 0) return new Set()
  let min = null
  let max = null
  for (const a of ausencias) {
    const ini = new Date(a.startDate)
    const fin = new Date(a.endDate)
    if (!min || ini < min) min = ini
    if (!max || fin > max) max = fin
  }
  // Rangos corruptos (año 0206, fin < inicio) podrían pedir décadas de festivos.
  if (!min || !max || max < min) return new Set()
  return cargarFestivosDelRango(min, max)
}

function diasHabilesDeAusencia(ausencia, festivosSet) {
  let dias = 0
  const cursor = new Date(ausencia.startDate)
  const fin = new Date(ausencia.endDate)
  // Guarda contra fechas corruptas (fin < inicio): devuelve 0 en vez de colgarse.
  if (fin < cursor) return 0
  while (cursor <= fin) {
    if (!esDomingoOFestivo(cursor, festivosSet)) dias++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dias
}

// TTL de caché para lecturas analíticas. Suficientemente corto para que los datos
// se sientan "en vivo" y suficientemente largo para absorber picos de concurrencia.
const TTL_INFORME = 30_000
const TTL_DASHBOARD = 20_000

// ============================================================
// FUNCIONES DE DATOS (puras — devuelven arrays/objetos)
// Reutilizadas tanto por los endpoints GET como por la exportación.
// ============================================================

// Convierte un parámetro que puede venir como "a,b,c", ["a","b"] o "a" → array limpio
const aLista = (v) => {
  if (!v) return null
  const arr = Array.isArray(v) ? v : String(v).split(',')
  const limpio = arr.map((x) => String(x).trim()).filter(Boolean)
  return limpio.length > 0 ? limpio : null
}

// Ventana por defecto de los informes que no traen rango de fechas propio.
// Sin ella, las consultas barrían la tabla `asignacion` entera: a ~500
// asignaciones por semana son 26.000 filas al año, y el coste de cada informe
// crecía de forma lineal y para siempre. 12 semanas es la misma ventana que ya
// usa el comparativo.
const SEMANAS_VENTANA_POR_DEFECTO = 12

/**
 * IDs de las semanas que solapan el rango [desde, hasta].
 *
 * Se resuelve en dos pasos a propósito: primero los ids de `semana` (tabla
 * pequeña, con índice único por fechaInicio) y luego se filtra `asignacion` por
 * `semanaId IN (...)`, que sí usa el índice @@index([semanaId]). Filtrar
 * directamente por la fecha de la semana relacionada obligaría a MySQL a una
 * subconsulta sobre la tabla grande.
 *
 * Sin rango devuelve las últimas SEMANAS_VENTANA_POR_DEFECTO ya iniciadas.
 */
async function semanaIdsEnRango({ desde, hasta } = {}) {
  if (!desde && !hasta) {
    const recientes = await prisma.week.findMany({
      where: { startDate: { lte: new Date() } },
      orderBy: { startDate: 'desc' },
      take: SEMANAS_VENTANA_POR_DEFECTO,
      select: { id: true },
    })
    return recientes.map((s) => s.id)
  }
  // Una semana entra si solapa el rango, no si está contenida en él.
  const where = {}
  if (hasta) where.startDate = { lte: new Date(hasta) }
  if (desde) where.endDate = { gte: new Date(desde) }
  const semanas = await prisma.week.findMany({ where, select: { id: true } })
  return semanas.map((s) => s.id)
}

/**
 * Mapa recursoId → { sedeIds:Set, sedeNombres:Set } a partir de las asignaciones
 * no canceladas (el recurso puede aparecer como titular o auxiliar). Sirve para
 * los informes centrados en el recurso (ausentismo, subutilización, impacto),
 * donde la sede no es un atributo directo del recurso sino algo que se infiere
 * de dónde tiene asignaciones.
 *
 * Acotado a las semanas del rango pedido (o a la ventana por defecto): antes
 * leía TODAS las asignaciones de la historia en cada informe que lo llamaba, que
 * son cuatro.
 */
async function mapaSedesPorRecurso(rango = {}) {
  const semanaIds = await semanaIdsEnRango(rango)
  if (semanaIds.length === 0) return new Map()

  const asigs = await prisma.assignment.findMany({
    where: { weekId: { in: semanaIds }, status: { not: 'cancelada' } },
    select: {
      resourceId: true,
      assistantId: true,
      room: { select: { siteId: true, site: { select: { name: true } } } },
    },
  })
  const mapa = new Map()
  const add = (rid, sedeId, sedeNombre) => {
    if (!rid) return
    if (!mapa.has(rid)) mapa.set(rid, { sedeIds: new Set(), sedeNombres: new Set() })
    mapa.get(rid).sedeIds.add(sedeId)
    mapa.get(rid).sedeNombres.add(sedeNombre)
  }
  for (const a of asigs) {
    add(a.resourceId, a.room.siteId, a.room.site.name)
    add(a.assistantId, a.room.siteId, a.room.site.name)
  }
  return mapa
}

// Nombre(s) de sede de un recurso para mostrar en el informe ('—' si no tiene asignaciones)
const nombreSedes = (info) => (info && info.sedeNombres.size ? [...info.sedeNombres].join(', ') : '—')

// ¿El recurso pertenece a alguna de las sedes filtradas? (sin filtro → siempre true)
const recursoEnSedes = (info, sedeIds) => {
  if (!sedeIds) return true
  if (!info) return false
  return sedeIds.some((sid) => info.sedeIds.has(sid))
}

/**
 * Informe de ocupación por consultorio.
 * Filtros (todos opcionales, aceptan múltiples valores separados por coma):
 *   - sede_id: una o varias sedes
 *   - tipo_recurso: uno o varios tipos (oftalmologo, optometra, ...) — filtra
 *     qué asignaciones se cuentan para la ocupación
 */
export async function dataOcupacion({ site_id: sede_id, resource_type: tipo_recurso, week_id: semana_id } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Por defecto: solo la semana ACTUAL (la que contiene hoy) si no se pasa semana_id.
  // Importante: "actual" ≠ "abierta más reciente" — una semana futura puede estar
  // abierta y distorsionaría las métricas de ocupación.
  let semanaId = semana_id
  if (!semanaId) {
    const semanaActual = await getSemanaActual()
    semanaId = semanaActual?.id
  }

  const where = { status: { not: 'cancelada' } }
  if (semanaId) where.weekId = semanaId
  if (sedeIds) where.room = { siteId: { in: sedeIds } }
  if (tipos) where.resource = { type: { in: tipos } }

  // PROYECTOS-3255 #1.1: h_base dinamica descontando festivos LV de la semana.
  // Si la semana tiene 1 lunes festivo, la base baja de 64h a 52h por consultorio.
  const semanaObj = semanaId
    ? await prisma.week.findUnique({
        where: { id: semanaId },
        select: { id: true, startDate: true, endDate: true },
      })
    : null
  const festivosSet = semanaObj
    ? await cargarFestivosDelRango(semanaObj.startDate, semanaObj.endDate)
    : new Set()
  // Sep-2026 · la base horaria ya no es la constante de 64h: sale de Metas del
  // sistema (base_horas_lun_vie_min / base_horas_sabado_min). Si gerencia la
  // cambia a 70h, este informe se recalcula solo.
  const baseHoraria = await cargarBaseHoraria()
  const hBaseSemana = minutosBaseSemana(semanaObj, festivosSet, baseHoraria) / 60

  const [asignaciones] = await Promise.all([
    prisma.assignment.findMany({
      where,
      include: { room: { include: { site: true } }, resource: true },
    }),
  ])

  // Sep-2026 · EL DENOMINADOR SON TODOS LOS CONSULTORIOS ACTIVOS, no solo los
  // que tuvieron programación. Antes la lista se armaba a partir de las
  // asignaciones, así que un consultorio sin programar esa semana no existía
  // para el informe: en producción entraban 100 de 211 y el porcentaje
  // respondía "de los consultorios que se usaron, qué tan llenos están" en vez
  // de "qué tan ocupada está la capacidad instalada".
  //
  // Excepción: cuando se filtra por tipo de recurso, sembrar los 211 llenaría
  // el informe de ceros de consultorios que ese tipo nunca usa. Ahí se mantiene
  // el comportamiento anterior.
  //
  // Asesoría queda fuera: no es un consultorio físico sino N asesores en
  // paralelo bajo un mismo "Área Asesores" lógico, y contra una base por
  // consultorio da porcentajes irreales. Sus KPIs viven en Ocupación de
  // asesores, que escala la base por número de asesores.
  const porCons = new Map()
  if (!tipos) {
    const consultorios = await prisma.room.findMany({
      where: {
        active: true,
        specialty: { not: 'asesoria' },
        ...(sedeIds ? { siteId: { in: sedeIds } } : {}),
      },
      include: { site: { select: { name: true } } },
    })
    for (const c of consultorios) {
      porCons.set(c.id, {
        room: c.name,
        site: c.site.name,
        specialty: c.specialty,
        // OJO con el orden de estas claves: ReportPage lee la tabla por
        // POSICIÓN, así que `h_asignadas` tiene que ir ANTES que `h_base` para
        // coincidir con las columnas. Se declara aquí aunque se calcule al
        // final, para fijar la posición.
        h_asignadas: 0,
        h_base: hBaseSemana,
        _franjas: new Map(),
      })
    }
  }

  for (const a of asignaciones) {
    if (a.room.specialty === 'asesoria') continue
    const k = a.room.id
    if (!porCons.has(k)) {
      // Consultorio desactivado con programación vieja, o filtro por tipo.
      // Mismo orden de claves que arriba: h_asignadas antes que h_base.
      porCons.set(k, {
        room: a.room.name,
        site: a.room.site.name,
        specialty: a.room.specialty,
        h_asignadas: 0,
        h_base: hBaseSemana,
        _franjas: new Map(),
      })
    }
    // Sep-2026 · las franjas se guardan y se UNEN por día; antes se sumaban.
    // En producción hay 653 pares de asignaciones que se pisan en el mismo
    // consultorio en una sola semana (dos recursos a la vez en la misma sala):
    // sumarlas contaba 12h de ocupación donde la sala estuvo ocupada 6.
    // Misma unión que ya se aplica a los médicos multi-consultorio.
    const fr = porCons.get(k)._franjas
    if (!fr.has(a.weekday)) fr.set(a.weekday, [])
    fr.get(a.weekday).push({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) })
  }

  return Array.from(porCons.values()).map(({ _franjas, ...f }) => {
    let minutos = 0
    for (const franjas of _franjas.values()) minutos += minutosUnion(franjas)
    const horas = minutos / 60
    return {
      ...f,
      h_asignadas: Math.round(horas * 10) / 10,
      pct_ocupacion: f.h_base > 0 ? Math.round((horas / f.h_base) * 100) : 0,
    }
  })
}

/**
 * Informe de ocupación del ÁREA DE ASESORES (recepción / módulos).
 *
 * No son consultorios físicos: en una sede pueden trabajar N asesores en
 * paralelo en distintos módulos de recepción. Por eso la capacidad teórica
 * debe escalarse por el número de asesores que cubren la sede esa semana,
 * no compararse contra la base fija de 64h de un consultorio.
 *
 * Modelo:
 *   - N_asesores = cantidad de asesores DISTINTOS con al menos una asignación
 *     en la sede esa semana.
 *   - h_base    = N_asesores × jornada_semanal (44h Ley 2101 fase actual,
 *                 editable desde "Metas del sistema").
 *   - h_asign   = suma de horas EFECTIVAS (con almuerzo descontado) de TODAS
 *                 las asignaciones de asesores en esa sede.
 *   - % ocup    = h_asign / h_base × 100.
 *
 * Importante: usamos horas EFECTIVAS, no brutas. Una franja 08:00–17:00 son
 * 9h brutas, pero la persona solo atiende 8h (1h de almuerzo). Comparar 9h
 * contra una jornada de 44h efectivas inflaría artificialmente la ocupación.
 */
export async function dataOcupacionAsesores({ site_id: sede_id, week_id: semana_id } = {}) {
  const sedeIds = aLista(sede_id)
  let semanaId = semana_id
  if (!semanaId) {
    const semanaActual = await getSemanaActual()
    semanaId = semanaActual?.id
  }

  // Jornada nominal global (Ley 2101 — editable desde Metas del sistema)
  const jornadaParam = await prisma.systemSetting.findUnique({ where: { key: 'jornada_semanal_horas' } })
  const jornadaNominal = jornadaParam ? Number(jornadaParam.value) : JORNADA_LEGAL_SEMANAL

  // PROYECTOS-3255 #1.1: si la semana tiene festivos, el tope individual del
  // asesor se recorta PROPORCIONAL AL PESO REAL DEL DIA (mismo criterio que
  // dataOcupacion via minutosBaseSemana). Un festivo LV pesa 720/3840=18.75%,
  // un festivo sabado pesa 240/3840=6.25% — no darles el mismo peso (1/6=16.7%)
  // porque los dos informes de ocupacion daban numeros distintos para la misma semana.
  const semanaObj = semanaId
    ? await prisma.week.findUnique({
        where: { id: semanaId },
        select: { id: true, startDate: true, endDate: true },
      })
    : null
  const festivosSet = semanaObj
    ? await cargarFestivosDelRango(semanaObj.startDate, semanaObj.endDate)
    : new Set()
  const factorFestivos = semanaObj
    ? minutosBaseSemana(semanaObj, festivosSet) / BASE_MINUTOS_SEMANA_TEORICA
    : 1

  // IMPORTANTE: filtramos por sede SOLO al final, no al traer. Necesitamos
  // ver TODAS las sedes donde trabajó cada asesor para distribuir su tope
  // proporcionalmente (si Cinthia trabajó 20h Sede 2 + 20h Mall Plaza, su
  // tope 44h se reparte 22h+22h entre las dos sedes, no 44h en cada una).
  const where = {
    status: { not: 'cancelada' },
    resource: { type: 'asesor_servicios' },
  }
  if (semanaId) where.weekId = semanaId

  const asigs = await prisma.assignment.findMany({
    where,
    include: { room: { include: { site: true } }, resource: { select: { id: true, type: true, maxHoursPerWeek: true } } },
  })

  // Paso 1: para cada asesor, calcular sus horas EFECTIVAS totales en la semana
  // (suma de TODAS las sedes donde trabajó). Necesario para el factor proporcional.
  // El tope tambien va recortado por festivos (jornadaSemanal ya incluye factorFestivos;
  // el tope individual del recurso se recorta con el mismo factor).
  const horasPorAsesor = new Map()  // recursoId → { tope, horasSemana }
  for (const a of asigs) {
    const r = a.resource
    if (!horasPorAsesor.has(r.id)) {
      const topeIndividual = (r.maxHoursPerWeek ?? jornadaNominal) * factorFestivos
      horasPorAsesor.set(r.id, { tope: topeIndividual, horasSemana: 0 })
    }
    horasPorAsesor.get(r.id).horasSemana += horasEfectivasFranja(a.startTime, a.endTime, r.type)
  }

  // Paso 2: agrupar por sede sumando horas asignadas + capacidad proporcional.
  //   capacidad_aportada_a_la_sede = (horas_en_esta_sede / horas_totales) × tope_individual
  // Si un asesor trabajó solo en 1 sede, recibe su tope completo (factor=1).
  // Si trabajó 50%/50% entre 2 sedes, cada una recibe 50% de su tope.
  const porSede = new Map()
  for (const a of asigs) {
    const sid = a.room.siteId
    if (!porSede.has(sid)) {
      porSede.set(sid, {
        site: a.room.site.name,
        h_asignadas: 0,
        h_base: 0,
        // Conteo "fraccional" de asesores: si un asesor trabaja 50% aquí, suma 0.5.
        // Refleja mejor la realidad que contarlo como "1 asesor".
        asesoresFrac: 0,
        // Set para mostrar también el conteo bruto (cuántas personas distintas pasaron).
        asesoresBruto: new Set(),
      })
    }
    const grp = porSede.get(sid)
    const hAsig = horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
    const stat = horasPorAsesor.get(a.resource.id)
    const factor = stat.horasSemana > 0 ? hAsig / stat.horasSemana : 0
    grp.h_asignadas += hAsig
    grp.h_base       += factor * stat.tope
    grp.asesoresFrac += factor
    grp.asesoresBruto.add(a.resource.id)
  }

  // Paso 3: filtrar por sede (si se pidió) y armar filas.
  const filas = [...porSede.entries()]
    .filter(([sid]) => !sedeIds || sedeIds.includes(sid))
    .map(([, f]) => ({
      site: f.site,
      n_asesores: f.asesoresBruto.size,
      h_asignadas: Math.round(f.h_asignadas * 10) / 10,
      h_base: Math.round(f.h_base * 10) / 10,
      pct_ocupacion: f.h_base > 0 ? Math.round((f.h_asignadas / f.h_base) * 100) : 0,
    }))

  return filas.sort((a, b) => b.pct_ocupacion - a.pct_ocupacion)
}

export async function dataProductividad({ site_id: sede_id, resource_type: tipo_recurso, desde, hasta } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // desde/hasta: el frontend YA los enviaba (InformePage manda el rango a todos
  // los informes que no son "por semana"), pero esta función los descartaba, así
  // que el filtro de fechas de la UI era decorativo y el informe siempre
  // acumulaba desde el principio de los tiempos. Mismo defecto que ya se
  // corrigió en dataCierreSemanas. Ahora se respetan, y sin rango se usa la
  // ventana por defecto en vez de la tabla entera.
  const semanaIds = await semanaIdsEnRango({ desde, hasta })

  // PROYECTOS-3255 #3.1: partir de TODOS los recursos activos (con filtro de
  // tipo si aplica), no solo los que tienen asignaciones — asi se ven los
  // recursos ociosos con 0h para detectarlos rapido.
  //
  // El filtro de SEDE se aplica DESPUES contra la sede resuelta (mapaSedesPorRecurso),
  // no en el where de Prisma, porque un recurso sin asignaciones en el rango no
  // tiene sede via asignacion — y no queremos excluirlo si el usuario NO filtro sede.
  const whereRec = { active: true }
  if (tipos) whereRec.type = { in: tipos }

  // PROYECTOS-3255 #1.3: para NO penalizar a recursos incapacitados, cargamos
  // ausencias confirmadas del rango cuyo TYPE equivale a incapacidad
  // (enfermedad | licencia_remunerada — ver TIPOS_INCAPACIDAD_QUE_NO_PENALIZAN).
  // Se marcan como en_incapacidad y el frontend anula el semaforo/% sobre ellos.
  const [recursos, asigs, mapaSedes, ausenciasMedicas] = await Promise.all([
    prisma.resource.findMany({
      where: whereRec,
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
    semanaIds.length > 0
      ? prisma.assignment.findMany({
          where: { weekId: { in: semanaIds }, status: { not: 'cancelada' } },
          select: {
            resourceId: true,
            weekId: true,
            weekday: true,
            startTime: true,
            endTime: true,
            patientCapacity: true,
            resource: { select: { type: true, multiRoom: true } },
            execution: { select: { patientsSeen: true, shiftStatus: true } },
          },
        })
      : Promise.resolve([]),
    mapaSedesPorRecurso({ desde, hasta }),
    // Ausencias de incapacidad confirmadas del rango. Sin rango explicito no las cargamos.
    // PROYECTOS-3255 #1.3: filtro por TYPE IN [enfermedad, licencia_remunerada]
    // (family='medico' NO existe en el catalogo, era un false-negative silencioso).
    (desde && hasta)
      ? prisma.absence.findMany({
          where: whereAusenciasIncapacidadEnRango(desde, hasta),
          select: { resourceId: true, startDate: true, endDate: true },
        })
      : Promise.resolve([]),
  ])

  // Mapa resourceId → dias en incapacidad (por si hay varias ausencias del mismo recurso)
  const incapacidadPorRecurso = new Map()
  for (const a of ausenciasMedicas) {
    const dias = Math.round((a.endDate - a.startDate) / (1000 * 60 * 60 * 24)) + 1
    incapacidadPorRecurso.set(a.resourceId, (incapacidadPorRecurso.get(a.resourceId) ?? 0) + dias)
  }

  // PROYECTOS-3255 #3.3: para el promedio dividimos por semanas / meses en los
  // que el recurso REALMENTE tuvo asignaciones (no por toda la ventana). Si
  // dividimos por la ventana completa (12 semanas por defecto), un recurso que
  // solo trabajo 2 de las 12 semanas con 22h c/u apareceria con "prom_semanal=3.7h"
  // en vez de "22h", ocultando su carga real durante las semanas activas.
  //
  // Trackeamos:
  //   semanasActivas = Set<weekId>  — semanas ISO en que hay al menos 1 asignacion no cancelada
  //   mesesActivos   = Set<YYYY-MM> — meses calendario derivados de las startDate de las semanas
  const agregados = new Map()
  const semanaStartDate = new Map()   // weekId → startDate (para mapear mes)
  for (const s of await prisma.week.findMany({ where: { id: { in: semanaIds } }, select: { id: true, startDate: true } })) {
    semanaStartDate.set(s.id, s.startDate)
  }
  for (const a of asigs) {
    const k = a.resourceId
    if (!agregados.has(k)) {
      agregados.set(k, {
        h_prog: 0, h_ejec: 0, pac_prog: 0, pac_at: 0,
        semanasActivas: new Set(),
        mesesActivos: new Set(),
        // Sep-2026 · franjas guardadas por semana para poder UNIRLAS en los
        // médicos multi-consultorio (ver el ajuste después del bucle).
        _tipo: a.resource.type,
        _multiRoom: !!a.resource.multiRoom,
        _prog: new Map(),
        _ejec: new Map(),
      })
    }
    const agg = agregados.get(k)
    // Horas EFECTIVAS (descontando almuerzo): es lo que realmente trabajó.
    // Si la franja se ejecutó completa, ejecutadas = programadas (también netas).
    const h = horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
    if (!agg._prog.has(a.weekId)) agg._prog.set(a.weekId, [])
    agg._prog.get(a.weekId).push(a)
    agg.h_prog += h
    // PROYECTOS-3255 #2.1: asesor_servicios NO atiende pacientes con cita, no
    // se acumulan sus pacientes en el indicador (aunque el campo BD legacy contenga valores).
    if (a.resource.type !== 'asesor_servicios') {
      agg.pac_prog += a.patientCapacity ?? 0
    }
    // Sep-2026 · una jornada marcada `no_ejecutada` NO suma horas ejecutadas.
    // Antes bastaba con que existiera el registro: las 76 jornadas que el
    // coordinador marcó explícitamente como no ejecutadas contaban como
    // cumplidas al 100%, y el "% de cumplimiento" era en realidad "% de turnos
    // con registro". `parcial` sigue sumando completo: el sistema no captura
    // cuántas horas se cubrieron, así que queda como dato pendiente de definir.
    if (a.execution && a.execution.shiftStatus !== 'no_ejecutada') {
      agg.h_ejec += h
      if (!agg._ejec.has(a.weekId)) agg._ejec.set(a.weekId, [])
      agg._ejec.get(a.weekId).push(a)
      if (a.resource.type !== 'asesor_servicios') {
        agg.pac_at += a.execution.patientsSeen
      }
    }
    // Nota: usamos startDate de la SEMANA (no de la asignacion, que solo tiene weekday)
    // para determinar el mes. El mes de una semana es el mes de su lunes en la practica.
    agg.semanasActivas.add(a.weekId)
    const startDate = semanaStartDate.get(a.weekId)
    if (startDate) {
      const mes = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`
      agg.mesesActivos.add(mes)
    }
  }

  // Sep-2026 · MULTI-CONSULTORIO: horas por UNIÓN, no por suma.
  // Un médico que cubre 3 salas de 07:00 a 13:00 trabaja 6 horas, no 18. Tiempos
  // ociosos ya lo calculaba así (`r.multiRoom ? horasUnionPorDia : suma`), pero
  // Productividad las sumaba: la misma persona, la misma semana, daba horas
  // distintas según la pantalla que mirara dirección. Se unen por semana — no
  // globalmente — porque el mismo día de la semana se repite en cada semana del
  // rango y unirlos todos volvería a subestimar.
  for (const agg of agregados.values()) {
    if (!agg._multiRoom) continue
    let prog = 0
    for (const asigs of agg._prog.values()) prog += horasUnionPorDia(asigs, agg._tipo)
    let ejec = 0
    for (const asigs of agg._ejec.values()) ejec += horasUnionPorDia(asigs, agg._tipo)
    agg.h_prog = prog
    agg.h_ejec = ejec
  }

  // Left-join en memoria: una fila POR CADA recurso activo, tenga o no asignaciones.
  const filas = recursos.map((r) => {
    const agg = agregados.get(r.id) ?? {
      h_prog: 0, h_ejec: 0, pac_prog: 0, pac_at: 0,
      semanasActivas: new Set(), mesesActivos: new Set(),
    }
    const info = mapaSedes.get(r.id)
    // Divisor >=1 para no dividir por 0 en recursos sin actividad; el h_ejec=0
    // hace que el resultado sea 0 igual.
    const nSemActivas = Math.max(1, agg.semanasActivas.size)
    const nMesesActivos = Math.max(1, agg.mesesActivos.size)
    return {
      resource: r.name,
      type: r.type,
      site: nombreSedes(info),
      _sedeIds: info?.sedeIds ?? new Set(),  // interno — usado por el filtro de sede
      h_prog: Math.round(agg.h_prog * 10) / 10,
      h_ejec: Math.round(agg.h_ejec * 10) / 10,
      // PROYECTOS-3255 #3.3: promedios SOBRE h_ejec / semanas o meses ACTIVOS del recurso.
      // Se emiten como 0 (no null) para recursos sin actividad — coherente con h_ejec=0.
      // El orden de las keys respeta la posicion de cfg.cols en ReportPage.
      prom_h_semanal: Math.round((agg.h_ejec / nSemActivas) * 10) / 10,
      prom_h_mensual: Math.round((agg.h_ejec / nMesesActivos) * 10) / 10,
      pac_prog: agg.pac_prog,
      pac_at: agg.pac_at,
      // PROYECTOS-3255 #3.1 / #1.3: pct=null (no 0) para no pintar semaforo ROJO falso.
      // Casos: (a) recurso sin actividad, (b) recurso con incapacidad confirmada en
      // el rango (no se penaliza a un enfermo). El renderer trata null como '—' sin color.
      pct_cumplimiento: (incapacidadPorRecurso.get(r.id) ?? 0) > 0
        ? null
        : agg.pac_prog > 0 ? Math.round((agg.pac_at / agg.pac_prog) * 100) : null,
      // PROYECTOS-3255 #1.3: dias en incapacidad medica confirmada durante el rango.
      // Si >0, el frontend muestra badge "En incapacidad" y NO aplica semaforo rojo.
      dias_incapacidad: incapacidadPorRecurso.get(r.id) ?? 0,
    }
  })

  // Filtro por sede sobre la sede RESUELTA (no en el where de prisma).
  // Un recurso sin asignaciones en el rango solo aparece si NO se filtro sede.
  const filtradas = sedeIds
    ? filas.filter((f) => [...f._sedeIds].some((sid) => sedeIds.includes(sid)))
    : filas

  // Orden: primero los que tienen actividad (por % desc, luego h_prog desc),
  // despues los inactivos (h_prog=0) alfabeticamente al final.
  filtradas.sort((a, b) => {
    const aInactiva = a.h_prog === 0
    const bInactiva = b.h_prog === 0
    if (aInactiva !== bInactiva) return aInactiva ? 1 : -1
    if (aInactiva) return a.resource.localeCompare(b.resource, 'es')
    const pa = a.pct_cumplimiento ?? -1
    const pb = b.pct_cumplimiento ?? -1
    if (pa !== pb) return pb - pa
    return b.h_prog - a.h_prog
  })

  // Limpiar campo interno antes de devolver (exportService serializa Object.keys).
  return filtradas.map(({ _sedeIds, ...rest }) => rest)
}

export async function dataAusentismo({ desde, hasta, site_id: sede_id, resource_type: tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { status: 'confirmada' }
  if (desde) where.startDate = { gte: new Date(desde) }
  if (hasta) where.startDate = { ...(where.startDate ?? {}), lte: new Date(hasta) }
  if (tipos) where.resource = { type: { in: tipos } }

  const ausencias = await prisma.absence.findMany({ where, include: { resource: true } })
  const mapaSedes = await mapaSedesPorRecurso({ desde, hasta })
  const festivos = await festivosDeAusencias(ausencias)

  const porRecurso = new Map()
  for (const a of ausencias) {
    const info = mapaSedes.get(a.resourceId)
    if (!recursoEnSedes(info, sedeIds)) continue
    const k = a.resourceId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        resource: a.resource.name, type: a.resource.type, site: nombreSedes(info),
        absences: 0, programadas: 0, imprevistas: 0,
        dias: 0, pac_afectados: 0, cost: 0, quejas: 0,
      })
    }
    const r = porRecurso.get(k)
    r.absences++
    // Contadores nuevos (ago-2026): >15 días anticipación = programada,
    // ≤15 días = imprevista. Alimentan el análisis de reprogramación.
    if (a.isPlanned) r.programadas++
    else r.imprevistas++
    r.dias += diasHabilesDeAusencia(a, festivos)
    r.pac_afectados += a.patientsAffected ?? 0
    r.cost += Number(a.opportunityCost ?? 0)
    r.quejas += a.complaintsLogged ?? 0
  }

  return Array.from(porRecurso.values()).sort((a, b) => b.absences - a.absences)
}

export async function dataSubutilizacion({ site_id: sede_id, resource_type: tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Utilización SEMANAL contra la semana actual (la que contiene hoy)
  const semanaActual = await getSemanaActual()

  const whereRec = { active: true, payScheme: { in: ['fijo', 'mixto'] } }
  if (tipos) whereRec.type = { in: tipos }
  const recursos = await prisma.resource.findMany({ where: whereRec })

  const asigs = semanaActual
    ? await prisma.assignment.findMany({
        where: { weekId: semanaActual.id, status: { not: 'cancelada' } },
      })
    : []
  const mapaSedes = await mapaSedesPorRecurso()

  // PROYECTOS-3255 #1.3: dias de incapacidad confirmada que solapan la semana
  // actual, por recurso. Si >0, se muestra badge "Incapacidad" y pct=null para
  // no penalizar al enfermo (mismo criterio que dataProductividad).
  const incapacidadPorRecurso = new Map()
  if (semanaActual) {
    const ausenciasIncap = await prisma.absence.findMany({
      where: whereAusenciasIncapacidadEnRango(semanaActual.startDate, semanaActual.endDate),
      select: { resourceId: true, startDate: true, endDate: true },
    })
    for (const a of ausenciasIncap) {
      const inicio = a.startDate > semanaActual.startDate ? a.startDate : semanaActual.startDate
      const fin = a.endDate < semanaActual.endDate ? a.endDate : semanaActual.endDate
      const dias = Math.max(0, Math.round((fin - inicio) / (1000 * 60 * 60 * 24)) + 1)
      incapacidadPorRecurso.set(a.resourceId, (incapacidadPorRecurso.get(a.resourceId) ?? 0) + dias)
    }
  }

  return recursos
    .filter((r) => recursoEnSedes(mapaSedes.get(r.id), sedeIds))
    .map((r) => {
      const propias = asigs.filter((a) => a.resourceId === r.id || a.assistantId === r.id)
      // FIX: para médicos multi-consultorio (cubren varias salas en paralelo)
      // las horas se cuentan por UNIÓN por día, no por suma. Antes una doctora
      // con 3 salas 7-13h aparecía con 257% — ahora aparece con su valor real.
      const horas = r.multiRoom
        ? horasUnionPorDia(propias, r.type)
        : propias.reduce((acc, a) => acc + horasEfectivasFranja(a.startTime, a.endTime, r.type), 0)
      // Sep-2026 · SIN TOPE SEMANAL NO HAY PORCENTAJE. Antes, si
      // `maxHoursPerWeek` era null, el cálculo devolvía 0 — y un oftalmólogo con
      // 32,5 horas asignadas aparecía al 0% de utilización y además contaba
      // como "recurso con tiempo ocioso". En producción hay 94 oftalmólogos con
      // esquema 'fijo' pero tope en NULL: una combinación que el alta de
      // usuarios no puede producir (viene de una carga antigua) y que el filtro
      // `payScheme IN (fijo, mixto)` deja entrar al informe.
      // Ahora se devuelve null: la columna muestra "—" y el semáforo se apaga,
      // igual que con una incapacidad. El KPI de ociosos ya ignora los null.
      const sinTope = !(r.maxHoursPerWeek > 0)
      const pctBruto = sinTope ? null : Math.round((horas / r.maxHoursPerWeek) * 100)
      const diasIncapa = incapacidadPorRecurso.get(r.id) ?? 0
      // PROYECTOS-3255 #1.3: pct=null cuando hay incapacidad → semaforo se apaga.
      const pct = (sinTope || diasIncapa > 0) ? null : Math.min(100, pctBruto)
      return {
        resource: r.name, type: r.type, site: nombreSedes(mapaSedes.get(r.id)),
        h_asignadas: Math.round(horas * 10) / 10,
        h_disponibles: r.maxHoursPerWeek,
        pct_utilizacion: pct,
        pct_bruto: pctBruto,                  // por si interesa ver el exceso
        // `pctBruto` es null sin tope: `null > 100` da false, así que un recurso
        // sin tope nunca sale marcado como sobreasignado. Es lo correcto — sin
        // denominador no se puede afirmar que esté por encima de nada.
        sobreasignado: pctBruto > 100,
        sem_consec: 0,
        dias_incapacidad: diasIncapa,         // consumido por ReportPage (badge/semaforo)
      }
    }).sort((a, b) => (a.pct_utilizacion ?? 1e9) - (b.pct_utilizacion ?? 1e9))
}

export async function dataImpacto({ site_id: sede_id, resource_type: tipo_recurso, desde, hasta } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Mismo caso que dataProductividad: InformePage ya enviaba desde/hasta y esta
  // función los ignoraba, así que el informe listaba TODAS las ausencias
  // confirmadas de la historia por mucho que se acotara el rango en pantalla.
  // El criterio de fechas es el mismo que usa dataAusentismo, para que los dos
  // informes de ausencias no se contradigan.
  const where = { status: 'confirmada' }
  if (desde) where.startDate = { gte: new Date(desde) }
  if (hasta) where.startDate = { ...(where.startDate ?? {}), lte: new Date(hasta) }
  if (tipos) where.resource = { type: { in: tipos } }

  const ausencias = await prisma.absence.findMany({
    where,
    select: {
      resourceId: true,
      startDate: true,
      type: true,
      patientsAffected: true,
      opportunityCost: true,
      idleStaffCost: true,
      resource: { select: { name: true } },
      // PROYECTOS-3255 #3.2: familia del motivo para agrupar/desglosar en el informe.
      // Puede ser null en ausencias legacy sin motivoRef.
      reasonRef: { select: { family: true } },
    },
    orderBy: { startDate: 'desc' },
  })
  // El filtro por sede usa el mapa (la ausencia no tiene sede directa)
  const mapaSedes = sedeIds ? await mapaSedesPorRecurso({ desde, hasta }) : null

  // El orden de las claves importa: InformePage mapea las columnas por posición
  // (recurso, fecha, tipo, familia, pac_afectados, costo_oport, costo_personal, costo_reprog, total)
  return ausencias
    .filter((a) => !sedeIds || recursoEnSedes(mapaSedes.get(a.resourceId), sedeIds))
    .map((a) => {
    const oport = Number(a.opportunityCost ?? 0)
    const personal = Number(a.idleStaffCost ?? 0)
    // El desglose de reprogramación no se guarda en la ausencia — se estima como
    // el costo operativo de reprogramar los pacientes impactados.
    const reprog = 0
    return {
      resource: a.resource.name,
      date: a.startDate.toISOString().slice(0, 10),
      type: a.type,
      // PROYECTOS-3255 #3.2: familia del motivo — usada por el frontend para
      // agrupar el informe por categoria. 'sin_familia' cuando la ausencia es
      // legacy y no tiene motivoRef enlazado.
      family: a.reasonRef?.family ?? 'sin_familia',
      pac_afectados: a.patientsAffected ?? 0,
      costo_oport: oport,
      costo_personal: personal,
      costo_reprog: reprog,
      total: oport + personal + reprog,
    }
  })
}

/**
 * Informe FUSIONADO de ausentismo + impacto económico, agrupado por recurso.
 * Une el ranking de ausencias (cuántas, días, pacientes afectados) con el
 * impacto económico (costo de oportunidad + costo de personal inactivo = total).
 * Ordenado por costo total descendente (los más costosos primero).
 */
export async function dataAusentismoImpacto({ desde, hasta, site_id: sede_id, resource_type: tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { status: 'confirmada' }
  if (desde) where.startDate = { gte: new Date(desde) }
  if (hasta) where.startDate = { ...(where.startDate ?? {}), lte: new Date(hasta) }
  if (tipos) where.resource = { type: { in: tipos } }

  const ausencias = await prisma.absence.findMany({
    where,
    include: { resource: true, reasonRef: { select: { family: true } } },
  })
  const mapaSedes = await mapaSedesPorRecurso({ desde, hasta })
  const festivos = await festivosDeAusencias(ausencias)

  const porRecurso = new Map()
  for (const a of ausencias) {
    const info = mapaSedes.get(a.resourceId)
    if (!recursoEnSedes(info, sedeIds)) continue
    const k = a.resourceId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        resource: a.resource.name, type: a.resource.type, site: nombreSedes(info),
        absences: 0, programadas: 0, imprevistas: 0,
        dias: 0, pac_afectados: 0, quejas: 0,
        opportunity_cost: 0, costo_personal: 0, total: 0,
        // PROYECTOS-3255 #3.2: contadores por familia para agrupar visualmente
        // (medico, personal, sistema, etc.). Preservan el desglose al agrupar UI.
        por_familia: {},
      })
    }
    const r = porRecurso.get(k)
    r.absences++
    // Contadores nuevos (ago-2026): >15 días anticipación = programada,
    // ≤15 días = imprevista. Alimentan el análisis de reprogramación.
    if (a.isPlanned) r.programadas++
    else r.imprevistas++
    r.dias += diasHabilesDeAusencia(a, festivos)
    r.pac_afectados += a.patientsAffected ?? 0
    r.quejas += a.complaintsLogged ?? 0
    const oport = Number(a.opportunityCost ?? 0)
    const personal = Number(a.idleStaffCost ?? 0)
    r.opportunity_cost += oport
    r.costo_personal += personal
    r.total += oport + personal
    // Acumular tambien por familia del motivo (PROYECTOS-3255 #3.2)
    const fam = a.reasonRef?.family ?? 'sin_familia'
    if (!r.por_familia[fam]) r.por_familia[fam] = { absences: 0, dias: 0, total: 0 }
    r.por_familia[fam].absences++
    r.por_familia[fam].dias += diasHabilesDeAusencia(a, festivos)
    r.por_familia[fam].total += oport + personal
  }

  return Array.from(porRecurso.values()).sort((a, b) => b.total - a.total)
}

export async function dataHorasProgEjec({ desde, hasta, site_id: sede_id, resource_type: tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Filtro opcional de las asignaciones por sede y/o tipo de recurso titular
  const whereAsig = {}
  if (sedeIds) whereAsig.room = { siteId: { in: sedeIds } }
  if (tipos) whereAsig.resource = { type: { in: tipos } }

  // Solo semanas ya iniciadas — una semana futura no tiene ejecución y arruina la gráfica.
  //
  // Sep-2026 · el informe IGNORABA el rango de fechas de la pantalla: devolvía
  // siempre las últimas 8 semanas, pusieras el rango que pusieras. Ahora
  // `desde`/`hasta` filtran por el fin de la semana —igual que en Cierre de
  // semanas— y el tope de 8 solo aplica cuando no se pidió rango.
  const whereSemana = { startDate: { lte: new Date() } }
  if (desde) whereSemana.endDate = { gte: new Date(desde) }
  if (hasta) whereSemana.endDate = { ...(whereSemana.endDate ?? {}), lte: new Date(hasta) }

  const semanas = await prisma.week.findMany({
    where: whereSemana,
    ...(desde || hasta ? {} : { take: 8 }),
    orderBy: { startDate: 'desc' },
    include: {
      assignments: {
        where: whereAsig,
        include: { execution: true, resource: { select: { type: true } }, room: { include: { site: true } } },
      },
    },
  })
  const filas = []
  for (const s of semanas) {
    const porSede = new Map()
    for (const a of s.assignments) {
      const key = a.room.site.name
      if (!porSede.has(key)) porSede.set(key, { h_programadas: 0, h_ejecutadas: 0 })
      // Horas EFECTIVAS: si la franja se ejecutó completa, ejecutadas = programadas
      const h = horasEfectivasFranja(a.startTime, a.endTime, a.resource?.type)
      porSede.get(key).h_programadas += h
      // Sep-2026 · ver dataProductividad: una jornada no_ejecutada no suma horas.
      if (a.execution && a.execution.shiftStatus !== 'no_ejecutada') porSede.get(key).h_ejecutadas += h
    }
    for (const [sede, vals] of porSede.entries()) {
      filas.push({
        site: sede,
        week: s.startDate.toISOString().slice(0, 10),
        h_programadas: Math.round(vals.h_programadas * 10) / 10,
        h_ejecutadas: Math.round(vals.h_ejecutadas * 10) / 10,
        diferencia: Math.round((vals.h_ejecutadas - vals.h_programadas) * 10) / 10,
        pct_cumplimiento: vals.h_programadas > 0 ? Math.round((vals.h_ejecutadas / vals.h_programadas) * 100) : 0,
      })
    }
  }
  return filas
}

/**
 * Informe de cumplimiento de cierre de semanas (HU-D): quién cerró cada semana,
 * cuándo, y si fue a tiempo. "A tiempo" = la semana se cerró en o antes de su
 * fecha de inicio (la programación quedó lista antes de arrancar la semana).
 */
export async function dataCierreSemanas({ desde, hasta, site_id: sede_id } = {}) {
  // Filtros del informe (fix jul-2026): antes esta función ignoraba los
  // parámetros y siempre devolvía las últimas 24 semanas — los filtros de la
  // UI eran cosméticos. Ahora:
  //   - desde/hasta: filtran por Semana.fechaFin (día del sábado)
  //   - sede_id: filtra las filas al conjunto de sedes indicadas (uno o varios,
  //     separado por coma en la query — tal como el resto de informes).
  //   - tipo_recurso: no aplica a este informe (el cierre es por sede, no
  //     por recurso). Si viene se ignora silenciosamente para no romper la UI.
  const sedeIds = aLista(sede_id)

  const whereSemana = {}
  if (desde) whereSemana.endDate = { gte: new Date(desde) }
  if (hasta) whereSemana.endDate = { ...(whereSemana.endDate ?? {}), lte: new Date(hasta) }

  const semanas = await prisma.week.findMany({
    where: whereSemana,
    orderBy: { startDate: 'desc' },
    // Cuando hay filtro de fechas mostramos todo lo que caiga en el rango;
    // sin filtro, cap de 24 semanas para no traer histórico enorme por defecto.
    ...(desde || hasta ? {} : { take: 24 }),
  })
  const semanaIds = semanas.map((s) => s.id)
  const semanaPorId = new Map(semanas.map((s) => [s.id, s]))

  const whereCierre = { weekId: { in: semanaIds } }
  if (sedeIds) whereCierre.siteId = { in: sedeIds }

  const cierres = await prisma.weekSiteClosure.findMany({
    where: whereCierre,
    include: { site: { select: { name: true } } },
  })
  const userIds = [...new Set(cierres.map((c) => c.closedBy).filter(Boolean))]
  const usuarios = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : []
  const nombre = new Map(usuarios.map((u) => [u.id, u.name]))

  const DIA = 1000 * 60 * 60 * 24

  // Sep-2026 · EL INFORME AHORA MIDE CUMPLIMIENTO DE VERDAD. Tres cambios:
  //
  //   1. Se listan TODAS las sedes que tuvieron programación esa semana, no
  //      solo las que cerraron. Antes una sede que nunca cerró simplemente no
  //      aparecía, así que un informe llamado "Cumplimiento de cierre por sede"
  //      no podía mostrar un incumplimiento.
  //   2. "Fecha de cierre" muestra `closedAt` — cuándo se cerró de verdad. Antes
  //      imprimía el plazo, idéntico para todas las filas de la misma semana.
  //   3. El estado compara contra el plazo. Antes era "A tiempo" siempre que lo
  //      cerrara una persona, sin mirar la fecha: nunca podía salir "Tarde".
  //
  // Plazo: lunes siguiente al domingo de fin (endDate + 1 día), 23:59.
  const cierrePorClave = new Map(cierres.map((c) => [`${c.weekId}|${c.siteId}`, c]))

  // Sedes con programación en esas semanas — el universo que DEBÍA cerrar.
  const sedesConProgramacion = await prisma.assignment.findMany({
    where: { weekId: { in: semanaIds }, status: { not: 'cancelada' } },
    select: { weekId: true, room: { select: { siteId: true, site: { select: { name: true } } } } },
  })
  const paresEsperados = new Map()
  for (const a of sedesConProgramacion) {
    const sid = a.room?.siteId
    if (!sid) continue
    if (sedeIds && !sedeIds.includes(sid)) continue
    paresEsperados.set(`${a.weekId}|${sid}`, { weekId: a.weekId, siteId: sid, siteName: a.room.site?.name ?? '—' })
  }
  // Una sede pudo cerrar sin tener programación (cierre vacío): también entra.
  for (const c of cierres) {
    const k = `${c.weekId}|${c.siteId}`
    if (!paresEsperados.has(k)) {
      paresEsperados.set(k, { weekId: c.weekId, siteId: c.siteId, siteName: c.site?.name ?? '—' })
    }
  }

  const filas = [...paresEsperados.values()].map(({ weekId, siteId, siteName }) => {
    const sem = semanaPorId.get(weekId)
    if (!sem) return null
    const c = cierrePorClave.get(`${weekId}|${siteId}`)
    const deadline = new Date(sem.endDate.getTime() + 1 * DIA)
    const deadlineIso = deadline.toISOString().slice(0, 10)

    if (!c) {
      const vencido = Date.now() > deadline.getTime() + DIA   // pasó el lunes completo
      return {
        week: `${sem.startDate.toISOString().slice(0, 10)} → ${sem.endDate.toISOString().slice(0, 10)}`,
        site: siteName,
        coordinador: '—',
        fecha_cierre: `— (plazo ${deadlineIso})`,
        status: vencido ? 'SIN CERRAR' : 'Pendiente',
      }
    }

    const responsable = c.closedBy ? (nombre.get(c.closedBy) ?? '— sin registro —') : '(Sistema)'
    const cerradoEn = c.closedAt ? new Date(c.closedAt) : null
    // El plazo vence al final del lunes: deadline + 1 día completo.
    const aTiempo = cerradoEn ? cerradoEn.getTime() <= deadline.getTime() + DIA : false
    return {
      week: `${sem.startDate.toISOString().slice(0, 10)} → ${sem.endDate.toISOString().slice(0, 10)}`,
      site: siteName,
      coordinador: responsable,
      fecha_cierre: cerradoEn ? cerradoEn.toISOString().slice(0, 10) : deadlineIso,
      status: !c.closedBy ? 'Auto (Sistema)' : aTiempo ? 'A tiempo' : 'Tarde',
    }
  }).filter(Boolean)

  // Ordenar: semana DESC, dentro de cada semana sede ASC
  return filas.sort((a, b) => b.week.localeCompare(a.week) || a.site.localeCompare(b.site))
}

// Registro central — usado por exportar()
const GENERADORES = {
  ocupacion: dataOcupacion,
  'ocupacion-asesores': dataOcupacionAsesores,
  productividad: dataProductividad,
  ausentismo: dataAusentismo,
  subutilizacion: dataSubutilizacion,
  impacto: dataImpacto,
  'ausentismo-impacto': dataAusentismoImpacto,
  'horas-prog-ejec': dataHorasProgEjec,
  'cierre-semanas': dataCierreSemanas,
}

// ============================================================
// ENDPOINTS GET (handlers delgados)
// ============================================================

// Cada informe se cachea por su combinación de filtros (sede/tipo/fechas) durante
// TTL_INFORME. Si 100 usuarios abren el mismo informe, se calcula una sola vez.
export const ocupacion = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:ocupacion', req.query), TTL_INFORME, () => dataOcupacion(req.query)))
export const ocupacionAsesores = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:ocupacion-asesores', req.query), TTL_INFORME, () => dataOcupacionAsesores(req.query)))
export const productividad = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:productividad', req.query), TTL_INFORME, () => dataProductividad(req.query)))
export const ausentismo = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:ausentismo', req.query), TTL_INFORME, () => dataAusentismo(req.query)))
export const subutilizacion = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:subutilizacion', req.query), TTL_INFORME, () => dataSubutilizacion(req.query)))
export const impacto = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:impacto', req.query), TTL_INFORME, () => dataImpacto(req.query)))
export const ausentismoImpacto = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:ausentismo-impacto', req.query), TTL_INFORME, () => dataAusentismoImpacto(req.query)))
export const horasProgEjec = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:horas-prog-ejec', req.query), TTL_INFORME, () => dataHorasProgEjec(req.query)))
export const cierreSemanas = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:cierre-semanas', req.query), TTL_INFORME, () => dataCierreSemanas(req.query)))

/**
 * Sede principal de VARIOS recursos a la vez: la de su asignación no cancelada
 * más reciente. Devuelve Map<recursoId, nombreSede>.
 *
 * Sustituye al antiguo sedeDelRecursoEnAusencia(), que hacía una consulta por
 * ausencia (N+1) desde el dashboard. Aquí es una sola consulta para todo el
 * grupo: se traen las asignaciones de esos recursos ordenadas de más reciente a
 * más antigua y nos quedamos con la primera de cada uno.
 */
async function sedesDeRecursos(recursoIds) {
  const ids = [...new Set(recursoIds.filter(Boolean))]
  if (ids.length === 0) return new Map()

  const asigs = await prisma.assignment.findMany({
    where: {
      OR: [{ resourceId: { in: ids } }, { assistantId: { in: ids } }],
      status: { not: 'cancelada' },
    },
    select: {
      resourceId: true,
      assistantId: true,
      room: { select: { site: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const mapa = new Map()
  for (const a of asigs) {
    const nombre = a.room?.site?.name
    if (!nombre) continue
    // Recorremos de más reciente a más antigua: la primera que aparece gana.
    for (const rid of [a.resourceId, a.assistantId]) {
      if (rid && ids.includes(rid) && !mapa.has(rid)) mapa.set(rid, nombre)
    }
  }
  return mapa
}

/** Suma pacientes_capacidad de una semana (programado). Si `dia` está presente
 * (ej: "lunes") solo cuenta las asignaciones de ese día. */
async function pacientesDeSemana(semanaId, dia = null) {
  if (!semanaId) return 0
  const where = { weekId: semanaId, status: { not: 'cancelada' } }
  if (dia) where.weekday = dia
  const asigs = await prisma.assignment.findMany({
    where,
    select: { patientCapacity: true },
  })
  return asigs.reduce((acc, a) => acc + (a.patientCapacity ?? 0), 0)
}

/** Suma pacientes ATENDIDOS (ejecución real) de una semana. Si `dia` filtra al día. */
async function atendidosDeSemana(semanaId, dia = null) {
  if (!semanaId) return 0
  const where = { weekId: semanaId, status: { not: 'cancelada' }, execution: { isNot: null } }
  if (dia) where.weekday = dia
  const asigs = await prisma.assignment.findMany({
    where,
    select: { execution: { select: { patientsSeen: true } } },
  })
  return asigs.reduce((acc, a) => acc + (a.execution?.patientsSeen ?? 0), 0)
}

/**
 * Convierte un nombre de día en su fecha exacta dentro de la semana.
 *
 * Sep-2026 · FIX: antes devolvía el día siguiente. La lista arrancaba en domingo
 * ("la semana arranca en domingo según RN-04") y ese índice se sumaba a
 * `startDate`. Pero las semanas se crean con `startOfWeek(..., weekStartsOn: 1)`
 * desde jul-2026 y en producción TODAS arrancan en LUNES: para 'lunes' el
 * índice 1 daba martes. En el dashboard, filtrar por un día mostraba el
 * siguiente.
 *
 * Ahora el desplazamiento se mide contra el día real en que arranca cada
 * semana, en vez de asumirlo. Funciona con semanas que empiecen lunes o
 * domingo, que es lo que hay mezclado en la base.
 */
const DIAS_POR_DOW = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
function fechaDelDia(semana, dia) {
  const idx = DIAS_POR_DOW.indexOf(dia)
  if (idx < 0 || !semana?.startDate) return null
  const inicio = new Date(semana.startDate)
  const offset = (idx - inicio.getUTCDay() + 7) % 7
  const d = new Date(inicio)
  d.setUTCDate(d.getUTCDate() + offset)
  return d
}

/** Suma pacientes impactados por ausencias confirmadas activas en el rango de una semana.
 * Si `dia` está presente, solo cuenta ausencias que cubren ese día específico. */
async function impactadosDeSemana(semana, dia = null) {
  if (!semana) return 0
  const rangoInicio = dia ? fechaDelDia(semana, dia) : semana.startDate
  const rangoFin = dia ? fechaDelDia(semana, dia) : semana.endDate
  if (!rangoInicio || !rangoFin) return 0
  const ausencias = await prisma.absence.findMany({
    where: {
      status: 'confirmada',
      startDate: { lte: rangoFin },
      endDate: { gte: rangoInicio },
    },
    select: { patientsAffected: true },
  })
  return ausencias.reduce((acc, a) => acc + (a.patientsAffected ?? 0), 0)
}

/**
 * GET /informes/dashboard — KPIs del dashboard ejecutivo (HU-D-01).
 * Shape alineado con DASH_DIRECTIVO del frontend. Datos reales de la BD.
 *
 * Filtros opcionales:
 *   - semanaId: ID de la semana a usar como "base". Si no se pasa = semana actual.
 *   - dia: "lunes"|"martes"|...|"domingo". Si se pasa, los KPIs de pacientes
 *     (programados, atendidos, impactados por ausencias) se calculan solo
 *     para ese día. La OCUPACIÓN y los RECURSOS OCIOSOS siguen siendo
 *     semanales (son métricas que no tienen sentido por día).
 */
async function computeDashboard({ weekId: semanaId, day: dia } = {}) {
  // Resolver semana base: la pedida (validar existe), o la actual.
  let semanaBase = null
  if (semanaId) {
    semanaBase = await prisma.week.findUnique({ where: { id: semanaId } })
  }
  if (!semanaBase) semanaBase = await getSemanaActual()

  // "Semana anterior" siempre relativa a la base (para el delta).
  const semanaAnterior = semanaBase
    ? await prisma.week.findFirst({
        where: { startDate: { lt: semanaBase.startDate } },
        orderBy: { startDate: 'desc' },
      })
    : null

  // Los seis contadores (actual y anterior de programados, atendidos e
  // impactados) son independientes entre sí. Antes se esperaban uno detrás de
  // otro, así que el dashboard tardaba la SUMA de las seis consultas; ahora
  // tarda la más lenta de las seis.
  const [
    pacientesProgramados,
    pacientesAnterior,
    atendidosActual,
    atendidosAnterior,
    impactadosActual,
    impactadosAnterior,
  ] = await Promise.all([
    pacientesDeSemana(semanaBase?.id, dia),
    pacientesDeSemana(semanaAnterior?.id, dia),
    atendidosDeSemana(semanaBase?.id, dia),
    atendidosDeSemana(semanaAnterior?.id, dia),
    impactadosDeSemana(semanaBase, dia),
    impactadosDeSemana(semanaAnterior, dia),
  ])

  const deltaPacientes = pacientesAnterior > 0
    ? Math.round(((pacientesProgramados - pacientesAnterior) / pacientesAnterior) * 1000) / 10
    : 0
  const deltaAtendidos = atendidosAnterior > 0
    ? Math.round(((atendidosActual - atendidosAnterior) / atendidosAnterior) * 1000) / 10
    : 0
  const deltaImpactados = impactadosActual - impactadosAnterior

  // Ausencias activas: las que cubren algún día de la semana base (o el día específico)
  const rangoIni = dia && semanaBase ? fechaDelDia(semanaBase, dia) : semanaBase?.startDate
  const rangoFin = dia && semanaBase ? fechaDelDia(semanaBase, dia) : semanaBase?.endDate
  // Estas tres tampoco dependen unas de otras: la lista de ausencias activas,
  // la ocupación por consultorio y la subutilización se piden a la vez.
  const [ausencias, ocupacionFilas, subutil] = await Promise.all([
    semanaBase
      ? prisma.absence.findMany({
          where: {
            status: 'confirmada',
            startDate: { lte: rangoFin },
            endDate: { gte: rangoIni },
          },
          select: {
            resourceId: true,
            patientsAffected: true,
            opportunityCost: true,
            resource: { select: { name: true } },
          },
          orderBy: { startDate: 'desc' },
        })
      : Promise.resolve([]),
    dataOcupacion({ week_id: semanaBase?.id }),
    dataSubutilizacion(),
  ])

  const costoTotalAusentismo = ausencias.reduce((acc, a) => acc + Number(a.opportunityCost ?? 0), 0)
  // Sep-2026 · FIX: `pct_utilizacion` viene en null cuando el recurso estuvo en
  // incapacidad confirmada esa semana (PROYECTOS-3255 #1.3, para no penalizar al
  // enfermo). Pero en JavaScript `null < 60` es TRUE, así que el KPI los contaba
  // como ociosos — justo lo contrario de lo que buscaba esa regla. El job de
  // alertas ya los excluía (jobs/alerts.js); este contador se había quedado atrás.
  // El mismo null llega ahora cuando el recurso no tiene tope semanal definido
  // (horas_max_semana en NULL): sin denominador no hay porcentaje que comparar.
  const recursosOciosos = subutil.filter(
    (r) => typeof r.pct_utilizacion === 'number' && r.pct_utilizacion < 60,
  ).length

  // Ocupación por sede — semanal (la pasamos por la semana base)
  const porSede = new Map()
  for (const f of ocupacionFilas) {
    if (!porSede.has(f.site)) porSede.set(f.site, { asignadas: 0, base: 0 })
    porSede.get(f.site).asignadas += f.h_asignadas
    porSede.get(f.site).base += f.h_base
  }
  const sedesOcupacion = [...porSede.entries()].map(([nombre, v]) => ({
    name: nombre,
    pct: v.base > 0 ? Math.round((v.asignadas / v.base) * 100) : 0,
  })).sort((a, b) => b.pct - a.pct)
  const ocupacionGlobal = sedesOcupacion.length > 0
    ? Math.round(sedesOcupacion.reduce((acc, s) => acc + s.pct, 0) / sedesOcupacion.length)
    : 0

  // Top 5 ausencias activas con su sede resuelta.
  // Antes esto lanzaba una consulta por ausencia (N+1). Ahora las cinco sedes
  // se resuelven de una vez.
  const top5 = ausencias.slice(0, 5)
  const sedePorRecurso = await sedesDeRecursos(top5.map((a) => a.resourceId))
  const ausenciasTop = top5.map((a) => ({
    name: a.resource.name,
    site: sedePorRecurso.get(a.resourceId) ?? '—',
    pacientes: a.patientsAffected ?? 0,
    cost: Number(a.opportunityCost ?? 0),
  }))

  return {
    week: semanaBase ? {
      id: semanaBase.id,
      start_date: semanaBase.startDate,
      end_date: semanaBase.endDate,
      status: semanaBase.status,
    } : null,
    day: dia ?? null,
    pacientes_programados: pacientesProgramados,
    delta_pacientes: deltaPacientes,
    patients_seen: atendidosActual,
    delta_atendidos: deltaAtendidos,
    impactados_ausencias: impactadosActual,
    delta_impactados: deltaImpactados,
    recursos_ociosos: recursosOciosos,
    ocupacion_global: ocupacionGlobal,
    meta_ocupacion: 80,
    sedes_ocupacion: sedesOcupacion,
    ausencias_activas: ausenciasTop,
    costo_total_ausentismo: costoTotalAusentismo,
  }
}

/** GET /informes/dashboard — KPIs ejecutivos (HU-D-01). Cacheado TTL_DASHBOARD por combinación de filtros. */
export async function dashboard(req, res) {
  const semanaId = req.query.week_id || null
  const dia = req.query.day || null
  const cacheKey = `dashboard:${semanaId ?? 'actual'}:${dia ?? 'todos'}`
  res.json(await withCache(cacheKey, TTL_DASHBOARD, () => computeDashboard({ weekId: semanaId, day: dia })))
}

/**
 * Calcula las métricas agregadas de una semana específica (real, desde BD).
 * Devuelve null si la semana no existe.
 */
export async function metricasDeSemanas(semanas) {
  const validas = semanas.filter(Boolean)
  const vacio = new Map()
  if (validas.length === 0) return vacio

  // Deduplicar: computeComparativo pide la semana A y la B, que casi siempre
  // están también dentro de la serie de las últimas 12.
  const porId = new Map(validas.map((s) => [s.id, s]))
  const ids = [...porId.keys()]

  // Rango que cubre TODAS las semanas pedidas, para traer las ausencias de una
  // sola vez en lugar de una consulta por semana.
  const minInicio = new Date(Math.min(...validas.map((s) => s.startDate.getTime())))
  const maxFin = new Date(Math.max(...validas.map((s) => s.endDate.getTime())))

  // 4 consultas para N semanas. Antes eran 4 POR semana: para las 14 semanas
  // que pide el comparativo, de ~56 a 4. Cargamos tambien festivos del rango
  // completo (PROYECTOS-3255 #1.1) para descontar dias no habiles del denominador.
  const [asigs, consultoriosBase, ausencias, festivosRango] = await Promise.all([
    prisma.assignment.findMany({
      where: { weekId: { in: ids }, status: { not: 'cancelada' } },
      select: {
        weekId: true,
        startTime: true,
        endTime: true,
        patientCapacity: true,
        execution: { select: { id: true, shiftStatus: true } },
      },
    }),
    // Sep-2026 · mismo denominador que dataOcupacion: consultorios activos SIN
    // asesoria. Antes esta pantalla contaba TODOS los activos (232, asesoria
    // incluida) y la otra solo los que tenian programacion (100): la misma
    // semana daba 53% en un informe y ~23% en el otro.
    prisma.room.count({ where: { active: true, specialty: { not: 'asesoria' } } }),
    prisma.absence.findMany({
      where: {
        status: 'confirmada',
        startDate: { lte: maxFin },
        endDate: { gte: minInicio },
      },
      select: { startDate: true, endDate: true, opportunityCost: true },
    }),
    cargarFestivosDelRango(minInicio, maxFin),
  ])

  // PROYECTOS-3255 #1.1: baseTotal por SEMANA (descontando festivos de ESA semana).
  // Antes era una constante para todas — semanas con festivo daban % de ocupacion
  // subestimado (denominador inflado).
  // Sep-2026 · la base horaria sale de Metas del sistema, no de una constante.
  const baseHoraria = await cargarBaseHoraria()
  const basePorSemana = new Map()
  for (const s of validas) {
    basePorSemana.set(s.id, consultoriosBase * minutosBaseSemana(s, festivosRango, baseHoraria))
  }

  const acc = new Map(ids.map((id) => [id, { pacientes: 0, progMin: 0, ejecMin: 0 }]))
  for (const a of asigs) {
    const m = acc.get(a.weekId)
    if (!m) continue
    const minutos = hhmmAMinutos(a.endTime) - hhmmAMinutos(a.startTime)
    m.pacientes += a.patientCapacity ?? 0
    m.progMin += minutos
    // Sep-2026 · ver dataProductividad: una jornada no_ejecutada no suma horas.
    if (a.execution && a.execution.shiftStatus !== 'no_ejecutada') m.ejecMin += minutos
  }

  // El coste se acumula en CÉNTIMOS enteros. Las columnas son Decimal(12,2) y
  // sumarlas como float acumularía error (0,1 + 0,2 ≠ 0,3); en enteros el
  // total coincide exactamente con el SUM de SQL que había antes.
  const out = new Map()
  for (const id of ids) {
    const semana = porId.get(id)
    const m = acc.get(id)
    const baseTotal = basePorSemana.get(id) ?? 0
    let nAusencias = 0
    let centimos = 0
    for (const au of ausencias) {
      // Misma condición de solape que usaba la consulta por semana.
      if (au.startDate <= semana.endDate && au.endDate >= semana.startDate) {
        nAusencias++
        centimos += Math.round(Number(au.opportunityCost ?? 0) * 100)
      }
    }
    out.set(id, {
      pacientes: m.pacientes,
      horas_ejec: Math.round((m.ejecMin / 60) * 10) / 10,
      ocupacion: baseTotal > 0 ? Math.round((m.progMin / baseTotal) * 100) : 0,
      absences: nAusencias,
      costo_ausentismo: centimos / 100,
    })
  }
  return out
}

/**
 * GET /informes/comparativo — HU-D-06
 * Compara la semana actual contra otra (por defecto la anterior) y devuelve
 * la serie de las últimas 12 semanas. Todo con datos reales de la BD.
 *
 * Query: ?semana_b=<uuid> (opcional — si no se pasa, usa la semana anterior)
 */
async function computeComparativo(query) {
  const { semana_b: semanaBSpec } = query

  // Últimas 12 semanas (la más reciente primero) — solo las ya iniciadas.
  // Una semana futura no tiene historial real para comparar.
  const ultimas = await prisma.week.findMany({
    where: { startDate: { lte: new Date() } },
    orderBy: { startDate: 'desc' },
    take: 13, // +1 para acceder a la "anterior" si la actual es ultimas[0]
  })

  const semanaA = ultimas[0] ?? null

  // semanaB puede venir como UUID, o como string simbólico ('sem-anterior',
  // 'sem-mes-anterior', 'sem-trimestre-anterior'). Por defecto: la anterior.
  let semanaB = null
  if (semanaBSpec === 'sem-mes-anterior') {
    semanaB = ultimas[4] ?? null
  } else if (semanaBSpec === 'sem-trimestre-anterior') {
    semanaB = ultimas[12] ?? null
  } else if (semanaBSpec && semanaBSpec !== 'sem-anterior') {
    // Asumir UUID
    semanaB = await prisma.week.findUnique({ where: { id: semanaBSpec } }).catch(() => null)
  }
  if (!semanaB) semanaB = ultimas[1] ?? null

  const fmtLabel = (s) =>
    s ? `${s.startDate.toISOString().slice(5, 10)} – ${s.endDate.toISOString().slice(5, 10)}` : '—'

  // Serie cronológica de las últimas 12 (la más antigua primero, para gráficas)
  const ultimasCronologico = [...ultimas.slice(0, 12)].reverse()

  // Una sola tanda de consultas para las 12 de la serie + A + B (que casi
  // siempre ya están dentro de la serie; metricasDeSemanas las deduplica).
  const metricas = await metricasDeSemanas([...ultimasCronologico, semanaA, semanaB])
  const metA = semanaA ? metricas.get(semanaA.id) ?? null : null
  const metB = semanaB ? metricas.get(semanaB.id) ?? null : null

  const ultimas12 = ultimasCronologico.map((s) => {
    const m = metricas.get(s.id)
    return {
      week: s.startDate.toISOString().slice(5, 10),
      pacientes: m?.pacientes ?? 0,
      ocupacion: m?.ocupacion ?? 0,
      absences: m?.absences ?? 0,
    }
  })

  return {
    semana_a: semanaA
      ? { label: fmtLabel(semanaA), ...(metA ?? { pacientes: 0, horas_ejec: 0, ocupacion: 0, absences: 0, costo_ausentismo: 0 }) }
      : null,
    semana_b: semanaB
      ? { label: fmtLabel(semanaB), ...(metB ?? { pacientes: 0, horas_ejec: 0, ocupacion: 0, absences: 0, costo_ausentismo: 0 }) }
      : null,
    ultimas_12: ultimas12,
  }
}

/** GET /informes/comparativo — HU-D-06. Cacheado TTL_INFORME por semana comparada. */
export async function comparativo(req, res) {
  res.json(
    await withCache(
      keyDeQuery('comparativo', { semana_b: req.query.semana_b }),
      TTL_INFORME,
      () => computeComparativo(req.query),
    ),
  )
}

/**
 * GET /informes/:tipo/export?formato=pdf|excel — HU-D-07
 * Genera el archivo real con los datos del informe + registra auditoría (RN-34).
 */
export async function exportar(req, res) {
  const { type: tipo } = req.params
  const formato = (req.query.formato ?? 'pdf').toLowerCase()
  const generador = GENERADORES[tipo]
  if (!generador) {
    throw errors.badRequest(`Informe no exportable: ${tipo}. Disponibles: ${Object.keys(GENERADORES).join(', ')}`)
  }

  // Reutiliza la MISMA clave de caché que el endpoint GET del informe: exportar
  // justo después de mirarlo en pantalla ya no recalcula nada. Antes cada export
  // rehacía el informe entero aunque acabara de pedirse hace un segundo.
  //
  // `formato` se excluye de la clave a propósito: no es un filtro del informe
  // (los datos son los mismos en PDF y en Excel) y, si se dejara dentro, la
  // clave nunca coincidiría con la del GET y el caché no serviría de nada.
  const { formato: _formato, ...filtros } = req.query
  const filas = await withCache(keyDeQuery(`inf:${tipo}`, filtros), TTL_INFORME, () => generador(filtros))

  // RN-34: trazabilidad de exportación
  await registrarAuditoria({
    userId: req.user.id,
    action: 'exportar_informe',
    entity: 'informes',
    entityId: tipo,
    newValue: { formato, filtros: req.query, registros: filas.length },
    ipAddress: getIp(req),
  })

  const fecha = new Date().toISOString().slice(0, 10)
  if (formato === 'excel' || formato === 'xlsx') {
    const buffer = await generarExcel(tipo, filas, req.query)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="informe_${tipo}_${fecha}.xlsx"`)
    return res.send(Buffer.from(buffer))
  }

  // PDF por defecto
  const buffer = await generarPDF(tipo, filas, req.query)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="informe_${tipo}_${fecha}.pdf"`)
  return res.send(buffer)
}
