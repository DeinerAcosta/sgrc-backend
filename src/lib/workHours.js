/**
 * Utilidades de cálculo de horas para todo el sistema.
 *
 * Distinción crítica entre los dos conceptos:
 *
 *   - HORAS BRUTAS    (horasDeFranja): horaFin - horaInicio. Mide presencia
 *     o reserva de un consultorio físico. Útil para validar duración mínima,
 *     bloqueos de consultorio, RN-08 tope diario.
 *
 *   - HORAS EFECTIVAS (horasEfectivasFranja): brutas - almuerzo. Mide tiempo
 *     productivo del recurso. Es lo que se compara contra el tope semanal
 *     legal (Ley 2101) y contra horasMaxSemana del contrato individual.
 *
 * RN-11 (jul-2026 v4 — definitiva por gerencia):
 *
 * REGLA GENERAL: todo turno de ≥ 6h descuenta almuerzo (política laboral —
 * nadie puede quitarse el almuerzo).
 *   · Rotativos (oftalmo, anestesio, optómetra, fono, otorrino): 30 min
 *   · Resto: 60 min
 *
 * EXCEPCIÓN — TÉCNICOS de ayudas diagnósticas: sus turnos "partidos" del
 * área NO descuentan almuerzo. Los técnicos rotan turnos de 6h corridos:
 *   · 07:00–13:00 (matutino corrido)  → 0 min (no descuenta)
 *   · 13:00–19:00 (vespertino corrido) → 0 min (no descuenta)
 * Cualquier OTRO turno de técnico (ej. 08:00–17:00, 07:00–18:00) sí
 * descuenta 60 min — son turnos largos donde hay tiempo para almuerzo.
 *
 * Mantén estas funciones como la ÚNICA fuente de verdad sobre minutos/horas.
 * Cualquier cálculo de "descontar almuerzo" en el sistema debe pasar por
 * `minutosAlmuerzo()` — así una regla nueva solo se toca en un lugar.
 */

export const hhmmAMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export const horasDeFranja = (hi, hf) => (hhmmAMinutos(hf) - hhmmAMinutos(hi)) / 60

const ALMUERZO_CORTO = new Set(['oftalmologo', 'anestesiologo', 'optometra', 'fonoaudiologa', 'otorrino'])

/**
 * Minutos de almuerzo a descontar de un bloque de trabajo. Fuente de verdad
 * única para la regla operativa. Devuelve 0 si NO hay descuento.
 *
 * Regla v4 (jul-2026): descuenta si dura ≥ 6h, EXCEPTO los técnicos con
 * turnos partidos de ayudas diagnósticas (07:00–13:00 o 13:00–19:00 exactos).
 *
 * @param {number} minutosTotales  Duración del bloque (o unión de bloques del día)
 * @param {number} inicioMinutos   Hora de inicio en minutos desde 00:00
 * @param {number} finMinutos      Hora de fin en minutos desde 00:00 (para multi-bloque, max end)
 * @param {string|null} tipoRecurso
 * @returns {number}  Minutos a descontar (30, 60 o 0)
 */
export function minutosAlmuerzo(minutosTotales, inicioMinutos, finMinutos, tipoRecurso = null) {
  if (minutosTotales < 360) return 0                        // turno corto: sin pausa (< 6h)

  // Excepción técnicos: turnos partidos matutino/vespertino de ayudas
  // diagnósticas trabajan corrido y NO descuentan almuerzo. Cualquier
  // otro turno de técnico (ej. 08:00-17:00) sí descuenta como cualquier
  // otro recurso — el receso cabe dentro del turno largo.
  //   420 = 07:00, 780 = 13:00, 1140 = 19:00
  if (tipoRecurso === 'tecnico') {
    const esMatutinoCorrido  = inicioMinutos === 420 && finMinutos === 780
    const esVespertinoCorrido = inicioMinutos === 780 && finMinutos === 1140
    if (esMatutinoCorrido || esVespertinoCorrido) return 0
  }

  return ALMUERZO_CORTO.has(tipoRecurso) ? 30 : 60
}

/**
 * Horas efectivas (productivas) de una franja, descontando almuerzo según el tipo.
 * @param {string} hi  Hora inicio "HH:MM"
 * @param {string} hf  Hora fin "HH:MM"
 * @param {string|null} tipoRecurso  Tipo del recurso ('oftalmologo', 'asesor_servicios', etc.)
 * @returns {number}   Horas efectivas (decimal)
 */
export function horasEfectivasFranja(hi, hf, tipoRecurso = null) {
  const inicio = hhmmAMinutos(hi)
  const fin = hhmmAMinutos(hf)
  const minutos = fin - inicio
  if (minutos <= 0) return 0
  const almuerzo = minutosAlmuerzo(minutos, inicio, fin, tipoRecurso)
  return (minutos - almuerzo) / 60
}

/**
 * Minutos de la UNIÓN de intervalos, no de su suma.
 *
 * Es la diferencia entre "cuánto tiempo estuvo trabajando" y "cuántas horas-sala
 * ocupó". Una doctora multi-consultorio que cubre 3 salas de 07:00 a 13:00 está
 * 6h presentes, no 18h: sin esta unión aparecía con un 257% de utilización.
 *
 * Estaba duplicada en asignacionService (minutosUnion) y en informeController
 * (dentro de horasConUnionPorDia), con dos implementaciones independientes que
 * podían divergir. Vive aquí, que es donde este archivo declara estar la única
 * fuente de verdad sobre minutos y horas.
 *
 * @param {Array<{start:number, end:number}>} intervalos  minutos desde 00:00
 * @returns {number} minutos cubiertos, contando una sola vez los solapes
 */
export function minutosUnion(intervalos) {
  if (!intervalos.length) return 0
  const sorted = [...intervalos].sort((a, b) => a.start - b.start)
  let total = 0
  let curStart = sorted[0].start
  let curEnd = sorted[0].end
  for (let i = 1; i < sorted.length; i++) {
    const { start, end } = sorted[i]
    if (start <= curEnd) curEnd = Math.max(curEnd, end)
    else { total += curEnd - curStart; curStart = start; curEnd = end }
  }
  return total + (curEnd - curStart)
}

/**
 * Horas EFECTIVAS de un conjunto de asignaciones agrupando por día y contando
 * los solapes una sola vez. Para cada día: unión de franjas y, sobre ese total,
 * el almuerzo que corresponda al tipo de recurso.
 *
 * El almuerzo se evalúa contra el inicio más temprano y el fin más tardío del
 * día, no contra cada franja suelta: quien cubre 07:00–11:00 y 11:00–13:00 hace
 * un bloque de 6h y le aplica la misma regla que a un 07:00–13:00 seguido.
 *
 * @param {Array<{diaSemana:string, horaInicio:string, horaFin:string}>} asignaciones
 * @param {string|null} tipoRecurso
 * @returns {number} horas efectivas (decimal)
 */
export function horasUnionPorDia(asignaciones, tipoRecurso = null) {
  const porDia = new Map()
  for (const a of asignaciones) {
    const start = hhmmAMinutos(a.startTime)
    const end = hhmmAMinutos(a.endTime)
    if (end <= start) continue
    if (!porDia.has(a.weekday)) porDia.set(a.weekday, [])
    porDia.get(a.weekday).push({ start, end })
  }

  let totalMin = 0
  for (const intervalos of porDia.values()) {
    const minutosDia = minutosUnion(intervalos)
    const inicioDia = Math.min(...intervalos.map((iv) => iv.start))
    const finDia = Math.max(...intervalos.map((iv) => iv.end))
    totalMin += minutosDia - minutosAlmuerzo(minutosDia, inicioDia, finDia, tipoRecurso)
  }
  return totalMin / 60
}

/**
 * Jornada legal vigente en Colombia (Ley 2101 de 2021).
 *
 * Cronograma del Art. 2:
 *   - Antes de 15-jul-2023: 48 h
 *   - 15-jul-2023 → 14-jul-2024: 47 h
 *   - 15-jul-2024 → 14-jul-2025: 46 h
 *   - 15-jul-2025 → 14-jul-2026: 44 h   ← VIGENTE HOY (2026-06-22)
 *   - Desde 15-jul-2026: 42 h
 *
 * Si no hay parámetro en BD, este valor es el fallback seguro.
 * Cuando llegue julio 2026 el supervisor cambia el parámetro a 42 desde
 * "Metas del sistema" sin necesidad de redeploy.
 */
export const JORNADA_LEGAL_SEMANAL = 44
