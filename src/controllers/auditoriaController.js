import { prisma } from '../lib/prisma.js'

export async function list(req, res) {
  const { accion, usuario_id, desde, hasta } = req.query
  const where = {}
  if (accion) where.accion = accion
  if (usuario_id) where.usuarioId = usuario_id
  if (desde) where.creadaEn = { gte: new Date(desde) }
  if (hasta) where.creadaEn = { ...(where.creadaEn ?? {}), lte: new Date(hasta) }

  const logs = await prisma.auditoria.findMany({
    where,
    include: { usuario: { select: { nombre: true } } },
    orderBy: { creadaEn: 'desc' },
    take: 200,
  })
  res.json(logs.map((l) => ({
    ...l,
    usuario_nombre: l.usuario?.nombre ?? '?',
  })))
}
