/**
 * HORAS DISPONIBLES DE UN RECURSO EN LA SEMANA
 * ============================================
 *
 * Oct-2026 · El dashboard del coordinador marcaba "ociosa" y "Costo fijo sin
 * utilizar" a un técnico que estaba de vacaciones toda la semana: medía sus 0 h
 * contra el tope completo de 42 h. El tope ya descontaba los festivos, pero no
 * las ausencias. El correo diario al coordinador, en cambio, sacaba a cualquiera
 * con una ausencia confirmada esa semana — aunque fuera de un solo día — así que
 * la pantalla y el correo decían cosas distintas.
 *
 * Ahora los dos usan esta cuenta:
 *   · cada día laborable (lunes a sábado, sin festivos) cubierto por una ausencia
 *     de día completo se descuenta del tope, como un festivo;
 *   · un permiso por horas descuenta sus horas;
 *   · si la ausencia cubre todos los días laborables, el recurso está AUSENTE
 *     y no se mide: ni ocioso ni "sin programación".
 *
 * Fechas en UTC, que es como Prisma lee las columnas @db.Date (ver semana.js).
 */

const DIAS_LABORABLES_SEMANA = 6   // lunes a sábado

const diaIso = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)

/** Los días lunes a sábado de la semana que empieza en `lunes`, sin festivos. */
export function diasLaborables(lunes, festivos = []) {
  const fest = new Set(festivos.map(diaIso))
  const base = new Date(diaIso(lunes) + 'T00:00:00Z')
  const dias = []
  for (let i = 0; i < DIAS_LABORABLES_SEMANA; i++) {
    const d = new Date(base)
    d.setUTCDate(base.getUTCDate() + i)
    const iso = diaIso(d)
    if (!fest.has(iso)) dias.push(iso)
  }
  return dias
}

const minutos = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

/**
 * Cuánto le quitan las ausencias a la semana de un recurso.
 * `ausencias`: [{ startDate, endDate, isPartial, absenceStartTime, absenceEndTime, motivo }]
 * Devuelve { diasAusente, horasPermiso, todaLaSemana, motivo }.
 */
export function ausenciaEnSemana(ausencias, laborables) {
  const completos = new Set()
  let motivo = null
  for (const a of ausencias) {
    if (a.isPartial && a.absenceStartTime && a.absenceEndTime) continue
    const ini = diaIso(a.startDate), fin = diaIso(a.endDate ?? a.startDate)
    for (const d of laborables) {
      if (d >= ini && d <= fin) { completos.add(d); motivo ??= a.motivo ?? null }
    }
  }
  let horasPermiso = 0
  for (const a of ausencias) {
    if (!(a.isPartial && a.absenceStartTime && a.absenceEndTime)) continue
    const ini = diaIso(a.startDate), fin = diaIso(a.endDate ?? a.startDate)
    const dias = laborables.filter((d) => d >= ini && d <= fin && !completos.has(d)).length
    horasPermiso += Math.max(0, minutos(a.absenceEndTime) - minutos(a.absenceStartTime)) / 60 * dias
  }
  const todaLaSemana = laborables.length > 0 && completos.size === laborables.length
  if (!todaLaSemana && completos.size === 0 && horasPermiso === 0) motivo = null
  return { diasAusente: completos.size, horasPermiso, todaLaSemana, motivo }
}

/**
 * Tope semanal que le queda al recurso: el nominal, menos festivos, menos días
 * de ausencia, menos horas de permiso. null si no tiene tope (por paciente).
 */
export function horasDisponibles(topeNominal, laborables, { diasAusente = 0, horasPermiso = 0 } = {}) {
  if (topeNominal == null) return null
  const dias = Math.max(0, laborables.length - diasAusente)
  const horas = topeNominal * dias / DIAS_LABORABLES_SEMANA - horasPermiso
  return Math.max(0, Math.round(horas * 10) / 10)
}
