import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

// Util: kebab/snake de un string libre para usar como codigo único.
const slugify = (s) =>
  s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

// Familias válidas — alineadas al tablero FOCA de reprogramaciones (ago-2026).
export const FAMILIAS_MOTIVO = [
  'ausencia_profesional',
  'reprogramacion_operativa',
  'ajuste_cupos',
  'movilidad_regional',
  'calendario_festivo',
  'otros',
]

export const FAMILIAS_MOTIVO_LABEL = {
  ausencia_profesional: 'Ausencia profesional',
  reprogramacion_operativa: 'Reprogramación operativa',
  ajuste_cupos: 'Ajuste de cupos',
  movilidad_regional: 'Movilidad / Regional',
  calendario_festivo: 'Calendario / Festivo',
  otros: 'Otros',
}

const familiaSchema = z.enum(FAMILIAS_MOTIVO)

const crearSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(2000).optional().nullable(),
  family: familiaSchema.default('ausencia_profesional'),
  impactFactor: z.coerce.number().min(0).max(1).default(1),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
})

const actualizarSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  family: familiaSchema.optional(),
  impactFactor: z.coerce.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
})

/**
 * GET /motivos-ausencia
 * Query: ?soloActivos=true (default false — lista todos)
 * Pública para usuarios autenticados (el modal de registrar ausencia la consume).
 */
export async function list(req, res) {
  const soloActivos = req.query.soloActivos === 'true'
  const where = soloActivos ? { active: true } : {}
  const motivos = await prisma.absenceReason.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  res.json(motivos.map(toApi))
}

export async function getById(req, res) {
  const m = await prisma.absenceReason.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { absences: true } } },
  })
  if (!m) throw errors.notFound('Motivo no encontrado')
  res.json({ ...toApi(m), totalAusencias: m._count.absences })
}

/**
 * POST /motivos-ausencia (gerencia/supervisor)
 * Solo motivos personalizados (esSistema=false). El código se genera del nombre.
 */
export async function crear(req, res) {
  const body = crearSchema.parse(req.body)

  // Generar código único basado en el nombre
  let codigo = slugify(body.name)
  if (!codigo) throw errors.badRequest('El nombre no puede generar un código válido')

  // Si ya existe el código, agregar sufijo numérico
  const existe = await prisma.absenceReason.findUnique({ where: { code: codigo } })
  if (existe) {
    let n = 2
    while (await prisma.absenceReason.findUnique({ where: { code: `${codigo}_${n}` } })) n++
    codigo = `${codigo}_${n}`
  }

  const m = await prisma.absenceReason.create({
    data: {
      code: codigo,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      family: body.family,
      impactFactor: body.impactFactor,
      sortOrder: body.sortOrder,
      isSystem: false,
      active: true,
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'motivo_ausencia_crear',
    entity: 'motivo_ausencia',
    entityId: m.id,
    newValue: {
      code: m.code,
      name: m.name,
      family: m.family,
      impactFactor: Number(m.impactFactor),
    },
    reason: 'Creación de motivo de ausencia personalizado',
    ipAddress: getIp(req),
  })

  res.status(201).json(toApi(m))
}

/**
 * PUT /motivos-ausencia/:id (gerencia/supervisor)
 * Los del sistema solo pueden editar nombre/descripcion/factor/orden — no activo.
 */
export async function actualizar(req, res) {
  const body = actualizarSchema.parse(req.body)
  const actual = await prisma.absenceReason.findUnique({ where: { id: req.params.id } })
  if (!actual) throw errors.notFound('Motivo no encontrado')

  if (actual.isSystem && body.active === false) {
    throw errors.badRequest('Los motivos del sistema no se pueden desactivar — solo se editan')
  }

  const data = {}
  if (body.name !== undefined) data.name = body.name.trim()
  if (body.description !== undefined) data.description = body.description?.trim() || null
  if (body.family !== undefined) data.family = body.family
  if (body.impactFactor !== undefined) data.impactFactor = body.impactFactor
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
  if (body.active !== undefined && !actual.isSystem) data.active = body.active

  if (Object.keys(data).length === 0) {
    return res.json(toApi(actual))
  }

  const m = await prisma.absenceReason.update({
    where: { id: actual.id },
    data,
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'motivo_ausencia_actualizar',
    entity: 'motivo_ausencia',
    entityId: m.id,
    oldValue: {
      name: actual.name,
      description: actual.description,
      family: actual.family,
      impactFactor: Number(actual.impactFactor),
      active: actual.active,
      sortOrder: actual.sortOrder,
    },
    newValue: {
      name: m.name,
      description: m.description,
      family: m.family,
      impactFactor: Number(m.impactFactor),
      active: m.active,
      sortOrder: m.sortOrder,
    },
    reason: 'Edición de motivo de ausencia',
    ipAddress: getIp(req),
  })

  res.json(toApi(m))
}

/**
 * DELETE /motivos-ausencia/:id (gerencia/supervisor)
 * Soft-delete: marca activo=false. NO borra de la BD para no romper FK con
 * ausencias históricas. Los del sistema no se pueden desactivar.
 */
export async function desactivar(req, res) {
  const actual = await prisma.absenceReason.findUnique({ where: { id: req.params.id } })
  if (!actual) throw errors.notFound('Motivo no encontrado')
  if (actual.isSystem) {
    throw errors.badRequest('Los motivos del sistema no se pueden desactivar')
  }
  const m = await prisma.absenceReason.update({
    where: { id: actual.id },
    data: { active: false },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'motivo_ausencia_desactivar',
    entity: 'motivo_ausencia',
    entityId: m.id,
    reason: 'Desactivación de motivo personalizado',
    ipAddress: getIp(req),
  })

  res.json({ ok: true, reason: toApi(m) })
}

// Helper: Prisma Decimal → number en respuestas
function toApi(m) {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    description: m.description,
    family: m.family,
    familia_label: FAMILIAS_MOTIVO_LABEL[m.family] ?? 'Otros',
    impact_factor: Number(m.impactFactor),
    active: m.active,
    is_system: m.isSystem,
    sortOrder: m.sortOrder,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  }
}

// Endpoint auxiliar para poblar el select de familias en el UI.
export async function listarFamilias(_req, res) {
  res.json(FAMILIAS_MOTIVO.map((f) => ({ value: f, label: FAMILIAS_MOTIVO_LABEL[f] })))
}
