/**
 * El lunes de la semana operativa (LUNES → DOMINGO).
 *
 * Oct-2026 · Antes era `startOfWeek(new Date('2026-10-19'), { weekStartsOn: 1 })`.
 * `new Date('2026-10-19')` es medianoche UTC, que en Colombia es el DOMINGO 18
 * a las 7 p. m.; con el proceso en America/Bogota, startOfWeek devolvía el
 * lunes 12 y se creaba (o se copiaba sobre) la semana ANTERIOR. Con el proceso
 * en UTC salía bien, así que dependía de cómo arrancara el servidor.
 *
 * Aquí todo va en UTC, que es como Prisma lee y escribe las columnas @db.Date:
 * el mismo resultado que antes en un servidor UTC, y el correcto en cualquier
 * otro. Sin dependencias, para probarla sin base de datos.
 */
export function lunesDeLaSemana(yyyyMmDd) {
  const d = new Date(String(yyyyMmDd).slice(0, 10) + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))   // getUTCDay: 0 = domingo
  return d
}

/** El domingo con que cierra la semana que empieza ese lunes. */
export function domingoDeLaSemana(lunes) {
  const d = new Date(lunes)
  d.setUTCDate(d.getUTCDate() + 6)
  return d
}
