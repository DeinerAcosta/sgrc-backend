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

export const MINUTOS_DIA_LV = 720        // 12h L-V  (valor por defecto)
export const MINUTOS_SABADO = 240        // 4h sabado (valor por defecto)
export const BASE_MINUTOS_SEMANA_TEORICA = 5 * MINUTOS_DIA_LV + MINUTOS_SABADO   // 3840 (64h)
export const DIAS_LABORABLES_SEMANA = 6  // L-S

/**
 * BASE HORARIA CONFIGURABLE (sep-2026)
 * ====================================
 * Las 64h semanales por consultorio NO son una constante del negocio: gerencia
 * las ajusta desde Metas del sistema (`base_horas_lun_vie_min` y
 * `base_horas_sabado_min`, en minutos). Los dos parametros YA existian, se
 * guardaban en `parametros_sistema` y se editaban en pantalla — pero ningun
 * calculo los leia: la ocupacion seguia usando las constantes de arriba, asi
 * que cambiar el valor no movia un solo indicador.
 *
 * Ahora la ocupacion se recalcula con lo que este configurado. Si la operacion
 * pasa a 70h semanales, se cambia ahi y los informes siguen.
 *
 * Cache de 60s: estos indicadores recorren muchas semanas y no tiene sentido
 * consultar la tabla de parametros en cada una. Un cambio en Metas se refleja
 * en menos de un minuto, o al instante si el caller invalida la cache.
 */
const BASE_POR_DEFECTO = { lv: MINUTOS_DIA_LV, sab: MINUTOS_SABADO, teorica: BASE_MINUTOS_SEMANA_TEORICA }
const TTL_BASE_MS = 60_000
let _baseCache = null

/** Lee la base horaria configurada: minutos por dia L-V, por sabado, y el total teorico. */
export async function cargarBaseHoraria(prisma = prismaDefault) {
  const ahora = Date.now()
  if (_baseCache && _baseCache.expira > ahora) return _baseCache.valor

  let valor = BASE_POR_DEFECTO
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['base_horas_lun_vie_min', 'base_horas_sabado_min'] } },
    })
    const obj = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]))
    const lv = Number.isFinite(obj.base_horas_lun_vie_min) && obj.base_horas_lun_vie_min > 0
      ? obj.base_horas_lun_vie_min : MINUTOS_DIA_LV
    const sab = Number.isFinite(obj.base_horas_sabado_min) && obj.base_horas_sabado_min >= 0
      ? obj.base_horas_sabado_min : MINUTOS_SABADO
    valor = { lv, sab, teorica: 5 * lv + sab }
  } catch {
    // Si la tabla no responde, preferimos el default antes que tumbar el informe.
    valor = BASE_POR_DEFECTO
  }

  _baseCache = { valor, expira: ahora + TTL_BASE_MS }
  return valor
}

/** Olvida la base cacheada — la llama updateSistema para que el cambio se vea ya. */
export function invalidarBaseHoraria() {
  _baseCache = null
}

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
 * PLAZO DE CIERRE DE UNA SEMANA — primer dia habil despues del domingo
 * =====================================================================
 *
 * La semana operativa termina el DOMINGO. El coordinador tiene todo el dia
 * habil siguiente —normalmente el lunes— hasta las 23:59 para cerrarla a mano.
 * Si ese lunes es FESTIVO, nadie trabaja, asi que el plazo corre al martes.
 *
 * Oct-2026 · Esta regla estaba escrita en un comentario de jobs/autoCloseWeek.js
 * ("o el siguiente dia habil si el lunes es festivo") pero NO estaba
 * implementada: el job restaba 2 dias de calendario y punto. El lunes 12 de
 * octubre de 2026 fue festivo y el sistema cerro la semana igual, el martes a
 * medianoche, quitandole al coordinador su unico dia habil de plazo.
 *
 * El plazo se devuelve como instante UTC correspondiente a las 23:59:59 de
 * BOGOTA, que es cuando de verdad termina el dia del coordinador. Colombia es
 * UTC-5 fijo y sin horario de verano, asi que son las 04:59:59 UTC del dia
 * siguiente. Antes el job hacia `setHours(23,59,59)` sobre un servidor en UTC,
 * y eso registraba el cierre a las 18:59 de Bogota.
 *
 * @param {Date|string} endDate  domingo de fin de la semana (medianoche UTC)
 * @param {Set<string>} festivosSet  fechas ISO de festivos
 * @returns {Date} instante limite; pasado ese momento la semana se puede cerrar
 */
export function deadlineCierreSemana(endDate, festivosSet = new Set()) {
  const dia = proximoDiaHabil(sumarDiasUTC(endDate, 1), festivosSet)
  // 23:59:59 de Bogota = 04:59:59 UTC del dia siguiente (UTC-5 fijo).
  const limite = sumarDiasUTC(dia, 1)
  limite.setUTCHours(4, 59, 59, 0)
  return limite
}

/**
 * Primer dia que NO es domingo ni festivo, empezando por el que se le pasa.
 * Si el dia ya es habil, lo devuelve tal cual.
 *
 * El tope de 15 vueltas es una salvaguarda: si alguien cargara por error un
 * rango enorme de festivos, es preferible cerrar tarde que colgar el job.
 */
export function proximoDiaHabil(fecha, festivosSet = new Set()) {
  let d = new Date(fecha)
  for (let i = 0; i < 15 && esDomingoOFestivo(d, festivosSet); i++) {
    d = sumarDiasUTC(d, 1)
  }
  return d
}

/** Suma dias en UTC sin tocar la hora. Las fechas de solo-dia viven a medianoche UTC. */
function sumarDiasUTC(fecha, dias) {
  const d = new Date(fecha)
  d.setUTCDate(d.getUTCDate() + dias)
  return d
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
export function minutosBaseSemana(semana, festivosSet = new Set(), base = BASE_POR_DEFECTO) {
  if (!semana) return 0
  const { lv, sab } = contarFestivosEnSemana(semana, festivosSet)
  const total = base.teorica - (lv * base.lv) - (sab * base.sab)
  return Math.max(0, total)
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
