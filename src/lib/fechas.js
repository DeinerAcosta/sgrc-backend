/**
 * FORMATEO DE FECHAS PARA CORREOS Y NOTIFICACIONES — fuente unica
 * ===============================================================
 *
 * En el SGRC conviven DOS tipos de fecha, y se formatean distinto. Confundirlos
 * es lo que puso "20 de septiembre — 26 de septiembre" en el correo de cierre
 * de una semana que en el Programador va del 21 al 27.
 *
 * 1. SOLO FECHA (un dia del calendario, sin hora que signifique nada)
 *    semanas, ausencias, reposiciones, festivos.
 *    Prisma las guarda a medianoche UTC: 2026-09-21T00:00:00.000Z.
 *    Formatearlas en America/Bogota (UTC-5) las corre a las 19:00 del DIA
 *    ANTERIOR, y el correo dice 20 de septiembre. Van en UTC. → fechaSolo()
 *
 * 2. MARCA DE TIEMPO REAL (un instante: cuando paso algo)
 *    closedAt, createdAt, "Fecha y hora de cierre", el pie de los correos.
 *    Esas SI van en America/Bogota, porque la hora importa y el lector esta
 *    en Colombia. → fechaHora()
 *
 * La regla corta: si el dato tiene hora que le importe a alguien, Bogota;
 * si es un dia del calendario, UTC.
 *
 * Medido en produccion el 29-sep-2026, antes de este arreglo: se corrian un dia
 * el 100% de las fechas de 260 ausencias, 36 semanas, 37 festivos y 1
 * reposicion — es decir, todas. En cambio `closedAt` salia bien, porque ahi
 * America/Bogota si era lo correcto.
 *
 * Ojo al leer el codigo viejo: en faa126FormService se hizo el cambio en la
 * direccion CONTRARIA (de UTC a Bogota) y ahi estaba bien — ese dato es
 * `new Date()`, el instante en que se genera el PDF, no un dia guardado.
 */

const LOCALE = 'es-CO'
export const TZ_COLOMBIA = 'America/Bogota'

/**
 * Un dia del calendario: "21 de septiembre de 2026".
 * Para fechas guardadas como solo-fecha (medianoche UTC).
 */
export function fechaSolo(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(LOCALE, {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}

/** Version corta: "21/09/2026". Mismo criterio de zona que fechaSolo(). */
export function fechaSoloCorta(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Un periodo: "21 de septiembre de 2026 al 27 de septiembre de 2026".
 * Si las dos fechas son el mismo dia, devuelve una sola.
 */
export function periodo(desde, hasta) {
  const a = fechaSolo(desde)
  const b = fechaSolo(hasta)
  return a === b ? a : `${a} al ${b}`
}

/**
 * Un instante real: "29 de septiembre de 2026, 3:58 p. m." en hora Colombia.
 * Para closedAt, createdAt y cualquier "cuando paso esto".
 */
export function fechaHora(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString(LOCALE, {
    dateStyle: 'long', timeStyle: 'short', timeZone: TZ_COLOMBIA,
  })
}
