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
    franjas.push({ ini, fin })
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
 * Horas de un día de la malla.
 *
 * El hueco entre dos franjas ES el almuerzo, así que con varias franjas se
 * suman tal cual. Con una sola franja corrida de más de 7h se descuenta 1h de
 * almuerzo. Es la cuenta que ya hacía el Excel: 08:00–16:00 = 7h,
 * 08:00–18:00 = 9h, 07:30–14:30 = 7h, 07:30–12:00 + 13:00–17:00 = 8,5h.
 */
export function horasDelDiaMatriz(franjas = []) {
  const validas = franjas.filter((f) => HHMM.test(f?.ini ?? '') && HHMM.test(f?.fin ?? '') && aMin(f.fin) > aMin(f.ini))
  const minutos = validas.reduce((s, f) => s + aMin(f.fin) - aMin(f.ini), 0)
  const almuerzo = validas.length === 1 && minutos > 7 * 60 ? 60 : 0
  return (minutos - almuerzo) / 60
}
