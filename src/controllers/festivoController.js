import { z } from 'zod'
import { prisma } from '../lib/prisma.js'

const festivoSchema = z.object({
  fecha: z.string(), // YYYY-MM-DD
  descripcion: z.string().min(1).max(200),
})

export async function list(req, res) {
  const { desde, hasta } = req.query
  const where = {}
  if (desde) where.fecha = { gte: new Date(desde) }
  if (hasta) where.fecha = { ...(where.fecha ?? {}), lte: new Date(hasta) }
  const festivos = await prisma.festivo.findMany({ where, orderBy: { fecha: 'asc' } })
  res.json(festivos)
}

export async function create(req, res) {
  const data = festivoSchema.parse(req.body)
  const f = await prisma.festivo.create({
    data: { fecha: new Date(data.fecha), descripcion: data.descripcion },
  })
  res.status(201).json(f)
}

export async function remove(req, res) {
  await prisma.festivo.delete({ where: { fecha: new Date(req.params.fecha) } })
  res.json({ ok: true })
}
