/**
 * TRAMOS DE UNA FRANJA (oct-2026)
 * ===============================
 *
 * Cuando el médico que cubre no alcanza para todos los pacientes, la franja se
 * parte POR HORAS: cada médico toma un tramo del horario en el mismo
 * consultorio. Decisión de Hector, entre tres opciones: "partir la franja por
 * horas". Cada paciente conserva su hora y su consultorio; solo cambia quién
 * lo atiende. Al paciente de las 09:30 se le dice "misma hora, mismo
 * consultorio, lo atiende la Dra. Montoya".
 *
 * Funciones puras, sin base de datos, para poder probarlas solas.
 */

/** "HH:mm" → minutos desde medianoche. */
export const aMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
/** minutos → "HH:mm". */
export const aHHmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/**
 * Lo que falta por cubrir de una franja, dados los tramos ya cubiertos.
 *
 * Los tramos pueden venir desordenados, solaparse o salirse de la franja: se
 * recortan a la franja y se funden antes de restar. Devuelve los huecos en
 * orden, como [{ desde, hasta }] en "HH:mm".
 *
 * @param {{desde:string, hasta:string}} franja
 * @param {Array<{desde:string, hasta:string}>} cubiertos
 */
export function huecosDeFranja(franja, cubiertos) {
  const ini = aMinutos(franja.desde)
  const fin = aMinutos(franja.hasta)
  const tramos = cubiertos
    .map((t) => [Math.max(ini, aMinutos(t.desde)), Math.min(fin, aMinutos(t.hasta))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])

  const huecos = []
  let cursor = ini
  for (const [a, b] of tramos) {
    if (a > cursor) huecos.push({ desde: aHHmm(cursor), hasta: aHHmm(a) })
    cursor = Math.max(cursor, b)
  }
  if (cursor < fin) huecos.push({ desde: aHHmm(cursor), hasta: aHHmm(fin) })
  return huecos
}

/**
 * Cuántos de los pacientes de la franja caen en un tramo.
 *
 * Proporcional a la duración, pero con redondeo ACUMULADO: se redondea hasta
 * dónde llega cada borde y se resta. Así los tramos de cualquier partición
 * suman EXACTAMENTE los pacientes de la franja. Redondear cada tramo por
 * separado puede dar 10 = 3 + 3 + 3, y entonces el caso no se cerraría nunca
 * con la franja entera cubierta.
 *
 * @param {number} pacientes  pacientes de toda la franja
 * @param {{desde:string, hasta:string}} franja
 * @param {{desde:string, hasta:string}} tramo   debe caer dentro de la franja
 */
export function pacientesDelTramo(pacientes, franja, tramo) {
  const ini = aMinutos(franja.desde)
  const dur = aMinutos(franja.hasta) - ini
  if (dur <= 0 || !pacientes) return 0
  const hastaDonde = (hhmm) => {
    const m = Math.min(Math.max(aMinutos(hhmm) - ini, 0), dur)
    return Math.round((pacientes * m) / dur)
  }
  return Math.max(0, hastaDonde(tramo.hasta) - hastaDonde(tramo.desde))
}

/**
 * Hasta qué hora atiende quien toma `n` pacientes empezando en `desde`.
 *
 * Oct-2026 · En la pantalla del caso ya no se eligen horas: al pulsar Asignar
 * se pregunta cuántos pacientes atiende ese médico (Hector: "me debe salir un
 * modal diciendo cuántos pacientes puede, y así poder seleccionar a más de
 * uno"). La hora sale de aquí. Copia exacta de la del frontend
 * (sgrc-frontend/src/utils/tramos.js): si una cambia, la otra también.
 *
 * Devuelve una hora con la que pacientesDelTramo(desde → hora) da justo n.
 */
export function horaDeCorte(pacientes, franja, desde, n) {
  const ini = aMinutos(franja.desde)
  const fin = aMinutos(franja.hasta)
  const dur = fin - ini
  if (dur <= 0 || !pacientes || n <= 0) return desde
  const acumulado = (m) => Math.round((pacientes * Math.min(Math.max(m, 0), dur)) / dur)
  const objetivo = acumulado(aMinutos(desde) - ini) + n
  if (objetivo >= pacientes) return franja.hasta

  const exacto = Math.round((dur * objetivo) / pacientes)
  const candidatos = [Math.round(exacto / 5) * 5, exacto]
  for (let d = 1; d <= dur; d++) candidatos.push(exacto - d, exacto + d)
  const m = candidatos.find((x) => x > aMinutos(desde) - ini && x <= dur && acumulado(x) === objetivo)
  return m == null ? franja.hasta : aHHmm(ini + m)
}

/**
 * La parte de un turno que tumba una ausencia, con sus pacientes.
 *
 * Oct-2026 · Hector eligió "solo las horas que faltó". Hasta ahora el sistema
 * contaba una ausencia parcial de dos formas que no cuadraban: al registrarla,
 * horas que falta ÷ 10 h × TODOS los turnos del día (también los de la tarde);
 * en la pantalla del caso, el turno entero que se cruzara. El Dr. Ortega, que
 * faltaba de 07:00 a 13:00 con 22 pacientes en la mañana y 22 en la tarde,
 * salía con 26 en el registro y 22 en el caso. Ahora todos usan esto.
 *
 *   · día completo, o parcial sin horas cargadas → el turno entero
 *   · parcial → solo lo que cae dentro de su horario, con los pacientes de esa
 *     parte (mismo redondeo que pacientesDelTramo)
 *   · si no se cruzan → null: ese turno no se cayó
 *
 * @param {{startTime:string, endTime:string, patientCapacity?:number}} turno
 * @param {{isPartial?:boolean, absenceStartTime?:string, absenceEndTime?:string}} ausencia
 * @returns {{desde:string, hasta:string, pacientes:number} | null}
 */
export function parteAfectada(turno, ausencia) {
  const entero = { desde: turno.startTime, hasta: turno.endTime, pacientes: turno.patientCapacity ?? 0 }
  if (!ausencia.isPartial || !ausencia.absenceStartTime || !ausencia.absenceEndTime) return entero
  const desde = turno.startTime > ausencia.absenceStartTime ? turno.startTime : ausencia.absenceStartTime
  const hasta = turno.endTime < ausencia.absenceEndTime ? turno.endTime : ausencia.absenceEndTime
  if (desde >= hasta) return null
  if (desde === turno.startTime && hasta === turno.endTime) return entero
  return {
    desde,
    hasta,
    pacientes: pacientesDelTramo(entero.pacientes, { desde: turno.startTime, hasta: turno.endTime }, { desde, hasta }),
  }
}

/**
 * ¿Dos ausencias del mismo recurso se cruzan? (Oct-2026)
 *
 * Un asesor pidió permiso de 08:00 a 09:00, se le extendió hasta las 10:30 y
 * la coordinadora registró otro de 09:00 a 10:30 el mismo día. El anti-
 * duplicado solo miraba las fechas y lo rechazó como "ya registrada". Son dos
 * permisos distintos, cada uno con sus horas y sus pacientes.
 *
 *   · las fechas no se tocan                     → no se cruzan
 *   · alguna es de día completo (o sin horas)    → se cruzan
 *   · las dos parciales con horas                → se cruzan solo si los
 *     horarios se pisan; terminar a las 09:00 y empezar a las 09:00 no es pisar
 *
 * Las fechas son 'YYYY-MM-DD' (o Date a medianoche UTC) y las horas "HH:mm".
 */
export function ausenciasSeCruzan(a, b) {
  const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)
  if (dia(a.startDate) > dia(b.endDate) || dia(a.endDate) < dia(b.startDate)) return false
  const conHoras = (x) => x.isPartial && x.absenceStartTime && x.absenceEndTime
  if (!conHoras(a) || !conHoras(b)) return true
  return a.absenceStartTime < b.absenceEndTime && a.absenceEndTime > b.absenceStartTime
}
