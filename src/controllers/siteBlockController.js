import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { isoDia } from '../lib/bloqueosSede.js'

// ============================================================================
// Oct-2026 · BLOQUEOS DE SEDE (PROYECTOS-3583 §5) · ver lib/bloqueosSede.js
// Los ponen y levantan supervisor y gerencia (las rutas lo exigen). Se
// levantan en vez de borrarse: queda quién la bloqueó, por qué y cuándo se abrió.
// ============================================================================

const crearSchema = z.object({
  siteId: z.string().uuid('Elija la sede'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha desde inválida'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha hasta inválida'),
  reason: z.string().trim().min(5, 'Escriba el motivo (mínimo 5 caracteres)').max(500),
})

const serializar = (b) => ({
  id: b.id,
  site_id: b.siteId,
  site_name: b.site?.name ?? null,
  start_date: isoDia(b.startDate),
  end_date: isoDia(b.endDate),
  reason: b.reason,
  created_by_name: b.creador?.name ?? null,
  created_at: b.createdAt,
  lifted_at: b.liftedAt,
  lifted_by_name: b.levantador?.name ?? null,
})

const conNombres = async (filas) => {
  const ids = [...new Set(filas.flatMap((b) => [b.createdBy, b.liftedBy]).filter(Boolean))]
  const usuarios = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
    .map((u) => [u.id, u]))
  return filas.map((b) => serializar({ ...b, creador: usuarios.get(b.createdBy), levantador: usuarios.get(b.liftedBy) }))
}

/** GET /site-blocks · vigentes y futuros (con ?todos=1, también los levantados y vencidos). */
export async function list(req, res) {
  const hoy = new Date(isoDia(new Date()))
  const filas = await prisma.siteBlock.findMany({
    where: req.query.todos ? {} : { liftedAt: null, endDate: { gte: hoy } },
    include: { site: { select: { name: true } } },
    orderBy: [{ startDate: 'asc' }],
  })
  res.json(await conNombres(filas))
}

/** POST /site-blocks */
export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  if (data.endDate < data.startDate) throw errors.badRequest('La fecha hasta no puede ser anterior a la fecha desde')
  const sede = await prisma.site.findUnique({ where: { id: data.siteId }, select: { id: true, name: true } })
  if (!sede) throw errors.notFound('Sede no encontrada')
  const solapado = await prisma.siteBlock.findFirst({
    where: { siteId: sede.id, liftedAt: null, startDate: { lte: new Date(data.endDate) }, endDate: { gte: new Date(data.startDate) } },
  })
  if (solapado) {
    throw errors.badRequest(`La sede ya está bloqueada del ${isoDia(solapado.startDate)} al ${isoDia(solapado.endDate)}.`)
  }
  const b = await prisma.siteBlock.create({
    data: {
      siteId: sede.id, startDate: new Date(data.startDate), endDate: new Date(data.endDate),
      reason: data.reason, createdBy: req.user.id,
    },
    include: { site: { select: { name: true } } },
  })
  await registrarAuditoria({
    userId: req.user.id, action: 'sede_bloquear', entity: 'sedes', entityId: sede.id,
    newValue: { bloqueoId: b.id, sede: sede.name, desde: data.startDate, hasta: data.endDate },
    reason: data.reason, ipAddress: getIp(req),
  })
  res.status(201).json((await conNombres([b]))[0])
}

/** PUT /site-blocks/:id/lift */
export async function lift(req, res) {
  const b = await prisma.siteBlock.findUnique({ where: { id: req.params.id }, include: { site: { select: { name: true } } } })
  if (!b) throw errors.notFound('Bloqueo no encontrado')
  if (b.liftedAt) throw errors.badRequest('Ese bloqueo ya se levantó')
  const actualizado = await prisma.siteBlock.update({
    where: { id: b.id },
    data: { liftedAt: new Date(), liftedBy: req.user.id },
    include: { site: { select: { name: true } } },
  })
  await registrarAuditoria({
    userId: req.user.id, action: 'sede_desbloquear', entity: 'sedes', entityId: b.siteId,
    oldValue: { bloqueoId: b.id, sede: b.site?.name, desde: isoDia(b.startDate), hasta: isoDia(b.endDate) },
    ipAddress: getIp(req),
  })
  res.json((await conNombres([actualizado]))[0])
}
