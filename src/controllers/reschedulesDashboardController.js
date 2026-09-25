// Fase 4 (ago-2026) — Dashboard gerencial de Reprogramaciones.
// Endpoint agregado para las 4 tabs FOCA: Resumen · Médicos · Reposición · Causas.
//
// Devuelve TODO pre-calculado en una sola respuesta cacheada (TTL 60s):
//   { rango, kpis, por_mes, por_familia, top_motivos, por_recurso,
//     reposiciones: { …, por_mes, top_medicos }, por_especialidad, cruce_familia_especialidad }
//
// Filtros: ?desde=YYYY-MM-DD & ?hasta=YYYY-MM-DD & ?sede_id=csv & ?familia=csv & ?tipo_recurso=csv
// Rango default: últimos 3 meses. Se puede sobreescribir.

import { prisma } from '../lib/prisma.js'
import { cargarFestivosDelRango, esDomingoOFestivo } from '../lib/calendario.js'
import { withCache, keyDeQuery } from '../lib/cache.js'

const TTL_REPROG = 60_000  // 60s — dashboard ejecutivo, no necesita tiempo real

const FAMILIA_LABEL = {
  ausencia_profesional:     'Ausencia profesional',
  reprogramacion_operativa: 'Reprogramación operativa',
  ajuste_cupos:             'Ajuste de cupos',
  movilidad_regional:       'Movilidad / Regional',
  calendario_festivo:       'Calendario / Festivo',
  otros:                    'Otros',
}

const aLista = (v) => {
  if (!v) return null
  const arr = Array.isArray(v) ? v : String(v).split(',')
  const limpio = arr.map((x) => String(x).trim()).filter(Boolean)
  return limpio.length > 0 ? limpio : null
}

// Formatea Date → 'YYYY-MM-DD' usando fecha LOCAL (getFullYear/getMonth/getDate).
// Antes usábamos toISOString().slice(0,10) que devuelve fecha UTC — en Colombia
// (UTC-5) eso corría el día en horario nocturno (>=19:00 local saltaba a mañana).
function isoLocal(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Parsea 'YYYY-MM-DD' como fecha LOCAL medianoche (evita el shift UTC).
// Devuelve null si el formato no es válido.
function parseFechaLocal(iso) {
  if (typeof iso !== 'string') return null
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, y, mo, d] = m.map(Number)
  return new Date(y, mo - 1, d)
}

// Rango default: mes actual + 2 meses hacia atrás (3 meses en total). Fechas locales.
function rangoDefault() {
  const hoy = new Date()
  const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1)  // primer día del mes de hace 2
  return { desde: isoLocal(desde), hasta: isoLocal(hoy) }
}

// Cap del ancho del rango: máximo 24 meses. Evita DoS por consulta gigante.
const RANGO_MAX_MESES = 24
function validarRango(desde, hasta) {
  const d = parseFechaLocal(desde)
  const h = parseFechaLocal(hasta)
  if (!d || !h) return { ok: false, error: 'Fechas inválidas (formato YYYY-MM-DD)' }
  if (h < d) return { ok: false, error: 'hasta debe ser >= desde' }
  const meses = (h.getFullYear() - d.getFullYear()) * 12 + (h.getMonth() - d.getMonth())
  if (meses > RANGO_MAX_MESES) return { ok: false, error: `Rango máximo ${RANGO_MAX_MESES} meses` }
  return { ok: true, d, h }
}

// Mapa recursoId → { sedeIds:Set, sedeNombres:Set } tomado de asignaciones no
// canceladas. Reusa la lógica de informeController pero local para no acoplar.
async function mapaSedesPorRecurso() {
  const asigs = await prisma.assignment.findMany({
    where: { status: { not: 'cancelada' } },
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

// ============================================================================
// Núcleo del dashboard — puro, testeable.
// ============================================================================
async function dataReprogramacionesDashboard(query = {}) {
  const def = rangoDefault()
  const rango = {
    desde: query.desde || def.desde,
    hasta: query.hasta || def.hasta,
  }
  // Validación estricta — evita DoS con rangos gigantes y crashes por Invalid Date.
  const v = validarRango(rango.desde, rango.hasta)
  if (!v.ok) {
    throw Object.assign(new Error(v.error), { status: 400 })
  }
  const sedeIdsFiltro = aLista(query.site_id)
  const familiasFiltro = aLista(query.family)
  const tiposFiltro = aLista(query.resource_type)

  // ==== 1. Ausencias del rango + include para agregaciones ====
  // Rango: intersección con período de ausencia — fechaInicio <= hasta AND fechaFin >= desde.
  // v.d y v.h son fechas locales (medianoche Bogotá) — para hasta agregamos 23:59 para incluir el día.
  const desdeD = v.d
  const hastaD = new Date(v.h)
  hastaD.setHours(23, 59, 59, 999)
  const whereAus = {
    status: { not: 'rechazada' },
    startDate: { lte: hastaD },
    endDate:    { gte: desdeD },
  }
  // Filtro por familia: incluye null como 'ausencia_profesional' (fallback)
  if (familiasFiltro) {
    const orFam = [{ reasonRef: { is: { family: { in: familiasFiltro } } } }]
    if (familiasFiltro.includes('ausencia_profesional')) orFam.push({ reasonId: null })
    whereAus.OR = orFam
  }
  // Filtro por tipo de recurso
  if (tiposFiltro) {
    whereAus.resource = { is: { type: { in: tiposFiltro } } }
  }

  const ausencias = await prisma.absence.findMany({
    where: whereAus,
    include: {
      resource: { select: { id: true, name: true, type: true } },
      reasonRef: { select: { code: true, name: true, family: true } },
      makeups: { select: { id: true, status: true, requestedAt: true, approvedAt: true } },
    },
  })

  // ==== 2. Filtro por sede (post-hoc: sede no vive en Ausencia directa) ====
  // Solo cargamos mapaSedes si vamos a filtrar por sede. Antes se cargaba
  // siempre por un guard tautológico (verify Fase 4 flag DoS-wasted-scan).
  const mapaSedes = sedeIdsFiltro ? await mapaSedesPorRecurso() : null
  const perteneceASede = (recursoId) => {
    if (!sedeIdsFiltro) return true
    const info = mapaSedes.get(recursoId)
    if (!info) return false
    return sedeIdsFiltro.some((sid) => info.sedeIds.has(sid))
  }
  const ausF = sedeIdsFiltro ? ausencias.filter((a) => perteneceASede(a.resourceId)) : ausencias

  // Sep-2026 · los "días perdidos" son días HÁBILES (sin domingos ni festivos),
  // igual que en Ausentismo e impacto. Antes este tablero contaba días
  // calendario y la misma ausencia daba dos cifras distintas según la pantalla.
  // Se cargan una sola vez para todo el rango.
  const festivos = await cargarFestivosDelRango(desdeD, hastaD)

  // ==== 3. KPIs generales ====
  let diasPerdidos = 0
  let pacientesImpactados = 0
  let costoOportunidad = 0
  let programadas = 0
  let imprevistas = 0
  let conReposicionAprobada = 0

  for (const a of ausF) {
    const dias = diasEntreInclusive(a.startDate, a.endDate, festivos)
    diasPerdidos += dias
    pacientesImpactados += a.patientsAffected ?? 0
    costoOportunidad += Number(a.opportunityCost ?? 0)
    if (a.isPlanned) programadas++
    else imprevistas++
    if (a.makeups?.some((r) => r.status === 'aprobada' || r.completedAt)) {
      conReposicionAprobada++
    }
  }
  const total = ausF.length
  const tasaReposicion = total > 0 ? Math.round((conReposicionAprobada / total) * 100) : 0

  // ==== 4. Serie mensual (últimos ~12 meses, siempre 12 buckets) ====
  const meses = mesesEnRango(desdeD, hastaD)
  const seriePorMesMap = new Map(meses.map((m) => [m, { mes: m, count: 0, dias: 0, pacientes: 0 }]))
  for (const a of ausF) {
    // Distribución: contamos la ausencia en el mes de su fechaInicio (más simple y
    // consistente con cómo la coord la reporta). Días y pacientes también.
    const mes = mesLocal(a.startDate)  // YYYY-MM local Bogotá
    if (!seriePorMesMap.has(mes)) continue
    const b = seriePorMesMap.get(mes)
    b.count++
    b.dias += diasEntreInclusive(a.startDate, a.endDate, festivos)
    b.pacientes += a.patientsAffected ?? 0
  }
  const porMes = [...seriePorMesMap.values()]

  // ==== 5. Distribución por familia ====
  const famAgg = new Map()
  for (const a of ausF) {
    const fam = a.reasonRef?.family ?? 'ausencia_profesional'
    if (!famAgg.has(fam)) famAgg.set(fam, { family: fam, label: FAMILIA_LABEL[fam] ?? fam, count: 0, dias: 0, pacientes: 0 })
    const b = famAgg.get(fam)
    b.count++
    b.dias += diasEntreInclusive(a.startDate, a.endDate, festivos)
    b.pacientes += a.patientsAffected ?? 0
  }
  const porFamilia = [...famAgg.values()]
    .map((f) => ({ ...f, pct: total > 0 ? Math.round((f.count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count)

  // ==== 6. Top motivos (10 con más ocurrencias) ====
  const motAgg = new Map()
  for (const a of ausF) {
    const key = a.reasonRef?.code ?? a.type ?? 'otro'
    if (!motAgg.has(key)) {
      motAgg.set(key, {
        code: key,
        name: a.reasonRef?.name ?? a.type,
        family: a.reasonRef?.family ?? 'ausencia_profesional',
        count: 0,
      })
    }
    motAgg.get(key).count++
  }
  const topMotivos = [...motAgg.values()].sort((a, b) => b.count - a.count).slice(0, 10)

  // ==== 7. Ranking por recurso (top 30) ====
  const recAgg = new Map()
  for (const a of ausF) {
    const rid = a.resourceId
    if (!recAgg.has(rid)) {
      recAgg.set(rid, {
        resource_id: rid,
        name: a.resource?.name ?? '—',
        type: a.resource?.type ?? null,
        count: 0,
        dias: 0,
        pacientes: 0,
        approved_makeups: 0,
      })
    }
    const b = recAgg.get(rid)
    b.count++
    b.dias += diasEntreInclusive(a.startDate, a.endDate, festivos)
    b.pacientes += a.patientsAffected ?? 0
    if (a.makeups?.some((r) => r.status === 'aprobada' || r.completedAt)) {
      b.approved_makeups++
    }
  }
  const porRecurso = [...recAgg.values()].sort((a, b) => b.dias - a.dias).slice(0, 30)

  // ==== 8. Reposiciones (tab 3) ====
  const reposicionesData = await calcularReposiciones({
    desde: desdeD, hasta: hastaD, sedeIdsFiltro, mapaSedes, meses,
  })

  // ==== 9. Por especialidad + cruce familia × especialidad (tab 4) ====
  const espAgg = new Map()
  const cruceAgg = new Map()  // key = `${familia}|${tipo}`
  for (const a of ausF) {
    const tipo = a.resource?.type ?? 'otro'
    const fam = a.reasonRef?.family ?? 'ausencia_profesional'

    if (!espAgg.has(tipo)) espAgg.set(tipo, { type: tipo, count: 0, dias: 0, pacientes: 0 })
    const eb = espAgg.get(tipo)
    eb.count++
    eb.dias += diasEntreInclusive(a.startDate, a.endDate, festivos)
    eb.pacientes += a.patientsAffected ?? 0

    const ck = `${fam}|${tipo}`
    if (!cruceAgg.has(ck)) cruceAgg.set(ck, { family: fam, type: tipo, count: 0 })
    cruceAgg.get(ck).count++
  }
  const porEspecialidad = [...espAgg.values()].sort((a, b) => b.pacientes - a.pacientes)
  const cruceFamiliaEspecialidad = [...cruceAgg.values()]

  // ==== 10. Datos NUEVOS (sep-2026 · rediseño FOCA) ====
  // Se calculan a partir de las mismas colecciones ya cargadas (no queries extra).
  const nuevos = await calcularDatosFOCA({
    ausencias: ausF,
    reposiciones: reposicionesData._raw ?? [],
    mapaSedes: mapaSedes ?? await mapaSedesPorRecurso(),
  })

  return {
    rango,
    kpis: {
      total_ausencias: total,
      dias_perdidos: diasPerdidos,
      patients_affected: pacientesImpactados,
      opportunity_cost: costoOportunidad,
      programadas,
      imprevistas,
      tasa_reposicion_pct: tasaReposicion,
    },
    por_mes: porMes,
    por_familia: porFamilia,
    top_motivos: topMotivos,
    por_recurso: porRecurso,
    makeups: { ...reposicionesData, _raw: undefined },
    por_especialidad: porEspecialidad,
    cruce_familia_especialidad: cruceFamiliaEspecialidad,
    // FOCA sep-2026 — datos nuevos para el rediseño del dashboard.
    ...nuevos,
  }
}

// ============================================================================
// Datos adicionales del rediseño FOCA (sep-2026):
//   por_sede            → tasa de reposicion por sede
//   sla_reposicion      → cuando se repone (adelantada / mismo dia / 1-7 / 8-30 / >30)
//   antelacion_reporte  → dias entre creacion de la ausencia y fecha del evento
//   por_dia_semana      → patron L-D
//   por_subespecialidad → top subespecialidades (usa recurso.specialty)
//   medicos_involucrados → count distinct recursos con al menos 1 ausencia
//   pct_antelacion_ok   → % de ausencias reportadas con antelacion >= 1 dia
//   sin_cobertura       → pacientes de ausencias que NO se repusieron
// ============================================================================
async function calcularDatosFOCA({ ausencias, reposiciones, mapaSedes }) {
  // ---- Cobertura por paciente ----
  // Aproximacion: para cada ausencia con al menos 1 reposicion aprobada,
  // consideramos "cubiertos" a los patients_affected de esa ausencia.
  let pacientesCubiertos = 0
  let pacientesSinCobertura = 0
  for (const a of ausencias) {
    const pac = a.patientsAffected ?? 0
    const cubierta = a.makeups?.some((r) => r.status === 'aprobada' || r.completedAt)
    if (cubierta) pacientesCubiertos += pac
    else          pacientesSinCobertura += pac
  }

  // ---- Tasa de reposicion por sede ----
  // Usa mapaSedes (recursoId -> sedeNombres). Si un recurso pertenece a >1 sede
  // la ausencia se cuenta a cada sede (mejor sobre-representar que perder dato).
  const porSedeMap = new Map()  // sedeNombre → { total, aprobadas }
  for (const a of ausencias) {
    const info = mapaSedes.get(a.resourceId)
    if (!info) continue
    const cubierta = a.makeups?.some((r) => r.status === 'aprobada' || r.completedAt)
    for (const nombre of info.sedeNombres) {
      if (!porSedeMap.has(nombre)) porSedeMap.set(nombre, { name: nombre, total: 0, aprobadas: 0 })
      const b = porSedeMap.get(nombre)
      b.total++
      if (cubierta) b.aprobadas++
    }
  }
  const porSede = [...porSedeMap.values()]
    .map((s) => ({ ...s, pct: s.total > 0 ? Math.round((s.aprobadas / s.total) * 100) : 0 }))
    .sort((a, b) => b.pct - a.pct)

  // ---- SLA de reposicion (dias entre fechaAusencia inicio y fecha_reposicion) ----
  // requestedAt = solicitada, targetDate = fecha propuesta para reponer.
  // Signo:
  //   negativo = reposicion ANTES de la ausencia (adelantada)
  //   0        = mismo dia
  //   positivo = dias despues
  const sla = { adelantada: 0, mismo_dia: 0, uno_a_siete: 0, ocho_a_treinta: 0, mas_30: 0 }
  for (const r of reposiciones) {
    if (!r.absence?.startDate || !r.targetDate) continue
    const dias = Math.round(
      (new Date(r.targetDate).setHours(0,0,0,0) - new Date(r.absence.startDate).setHours(0,0,0,0))
      / (24 * 3600 * 1000)
    )
    if (dias < 0)       sla.adelantada++
    else if (dias === 0) sla.mismo_dia++
    else if (dias <= 7)  sla.uno_a_siete++
    else if (dias <= 30) sla.ocho_a_treinta++
    else                 sla.mas_30++
  }

  // ---- Antelacion del reporte (dias entre createdAt de ausencia y su startDate) ----
  // Positivo = reportada CON antelacion (correcto).
  // 0 o negativo = retroactiva (se reporta el mismo dia o despues del hecho).
  const ant = { retroactivo: 0, uno: 0, dos_a_siete: 0, ocho_a_treinta: 0, mas_30: 0 }
  let conAntelacion = 0
  for (const a of ausencias) {
    const dias = Math.round(
      (new Date(a.startDate).setHours(0,0,0,0) - new Date(a.createdAt).setHours(0,0,0,0))
      / (24 * 3600 * 1000)
    )
    if (dias <= 0)      ant.retroactivo++
    else if (dias === 1) ant.uno++
    else if (dias <= 7)  ant.dos_a_siete++
    else if (dias <= 30) ant.ocho_a_treinta++
    else                 ant.mas_30++
    if (dias >= 1) conAntelacion++
  }
  const pctAntelacionOk = ausencias.length > 0
    ? Math.round((conAntelacion / ausencias.length) * 1000) / 10
    : 0

  // ---- Patron por dia de la semana (Lun-Dom → 1..0 en JS getUTCDay) ----
  const dowMap = new Map()
  for (let i = 0; i <= 6; i++) dowMap.set(i, { dow: i, count: 0, pacientes: 0 })
  for (const a of ausencias) {
    const dow = new Date(a.startDate).getUTCDay()
    const b = dowMap.get(dow)
    b.count++
    b.pacientes += a.patientsAffected ?? 0
  }
  // Reorden L-D (JS: 0=Dom, 1=Lun ... 6=Sab) → salida Lun...Dom
  const porDiaSemana = [1, 2, 3, 4, 5, 6, 0].map((d) => dowMap.get(d))

  // ---- Top subespecialidad (necesita resource.specialty) ----
  // Necesitamos re-query solo el specialty de cada recurso involucrado.
  const recIds = [...new Set(ausencias.map((a) => a.resourceId))]
  const recs = recIds.length ? await prisma.resource.findMany({
    where: { id: { in: recIds } },
    select: { id: true, type: true, specialty: true },
  }) : []
  const specByRid = new Map(recs.map((r) => [r.id, { type: r.type, specialty: r.specialty ?? 'General' }]))
  const subAgg = new Map()  // key = `${type}|${specialty}` → count, pacientes
  for (const a of ausencias) {
    const meta = specByRid.get(a.resourceId)
    if (!meta) continue
    const key = `${meta.type}|${meta.specialty || 'General'}`
    if (!subAgg.has(key)) subAgg.set(key, {
      type: meta.type,
      specialty: meta.specialty || 'General',
      count: 0,
      pacientes: 0,
    })
    const b = subAgg.get(key)
    b.count++
    b.pacientes += a.patientsAffected ?? 0
  }
  const porSubespecialidad = [...subAgg.values()].sort((a, b) => b.pacientes - a.pacientes).slice(0, 15)

  // ---- Medicos involucrados (recursos con al menos 1 ausencia) ----
  const medicosInvolucrados = recIds.length

  return {
    por_sede: porSede,
    sla_reposicion: sla,
    antelacion_reporte: ant,
    pct_antelacion_ok: pctAntelacionOk,
    por_dia_semana: porDiaSemana,
    por_subespecialidad: porSubespecialidad,
    pacientes_cubiertos: pacientesCubiertos,
    pacientes_sin_cobertura: pacientesSinCobertura,
    medicos_involucrados: medicosInvolucrados,
  }
}

// ============================================================================
// Reposiciones (mismo rango de fechas — se cuentan por solicitadoEn)
// ============================================================================
async function calcularReposiciones({ desde, hasta, sedeIdsFiltro, mapaSedes, meses }) {
  const reps = await prisma.absenceMakeup.findMany({
    where: {
      requestedAt: { gte: desde, lte: fechaFinDelDia(hasta) },
    },
    include: {
      // Sep-2026: se agrega startDate para calcular SLA de reposicion (dias
      // entre fecha de la ausencia y fecha propuesta para reponerla).
      absence: { select: { resourceId: true, startDate: true, resource: { select: { name: true, type: true } } } },
    },
  })

  // Filtro por sede (via mapaSedes ya calculado)
  const filtered = sedeIdsFiltro
    ? reps.filter((r) => {
        const info = mapaSedes?.get(r.absence?.resourceId)
        if (!info) return false
        return sedeIdsFiltro.some((sid) => info.sedeIds.has(sid))
      })
    : reps

  let solicitadas = 0, aprobadas = 0, rechazadas = 0, realizadas = 0
  let tiempoAprobacionMs = 0
  let tiempoAprobacionN = 0

  const porMesMap = new Map(meses.map((m) => [m, { mes: m, solicitadas: 0, aprobadas: 0 }]))
  const topRec = new Map()

  for (const r of filtered) {
    solicitadas++  // Todos cuentan como solicitadas (histórico)
    if (r.status === 'aprobada') aprobadas++
    if (r.status === 'rechazada') rechazadas++
    if (r.completedAt) realizadas++
    if (r.approvedAt && r.requestedAt) {
      tiempoAprobacionMs += new Date(r.approvedAt) - new Date(r.requestedAt)
      tiempoAprobacionN++
    }
    const mes = mesLocal(r.requestedAt)
    if (porMesMap.has(mes)) {
      porMesMap.get(mes).solicitadas++
      if (r.status === 'aprobada' || r.status === 'realizada') porMesMap.get(mes).aprobadas++
    }
    const rid = r.absence?.resourceId
    if (rid) {
      if (!topRec.has(rid)) {
        topRec.set(rid, {
          resource_id: rid,
          name: r.absence?.resource?.name ?? '—',
          type: r.absence?.resource?.type ?? null,
          count: 0,
        })
      }
      topRec.get(rid).count++
    }
  }

  const tiempoMedioH = tiempoAprobacionN > 0
    ? Math.round((tiempoAprobacionMs / tiempoAprobacionN) / (3600 * 1000) * 10) / 10
    : null

  return {
    solicitadas,
    aprobadas,
    rechazadas,
    realizadas,
    pct_aprobacion: solicitadas > 0 ? Math.round((aprobadas / solicitadas) * 100) : 0,
    tiempo_medio_aprobacion_h: tiempoMedioH,
    por_mes: [...porMesMap.values()],
    top_medicos: [...topRec.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    // Se expone el array raw para que calcularDatosFOCA calcule SLA sin re-query.
    // Se elimina antes de devolver la respuesta al cliente.
    _raw: filtered,
  }
}

// ============================================================================
// Helpers de fechas
// ============================================================================
/**
 * Días HÁBILES que cubre una ausencia: excluye domingos y festivos.
 *
 * Sep-2026 · antes contaba días calendario, así que este tablero reportaba para
 * la misma ausencia una cifra de "días" distinta de la de Ausentismo e impacto.
 * Los sábados SÍ cuentan: la operación es de lunes a sábado.
 *
 * `festivosSet` lo carga la función principal una sola vez para todo el rango.
 * Sin él (Set vacío) solo se descuentan los domingos.
 */
function diasEntreInclusive(a, b, festivosSet = new Set()) {
  const cursor = new Date(a)
  const fin = new Date(b ?? a)
  if (fin < cursor) return 0
  let dias = 0
  while (cursor <= fin) {
    if (!esDomingoOFestivo(cursor, festivosSet)) dias++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dias
}

function fechaFinDelDia(d) {
  const f = new Date(d)
  f.setHours(23, 59, 59, 999)
  return f
}

function mesesEnRango(desde, hasta) {
  // Nota: desde/hasta ya son fechas LOCALES (via parseFechaLocal). Antes
  // recibíamos `new Date('YYYY-MM-DD')` que parsea UTC — en Bogotá (UTC-5)
  // eso corría al mes anterior si el día 1 es el desde (verify Fase 4 flag
  // "mes fantasma" al inicio del gráfico).
  const out = []
  const cur = new Date(desde.getFullYear(), desde.getMonth(), 1)
  const end = new Date(hasta.getFullYear(), hasta.getMonth(), 1)
  while (cur <= end) {
    const y = cur.getFullYear()
    const m = String(cur.getMonth() + 1).padStart(2, '0')
    out.push(`${y}-${m}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  return out
}

// Devuelve YYYY-MM del mes LOCAL de la fecha dada (evita corrimiento UTC).
function mesLocal(d) {
  const dt = new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// ============================================================================
// Handler HTTP
// ============================================================================
export async function reprogramacionesDashboard(req, res) {
  try {
    const data = await withCache(
      keyDeQuery('reprog-dashboard', req.query),
      TTL_REPROG,
      () => dataReprogramacionesDashboard(req.query),
    )
    res.json(data)
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ message: e.message })
    throw e
  }
}
