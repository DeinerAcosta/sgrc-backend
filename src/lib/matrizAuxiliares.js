/**
 * MATRIZ DE ASIGNACIONES — reglas puras (sin BD)
 * ===============================================
 *
 * Nov-2026 · La malla fija de cada auxiliar. Aquí vive lo que se puede probar
 * sin base de datos: cómo se validan las franjas de un día y cuántas horas dan.
 * El frontend repite `horasDelDiaMatriz` para pintar los totales; si cambia la
 * regla, cambiarla en los dos lados (src/utils/matriz.js en el frontend).
 */

/** Días de la malla. El domingo no se programa en la clínica. */
export const DIAS_MATRIZ = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_FRANJAS = 4

const aMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Valida y ordena las franjas de un día. Devuelve `{ franjas }` o `{ error }`.
 *
 * Reglas: formato HH:MM, fin después de inicio, sin cruces entre franjas y a lo
 * sumo cuatro (el Excel nunca pasa de tres).
 *
 * Nov-2026 · Hector: cada franja con SU profesional (`professionalId`, puede
 * faltar) y su hora de almuerzo (`lunch: { ini, fin }`, opcional, dentro de
 * la franja). "De 8 a 12 con uno y de 1 a 5 con otro" son dos franjas.
 */
export function validarFranjas(entrada) {
  if (!Array.isArray(entrada)) return { error: 'Las franjas deben ser una lista' }
  if (entrada.length > MAX_FRANJAS) return { error: `Máximo ${MAX_FRANJAS} franjas por día` }
  const franjas = []
  for (const [i, f] of entrada.entries()) {
    const ini = f?.ini
    const fin = f?.fin
    if (!HHMM.test(ini ?? '') || !HHMM.test(fin ?? '')) {
      return { error: `Franja ${i + 1}: la hora debe ir como HH:MM` }
    }
    if (aMin(fin) <= aMin(ini)) return { error: `Franja ${i + 1}: la hora fin debe ser después de la de inicio` }
    const franja = { ini, fin }
    if (f.professionalId) franja.professionalId = String(f.professionalId)
    const li = f.lunch?.ini, lf = f.lunch?.fin
    if (li || lf) {
      if (!HHMM.test(li ?? '') || !HHMM.test(lf ?? '')) return { error: `Franja ${i + 1}: el almuerzo debe ir como HH:MM` }
      if (aMin(lf) <= aMin(li)) return { error: `Franja ${i + 1}: el fin del almuerzo debe ser después del inicio` }
      if (aMin(li) < aMin(ini) || aMin(lf) > aMin(fin)) {
        return { error: `Franja ${i + 1}: el almuerzo (${li}–${lf}) debe estar dentro de ${ini}–${fin}` }
      }
      franja.lunch = { ini: li, fin: lf }
    }
    franjas.push(franja)
  }
  franjas.sort((a, b) => aMin(a.ini) - aMin(b.ini))
  for (let i = 1; i < franjas.length; i++) {
    if (aMin(franjas[i].ini) < aMin(franjas[i - 1].fin)) {
      return { error: `Las franjas ${franjas[i - 1].ini}–${franjas[i - 1].fin} y ${franjas[i].ini}–${franjas[i].fin} se cruzan` }
    }
  }
  return { franjas }
}

/**
 * ESTADO DE UNA AUXILIAR PARA UN TURNO (nov-2026)
 * ===============================================
 *
 * Al asignar en el Programador, la lista de auxiliares dice en qué está cada
 * una el día y a la hora del turno. Definición de Hector:
 *
 *   ausente     tiene ausencia ese día (una por horas, solo si toca el turno)
 *   asignado    ya tiene un turno que se cruza con este horario
 *   disponible  tiene turnos ese día pero está libre a esta hora
 *   sin_asignar no tiene nada ese día
 *
 * Ausente y asignado no se pueden elegir.
 *
 * @param {object}   p
 * @param {object[]} p.ausencias  las del día: { isPartial, absenceStartTime, absenceEndTime }
 * @param {object[]} p.franjas    su horario ese día: { ini, fin }
 * @param {string}   p.ini        horario del turno que se asigna
 * @param {string}   p.fin
 */
export function estadoAuxiliarEnTurno({ ausencias = [], franjas = [], ini, fin }) {
  const cruza = (a, b, c, d) => a < d && c < b   // [a,b) con [c,d); tocarse no es cruce
  const ausente = ausencias.some((x) =>
    !x.isPartial || !x.absenceStartTime || !x.absenceEndTime || cruza(x.absenceStartTime, x.absenceEndTime, ini, fin))
  if (ausente) return 'ausente'
  if (franjas.some((f) => cruza(f.ini, f.fin, ini, fin))) return 'asignado'
  if (franjas.length) return 'disponible'
  return 'sin_asignar'
}

/**
 * Horas de un día de la malla.
 *
 * El hueco entre dos franjas ES el almuerzo, así que con varias franjas se
 * suman tal cual. Con una sola franja corrida de más de 7h se descuenta 1h de
 * almuerzo. Es la cuenta que ya hacía el Excel: 08:00–16:00 = 7h,
 * 08:00–18:00 = 9h, 07:30–14:30 = 7h, 07:30–12:00 + 13:00–17:00 = 8,5h.
 *
 * Nov-2026 · Si una franja trae su almuerzo marcado, se le descuenta ese
 * almuerzo y ya no el automático de 1h.
 */
export function horasDelDiaMatriz(franjas = []) {
  return horasPorFranjaMatriz(franjas).reduce((s, h) => s + h, 0)
}

/** Las horas de cada franja (las mismas que suma horasDelDiaMatriz). */
export function horasPorFranjaMatriz(franjas = []) {
  const validas = franjas.filter((f) => HHMM.test(f?.ini ?? '') && HHMM.test(f?.fin ?? '') && aMin(f.fin) > aMin(f.ini))
  const unaSola = validas.length === 1
  return validas.map((f) => {
    const minutos = aMin(f.fin) - aMin(f.ini)
    const li = f.lunch?.ini, lf = f.lunch?.fin
    if (HHMM.test(li ?? '') && HHMM.test(lf ?? '') && aMin(lf) > aMin(li)) return Math.max(0, minutos - (aMin(lf) - aMin(li))) / 60
    return (minutos - (unaSola && minutos > 7 * 60 ? 60 : 0)) / 60
  })
}
