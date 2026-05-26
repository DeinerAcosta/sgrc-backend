import { prisma } from '../lib/prisma.js'

export async function list(req, res) {
  const list = await prisma.notificacion.findMany({
    where: { usuarioId: req.user.id, canal: 'app' },
    orderBy: { creadaEn: 'desc' },
    take: 50,
  })
  res.json(list)
}

export async function leer(req, res) {
  await prisma.notificacion.update({
    where: { id: req.params.id },
    data: { leida: true },
  })
  res.json({ ok: true })
}

export async function leerTodas(req, res) {
  await prisma.notificacion.updateMany({
    where: { usuarioId: req.user.id, leida: false },
    data: { leida: true },
  })
  res.json({ ok: true })
}
