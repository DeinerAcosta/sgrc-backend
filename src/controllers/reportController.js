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
  JORNADA_LEGAL_SEMANAL,
} from '../lib/workHours.js'

// TTL de caché para lecturas analíticas. Suficientemente corto para que los datos
// se sientan "en vivo" y suficientemente largo para absorber picos de concurrencia.
const TTL_INFORME = 30_000
const TTL_DASHBOARD = 20_000

// RN-31: base de ocupación = 12h L-V + 4h sábado = 5*720 + 240 = 3840 min = 64h/semana
const BASE_MINUTOS_SEMANA = 5 * 720 + 240

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

  const asignaciones = await prisma.assignment.findMany({
    where,
    include: { room: { include: { site: true } }, resource: true },
  })

  const porCons = new Map()
  for (const a of asignaciones) {
    // Asesoría NO es un consultorio físico — son N asesores atendiendo en
    // recepción/módulos en paralelo bajo un mismo "Area Asesores" lógico. El
    // cálculo de ocupación con h_base fijo de 64h da porcentajes irreales
    // (>200%). Se excluye de este informe; los KPIs de asesores viven en
    // Productividad por recurso (que sí los mide bien individualmente).
    if (a.room.specialty === 'asesoria') continue
    const k = a.room.id
    if (!porCons.has(k)) {
      porCons.set(k, {
        room: a.room.name,
        site: a.room.site.name,
        specialty: a.room.specialty,
        h_asignadas: 0,
        h_base: BASE_MINUTOS_SEMANA / 60,
      })
    }
    porCons.get(k).h_asignadas += horasDeFranja(a.startTime, a.endTime)
  }

  return Array.from(porCons.values()).map((f) => ({
    ...f,
    h_asignadas: Math.round(f.h_asignadas * 10) / 10,
    pct_ocupacion: Math.round((f.h_asignadas / f.h_base) * 100),
  }))
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
  const jornadaSemanal = jornadaParam ? Number(jornadaParam.value) : JORNADA_LEGAL_SEMANAL

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
  const horasPorAsesor = new Map()  // recursoId → { tope, horasSemana }
  for (const a of asigs) {
    const r = a.resource
    if (!horasPorAsesor.has(r.id)) {
      horasPorAsesor.set(r.id, { tope: r.maxHoursPerWeek ?? jornadaSemanal, horasSemana: 0 })
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
  if (semanaIds.length === 0) return []

  const where = { weekId: { in: semanaIds }, status: { not: 'cancelada' } }
  if (sedeIds) where.room = { siteId: { in: sedeIds } }
  if (tipos) where.resource = { type: { in: tipos } }

  // `select` en vez de `include`: antes se hidrataba la fila completa de
  // recurso, ejecución, consultorio y sede para leer cinco campos.
  const asigs = await prisma.assignment.findMany({
    where,
    select: {
      resourceId: true,
      startTime: true,
      endTime: true,
      patientCapacity: true,
      resource: { select: { name: true, type: true } },
      execution: { select: { patientsSeen: true } },
      room: { select: { site: { select: { name: true } } } },
    },
  })

  const porRecurso = new Map()
  for (const a of asigs) {
    const k = a.resourceId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        resource: a.resource.name,
        type: a.resource.type,
        site: a.room.site.name,
        h_prog: 0, h_ejec: 0, pac_prog: 0, pac_at: 0,
      })
    }
    const r = porRecurso.get(k)
    // Horas EFECTIVAS (descontando almuerzo): es lo que realmente trabajó.
    // Si la franja se ejecutó completa, ejecutadas = programadas (también netas).
    const h = horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
    r.h_prog += h
    r.pac_prog += a.patientCapacity ?? 0
    if (a.execution) {
      r.h_ejec += h
      r.pac_at += a.execution.patientsSeen
    }
  }

  return Array.from(porRecurso.values()).map((r) => ({
    ...r,
    h_prog: Math.round(r.h_prog * 10) / 10,
    h_ejec: Math.round(r.h_ejec * 10) / 10,
    pct_cumplimiento: r.pac_prog > 0 ? Math.round((r.pac_at / r.pac_prog) * 100) : 0,
  }))
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
    r.dias += Math.round((a.endDate - a.startDate) / (1000 * 60 * 60 * 24)) + 1
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
      // Tope al 100% en el porcentaje mostrado, pero registramos el bruto en otra clave.
      const pctBruto = r.maxHoursPerWeek > 0 ? Math.round((horas / r.maxHoursPerWeek) * 100) : 0
      const pct = Math.min(100, pctBruto)
      return {
        resource: r.name, type: r.type, site: nombreSedes(mapaSedes.get(r.id)),
        h_asignadas: Math.round(horas * 10) / 10,
        h_disponibles: r.maxHoursPerWeek,
        pct_utilizacion: pct,
        pct_bruto: pctBruto,                  // por si interesa ver el exceso
        sobreasignado: pctBruto > 100,        // bandera visual para el frontend
        sem_consec: 0,
      }
    }).sort((a, b) => a.pct_utilizacion - b.pct_utilizacion)
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
    },
    orderBy: { startDate: 'desc' },
  })
  // El filtro por sede usa el mapa (la ausencia no tiene sede directa)
  const mapaSedes = sedeIds ? await mapaSedesPorRecurso({ desde, hasta }) : null

  // El orden de las claves importa: InformePage mapea las columnas por posición
  // (recurso, fecha, tipo, pac_afectados, costo_oport, costo_personal, costo_reprog, total)
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

  const ausencias = await prisma.absence.findMany({ where, include: { resource: true } })
  const mapaSedes = await mapaSedesPorRecurso({ desde, hasta })

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
      })
    }
    const r = porRecurso.get(k)
    r.absences++
    // Contadores nuevos (ago-2026): >15 días anticipación = programada,
    // ≤15 días = imprevista. Alimentan el análisis de reprogramación.
    if (a.isPlanned) r.programadas++
    else r.imprevistas++
    r.dias += Math.round((a.endDate - a.startDate) / (1000 * 60 * 60 * 24)) + 1
    r.pac_afectados += a.patientsAffected ?? 0
    r.quejas += a.complaintsLogged ?? 0
    const oport = Number(a.opportunityCost ?? 0)
    const personal = Number(a.idleStaffCost ?? 0)
    r.opportunity_cost += oport
    r.costo_personal += personal
    r.total += oport + personal
  }

  return Array.from(porRecurso.values()).sort((a, b) => b.total - a.total)
}

export async function dataHorasProgEjec({ site_id: sede_id, resource_type: tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Filtro opcional de las asignaciones por sede y/o tipo de recurso titular
  const whereAsig = {}
  if (sedeIds) whereAsig.room = { siteId: { in: sedeIds } }
  if (tipos) whereAsig.resource = { type: { in: tipos } }

  // Solo semanas ya iniciadas — una semana futura no tiene ejecución y arruina la gráfica
  const semanas = await prisma.week.findMany({
    where: { startDate: { lte: new Date() } },
    take: 8,
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
      if (a.execution) porSede.get(key).h_ejecutadas += h
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
  // GRACE_DIAS = 4 — DEBE mantenerse sincronizado con GRACE_DIAS en
  // backend/src/jobs/autoCierreSemana.js:25. Es el mismo umbral: el sistema
  // cierra automáticamente pasado ese día, así que "A tiempo" para el coord
  // es cualquier cierre manual DENTRO de esa ventana.
  //
  // Cadencia real: sábado (día 0) + dom + lun (cierre de registro de ejecución)
  // + mar + mié (día 4) → el miércoles el job toma over si nadie cerró antes.
  const GRACE_DIAS = 4
  const filas = cierres.map((c) => {
    const sem = semanaPorId.get(c.weekId)
    if (!sem) return null
    // Días entre el fin de la semana (sábado) y la fecha de cierre:
    //   0 → cerró el mismo sábado (óptimo)
    //   1 a 4 → dentro del período de gracia, "A tiempo"
    //   5+ → "Tarde" (solo posible si el auto-cierre estuvo caído)
    // Negativo (cerró antes del fin) lo mostramos como 0 — no tiene sentido
    // físico cerrar antes de que termine la ejecución de la semana.
    const diasTrasFin = Math.max(0, Math.round((c.closedAt - sem.endDate) / DIA))
    const aTiempo = diasTrasFin <= GRACE_DIAS
    const responsable = c.closedBy ? (nombre.get(c.closedBy) ?? '— sin registro —') : '(Sistema)'
    return {
      week: `${sem.startDate.toISOString().slice(0, 10)} → ${sem.endDate.toISOString().slice(0, 10)}`,
      site: c.site?.name ?? '—',
      coordinador: responsable,
      fecha_cierre: c.closedAt.toISOString().slice(0, 10),
      dias_tras_fin: diasTrasFin,
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

/** Días de la semana: convierte un día en su fecha exacta dentro de la semana
 * (la semana arranca en domingo según RN-04). Devuelve Date UTC al inicio del día. */
const DIAS_ORDEN = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
function fechaDelDia(semana, dia) {
  const idx = DIAS_ORDEN.indexOf(dia)
  if (idx < 0) return null
  const d = new Date(semana.startDate)
  d.setUTCDate(d.getUTCDate() + idx)
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
  const recursosOciosos = subutil.filter((r) => r.pct_utilizacion < 60).length

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

  // 3 consultas para N semanas. Antes eran 4 POR semana: para las 14 semanas
  // que pide el comparativo, de ~56 a 3.
  const [asigs, consultoriosBase, ausencias] = await Promise.all([
    prisma.assignment.findMany({
      where: { weekId: { in: ids }, status: { not: 'cancelada' } },
      select: {
        weekId: true,
        startTime: true,
        endTime: true,
        patientCapacity: true,
        execution: { select: { id: true } },
      },
    }),
    prisma.room.count({ where: { active: true } }),
    prisma.absence.findMany({
      where: {
        status: 'confirmada',
        startDate: { lte: maxFin },
        endDate: { gte: minInicio },
      },
      select: { startDate: true, endDate: true, opportunityCost: true },
    }),
  ])

  const baseTotal = consultoriosBase * BASE_MINUTOS_SEMANA

  const acc = new Map(ids.map((id) => [id, { pacientes: 0, progMin: 0, ejecMin: 0 }]))
  for (const a of asigs) {
    const m = acc.get(a.weekId)
    if (!m) continue
    const minutos = hhmmAMinutos(a.endTime) - hhmmAMinutos(a.startTime)
    m.pacientes += a.patientCapacity ?? 0
    m.progMin += minutos
    if (a.execution) m.ejecMin += minutos
  }

  // El coste se acumula en CÉNTIMOS enteros. Las columnas son Decimal(12,2) y
  // sumarlas como float acumularía error (0,1 + 0,2 ≠ 0,3); en enteros el
  // total coincide exactamente con el SUM de SQL que había antes.
  const out = new Map()
  for (const id of ids) {
    const semana = porId.get(id)
    const m = acc.get(id)
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
