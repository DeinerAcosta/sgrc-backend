import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar } from '../services/notificationService.js'

/**
 * Módulo: Solicitudes de recurso entre sedes (#131).
 *
 * Resuelve el caso de un coordinador que necesita usar un recurso en una sede
 * que NO le pertenece (préstamo) o requiere que se cree un recurso nuevo
 * (alta_nueva) para una sede determinada.
 *
 * Flujo:
 *   1. Coord crea solicitud (estado: pendiente).
 *   2. Supervisor recibe notificación.
 *   3. Supervisor aprueba o rechaza con motivo.
 *      - Si aprueba prestamo: se vincula el Usuario del recurso a la sede destino.
 *      - Si aprueba alta_nueva: queda pendiente la creación manual del recurso por
 *        parte del supervisor (luego él lo asocia llamando PUT /:id/asociar-recurso).
 *   4. Coord ve el estado actualizado y puede usar el recurso si fue aprobada.
 */

const emptyToUndef = (v) => (v === '' ? undefined : v)

const TIPOS_VALIDOS = ['prestamo', 'alta_nueva']
const TIPOS_RECURSO = ['oftalmologo', 'optometra', 'anestesiologo', 'asesor_servicios', 'auxiliar', 'tecnico', 'fonoaudiologa']

const crearSchema = z.object({
  targetSiteId:    z.string().uuid(),
  requestType:    z.enum(TIPOS_VALIDOS),
  resourceId:        z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  newResourceType: z.preprocess(emptyToUndef, z.enum(TIPOS_RECURSO).optional().nullable()),
  specialty:     z.preprocess(emptyToUndef, z.string().max(200).optional().nullable()),
  startWeekId:   z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  endWeekId:      z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  justification:    z.string().min(10).max(2000),
})

const decisionSchema = z.object({
  decisionReason: z.preprocess(emptyToUndef, z.string().min(5).max(1000).optional()),
})

const asociarRecursoSchema = z.object({
  createdResourceId: z.string().uuid(),
})

/**
 * GET /solicitudes-recurso
 * - Coordinador: solo ve las suyas
 * - Supervisor/gerencia: ve todas, filtra por estado opcional
 */
export async function list(req, res) {
  const { status: estado } = req.query
  const where = {}
  if (estado) where.status = estado

  if (req.user.role === 'coordinador') {
    where.requesterId = req.user.id
  }

  const items = await prisma.resourceRequest.findMany({
    where,
    include: {
      requester:  { select: { id: true, name: true, email: true } },
      targetSite:  { select: { id: true, name: true, city: true } },
      resource:      { select: { id: true, name: true, type: true } },
      decidedBy:  { select: { id: true, name: true } },
      startWeek: { select: { id: true, startDate: true, endDate: true } },
      endWeek:    { select: { id: true, startDate: true, endDate: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(items)
}

/** GET /solicitudes-recurso/:id */
export async function getById(req, res) {
  const item = await prisma.resourceRequest.findUnique({
    where: { id: req.params.id },
    include: {
      requester:  { select: { id: true, name: true, email: true } },
      targetSite:  { select: { id: true, name: true, city: true } },
      resource:      { select: { id: true, name: true, type: true } },
      decidedBy:  { select: { id: true, name: true } },
      startWeek: { select: { id: true, startDate: true, endDate: true } },
      endWeek:    { select: { id: true, startDate: true, endDate: true } },
    },
  })
  if (!item) throw errors.notFound('Solicitud no encontrada')

  // Coord solo puede ver las suyas
  if (req.user.role === 'coordinador' && item.requesterId !== req.user.id) {
    throw errors.forbidden('Solo puedes ver tus propias solicitudes')
  }
  res.json(item)
}

/** POST /solicitudes-recurso — solo coord */
export async function crear(req, res) {
  const data = crearSchema.parse(req.body)

  // Validación de consistencia según tipo
  if (data.requestType === 'prestamo' && !data.resourceId) {
    throw errors.badRequest('Para préstamo de recurso debes elegir un recursoId')
  }
  if (data.requestType === 'alta_nueva' && !data.newResourceType) {
    throw errors.badRequest('Para alta nueva debes indicar tipoRecursoNuevo')
  }

  // Validar sede destino existe
  const sedeDestino = await prisma.site.findUnique({ where: { id: data.targetSiteId } })
  if (!sedeDestino) throw errors.badRequest('La sede destino no existe')

  // Si es préstamo, validar recurso existe y NO es ya de una sede del solicitante
  if (data.requestType === 'prestamo') {
    const recurso = await prisma.resource.findUnique({
      where: { id: data.resourceId },
      include: { user: { include: { sites: true } } },
    })
    if (!recurso) throw errors.badRequest('El recurso no existe')
    // Validamos solo informacionalmente — el coord puede pedir préstamo incluso si
    // el recurso ya está en una de sus sedes (caso raro pero posible).
  }

  const creada = await prisma.resourceRequest.create({
    data: {
      requesterId:    req.user.id,
      targetSiteId:    data.targetSiteId,
      requestType:    data.requestType,
      resourceId:        data.resourceId ?? null,
      newResourceType: data.newResourceType ?? null,
      specialty:     data.specialty ?? null,
      startWeekId:   data.startWeekId ?? null,
      endWeekId:      data.endWeekId ?? null,
      justification:    data.justification,
    },
    include: {
      targetSite: { select: { name: true } },
      resource:     { select: { name: true, type: true } },
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'crear_solicitud_recurso',
    entity: 'solicitudes_recurso',
    entityId: creada.id,
    newValue: { type: creada.requestType, target_site: creada.targetSite.name },
    ipAddress: getIp(req),
  })

  // Notificar a TODOS los supervisores activos
  const supervisores = await prisma.user.findMany({
    where: { role: { in: ['supervisor', 'gerencia'] }, active: true },
    select: { id: true },
  })
  const detalleRecurso = creada.requestType === 'prestamo'
    ? `préstamo de <strong>${creada.resource?.name ?? 'recurso'}</strong>`
    : `alta de un nuevo <strong>${creada.newResourceType}</strong>`

  for (const sup of supervisores) {
    await notificar({
      userId: sup.id,
      type: 'solicitud_recurso_nueva',
      title: 'Nueva solicitud de recurso',
      message: `<p>El coordinador <strong>${req.user.name ?? 'desconocido'}</strong> solicita ${detalleRecurso} para la sede <strong>${creada.targetSite.name}</strong>.</p><p><em>Justificación:</em> ${creada.justification}</p>`,
      criticidad: 'media',
      accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/admin/solicitudes-recurso`,
      accionTexto: 'Ver solicitud',
    })
  }

  res.status(201).json(creada)
}

/** PUT /solicitudes-recurso/:id/aprobar — solo supervisor */
export async function aprobar(req, res) {
  const { decisionReason: motivoDecision } = decisionSchema.parse(req.body)
  const sol = await prisma.resourceRequest.findUnique({
    where: { id: req.params.id },
    include: {
      resource: { include: { user: { include: { sites: true } } } },
      targetSite: true,
      requester: { select: { id: true, name: true } },
    },
  })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.status !== 'pendiente') {
    throw errors.badRequest(`Solo se pueden aprobar solicitudes pendientes (estado actual: ${sol.status})`)
  }

  // PRESTAMO: vincular el usuario del recurso a la sede destino
  if (sol.requestType === 'prestamo' && sol.resource?.user) {
    const yaVinculado = sol.resource.user.sites.some((us) => us.siteId === sol.targetSiteId)
    if (!yaVinculado) {
      await prisma.userSite.create({
        data: { userId: sol.resource.user.id, siteId: sol.targetSiteId },
      })
    }
  }
  // Para alta_nueva, el supervisor luego debe crear el recurso y llamar
  // PUT /:id/asociar-recurso pasando el id del recurso creado.

  const actualizada = await prisma.resourceRequest.update({
    where: { id: sol.id },
    data: {
      status: sol.requestType === 'prestamo' ? 'ejecutada' : 'aprobada',
      decisionReason: motivoDecision ?? null,
      decidedById: req.user.id,
      decidedAt: new Date(),
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'aprobar_solicitud_recurso',
    entity: 'solicitudes_recurso',
    entityId: sol.id,
    oldValue: { status: 'pendiente' },
    newValue: { status: actualizada.status, reason: motivoDecision },
    ipAddress: getIp(req),
  })

  // Notificar al solicitante
  await notificar({
    userId: sol.requesterId,
    type: 'solicitud_recurso_aprobada',
    title: 'Tu solicitud de recurso fue aprobada',
    message: sol.requestType === 'prestamo'
      ? `<p>Tu solicitud de <strong>préstamo de ${sol.resource?.name}</strong> en la sede <strong>${sol.targetSite.name}</strong> fue aprobada. Ya puedes asignarlo desde el programador.</p>`
      : `<p>Tu solicitud de <strong>alta nueva (${sol.newResourceType})</strong> para la sede <strong>${sol.targetSite.name}</strong> fue aprobada. El supervisor creará el recurso en breve.</p>`,
    criticidad: 'media',
    accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/solicitudes-recurso`,
    accionTexto: 'Ver mis solicitudes',
  })

  // Si era préstamo: notificar también al coord líder del recurso (si tiene)
  if (sol.requestType === 'prestamo' && sol.resource?.leadCoordinatorId && sol.resource.leadCoordinatorId !== sol.requesterId) {
    await notificar({
      userId: sol.resource.leadCoordinatorId,
      type: 'solicitud_recurso_aprobada',
      title: 'Préstamo aprobado de un recurso de tu equipo',
      message: `<p>El recurso <strong>${sol.resource.name}</strong> (de tu equipo) fue prestado a la sede <strong>${sol.targetSite.name}</strong> por solicitud de <strong>${sol.requester.name}</strong>. Esto es informativo — coordina con esa sede si hay choques de agenda.</p>`,
      criticidad: 'baja',
    })
  }

  res.json(actualizada)
}

/** PUT /solicitudes-recurso/:id/rechazar — solo supervisor */
export async function rechazar(req, res) {
  const { decisionReason: motivoDecision } = decisionSchema.parse(req.body)
  if (!motivoDecision) throw errors.badRequest('Debes indicar un motivo al rechazar')

  const sol = await prisma.resourceRequest.findUnique({
    where: { id: req.params.id },
    include: { targetSite: { select: { name: true } } },
  })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.status !== 'pendiente') {
    throw errors.badRequest('Solo se pueden rechazar solicitudes pendientes')
  }

  const actualizada = await prisma.resourceRequest.update({
    where: { id: sol.id },
    data: {
      status: 'rechazada',
      decisionReason: motivoDecision,
      decidedById: req.user.id,
      decidedAt: new Date(),
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'rechazar_solicitud_recurso',
    entity: 'solicitudes_recurso',
    entityId: sol.id,
    newValue: { reason: motivoDecision },
    ipAddress: getIp(req),
  })

  await notificar({
    userId: sol.requesterId,
    type: 'solicitud_recurso_rechazada',
    title: 'Tu solicitud de recurso fue rechazada',
    message: `<p>Tu solicitud para la sede <strong>${sol.targetSite.name}</strong> fue rechazada.</p><p><em>Motivo:</em> ${motivoDecision}</p>`,
    criticidad: 'media',
    accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/solicitudes-recurso`,
    accionTexto: 'Ver mis solicitudes',
  })

  res.json(actualizada)
}

/** DELETE /solicitudes-recurso/:id — coord cancela su propia solicitud pendiente */
export async function cancelar(req, res) {
  const sol = await prisma.resourceRequest.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.requesterId !== req.user.id) {
    throw errors.forbidden('Solo puedes cancelar tus propias solicitudes')
  }
  if (sol.status !== 'pendiente') {
    throw errors.badRequest(`Solo se pueden cancelar solicitudes pendientes (actual: ${sol.status})`)
  }
  const actualizada = await prisma.resourceRequest.update({
    where: { id: sol.id },
    data: { status: 'cancelada' },
  })
  res.json(actualizada)
}

/**
 * PUT /solicitudes-recurso/:id/asociar-recurso — supervisor asocia el recurso
 * recién creado a una solicitud de alta_nueva ya aprobada. Marca como ejecutada.
 */
export async function asociarRecurso(req, res) {
  const { createdResourceId: recursoCreadoId } = asociarRecursoSchema.parse(req.body)
  const sol = await prisma.resourceRequest.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.requestType !== 'alta_nueva') {
    throw errors.badRequest('Esta acción solo aplica a solicitudes de alta nueva')
  }
  if (sol.status !== 'aprobada') {
    throw errors.badRequest('Solo aplica a solicitudes ya aprobadas')
  }

  const recurso = await prisma.resource.findUnique({ where: { id: recursoCreadoId } })
  if (!recurso) throw errors.badRequest('El recurso indicado no existe')

  // Vincular el usuario del recurso (si tiene) a la sede destino
  const usuarioRecurso = await prisma.user.findFirst({ where: { resourceId: recurso.id } })
  if (usuarioRecurso) {
    const yaVinculado = await prisma.userSite.findUnique({
      where: { userId_siteId: { userId: usuarioRecurso.id, siteId: sol.targetSiteId } },
    })
    if (!yaVinculado) {
      await prisma.userSite.create({
        data: { userId: usuarioRecurso.id, siteId: sol.targetSiteId },
      })
    }
  }

  const actualizada = await prisma.resourceRequest.update({
    where: { id: sol.id },
    data: { status: 'ejecutada', createdResourceId: recursoCreadoId },
  })

  await notificar({
    userId: sol.requesterId,
    type: 'solicitud_recurso_ejecutada',
    title: 'Recurso creado y vinculado',
    message: `<p>El supervisor creó el recurso <strong>${recurso.name}</strong> y lo vinculó a la sede que solicitaste. Ya puedes asignarlo en el programador.</p>`,
    criticidad: 'media',
  })

  res.json(actualizada)
}

/** GET /solicitudes-recurso/count-pendientes — para badge del menú */
export async function countPendientes(req, res) {
  const count = await prisma.resourceRequest.count({ where: { status: 'pendiente' } })
  res.json({ count })
}
