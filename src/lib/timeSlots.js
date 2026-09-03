import { hhmmAMinutos } from './workHours.js'

/**
 * Helpers puros sobre franjas y asignaciones.
 *
 * Viven aquí, y no dentro de asignacionService, porque los usan DOS caminos que
 * tienen que aplicar exactamente las mismas reglas:
 *   - crearAsignacion(): una asignación cada vez, dentro de su transacción.
 *   - validarLote():     muchas de golpe, al copiar un día o una semana.
 * Si cada uno tuviera su copia, acabarían divergiendo y "copiar" volvería a
 * comportarse distinto que "crear", que es justo el defecto que se corrigió.
 */

/**
 * Tipos de recurso que NO tienen tope diario laboral: son rotativos y cubren
 * agendas largas con bloques cortos en varias sedes (turnos partidos tipo
 * 07:00-13:00 + 14:00-18:00). Para auxiliar/técnico/asesor sí aplica.
 */
export const SIN_TOPE_DIARIO = new Set([
  'oftalmologo', 'anestesiologo', 'fonoaudiologa', 'otorrino', 'optometra',
])

/**
 * Especialidades cuyos consultorios admiten un recurso de apoyo
 * (auxiliar_id / auxiliar2_id). En optometría y asesoría no aplica.
 */
export const ESPECIALIDADES_PERMITEN_APOYO = new Set([
  'oftalmologia', 'anestesiologia', 'diagnostico',
])

export const minutosAhhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** ¿La asignación `a` pisa la franja [hi, hf)? Tocarse en el borde NO es solape. */
export const solapan = (a, hi, hf) => !(hf <= a.startTime || hi >= a.endTime)

/**
 * Rango horario EFECTIVO en el que `auxId` está activo dentro de la asignación
 * `a`. Si figura como auxiliarId/auxiliar2Id y tiene sub-horario, se respeta;
 * null significa "hereda del doctor". Si es el recurso principal, su horario es
 * el del doctor.
 *
 * Sin esto se comparaba contra el horario del doctor y salían conflictos
 * inexistentes (aux 07-09 vs aux 09-15 con el mismo doctor 07-15).
 */
export function horarioEfectivoAuxEnAsig(a, auxId) {
  if (a.assistantId === auxId) {
    return { ini: a.assistantStartTime || a.startTime, fin: a.assistantEndTime || a.endTime }
  }
  if (a.assistant2Id === auxId) {
    return { ini: a.assistant2StartTime || a.startTime, fin: a.assistant2EndTime || a.endTime }
  }
  return { ini: a.startTime, fin: a.endTime }
}

/** ¿La auxiliar `auxId` está ocupada en `a` durante [hi, hf)? */
export const solapaConAux = (a, auxId, hi, hf) => {
  const ef = horarioEfectivoAuxEnAsig(a, auxId)
  return !(hf <= ef.ini || hi >= ef.fin)
}

/** Intervalo en minutos desde medianoche de una asignación. */
export const intervaloDe = (a) => ({
  start: hhmmAMinutos(a.startTime),
  end: hhmmAMinutos(a.endTime),
})
