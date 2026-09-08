import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

// PROYECTOS-3255 #4.1 · Módulo Queja (MVP).
//
// Interpretación (a validar con Maremys): las quejas son incidentes que se
// registran sobre un recurso, con o sin ausencia vinculada. El coordinador
// crea la queja desde su sede; supervisor/gerencia/directivo pueden verlas
// todas y cambiar el estado (atender / resolver / desestimar).

const ORIGENES = ['paciente', 'interno', 'directivo']
const PRIORIDADES = ['baja', 'media', 'alta']
const ESTADOS = ['pendiente', 'en_atencion', 'resuelta', 'desestimada']

const emptyToUndef = (v) => (v === '' ? undefined : v)

const crearSchema = z.object({
  resourceId: z.string().uuid(),
  siteId: z.string().uuid(),
  absenceId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  source: z.enum(ORIGENES),
  description: z.string().min(3).max(2000),
  priority: z.enum(PRIORIDADES).default('media'),
  notes: z.preprocess(emptyToUndef, z.string().max(2000).optional().nullable()),
})

const actualizarSchema = z.object({
  status: z.enum(ESTADOS).optional(),
  priority: z.enum(PRIORIDADES).optional(),
  notes: z.preprocess(emptyToUndef, z.string().max(2000).optional().nullable()),
})

/** GET /complaints — lista con filtros. Coord solo ve las de sus sedes. */
export async function list(req, res) {
  const { site_id, status, priority, resource_id, desde, hasta } = req.query
  const where = {}
  if (site_id) where.siteId = site_id
  if (status) where.status = status
  if (priority) where.priority = priority
  if (resource_id) where.resourceId = resource_id
  if (desde || hasta) {
    where.createdAt = {}
    if (desde) where.createdAt.gte = new Date(desde)
    if (hasta) where.createdAt.lte = new Date(`${hasta}T23:59:59.999Z`)
  }

  // RN-Q1: coordinador solo ve las quejas de sus sedes autorizadas. Supervisor,
  // gerencia y directivo ven todas (para tomar decisiones globales).
  if (req.user.role === 'coordinador') {
    const sedes = await prisma.userSite.findMany({
      where: { userId: req.user.id },
      select: { siteId: true },
    })
    const sedeIds = sedes.map((s) => s.siteId)
    if (sedeIds.length === 0) return res.json([])
    where.siteId = { in: sedeIds }
    if (site_id) {
      // Si tambien filtro por site_id, respetar la interseccion.
      where.siteId = sedeIds.includes(site_id) ? site_id : { in: [] }
    }
  }

  const rows = await prisma.complaint.findMany({
    where,
    include: {
      resource: { select: { id: true, name: true, type: true } },
      site: { select: { id: true, name: true } },
      absence: { select: { id: true, startDate: true, endDate: true, reason: true } },
    },
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  })
  res.json(rows)
}

export async function getById(req, res) {
  const r = await prisma.complaint.findUnique({
    where: { id: req.params.id },
    include: {
      resource: { select: { id: true, name: true, type: true } },
      site: { select: { id: true, name: true } },
      absence: { select: { id: true, startDate: true, endDate: true, reason: true } },
    },
  })
  if (!r) throw errors.notFound()
  res.json(r)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const complaint = await prisma.complaint.create({
    data: {
      ...data,
      reportedBy: req.user.id,
      status: 'pendiente',
    },
    include: {
      resource: { select: { id: true, name: true, type: true } },
      site: { select: { id: true, name: true } },
    },
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'crear_queja',
    entity: 'quejas',
    entityId: complaint.id,
    newValue: { resourceId: complaint.resourceId, source: complaint.source, priority: complaint.priority },
    ipAddress: getIp(req),
  })
  res.status(201).json(complaint)
}

export async function update(req, res) {
  const data = actualizarSchema.parse(req.body)
  const anterior = await prisma.complaint.findUnique({ where: { id: req.params.id } })
  if (!anterior) throw errors.notFound()

  // Coord solo puede cambiar quejas de sus sedes. Supervisor/gerencia/directivo, todas.
  if (req.user.role === 'coordinador') {
    const perteneceASuSede = await prisma.userSite.findFirst({
      where: { userId: req.user.id, siteId: anterior.siteId },
    })
    if (!perteneceASuSede) throw errors.forbidden('No puede modificar quejas de sedes ajenas')
  }

  const patch = { ...data }
  // Si pasa a resuelta/desestimada, marcar quien atendio y cuando
  const cambiaEstadoFinal = data.status && ['resuelta', 'desestimada'].includes(data.status)
    && !['resuelta', 'desestimada'].includes(anterior.status)
  if (cambiaEstadoFinal) {
    patch.attendedBy = req.user.id
    patch.resolvedAt = new Date()
  }
  // Si pasa a en_atencion, marcar quien atiende
  if (data.status === 'en_atencion' && anterior.status !== 'en_atencion') {
    patch.attendedBy = req.user.id
  }

  const updated = await prisma.complaint.update({
    where: { id: req.params.id },
    data: patch,
    include: {
      resource: { select: { id: true, name: true, type: true } },
      site: { select: { id: true, name: true } },
    },
  })

  if (data.status && data.status !== anterior.status) {
    await registrarAuditoria({
      userId: req.user.id,
      action: 'cambiar_estado_queja',
      entity: 'quejas',
      entityId: updated.id,
      oldValue: { status: anterior.status },
      newValue: { status: updated.status },
      ipAddress: getIp(req),
    })
  }
  res.json(updated)
}

/** DELETE /complaints/:id — solo supervisor/gerencia, y auditado. */
export async function remove(req, res) {
  const anterior = await prisma.complaint.findUnique({ where: { id: req.params.id } })
  if (!anterior) throw errors.notFound()
  await prisma.complaint.delete({ where: { id: req.params.id } })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'eliminar_queja',
    entity: 'quejas',
    entityId: req.params.id,
    oldValue: anterior,
    ipAddress: getIp(req),
  })
  res.status(204).send()
}
