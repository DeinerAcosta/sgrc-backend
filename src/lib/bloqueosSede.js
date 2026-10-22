/**
 * BLOQUEO DE UNA SEDE COMPLETA (PROYECTOS-3583 §5)
 *
 * Supervisor y gerencia bloquean una sede por unas fechas cuando no hay
 * disponibilidad. Mientras dure:
 *   - no se programa en ella (crear, editar ni copiar turnos), y
 *   - no cuenta en los informes de ocupación: sus días bloqueados se tratan
 *     como festivos de esa sede, así que salen de la base de horas.
 *
 * Las fechas van como "YYYY-MM-DD", igual que los festivos (lib/calendario):
 * las de solo-día se guardan a medianoche UTC y se comparan como texto.
 * Las funciones de arriba son puras, para probarlas sin base de datos.
 */
const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

export const isoDia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)

/** La fecha ("YYYY-MM-DD") de un día de la semana, por nombre. */
export function fechaDeTurno(inicioSemana, weekday) {
  const d = new Date(isoDia(inicioSemana) + 'T00:00:00Z')
  for (let i = 0; i < 7; i++) {
    if (NOMBRES_DIA[d.getUTCDay()] === weekday) return isoDia(d)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return null
}

/** El bloqueo vigente que cubre esa sede ese día, o null. */
export function bloqueoQueCubre(bloqueos, siteId, fecha) {
  const f = isoDia(fecha)
  return bloqueos.find((b) => b.siteId === siteId && !b.liftedAt && isoDia(b.desde) <= f && f <= isoDia(b.hasta)) ?? null
}

/** Los días bloqueados de una sede dentro de [desde, hasta], como Set de "YYYY-MM-DD". */
export function diasBloqueados(bloqueos, siteId, desde, hasta) {
  const dias = new Set()
  const fin = isoDia(hasta)
  for (const b of bloqueos) {
    if (b.siteId !== siteId || b.liftedAt) continue
    const d = new Date((isoDia(b.desde) > isoDia(desde) ? isoDia(b.desde) : isoDia(desde)) + 'T00:00:00Z')
    const tope = isoDia(b.hasta) < fin ? isoDia(b.hasta) : fin
    while (isoDia(d) <= tope) {
      dias.add(isoDia(d))
      d.setUTCDate(d.getUTCDate() + 1)
    }
  }
  return dias
}

/** El texto con el que se rechaza programar en una sede bloqueada. */
export const mensajeBloqueo = (b, nombreSede) =>
  `La sede ${nombreSede} está bloqueada del ${isoDia(b.desde)} al ${isoDia(b.hasta)} (${b.reason}). No se puede programar en ella.`

/** Los bloqueos vigentes que tocan [desde, hasta]. `client` es Prisma o una transacción. */
export function cargarBloqueos(client, desde, hasta, siteIds = null) {
  return client.siteBlock.findMany({
    where: {
      liftedAt: null,
      startDate: { lte: new Date(isoDia(hasta)) },
      endDate: { gte: new Date(isoDia(desde)) },
      ...(siteIds ? { siteId: { in: siteIds } } : {}),
    },
  }).then((filas) => filas.map((b) => ({ ...b, desde: b.startDate, hasta: b.endDate })))
}
