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

  // ==== 3. KPIs generales ====
  let diasPerdidos = 0
  let pacientesImpactados = 0
  let costoOportunidad = 0
  let programadas = 0
  let imprevistas = 0
  let conReposicionAprobada = 0

  for (const a of ausF) {
    const dias = diasEntreInclusive(a.startDate, a.endDate)
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
    b.dias += diasEntreInclusive(a.startDate, a.endDate)
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
    b.dias += diasEntreInclusive(a.startDate, a.endDate)
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
    b.dias += diasEntreInclusive(a.startDate, a.endDate)
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

    if (!espAgg.has(tipo)) espAgg.set(tipo, { type: tipo, count: 0, dias: 0 })
    const eb = espAgg.get(tipo)
    eb.count++
    eb.dias += diasEntreInclusive(a.startDate, a.endDate)

    const ck = `${fam}|${tipo}`
    if (!cruceAgg.has(ck)) cruceAgg.set(ck, { family: fam, type: tipo, count: 0 })
    cruceAgg.get(ck).count++
  }
  const porEspecialidad = [...espAgg.values()].sort((a, b) => b.count - a.count)
  const cruceFamiliaEspecialidad = [...cruceAgg.values()]

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
    makeups: reposicionesData,
    por_especialidad: porEspecialidad,
    cruce_familia_especialidad: cruceFamiliaEspecialidad,
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
      absence: { select: { resourceId: true, resource: { select: { name: true, type: true } } } },
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
  }
}

// ============================================================================
// Helpers de fechas
// ============================================================================
function diasEntreInclusive(a, b) {
  const start = new Date(a)
  const end   = new Date(b ?? a)
  const ms = end.setHours(0,0,0,0) - start.setHours(0,0,0,0)
  return Math.max(1, Math.round(ms / (24 * 3600 * 1000)) + 1)
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
