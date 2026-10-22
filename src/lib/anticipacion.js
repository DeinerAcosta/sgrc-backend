/**
 * Cuándo una ausencia cuenta como "programada".
 *
 * Oct-2026 · Hector: 20 días o más de anticipación es programada; menos de 20
 * es imprevista. Es el mismo número del aviso que ve quien registra ("las
 * ausencias médicas deben informarse con al menos 20 días de anticipación").
 *
 * Antes había tres números a la vez: lo guardado (y los informes) usaba más de
 * 15 días, el correo de aviso decía "Programada: Sí" desde 2 días y el mensaje
 * pedía 20. Una ausencia avisada con 5 días quedaba imprevista en la base y
 * "con anticipación" en el correo. Por eso vive aquí, en un solo sitio.
 *
 * Sin dependencias, para probarla sin base de datos.
 */
export const DIAS_PROGRAMADA = 20

export const esProgramada = (diasDeAnticipacion) =>
  Number.isFinite(diasDeAnticipacion) && diasDeAnticipacion >= DIAS_PROGRAMADA

const DIA_MS = 24 * 3600 * 1000
const hoyEnColombia = (ahora) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(ahora)   // "2026-10-20"
const diaUTC = (yyyyMmDd) => Date.parse(yyyyMmDd.slice(0, 10) + 'T00:00:00Z')

/**
 * Días de calendario entre hoy (en Colombia) y el primer día de la ausencia.
 *
 * Oct-2026 · Antes se restaba la hora del registro: el 20-oct a las 11:00, una
 * ausencia del 9-nov daba 19 días y no 20, porque faltaban 19 días y 13 horas.
 * Con el umbral en 20, quien avisaba con 20 días quedaba "imprevista" y el
 * aviso le decía "19 días". Y con el servidor en UTC, lo registrado después de
 * las 19:00 de Colombia ya contaba desde el día siguiente.
 */
export function diasDeAnticipacion(fechaInicio, ahora = new Date()) {
  return Math.round((diaUTC(fechaInicio) - diaUTC(hoyEnColombia(ahora))) / DIA_MS)
}
