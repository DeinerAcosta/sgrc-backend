/**
 * Las reglas del tablero de Reprogramaciones (Oct-2026, revisión pedida por
 * Hector: "si hay uno que no concuerde, aplicarlo").
 *
 * Antes el tablero contaba como "repuesta" solo la ausencia con una
 * REPOSICIÓN aprobada (la que propone el propio médico), y nunca los turnos
 * que cubren la ausencia, que es como la líder resuelve hoy los casos: daba 0%
 * de reposición con casos cubiertos. Y los pacientes eran el estimado, no los
 * reales que pone la líder.
 *
 * Sin dependencias, para probarla sin base de datos.
 */
import { DIAS_PROGRAMADA } from './anticipacion.js'

/**
 * Cuánto de una ausencia quedó cubierto.
 *   total      — pacientes del caso (los reales si la líder los puso)
 *   cubiertos  — suma de pacientes de los turnos que la cubren
 *   reposicion — tiene una reposición aprobada o realizada (flujo del médico)
 * Una reposición aprobada sin turnos cuenta como el caso entero cubierto: es
 * el flujo viejo, donde el médico repone su propia agenda.
 */
export function coberturaDeAusencia({ total = 0, cubiertos = 0, reposicion = false }) {
  const t = Math.max(0, total)
  const c = reposicion && cubiertos === 0 ? t : Math.min(t, Math.max(0, cubiertos))
  return {
    pacientesCubiertos: c,
    pacientesSinCobertura: t - c,
    // Repuesta = todos sus pacientes con turno nuevo. Sin pacientes no hay
    // nada que reponer: cuenta como repuesta solo si hubo reposición.
    repuesta: t > 0 ? c >= t : reposicion,
  }
}

/**
 * Antelación del aviso, alineada con la regla de 20 días: 20 o más es
 * "programada"; menos, imprevista. `dias` son días de calendario (noticeDays).
 */
export const BUCKETS_ANTELACION = ['retroactivo', 'uno_a_siete', 'ocho_a_diecinueve', 'veinte_o_mas']
export function bucketAntelacion(dias) {
  if (!Number.isFinite(dias) || dias <= 0) return 'retroactivo'
  if (dias <= 7) return 'uno_a_siete'
  if (dias < DIAS_PROGRAMADA) return 'ocho_a_diecinueve'
  return 'veinte_o_mas'
}

/** Oportunidad de la reposición: días entre la ausencia y el turno que la cubre. */
export const BUCKETS_SLA = ['adelantada', 'mismo_dia', 'uno_a_siete', 'ocho_a_treinta', 'mas_30']
export function bucketSla(dias) {
  if (dias < 0) return 'adelantada'
  if (dias === 0) return 'mismo_dia'
  if (dias <= 7) return 'uno_a_siete'
  if (dias <= 30) return 'ocho_a_treinta'
  return 'mas_30'
}

/** Días entre dos fechas @db.Date (medianoche UTC), sin que la zona horaria corra el día. */
export function diasEntreFechas(desde, hasta) {
  const d = (x) => Date.parse(String(x instanceof Date ? x.toISOString() : x).slice(0, 10) + 'T00:00:00Z')
  return Math.round((d(hasta) - d(desde)) / 86_400_000)
}

/** 'YYYY-MM' de una fecha @db.Date, en UTC (en Bogotá, el día 1 caía en el mes anterior). */
export const mesDeFecha = (f) => (f instanceof Date ? f.toISOString() : String(f)).slice(0, 7)

/**
 * 27-oct · PROYECTOS-3799 · CONCENTRACIÓN SOBRE EL 10%.
 * Qué parte de los pacientes impactados la generan el 10% de los
 * profesionales con más pacientes afectados. n = máx(1, 10% hacia arriba) de
 * los profesionales involucrados (cuentan también los de 0 pacientes).
 * `pacientes` es la lista de pacientes afectados de cada profesional.
 * Antes el frontend sumaba el "top 3" de una lista recortada y ordenada por
 * días, y las dos pestañas daban cifras distintas.
 */
export function concentracionTop(pacientes = [], pct = 10) {
  const vals = pacientes.map((p) => Math.max(0, Number(p) || 0)).sort((a, b) => b - a)
  const total = vals.length
  const n = total > 0 ? Math.max(1, Math.ceil((total * pct) / 100)) : 0
  const pacientesTop = vals.slice(0, n).reduce((s, v) => s + v, 0)
  const totalPacientes = vals.reduce((s, v) => s + v, 0)
  return {
    pct_profesionales: pct,
    n,
    total_profesionales: total,
    pacientes_top: pacientesTop,
    total_pacientes: totalPacientes,
    pct_impacto: totalPacientes > 0 ? Math.round((pacientesTop / totalPacientes) * 1000) / 10 : 0,
  }
}
