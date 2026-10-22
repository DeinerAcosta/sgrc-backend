/**
 * ORDEN DE PRIORIDAD PARA REEMPLAZAR AUXILIARES Y ASESORES (PROYECTOS-3583 §4)
 *
 *   1. La auxiliar cuyo médico está ausente: su turno se cayó, así que está
 *      libre y ya conoce la sede.
 *   2. La que no ha completado su tope semanal (42 h).
 *   3. La de otra jornada. Se le avisa con 1 día de anticipación; llamarla el
 *      mismo día es una excepción y se marca.
 *
 * Para asesores es la misma lógica; el criterio 1 solo aplica si el asesor
 * estaba ligado a un médico (iba de acompañante en su turno).
 *
 * Pura, para probarla sin base de datos.
 */
export const TIPOS_CON_PRIORIDAD = new Set(['auxiliar', 'asesor_servicios'])

export const TOPE_SEMANAL_AUXILIAR = 42

/**
 * @param {object} c
 * @param {boolean} c.liberadaPorAusencia  su médico falta en una franja suya de ese día
 * @param {number}  c.horasSemana          horas que ya tiene en la semana
 * @param {number|null} c.topeSemanal      su tope (null = el de la clínica)
 * @param {boolean} c.esMismoDia           el hueco es hoy
 */
export function prioridadDeReemplazo({ liberadaPorAusencia, horasSemana, topeSemanal, esMismoDia }) {
  const tope = topeSemanal ?? TOPE_SEMANAL_AUXILIAR
  if (liberadaPorAusencia) {
    return { prioridad: 1, motivo: 'Su médico está ausente ese día' }
  }
  if (horasSemana < tope) {
    return { prioridad: 2, motivo: `Lleva ${redondear(horasSemana)} h de ${redondear(tope)} h esta semana` }
  }
  return {
    prioridad: 3,
    motivo: 'De otra jornada',
    // Avisarle el mismo día es la excepción: se marca para que se vea.
    avisoMismoDia: !!esMismoDia,
  }
}

const redondear = (h) => Math.round(h * 10) / 10

/** Orden de la lista: prioridad, luego misma sede, luego quien tiene menos horas. */
export const compararPorPrioridad = (a, b) =>
  (a.prioridad ?? 9) - (b.prioridad ?? 9) ||
  Number(b.misma_sede) - Number(a.misma_sede) ||
  (a.horas_semana ?? 0) - (b.horas_semana ?? 0)
