import { format } from 'date-fns'
import { cargarFestivosDelRango, esDomingoOFestivo } from '../lib/calendario.js'
import { TIPOS_QUE_IMPACTAN_PACIENTES, TIPOS_QUE_LIBERAN_AUXILIAR } from '../lib/resourceTypes.js'

/**
 * Lógica de cálculo de impacto de ausencias y liberación de auxiliares.
 * Extraído del controller para mantener `confirmar()` delgado y permitir reuso/tests.
 *
 * Reglas implementadas:
 *  - RN-18: impacto día a día (pacientes y costo de oportunidad)
 *  - RN-19: factor parcial cuando la ausencia es de horas y no del día completo
 *  - RN-24: liberación automática de auxiliar cuando falta quien la tiene asignada
 *    (oftalmólogo, anestesiólogo, otorrino — ver TIPOS_QUE_LIBERAN_AUXILIAR)
 */

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
// Oct-2026 · La lista se mudo a lib/resourceTypes.js y hoy incluye otorrino.

// Oct-2026 · La lista se mudo a lib/resourceTypes.js, que no tiene
// dependencias y por eso se puede probar sin BD. Se re-exporta porque varios
// controladores la importan desde aqui.
export { TIPOS_QUE_IMPACTAN_PACIENTES } from '../lib/resourceTypes.js'

const hhmmAMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * RN-19: factor parcial. Si la ausencia es de día completo → 1.
 * Si es parcial con horas, se prorratea contra una jornada estándar de 10h (600 min).
 * El min(1, ...) protege contra horas malformadas que excedan el día.
 */
export function calcularFactorParcial(ausencia) {
  if (!ausencia.isPartial || !ausencia.absenceStartTime || !ausencia.absenceEndTime) {
    return 1
  }
  const minAus = hhmmAMin(ausencia.absenceEndTime) - hhmmAMin(ausencia.absenceStartTime)
  if (minAus <= 0) return 0
  return Math.min(1, minAus / 600)
}

/**
 * Genera el listado de días que cubre la ausencia.
 * Retorna [{ fecha: 'YYYY-MM-DD', dia: 'lunes' }, ...].
 */
export function diasDeAusencia(ausencia) {
  const fechas = []
  const cursor = new Date(ausencia.startDate)
  while (cursor <= ausencia.endDate) {
    fechas.push({ date: format(cursor, 'yyyy-MM-dd'), day: DIAS[cursor.getDay()] })
    cursor.setDate(cursor.getDate() + 1)
  }
  return fechas
}

/**
 * Construye un resolver de costo por especialidad: dada una lista de parámetros
 * ordenados por `vigenteDesde DESC`, devuelve una función que retorna el costo
 * vigente al inicio de la ausencia para cada especialidad.
 */
export function buildCostoResolver(parametros, fechaRef) {
  return (especialidad) => {
    const aplicables = parametros.filter(
      (p) => p.visitType === especialidad && p.effectiveFrom <= fechaRef,
    )
    return Number(aplicables[0]?.visitCost ?? 0)
  }
}

/**
 * Resuelve el factor de impacto del motivo. Si la ausencia tiene motivoId
 * vinculado al catálogo editable, se usa motivoRef.factorImpacto. Si no
 * (legacy o motivo huérfano), se usa 1.0 (backward compatible — comportamiento
 * idéntico al sistema antes del catálogo).
 *
 * Acepta la ausencia ya hidratada con motivoRef o un id suelto para resolver.
 */
export async function resolverFactorMotivo(tx, ausencia) {
  if (ausencia.reasonRef?.impactFactor != null) {
    return Number(ausencia.reasonRef.impactFactor)
  }
  if (ausencia.reasonId) {
    const m = await tx.absenceReason.findUnique({ where: { id: ausencia.reasonId } })
    if (m?.impactFactor != null) return Number(m.impactFactor)
  }
  return 1
}

/**
 * RN-18: calcula el impacto total de una ausencia. Itera día a día, suma
 * pacientes y costo de oportunidad, y deja el breakdown en `impactoPorDia`.
 *
 * Aplica DOS atenuadores multiplicativos:
 *   - factorParcial (RN-19): si es ausencia por horas, prorratea contra 10h
 *   - factorMotivo: del catálogo editable. Default 1.0 si la ausencia no
 *     tiene motivoId (ausencias previas al catálogo siguen midiéndose 100%).
 *
 * Requiere `tx` para correr dentro de la misma transacción del caller.
 */
export async function calcularImpacto(tx, ausencia) {
  const fechas = diasDeAusencia(ausencia)
  const factorParcial = calcularFactorParcial(ausencia)
  const factorMotivo = await resolverFactorMotivo(tx, ausencia)
  const factor = factorParcial * factorMotivo

  const parametros = await tx.costSetting.findMany({
    orderBy: { effectiveFrom: 'desc' },
  })
  const costoVigente = buildCostoResolver(parametros, ausencia.startDate)

  // Sep-2026 · solo los tipos con agenda propia generan impacto en pacientes.
  // Para los demás la ausencia se registra igual, pero en cero.
  const impactaPacientes = TIPOS_QUE_IMPACTAN_PACIENTES.has(ausencia.resource?.type)

  // Sep-2026 · domingos y festivos no cuentan: la sede no atiende, así que no
  // hay agenda que perder. Los sábados SÍ (la operación es lunes a sábado).
  const festivos = await cargarFestivosDelRango(ausencia.startDate, ausencia.endDate, tx)

  // Sep-2026 · las semanas que cruza la ausencia, para acotar cada día a la
  // suya. Antes se buscaba por `dia_semana` sin filtrar semana, así que una
  // ausencia de un lunes sumaba los pacientes de TODOS los lunes cargados en la
  // base — el número se multiplicaba por la cantidad de semanas existentes y
  // crecía solo con el tiempo. Una ausencia de 18 días ahora suma los turnos de
  // la primera semana, luego los de la segunda, y así: cada día contra la suya.
  const semanas = await tx.week.findMany({
    where: { startDate: { lte: ausencia.endDate }, endDate: { gte: ausencia.startDate } },
    select: { id: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' },
  })
  const semanaDe = (fechaIso) => {
    const d = new Date(`${fechaIso}T00:00:00.000Z`)
    return semanas.find((s) => d >= s.startDate && d <= s.endDate) ?? null
  }

  let pacImpactados = 0
  let costoOportunidad = 0
  let diasHabiles = 0
  const impactoPorDia = []

  for (const { date: fecha, day: dia } of fechas) {
    if (esDomingoOFestivo(fecha, festivos)) continue
    diasHabiles++

    const semana = impactaPacientes ? semanaDe(fecha) : null

    // El recurso ausente puede aparecer como titular O como auxiliar
    // (RN-18: cuenta TODAS sus asignaciones del día, no solo las titulares).
    const asigsDia = semana
      ? await tx.assignment.findMany({
          where: {
            weekId: semana.id,
            OR: [{ resourceId: ausencia.resourceId }, { assistantId: ausencia.resourceId }],
            weekday: dia,
            status: { not: 'cancelada' },
          },
          include: { room: true },
        })
      : []

    let pacDia = 0
    let costoDia = 0
    for (const a of asigsDia) {
      const p = Math.round((a.patientCapacity ?? 0) * factor)
      pacDia += p
      costoDia += Math.round(p * costoVigente(a.room.specialty))
    }
    pacImpactados += pacDia
    costoOportunidad += costoDia
    impactoPorDia.push({ date: fecha, day: dia, pacientes: pacDia, cost: costoDia, parcial: ausencia.isPartial, factorMotivo })
  }

  // Quejas estimadas (nueva RN ago-2026):
  //   Si anticipacionDias > 30 → 9% de pacientes impactados
  //   Si anticipacionDias ≤ 30 → 8% de pacientes impactados
  // Redondeo estándar (Math.round). La agenda "madura" (>30 días agendada de
  // antemano) genera más quejas porque más pacientes tienen mayor expectativa;
  // la anticipación se mide contra la fecha de reporte de la ausencia.
  const pctQuejas = (ausencia.noticeDays ?? 0) > 30 ? 0.09 : 0.08
  const quejasEstimadas = Math.round(pacImpactados * pctQuejas)

  // `diasHabiles` excluye domingos y festivos: es el dato que deben mostrar los
  // informes, no los días calendario del rango.
  return {
    fechas,
    diasHabiles,
    pacImpactados,
    opportunityCost: costoOportunidad,
    dailyImpact: impactoPorDia,
    factorMotivo,
    quejasEstimadas,
    impactaPacientes,
  }
}

/**
 * RN-24: si el ausente es oftalmólogo o anestesiólogo, las asignaciones que
 * tenían auxiliar pasan a estado 'sin_cobertura' — la auxiliar queda "liberada"
 * para que el coordinador la reasigne.
 *
 * No-op para otros tipos de recurso.
 */
export async function liberarAuxiliaresSiAplica(tx, ausencia, fechas) {
  if (!TIPOS_QUE_LIBERAN_AUXILIAR.has(ausencia.resource.type)) {
    return { liberadas: 0 }
  }

  const asignacionesConAux = await tx.assignment.findMany({
    where: {
      resourceId: ausencia.resourceId,
      assistantId: { not: null },
      weekday: { in: fechas.map((f) => f.day) },
      status: 'activa',
    },
  })

  for (const a of asignacionesConAux) {
    await tx.assignment.update({
      where: { id: a.id },
      data: { status: 'sin_cobertura' },
    })
  }

  return { liberadas: asignacionesConAux.length }
}
