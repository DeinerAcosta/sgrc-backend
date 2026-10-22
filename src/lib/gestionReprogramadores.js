import { pacientesDelCaso } from './pacientesDelCaso.js'

/**
 * La gestión de cada reprogramador en un período (PROYECTOS-3398 §6.1 · 3660).
 *
 * "Un informe que cuente, por período y por asesor de reprogramación: cuántas
 * agendas se reprogramaron, cuántas las cubrió otro, cuántas se perdieron".
 * Con el flujo de oct-2026 eso se lee así:
 *   - con turno nuevo: los pacientes que quedaron con otro médico u otro día
 *     (reemplazo o agenda movida), topados a los pacientes del caso;
 *   - por llamada: el resto de los pacientes del caso;
 *   - de las llamadas: contestaron, no contestaron y los que faltan por llamar.
 *
 * Pura, para probarla sin base de datos. `cubiertoDe` es un Map
 * ausenciaId → pacientes en turnos nuevos.
 */
export function resumirGestion(casos, cubiertoDe = new Map(), nombres = new Map()) {
  const filas = new Map()
  const fila = (id) => {
    if (!filas.has(id)) {
      filas.set(id, {
        id, nombre: nombres.get(id) ?? 'Usuario retirado',
        casos: 0, llamando: 0, terminados: 0,
        pacientes: 0, con_turno_nuevo: 0, por_llamada: 0,
        llamados: 0, contestaron: 0, no_contestaron: 0, por_llamar: 0,
      })
    }
    return filas.get(id)
  }
  for (const c of casos) {
    if (!c.reschedulerId) continue
    const f = fila(c.reschedulerId)
    const total = pacientesDelCaso(c)
    const cubiertos = Math.min(total, cubiertoDe.get(c.id) ?? 0)
    const contestaron = c.patientsReached ?? 0
    const noContestaron = c.patientsNoAnswer ?? 0
    f.casos++
    if (c.rescheduleStatus === 'resuelta') f.terminados++
    else f.llamando++
    f.pacientes += total
    f.con_turno_nuevo += cubiertos
    f.por_llamada += total - cubiertos
    f.contestaron += contestaron
    f.no_contestaron += noContestaron
    f.llamados += contestaron + noContestaron
    f.por_llamar += Math.max(0, total - contestaron - noContestaron)
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
  const conPct = (f) => ({ ...f, pct_contestaron: pct(f.contestaron, f.llamados), pct_terminados: pct(f.terminados, f.casos) })
  const lista = [...filas.values()]
    .map(conPct)
    .sort((a, b) => b.casos - a.casos || a.nombre.localeCompare(b.nombre, 'es'))
  const CAMPOS = ['casos', 'llamando', 'terminados', 'pacientes', 'con_turno_nuevo', 'por_llamada',
    'llamados', 'contestaron', 'no_contestaron', 'por_llamar']
  const totales = conPct({
    id: null,
    nombre: 'Total',
    ...Object.fromEntries(CAMPOS.map((k) => [k, lista.reduce((acc, f) => acc + f[k], 0)])),
  })
  return { reprogramadores: lista, totales }
}
