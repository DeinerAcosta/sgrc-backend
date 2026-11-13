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
 * APOYO EN CONSULTORIO — fuente unica
 * ===================================
 *
 * EXIGEN: el profesional no puede atender solo, la auxiliar es obligatoria.
 * PERMITEN: admiten apoyo, obligatorio o no. Diagnostico solo permite (y ahi
 * el apoyo es OTRO TECNICO, no una auxiliar).
 *
 * Sep-2026 · se agrega 'otorrinolaringologia'. Los 7 consultorios de otorrino
 * ya estaban marcados `requiere_auxiliar = true` en BD desde jul-2026
 * (roomController los crea asi), pero la especialidad nunca se agrego a estas
 * listas: el modal de asignacion no mostraba el campo de auxiliar y un segundo
 * auxiliar habria sido rechazado con "Este consultorio no acepta apoyo".
 * Nadie lo noto porque no habia ni una sola asignacion en esos consultorios.
 *
 * Misma familia que el bug de jul-2026 en que crear un Otorrino fallaba con
 * "Datos invalidos": el tipo se agrego a la BD y al desplegable, pero no a las
 * listas de validacion repartidas por el codigo. Por eso ahora `REQUIEREN_AUX`
 * de roomController sale de aqui en vez de estar copiado alli.
 */
export const ESPECIALIDADES_EXIGEN_APOYO = new Set([
  'oftalmologia', 'anestesiologia', 'otorrinolaringologia',
])

/** Admiten apoyo (las auxiliares del turno, asignacion_auxiliares). Optometria y asesoria no. */
export const ESPECIALIDADES_PERMITEN_APOYO = new Set([
  ...ESPECIALIDADES_EXIGEN_APOYO, 'diagnostico',
])

export const minutosAhhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** ¿La asignación `a` pisa la franja [hi, hf)? Tocarse en el borde NO es solape. */
export const solapan = (a, hi, hf) => !(hf <= a.startTime || hi >= a.endTime)

/**
 * Las auxiliares de un turno con su hora EFECTIVA, en orden.
 *
 * Nov-2026 · Hector: un turno lleva las auxiliares que hagan falta (antes eran
 * dos columnas fijas, auxiliar_id y auxiliar2_id). Cada una puede traer su
 * sub-horario; null significa "hereda el horario del turno". Este es el único
 * sitio que resuelve esa herencia: el resto del código pide aquí la lista.
 *
 * Lee `a.assistants` (filas de asignacion_auxiliares, con resourceId,
 * startTime, endTime y position). Ordena por position aunque la consulta no lo
 * haya pedido, para que "la primera" signifique siempre lo mismo.
 *
 * @returns {Array<{ resourceId: string, ini: string, fin: string, position: number }>}
 */
export function auxiliaresDe(a) {
  const lista = Array.isArray(a?.assistants) ? a.assistants : []
  return lista
    .filter((x) => x?.resourceId)
    .map((x, i) => ({
      resourceId: x.resourceId,
      ini: x.startTime || a.startTime,
      fin: x.endTime || a.endTime,
      position: x.position ?? i,
      descanso: x.breakStartTime && x.breakEndTime ? { ini: x.breakStartTime, fin: x.breakEndTime } : null,
      cubreDescansoDe: x.coversBreakOf ?? null,
    }))
    .sort((x, y) => x.position - y.position)
}

/** Ids de las auxiliares del turno, en orden. */
export const idsAuxiliaresDe = (a) => auxiliaresDe(a).map((x) => x.resourceId)

/** ¿`recursoId` está en el turno `a`, como profesional o como cualquiera de sus auxiliares? */
export const participaEn = (a, recursoId) =>
  !!recursoId && (a.resourceId === recursoId || idsAuxiliaresDe(a).includes(recursoId))

/**
 * Rango horario EFECTIVO en el que `auxId` está activo dentro de la asignación
 * `a`. Si figura como auxiliar del turno y tiene sub-horario, se respeta;
 * null significa "hereda del doctor". Si es el recurso principal, su horario es
 * el del doctor.
 *
 * Sin esto se comparaba contra el horario del doctor y salían conflictos
 * inexistentes (aux 07-09 vs aux 09-15 con el mismo doctor 07-15).
 */
export function horarioEfectivoAuxEnAsig(a, auxId) {
  const suya = auxiliaresDe(a).find((x) => x.resourceId === auxId)
  if (suya) return { ini: suya.ini, fin: suya.fin, descanso: suya.descanso }
  return { ini: a.startTime, fin: a.endTime, descanso: null }
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
