import { prisma } from '../lib/prisma.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { generarPDF, generarExcel } from '../services/exportService.js'
import { errors } from '../lib/errors.js'
import { getSemanaActual, getSemanaAnterior } from '../lib/semana.js'
import { withCache, keyDeQuery } from '../lib/cache.js'

// TTL de caché para lecturas analíticas. Suficientemente corto para que los datos
// se sientan "en vivo" y suficientemente largo para absorber picos de concurrencia.
const TTL_INFORME = 30_000
const TTL_DASHBOARD = 20_000

const hhmmAMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const horasDeFranja = (hi, hf) => (hhmmAMinutos(hf) - hhmmAMinutos(hi)) / 60

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

/**
 * Mapa recursoId → { sedeIds:Set, sedeNombres:Set } a partir de TODAS las
 * asignaciones no canceladas (el recurso puede aparecer como titular o auxiliar).
 * Sirve para los informes centrados en el recurso (ausentismo, subutilización,
 * impacto), donde la sede no es un atributo directo del recurso sino algo que se
 * infiere de dónde tiene asignaciones.
 */
async function mapaSedesPorRecurso() {
  const asigs = await prisma.asignacion.findMany({
    where: { estado: { not: 'cancelada' } },
    select: {
      recursoId: true,
      auxiliarId: true,
      consultorio: { select: { sedeId: true, sede: { select: { nombre: true } } } },
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
    add(a.recursoId, a.consultorio.sedeId, a.consultorio.sede.nombre)
    add(a.auxiliarId, a.consultorio.sedeId, a.consultorio.sede.nombre)
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
export async function dataOcupacion({ sede_id, tipo_recurso, semana_id } = {}) {
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

  const where = { estado: { not: 'cancelada' } }
  if (semanaId) where.semanaId = semanaId
  if (sedeIds) where.consultorio = { sedeId: { in: sedeIds } }
  if (tipos) where.recurso = { tipo: { in: tipos } }

  const asignaciones = await prisma.asignacion.findMany({
    where,
    include: { consultorio: { include: { sede: true } }, recurso: true },
  })

  const porCons = new Map()
  for (const a of asignaciones) {
    const k = a.consultorio.id
    if (!porCons.has(k)) {
      porCons.set(k, {
        consultorio: a.consultorio.nombre,
        sede: a.consultorio.sede.nombre,
        especialidad: a.consultorio.especialidad,
        h_asignadas: 0,
        h_base: BASE_MINUTOS_SEMANA / 60,
      })
    }
    porCons.get(k).h_asignadas += horasDeFranja(a.horaInicio, a.horaFin)
  }

  return Array.from(porCons.values()).map((f) => ({
    ...f,
    h_asignadas: Math.round(f.h_asignadas * 10) / 10,
    pct_ocupacion: Math.round((f.h_asignadas / f.h_base) * 100),
  }))
}

export async function dataProductividad({ sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { estado: { not: 'cancelada' } }
  if (sedeIds) where.consultorio = { sedeId: { in: sedeIds } }
  if (tipos) where.recurso = { tipo: { in: tipos } }

  const asigs = await prisma.asignacion.findMany({
    where,
    include: { recurso: true, ejecucion: true, consultorio: { include: { sede: true } } },
  })

  const porRecurso = new Map()
  for (const a of asigs) {
    const k = a.recursoId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        recurso: a.recurso.nombre,
        tipo: a.recurso.tipo,
        sede: a.consultorio.sede.nombre,
        h_prog: 0, h_ejec: 0, pac_prog: 0, pac_at: 0,
      })
    }
    const r = porRecurso.get(k)
    const h = horasDeFranja(a.horaInicio, a.horaFin)
    r.h_prog += h
    r.pac_prog += a.pacientesCapacidad ?? 0
    if (a.ejecucion) {
      r.h_ejec += h
      r.pac_at += a.ejecucion.pacientesAtendidos
    }
  }

  return Array.from(porRecurso.values()).map((r) => ({
    ...r,
    h_prog: Math.round(r.h_prog * 10) / 10,
    h_ejec: Math.round(r.h_ejec * 10) / 10,
    pct_cumplimiento: r.pac_prog > 0 ? Math.round((r.pac_at / r.pac_prog) * 100) : 0,
  }))
}

export async function dataAusentismo({ desde, hasta, sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { estado: 'confirmada' }
  if (desde) where.fechaInicio = { gte: new Date(desde) }
  if (hasta) where.fechaInicio = { ...(where.fechaInicio ?? {}), lte: new Date(hasta) }
  if (tipos) where.recurso = { tipo: { in: tipos } }

  const ausencias = await prisma.ausencia.findMany({ where, include: { recurso: true } })
  const mapaSedes = await mapaSedesPorRecurso()

  const porRecurso = new Map()
  for (const a of ausencias) {
    const info = mapaSedes.get(a.recursoId)
    if (!recursoEnSedes(info, sedeIds)) continue
    const k = a.recursoId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        recurso: a.recurso.nombre, tipo: a.recurso.tipo, sede: nombreSedes(info),
        ausencias: 0, dias: 0, pac_afectados: 0, costo: 0, quejas: 0,
      })
    }
    const r = porRecurso.get(k)
    r.ausencias++
    r.dias += Math.round((a.fechaFin - a.fechaInicio) / (1000 * 60 * 60 * 24)) + 1
    r.pac_afectados += a.pacientesImpactados ?? 0
    r.costo += Number(a.costoOportunidad ?? 0)
    r.quejas += a.quejasRegistradas ?? 0
  }

  return Array.from(porRecurso.values()).sort((a, b) => b.ausencias - a.ausencias)
}

export async function dataSubutilizacion({ sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Utilización SEMANAL contra la semana actual (la que contiene hoy)
  const semanaActual = await getSemanaActual()

  const whereRec = { activo: true, esquemaPago: { in: ['fijo', 'mixto'] } }
  if (tipos) whereRec.tipo = { in: tipos }
  const recursos = await prisma.recurso.findMany({ where: whereRec })

  const asigs = semanaActual
    ? await prisma.asignacion.findMany({
        where: { semanaId: semanaActual.id, estado: { not: 'cancelada' } },
      })
    : []
  const mapaSedes = await mapaSedesPorRecurso()

  return recursos
    .filter((r) => recursoEnSedes(mapaSedes.get(r.id), sedeIds))
    .map((r) => {
      const propias = asigs.filter((a) => a.recursoId === r.id || a.auxiliarId === r.id)
      const horas = propias.reduce((acc, a) => acc + horasDeFranja(a.horaInicio, a.horaFin), 0)
      const pct = r.horasMaxSemana > 0 ? Math.round((horas / r.horasMaxSemana) * 100) : 0
      return {
        recurso: r.nombre, tipo: r.tipo, sede: nombreSedes(mapaSedes.get(r.id)),
        h_asignadas: Math.round(horas * 10) / 10,
        h_disponibles: r.horasMaxSemana,
        pct_utilizacion: pct,
        sem_consec: 0,
      }
    }).sort((a, b) => a.pct_utilizacion - b.pct_utilizacion)
}

export async function dataImpacto({ sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { estado: 'confirmada' }
  if (tipos) where.recurso = { tipo: { in: tipos } }

  const ausencias = await prisma.ausencia.findMany({
    where,
    include: { recurso: true },
    orderBy: { fechaInicio: 'desc' },
  })
  // El filtro por sede usa el mapa (la ausencia no tiene sede directa)
  const mapaSedes = sedeIds ? await mapaSedesPorRecurso() : null

  // El orden de las claves importa: InformePage mapea las columnas por posición
  // (recurso, fecha, tipo, pac_afectados, costo_oport, costo_personal, costo_reprog, total)
  return ausencias
    .filter((a) => !sedeIds || recursoEnSedes(mapaSedes.get(a.recursoId), sedeIds))
    .map((a) => {
    const oport = Number(a.costoOportunidad ?? 0)
    const personal = Number(a.costoPersonalInactivo ?? 0)
    // El desglose de reprogramación no se guarda en la ausencia — se estima como
    // el costo operativo de reprogramar los pacientes impactados.
    const reprog = 0
    return {
      recurso: a.recurso.nombre,
      fecha: a.fechaInicio.toISOString().slice(0, 10),
      tipo: a.tipo,
      pac_afectados: a.pacientesImpactados ?? 0,
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
export async function dataAusentismoImpacto({ desde, hasta, sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  const where = { estado: 'confirmada' }
  if (desde) where.fechaInicio = { gte: new Date(desde) }
  if (hasta) where.fechaInicio = { ...(where.fechaInicio ?? {}), lte: new Date(hasta) }
  if (tipos) where.recurso = { tipo: { in: tipos } }

  const ausencias = await prisma.ausencia.findMany({ where, include: { recurso: true } })
  const mapaSedes = await mapaSedesPorRecurso()

  const porRecurso = new Map()
  for (const a of ausencias) {
    const info = mapaSedes.get(a.recursoId)
    if (!recursoEnSedes(info, sedeIds)) continue
    const k = a.recursoId
    if (!porRecurso.has(k)) {
      porRecurso.set(k, {
        recurso: a.recurso.nombre, tipo: a.recurso.tipo, sede: nombreSedes(info),
        ausencias: 0, dias: 0, pac_afectados: 0, costo_oportunidad: 0, costo_personal: 0, total: 0,
      })
    }
    const r = porRecurso.get(k)
    r.ausencias++
    r.dias += Math.round((a.fechaFin - a.fechaInicio) / (1000 * 60 * 60 * 24)) + 1
    r.pac_afectados += a.pacientesImpactados ?? 0
    const oport = Number(a.costoOportunidad ?? 0)
    const personal = Number(a.costoPersonalInactivo ?? 0)
    r.costo_oportunidad += oport
    r.costo_personal += personal
    r.total += oport + personal
  }

  return Array.from(porRecurso.values()).sort((a, b) => b.total - a.total)
}

export async function dataHorasProgEjec({ sede_id, tipo_recurso } = {}) {
  const sedeIds = aLista(sede_id)
  const tipos = aLista(tipo_recurso)

  // Filtro opcional de las asignaciones por sede y/o tipo de recurso titular
  const whereAsig = {}
  if (sedeIds) whereAsig.consultorio = { sedeId: { in: sedeIds } }
  if (tipos) whereAsig.recurso = { tipo: { in: tipos } }

  // Solo semanas ya iniciadas — una semana futura no tiene ejecución y arruina la gráfica
  const semanas = await prisma.semana.findMany({
    where: { fechaInicio: { lte: new Date() } },
    take: 8,
    orderBy: { fechaInicio: 'desc' },
    include: {
      asignaciones: {
        where: whereAsig,
        include: { ejecucion: true, consultorio: { include: { sede: true } } },
      },
    },
  })
  const filas = []
  for (const s of semanas) {
    const porSede = new Map()
    for (const a of s.asignaciones) {
      const key = a.consultorio.sede.nombre
      if (!porSede.has(key)) porSede.set(key, { h_programadas: 0, h_ejecutadas: 0 })
      const h = horasDeFranja(a.horaInicio, a.horaFin)
      porSede.get(key).h_programadas += h
      if (a.ejecucion) porSede.get(key).h_ejecutadas += h
    }
    for (const [sede, vals] of porSede.entries()) {
      filas.push({
        sede,
        semana: s.fechaInicio.toISOString().slice(0, 10),
        h_programadas: Math.round(vals.h_programadas * 10) / 10,
        h_ejecutadas: Math.round(vals.h_ejecutadas * 10) / 10,
        diferencia: Math.round((vals.h_ejecutadas - vals.h_programadas) * 10) / 10,
        pct_cumplimiento: vals.h_programadas > 0 ? Math.round((vals.h_ejecutadas / vals.h_programadas) * 100) : 0,
      })
    }
  }
  return filas
}

// Registro central — usado por exportar()
const GENERADORES = {
  ocupacion: dataOcupacion,
  productividad: dataProductividad,
  ausentismo: dataAusentismo,
  subutilizacion: dataSubutilizacion,
  impacto: dataImpacto,
  'ausentismo-impacto': dataAusentismoImpacto,
  'horas-prog-ejec': dataHorasProgEjec,
}

// ============================================================
// ENDPOINTS GET (handlers delgados)
// ============================================================

// Cada informe se cachea por su combinación de filtros (sede/tipo/fechas) durante
// TTL_INFORME. Si 100 usuarios abren el mismo informe, se calcula una sola vez.
export const ocupacion = async (req, res) =>
  res.json(await withCache(keyDeQuery('inf:ocupacion', req.query), TTL_INFORME, () => dataOcupacion(req.query)))
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

/**
 * Resuelve la sede principal del recurso ausente mirando sus asignaciones
 * en la semana de la ausencia.
 */
async function sedeDelRecursoEnAusencia(ausencia) {
  const asig = await prisma.asignacion.findFirst({
    where: {
      OR: [{ recursoId: ausencia.recursoId }, { auxiliarId: ausencia.recursoId }],
      estado: { not: 'cancelada' },
    },
    include: { consultorio: { include: { sede: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return asig?.consultorio?.sede?.nombre ?? '—'
}

/** Suma pacientes_capacidad de una semana (programado). */
async function pacientesDeSemana(semanaId) {
  if (!semanaId) return 0
  const asigs = await prisma.asignacion.findMany({
    where: { semanaId, estado: { not: 'cancelada' } },
    select: { pacientesCapacidad: true },
  })
  return asigs.reduce((acc, a) => acc + (a.pacientesCapacidad ?? 0), 0)
}

/** Suma pacientes impactados por ausencias confirmadas activas en el rango de una semana. */
async function impactadosDeSemana(semana) {
  if (!semana) return 0
  const ausencias = await prisma.ausencia.findMany({
    where: {
      estado: 'confirmada',
      fechaInicio: { lte: semana.fechaFin },
      fechaFin: { gte: semana.fechaInicio },
    },
    select: { pacientesImpactados: true },
  })
  return ausencias.reduce((acc, a) => acc + (a.pacientesImpactados ?? 0), 0)
}

/**
 * GET /informes/dashboard — KPIs del dashboard ejecutivo (HU-D-01).
 * Shape alineado con DASH_DIRECTIVO del frontend. Datos reales de la BD.
 */
async function computeDashboard() {
  // "Semana actual" = la que contiene hoy. NO la futura recién creada (RN).
  const semanaActual = await getSemanaActual()
  const semanaAnterior = await getSemanaAnterior()

  // Pacientes programados de la semana actual + delta vs anterior
  const pacientesProgramados = await pacientesDeSemana(semanaActual?.id)
  const pacientesAnterior = await pacientesDeSemana(semanaAnterior?.id)
  const deltaPacientes = pacientesAnterior > 0
    ? Math.round(((pacientesProgramados - pacientesAnterior) / pacientesAnterior) * 1000) / 10
    : 0

  // Impactados por ausencias de la semana actual + delta
  const impactadosActual = await impactadosDeSemana(semanaActual)
  const impactadosAnterior = await impactadosDeSemana(semanaAnterior)
  const deltaImpactados = impactadosActual - impactadosAnterior

  // Ausencias confirmadas activas (las de la semana actual o futuras)
  const hoy = new Date()
  const ausencias = await prisma.ausencia.findMany({
    where: { estado: 'confirmada', fechaFin: { gte: hoy } },
    include: { recurso: true },
    orderBy: { fechaInicio: 'desc' },
  })
  const costoTotalAusentismo = ausencias.reduce((acc, a) => acc + Number(a.costoOportunidad ?? 0), 0)

  // Ocupación por sede
  const ocupacionFilas = await dataOcupacion()
  const porSede = new Map()
  for (const f of ocupacionFilas) {
    if (!porSede.has(f.sede)) porSede.set(f.sede, { asignadas: 0, base: 0 })
    porSede.get(f.sede).asignadas += f.h_asignadas
    porSede.get(f.sede).base += f.h_base
  }
  const sedesOcupacion = [...porSede.entries()].map(([nombre, v]) => ({
    nombre,
    pct: v.base > 0 ? Math.round((v.asignadas / v.base) * 100) : 0,
  })).sort((a, b) => b.pct - a.pct)
  const ocupacionGlobal = sedesOcupacion.length > 0
    ? Math.round(sedesOcupacion.reduce((acc, s) => acc + s.pct, 0) / sedesOcupacion.length)
    : 0

  // Recursos ociosos (salario fijo con <60% utilización)
  const subutil = await dataSubutilizacion()
  const recursosOciosos = subutil.filter((r) => r.pct_utilizacion < 60).length

  // Top 5 ausencias activas con su sede resuelta
  const ausenciasTop = await Promise.all(
    ausencias.slice(0, 5).map(async (a) => ({
      nombre: a.recurso.nombre,
      sede: await sedeDelRecursoEnAusencia(a),
      pacientes: a.pacientesImpactados ?? 0,
      costo: Number(a.costoOportunidad ?? 0),
    }))
  )

  return {
    pacientes_programados: pacientesProgramados,
    delta_pacientes: deltaPacientes,
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

/** GET /informes/dashboard — KPIs ejecutivos (HU-D-01). Cacheado TTL_DASHBOARD. */
export async function dashboard(req, res) {
  res.json(await withCache('dashboard', TTL_DASHBOARD, computeDashboard))
}

/**
 * Calcula las métricas agregadas de una semana específica (real, desde BD).
 * Devuelve null si la semana no existe.
 */
async function metricasDeSemana(semana) {
  if (!semana) return null

  const asigs = await prisma.asignacion.findMany({
    where: { semanaId: semana.id, estado: { not: 'cancelada' } },
    include: { ejecucion: true, consultorio: true },
  })

  const pacientes = asigs.reduce((acc, a) => acc + (a.pacientesCapacidad ?? 0), 0)
  const horasProgMin = asigs.reduce(
    (acc, a) => acc + (hhmmAMinutos(a.horaFin) - hhmmAMinutos(a.horaInicio)),
    0
  )
  const horasEjecMin = asigs.reduce(
    (acc, a) => acc + (a.ejecucion ? (hhmmAMinutos(a.horaFin) - hhmmAMinutos(a.horaInicio)) : 0),
    0
  )

  const consultoriosUnicos = new Set(asigs.map((a) => a.consultorioId)).size
  const consultoriosBase = await prisma.consultorio.count({ where: { activo: true } })
  const baseTotal = consultoriosBase * BASE_MINUTOS_SEMANA
  const ocupacion = baseTotal > 0 ? Math.round((horasProgMin / baseTotal) * 100) : 0

  const ausencias = await prisma.ausencia.count({
    where: {
      estado: 'confirmada',
      fechaInicio: { lte: semana.fechaFin },
      fechaFin: { gte: semana.fechaInicio },
    },
  })
  const costoAusentismo = await prisma.ausencia.aggregate({
    _sum: { costoOportunidad: true },
    where: {
      estado: 'confirmada',
      fechaInicio: { lte: semana.fechaFin },
      fechaFin: { gte: semana.fechaInicio },
    },
  })

  return {
    pacientes,
    horas_ejec: Math.round((horasEjecMin / 60) * 10) / 10,
    ocupacion,
    ausencias,
    costo_ausentismo: Number(costoAusentismo._sum.costoOportunidad ?? 0),
  }
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
  const ultimas = await prisma.semana.findMany({
    where: { fechaInicio: { lte: new Date() } },
    orderBy: { fechaInicio: 'desc' },
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
    semanaB = await prisma.semana.findUnique({ where: { id: semanaBSpec } }).catch(() => null)
  }
  if (!semanaB) semanaB = ultimas[1] ?? null

  const fmtLabel = (s) =>
    s ? `${s.fechaInicio.toISOString().slice(5, 10)} – ${s.fechaFin.toISOString().slice(5, 10)}` : '—'

  const [metA, metB] = await Promise.all([
    metricasDeSemana(semanaA),
    metricasDeSemana(semanaB),
  ])

  // Serie cronológica de las últimas 12 (la más antigua primero, para gráficas)
  const ultimasCronologico = [...ultimas.slice(0, 12)].reverse()
  const ultimas12 = await Promise.all(
    ultimasCronologico.map(async (s) => {
      const m = await metricasDeSemana(s)
      return {
        semana: s.fechaInicio.toISOString().slice(5, 10),
        pacientes: m?.pacientes ?? 0,
        ocupacion: m?.ocupacion ?? 0,
        ausencias: m?.ausencias ?? 0,
      }
    })
  )

  return {
    semana_a: semanaA
      ? { label: fmtLabel(semanaA), ...(metA ?? { pacientes: 0, horas_ejec: 0, ocupacion: 0, ausencias: 0, costo_ausentismo: 0 }) }
      : null,
    semana_b: semanaB
      ? { label: fmtLabel(semanaB), ...(metB ?? { pacientes: 0, horas_ejec: 0, ocupacion: 0, ausencias: 0, costo_ausentismo: 0 }) }
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
  const { tipo } = req.params
  const formato = (req.query.formato ?? 'pdf').toLowerCase()
  const generador = GENERADORES[tipo]
  if (!generador) {
    throw errors.badRequest(`Informe no exportable: ${tipo}. Disponibles: ${Object.keys(GENERADORES).join(', ')}`)
  }

  const filas = await generador(req.query)

  // RN-34: trazabilidad de exportación
  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'exportar_informe',
    entidad: 'informes',
    entidadId: tipo,
    valorNuevo: { formato, filtros: req.query, registros: filas.length },
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
