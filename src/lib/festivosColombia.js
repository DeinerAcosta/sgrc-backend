/**
 * Calendario oficial de festivos de Colombia.
 *
 * 18 días al año: 7 fijos + 11 que caen en lunes por la Ley Emiliani.
 * Para festividades atadas a la Pascua usamos el cómputo de Gauss/Butcher.
 *
 * Función pura: dada un año devuelve un arreglo de { fecha (Date a medianoche
 * UTC), descripcion } ordenado cronológicamente. Sin side effects ni I/O.
 */

/** Domingo de Pascua para el año dado (algoritmo Anonymous Gregorian / Butcher). */
function domingoPascua(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3=marzo, 4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

/** Suma días a una Date (en UTC, sin TZ). */
function addDays(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

/** Devuelve el lunes siguiente a una fecha. Si ya es lunes, devuelve la misma fecha (Ley Emiliani). */
function trasladarALunes(date) {
  const dow = date.getUTCDay() // 0=dom, 1=lun, ..., 6=sáb
  if (dow === 1) return date
  // Distancia al próximo lunes: para dom = 1, mar = 6, mié = 5, jue = 4, vie = 3, sáb = 2
  const dist = (8 - dow) % 7 || 7
  return addDays(date, dist)
}

/** Construye Date UTC para un día calendario sin TZ-shift. */
function fechaUTC(year, month1based, day) {
  return new Date(Date.UTC(year, month1based - 1, day))
}

/**
 * Devuelve todos los festivos de Colombia para un año dado, ordenados.
 * Cada entrada: { fecha: Date (UTC midnight), descripcion: string }.
 */
export function festivosColombia(year) {
  const pascua = domingoPascua(year)

  // Movables atadas a Pascua. Las Emiliani después de Pascua mueven a lunes.
  const juevesSanto = addDays(pascua, -3)
  const viernesSanto = addDays(pascua, -2)
  const ascension = trasladarALunes(addDays(pascua, 39))     // 39 días desde Pascua
  const corpusChristi = trasladarALunes(addDays(pascua, 60))
  const sagradoCorazon = trasladarALunes(addDays(pascua, 68))

  const items = [
    { fecha: fechaUTC(year, 1, 1),  descripcion: 'Año Nuevo' },                                                      // fijo
    { fecha: trasladarALunes(fechaUTC(year, 1, 6)),  descripcion: 'Día de los Reyes Magos' },                        // Emiliani
    { fecha: trasladarALunes(fechaUTC(year, 3, 19)), descripcion: 'Día de San José' },                               // Emiliani
    { fecha: juevesSanto,    descripcion: 'Jueves Santo' },                                                          // movible
    { fecha: viernesSanto,   descripcion: 'Viernes Santo' },                                                         // movible
    { fecha: fechaUTC(year, 5, 1),  descripcion: 'Día del Trabajo' },                                                // fijo
    { fecha: ascension,      descripcion: 'Ascensión del Señor' },                                                   // Emiliani sobre Pascua
    { fecha: corpusChristi,  descripcion: 'Corpus Christi' },                                                        // Emiliani sobre Pascua
    { fecha: sagradoCorazon, descripcion: 'Sagrado Corazón' },                                                       // Emiliani sobre Pascua
    { fecha: trasladarALunes(fechaUTC(year, 6, 29)), descripcion: 'San Pedro y San Pablo' },                         // Emiliani
    { fecha: fechaUTC(year, 7, 20), descripcion: 'Día de la Independencia' },                                        // fijo
    { fecha: fechaUTC(year, 8, 7),  descripcion: 'Batalla de Boyacá' },                                              // fijo
    { fecha: trasladarALunes(fechaUTC(year, 8, 15)), descripcion: 'Asunción de la Virgen' },                         // Emiliani
    { fecha: trasladarALunes(fechaUTC(year, 10, 12)), descripcion: 'Día de la Raza / Diversidad Étnica y Cultural' },// Emiliani
    { fecha: trasladarALunes(fechaUTC(year, 11, 1)),  descripcion: 'Todos los Santos' },                             // Emiliani
    { fecha: trasladarALunes(fechaUTC(year, 11, 11)), descripcion: 'Independencia de Cartagena' },                   // Emiliani
    { fecha: fechaUTC(year, 12, 8),  descripcion: 'Inmaculada Concepción' },                                         // fijo
    { fecha: fechaUTC(year, 12, 25), descripcion: 'Navidad' },                                                       // fijo
  ]

  // Ordenar cronológicamente — las Emiliani pueden caer fuera de orden si
  // la fecha original y la del lunes desplazado están en distintos meses.
  return items.sort((a, b) => a.fecha - b.fecha)
}
