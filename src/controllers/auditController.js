import { prisma } from '../lib/prisma.js'

export async function list(req, res) {
  const { action: accion, user_id: usuario_id, desde, hasta } = req.query
  const where = {}
  if (accion) where.action = accion
  if (usuario_id) where.userId = usuario_id
  if (desde) where.createdAt = { gte: new Date(desde) }
  if (hasta) where.createdAt = { ...(where.createdAt ?? {}), lte: new Date(hasta) }

  const logs = await prisma.auditEntry.findMany({
    where,
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json(logs.map((l) => ({
    ...l,
    usuario_nombre: l.user?.name ?? '?',
  })))
}
