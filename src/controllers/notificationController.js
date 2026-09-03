import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

export async function list(req, res) {
  const list = await prisma.notification.findMany({
    where: { userId: req.user.id, channel: 'app' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json(list)
}

/**
 * PUT /notificaciones/:id/leer
 *
 * Se marca con updateMany y no con update para poder incluir `usuarioId` en el
 * WHERE: antes actualizaba por id a secas, así que cualquier usuario autenticado
 * podía marcar como leída la notificación de otro conociendo su identificador.
 * Si no se toca ninguna fila, la notificación no existe o no es suya — en ambos
 * casos respondemos 404, sin distinguirlos (no revelamos qué ids existen).
 */
export async function leer(req, res) {
  const { count } = await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { read: true },
  })
  if (count === 0) throw errors.notFound('Notificación no encontrada')
  res.json({ ok: true })
}

export async function leerTodas(req, res) {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, read: false },
    data: { read: true },
  })
  res.json({ ok: true })
}
