import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const ESPECIALIDADES = ['oftalmologia', 'optometria', 'anestesiologia', 'diagnostico']
const REQUIEREN_AUX = new Set(['oftalmologia', 'anestesiologia'])

const consSchema = z.object({
  sedeId: z.string().uuid().optional(),
  nombre: z.string().min(1).max(100),
  especialidad: z.enum(ESPECIALIDADES),
  activo: z.boolean().optional(),
})

export async function list(req, res) {
  const { sede_id, activo } = req.query
  const where = {}
  if (sede_id) where.sedeId = sede_id
  if (activo !== undefined) where.activo = activo === 'true'
  const list = await prisma.consultorio.findMany({ where, orderBy: { nombre: 'asc' } })
  res.json(list)
}

export async function create(req, res) {
  const data = consSchema.parse(req.body)
  if (!data.sedeId) throw errors.badRequest('sedeId requerido')
  const cons = await prisma.consultorio.create({
    data: {
      sedeId: data.sedeId,
      nombre: data.nombre,
      especialidad: data.especialidad,
      requiereAuxiliar: REQUIEREN_AUX.has(data.especialidad),
      activo: data.activo ?? true,
    },
  })
  res.status(201).json(cons)
}

export async function update(req, res) {
  const data = consSchema.partial().parse(req.body)
  if (data.especialidad) {
    data.requiereAuxiliar = REQUIEREN_AUX.has(data.especialidad)
  }
  const cons = await prisma.consultorio.update({ where: { id: req.params.id }, data })
  res.json(cons)
}
