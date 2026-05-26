import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const tareaSchema = z.object({
  nombre: z.string().min(1).max(150),
  descripcion: z.string().optional().nullable(),
  tiempoEstimadoMinutos: z.number().int().min(1).max(480),
  activa: z.boolean().optional(),
})

export async function list(req, res) {
  const { all } = req.query
  const where = all === 'true' ? {} : { activa: true }
  const tareas = await prisma.tareaBackoffice.findMany({ where, orderBy: { nombre: 'asc' } })
  res.json(tareas)
}

export async function create(req, res) {
  const data = tareaSchema.parse(req.body)
  const t = await prisma.tareaBackoffice.create({
    data: { ...data, creadaPor: req.user.id, activa: data.activa ?? true },
  })
  res.status(201).json(t)
}

export async function update(req, res) {
  const data = tareaSchema.partial().parse(req.body)
  const t = await prisma.tareaBackoffice.update({ where: { id: req.params.id }, data })
  res.json(t)
}
