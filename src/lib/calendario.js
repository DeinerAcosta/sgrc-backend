// Helpers de calendario: dias no laborables (domingo + festivo) y base semanal
// efectiva para los indicadores de capacidad / ocupacion.
//
// La semana en SGRC arranca en DOMINGO (RN-04). Los coordinadores NO cargan
// asignaciones en domingo (expandirRangoHabil lo salta), por eso la base
// teorica de una semana ya empieza en 5 dias LV + medio dia sabado = 64h.
// Al DESCONTAR festivos se recorta esa base cuando cae un dia laboral en
// festivo (7-sep, 25-dic, etc.).
//
// Coordinar cambios con:
//   - backend/src/controllers/resourceController.js  (tope por recurso, ya usa festivos)
//   - backend/src/lib/workdays.js                    (expandirRangoHabil, usa festivos)

import { prisma as prismaDefault } from './prisma.js'

export const MINUTOS_DIA_LV = 720        // 12h L-V
export const MINUTOS_SABADO = 240        // 4h sabado
export const BASE_MINUTOS_SEMANA_TEORICA = 5 * MINUTOS_DIA_LV + MINUTOS_SABADO   // 3840 (64h)
export const DIAS_LABORABLES_SEMANA = 6  // L-S

const toIso = (d) => new Date(d).toISOString().slice(0, 10)

/**
 * Carga los festivos que caen dentro de [desde, hasta] como Set<YYYY-MM-DD>.
 * Idempotente. Devuelve Set vacio si el rango es invalido o esta vacio.
 */
export async function cargarFestivosDelRango(desde, hasta, prisma = prismaDefault) {
  if (!desde || !hasta) return new Set()
  const rows = await prisma.holiday.findMany({
    where: { date: { gte: new Date(desde), lte: new Date(hasta) } },
    select: { date: true },
  })
  return new Set(rows.map((f) => toIso(f.date)))
}

/**
 * True si la fecha es domingo (dow=0) o esta en el set de festivos.
 * Acepta Date o "YYYY-MM-DD".
 */
export function esDomingoOFestivo(fecha, festivosSet = new Set()) {
  if (!fecha) return false
  const d = typeof fecha === 'string'
    ? new Date(`${fecha.slice(0, 10)}T00:00:00Z`)
    : new Date(fecha)
  if (Number.isNaN(d.getTime())) return false
  if (d.getUTCDay() === 0) return true
  return festivosSet.has?.(toIso(d)) ?? false
}

/**
 * Cuenta festivos LABORABLES en la semana:
 *   lv  = festivos en dow 1..5 (descuentan 720 min c/u)
 *   sab = festivos en dow 6   (descuentan 240 min c/u)
 * El domingo NO cuenta — ya esta fuera de la base teorica.
 */
export function contarFestivosEnSemana(semana, festivosSet = new Set()) {
  let lv = 0
  let sab = 0
  if (!semana) return { lv, sab }
  const cursor = new Date(semana.startDate)
  const fin = new Date(semana.endDate)
  while (cursor <= fin) {
    if (festivosSet.has(toIso(cursor))) {
      const dow = cursor.getUTCDay()
      if (dow >= 1 && dow <= 5) lv++
      else if (dow === 6) sab++
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return { lv, sab }
}

/**
 * Minutos base efectivos de la semana (base teorica menos festivos laborables).
 * Nunca negativo — una semana 100% festiva (hipotetica) da 0.
 *
 * Cuando semana es null/undefined devolvemos 0 (no la base teorica) para que
 * los callers no calculen % de ocupacion contra una semana "generica" cuando
 * en realidad no hay semana identificada. El caller decide como manejar el 0
 * (guard >0 ya presente en dataOcupacion y metricasDeSemanas).
 */
export function minutosBaseSemana(semana, festivosSet = new Set()) {
  if (!semana) return 0
  const { lv, sab } = contarFestivosEnSemana(semana, festivosSet)
  const base = BASE_MINUTOS_SEMANA_TEORICA - (lv * MINUTOS_DIA_LV) - (sab * MINUTOS_SABADO)
  return Math.max(0, base)
}

/**
 * Dias habiles laborables en la semana (entre 0 y 6). Sirve para recortar
 * el tope individual de asesores y otros calculos "por dia".
 * Semana null/undefined → 0 (misma politica que minutosBaseSemana).
 */
export function diasHabilesEnSemana(semana, festivosSet = new Set()) {
  if (!semana) return 0
  const { lv, sab } = contarFestivosEnSemana(semana, festivosSet)
  return Math.max(0, DIAS_LABORABLES_SEMANA - lv - sab)
}

/**
 * Cuenta meses calendario distintos que toca el rango [desde, hasta].
 * Devuelve >=1 (para evitar division por cero al usar como divisor).
 * Ej: [15-sep, 15-oct] → 2. [1-sep, 30-sep] → 1.
 */
export function contarMesesEnRango(desde, hasta) {
  if (!desde || !hasta) return 1
  const ini = new Date(desde)
  const fin = new Date(hasta)
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime())) return 1
  const keyIni = ini.getUTCFullYear() * 12 + ini.getUTCMonth()
  const keyFin = fin.getUTCFullYear() * 12 + fin.getUTCMonth()
  return Math.max(1, keyFin - keyIni + 1)
}
