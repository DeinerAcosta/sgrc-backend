import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const sedeSchema = z.object({
  nombre: z.string().min(1).max(150),
  ciudad: z.string().min(1).max(100),
  direccion: z.string().optional().nullable(),
  activa: z.boolean().optional(),
  responsableId: z.string().uuid().optional().nullable(),
})

export async function list(req, res) {
  const { activa } = req.query
  const sedes = await prisma.sede.findMany({
    where: activa !== undefined ? { activa: activa === 'true' } : undefined,
    orderBy: [{ ciudad: 'asc' }, { nombre: 'asc' }],
    include: { responsable: { select: { id: true, nombre: true, email: true, rol: true } } },
  })
  res.json(sedes)
}

export async function getById(req, res) {
  const sede = await prisma.sede.findUnique({
    where: { id: req.params.id },
    include: { responsable: { select: { id: true, nombre: true, email: true, rol: true } } },
  })
  if (!sede) throw errors.notFound('Sede no encontrada')
  res.json(sede)
}

export async function create(req, res) {
  const data = sedeSchema.parse(req.body)
  const sede = await prisma.sede.create({ data })
  res.status(201).json(sede)
}

export async function update(req, res) {
  const data = sedeSchema.partial().parse(req.body)
  const sede = await prisma.sede.update({ where: { id: req.params.id }, data })
  res.json(sede)
}

export async function consultorios(req, res) {
  const list = await prisma.consultorio.findMany({
    where: { sedeId: req.params.id },
    orderBy: { nombre: 'asc' },
  })
  res.json(list)
}
