/**
 * Itera los días hábiles entre dos fechas inclusive.
 *
 * Reglas:
 *  - Salta DOMINGOS siempre.
 *  - Salta los días en `festivos` (set de strings YYYY-MM-DD).
 *  - SÁBADOS van incluidos pero solo hasta las 12:00. Si el horario solicitado
 *    excede 12:00, el sábado se ajusta a hora_fin = '12:00'. Si la hora_inicio
 *    ya es >= 12:00, ese sábado se omite por completo (sin franja válida).
 *
 * Devuelve [{fecha: 'YYYY-MM-DD', diaSemana: 'lunes'|..., horaInicio, horaFin, ajustado: bool}].
 * Las fechas omitidas (dom/festivo/sab-sin-franja) NO aparecen en el array.
 */

const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const SABADO_MAXIMO = '12:00'

const hhmmAMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const toIso = (d) => d.toISOString().slice(0, 10)

/**
 * @param {string} fechaInicio YYYY-MM-DD
 * @param {string} fechaFin    YYYY-MM-DD
 * @param {string} horaInicio  HH:MM
 * @param {string} horaFin     HH:MM
 * @param {object} opciones
 * @param {Set<string>} opciones.festivos  set de 'YYYY-MM-DD' (default: vacío)
 * @param {boolean} opciones.sabadoMedioDia (default: true) — si false, sábado se trata como domingo (se omite)
 * @returns {Array<{fecha, diaSemana, horaInicio, horaFin, ajustado}>}
 */
export function expandirRangoHabil({ startDate: fechaInicio, endDate: fechaFin, startTime: horaInicio, endTime: horaFin, holidays: festivos = new Set(), sabadoMedioDia = true }) {
  const ini = new Date(fechaInicio + 'T00:00:00Z')
  const fin = new Date(fechaFin + 'T00:00:00Z')
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime())) {
    throw new Error('Fechas inválidas en expandirRangoHabil')
  }
  if (ini > fin) throw new Error('fecha_inicio debe ser <= fecha_fin')

  const out = []
  const cursor = new Date(ini)
  while (cursor <= fin) {
    const dow = cursor.getUTCDay() // 0 = domingo, 6 = sábado
    const fecha = toIso(cursor)
    const esFestivo = festivos.has(fecha)
    const esDomingo = dow === 0
    const esSabado = dow === 6

    if (esDomingo || esFestivo) {
      // Saltar día
    } else if (esSabado) {
      if (!sabadoMedioDia) {
        // configuración: sábado no cuenta
      } else if (hhmmAMin(horaInicio) >= hhmmAMin(SABADO_MAXIMO)) {
        // El inicio ya es >= 12:00 — no hay franja útil
      } else {
        const horaFinAjustada = hhmmAMin(horaFin) > hhmmAMin(SABADO_MAXIMO) ? SABADO_MAXIMO : horaFin
        out.push({
          date: fecha,
          weekday: NOMBRES_DIA[dow],
          startTime: horaInicio,
          endTime: horaFinAjustada,
          ajustado: horaFinAjustada !== horaFin,
        })
      }
    } else {
      out.push({
        date: fecha,
        weekday: NOMBRES_DIA[dow],
        startTime: horaInicio,
        endTime: horaFin,
        ajustado: false,
      })
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Sólo cuenta los días hábiles entre dos fechas (sin generar el array).
 * Útil para el preview del frontend si lo quisiéramos calcular en backend.
 */
export function contarDiasHabiles(args) {
  return expandirRangoHabil(args).length
}
