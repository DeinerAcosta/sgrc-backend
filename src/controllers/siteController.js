import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const emptyToUndef = (v) => (v === '' ? undefined : v)

const sedeSchema = z.object({
  name: z.string().min(1).max(150),
  city: z.string().min(1).max(100),
  address: z.preprocess(emptyToUndef, z.string().optional().nullable()),
  active: z.boolean().optional(),
  managerId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
})

export async function list(req, res) {
  const { active: activa } = req.query
  const sedes = await prisma.site.findMany({
    where: activa !== undefined ? { active: activa === 'true' } : undefined,
    orderBy: [{ city: 'asc' }, { name: 'asc' }],
    include: { manager: { select: { id: true, name: true, email: true, role: true } } },
  })
  res.json(sedes)
}

export async function getById(req, res) {
  const sede = await prisma.site.findUnique({
    where: { id: req.params.id },
    include: { manager: { select: { id: true, name: true, email: true, role: true } } },
  })
  if (!sede) throw errors.notFound('Sede no encontrada')
  res.json(sede)
}

export async function create(req, res) {
  const data = sedeSchema.parse(req.body)
  const sede = await prisma.site.create({ data })
  res.status(201).json(sede)
}

export async function update(req, res) {
  const data = sedeSchema.partial().parse(req.body)
  const sede = await prisma.site.update({ where: { id: req.params.id }, data })
  res.json(sede)
}

export async function rooms(req, res) {
  const list = await prisma.room.findMany({
    where: { siteId: req.params.id },
  })
  // 1) ÁREA ASESORES siempre arriba (es lo primero que el coordinador atiende).
  // 2) El resto en orden natural numérico (CONSULTORIO 2 < 19A < 20 < 20A) — no alfabético.
  list.sort(ordenConsultorios)
  res.json(list)
}

/**
 * Comparador reutilizable para consultorios.
 * - Asesores (especialidad === 'asesoria') van primero como grupo.
 * - Dentro de cada grupo, orden natural: "CONSULTORIO 2" antes que "CONSULTORIO 19A".
 */
export function ordenConsultorios(a, b) {
  const ae = a.specialty === 'asesoria' ? 0 : 1
  const be = b.specialty === 'asesoria' ? 0 : 1
  if (ae !== be) return ae - be
  return a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' })
}
