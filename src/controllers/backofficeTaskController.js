import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { notificar, notificarSupervisores } from '../services/notificationService.js'

const emptyToUndef = (v) => (v === '' ? undefined : v)

const tareaSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.preprocess(emptyToUndef, z.string().optional().nullable()),
  estimatedMinutes: z.number().int().min(1).max(480),
  active: z.boolean().optional(),
})

const solicitudSchema = z.object({
  name: z.string().min(1).max(150),
  justification: z.preprocess(emptyToUndef, z.string().max(1000).optional().nullable()),
  estimatedMinutes: z.preprocess(emptyToUndef, z.number().int().min(1).max(480).optional().nullable()),
})

const aprobarSchema = z.object({
  name: z.preprocess(emptyToUndef, z.string().min(1).max(150).optional()),
  description: z.preprocess(emptyToUndef, z.string().optional().nullable()),
  estimatedMinutes: z.preprocess(emptyToUndef, z.number().int().min(1).max(480).optional()),
})

const rechazarSchema = z.object({
  reason: z.string().min(5, 'El motivo es obligatorio (mín 5 caracteres)'),
})

/**
 * GET /tareas-backoffice
 * Por defecto solo devuelve tareas activas y aprobadas (las que el coordinador
 * puede asignar). El supervisor puede pedir all=true o estado=<x> para ver todas.
 */
export async function list(req, res) {
  const { all, status: estado } = req.query
  let where
  if (estado) where = { status: estado }
  else if (all === 'true') where = {}
  else where = { active: true, status: 'aprobada' }
  const tareas = await prisma.backofficeTask.findMany({ where, orderBy: { createdAt: 'desc' } })
  res.json(tareas)
}

export async function create(req, res) {
  const data = tareaSchema.parse(req.body)
  const t = await prisma.backofficeTask.create({
    data: { ...data, createdBy: req.user.id, active: data.active ?? true, status: 'aprobada' },
  })
  res.status(201).json(t)
}

export async function update(req, res) {
  const data = tareaSchema.partial().parse(req.body)
  const t = await prisma.backofficeTask.update({ where: { id: req.params.id }, data })
  res.json(t)
}

/**
 * Un coordinador solicita crear una tarea que aún no existe en el catálogo.
 * Crea la tarea en estado 'pendiente' (activa=false) — NO se puede asignar
 * hasta que el supervisor la apruebe en su panel. Notifica al supervisor.
 */
export async function solicitar(req, res) {
  const data = solicitudSchema.parse(req.body)
  const solicitante = await prisma.user.findUnique({ where: { id: req.user.id } })
  const nombreSolic = solicitante?.name ?? 'Un coordinador'

  // Validar duplicado por nombre (case-insensitive) entre tareas aprobadas o ya pendientes
  const duplicada = await prisma.backofficeTask.findFirst({
    where: { name: data.name, status: { in: ['aprobada', 'pendiente'] } },
  })
  if (duplicada) throw errors.conflict(`Ya existe una tarea "${data.name}" en estado ${duplicada.status}`)

  const tarea = await prisma.backofficeTask.create({
    data: {
      name: data.name,
      description: data.justification ?? null,
      estimatedMinutes: data.estimatedMinutes ?? 60,
      active: false,
      status: 'pendiente',
      requestedBy: req.user.id,
      justification: data.justification,
      createdBy: req.user.id,
    },
  })

  const FRONT_T = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  await notificarSupervisores({
    type: 'solicitud_tarea_backoffice',
    title: `Solicitud de nueva tarea de backoffice: "${data.name}"`,
    message: `<p>Un coordinador solicitó la creación de una nueva tarea para el catálogo de Backoffice. Las tareas de Backoffice son actividades asignables a auxiliares cuando se liberan por ausencias o cuando hay capacidad ociosa, y permiten convertir tiempo no programado en valor para la clínica.</p>
    <p>Antes de aprobar, valida que la tarea no exista ya en el catálogo y que el tiempo estimado sea razonable. Puedes ajustar el nombre, descripción y tiempo estimado durante el proceso de aprobación.</p>`,
    contexto: 'Acción requerida del módulo de Tareas de Backoffice',
    criticidad: 'media',
    referenceId: tarea.id,
    detalles: [
      ['Nombre de la tarea',     data.name],
      ['Solicitado por',         nombreSolic],
      ...(data.estimatedMinutes ? [['Tiempo estimado sugerido', `${data.estimatedMinutes} minutos por unidad`]] : []),
      ...(data.justification ? [['Justificación del coordinador', data.justification]] : []),
      ['Fecha de solicitud',     new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' })],
      ['Estado',                 'Pendiente de revisión'],
    ],
    accionUrl: `${FRONT_T}/app/admin/tareas-backoffice`,
    accionTexto: 'Revisar solicitud',
  })

  res.status(201).json({ ok: true, taskId: tarea.id })
}

/**
 * Supervisor aprueba una solicitud pendiente. Puede ajustar nombre/desc/tiempo
 * antes de activarla. Notifica al coordinador que la solicitó.
 */
export async function aprobarSolicitud(req, res) {
  const ajustes = aprobarSchema.parse(req.body ?? {})
  const tarea = await prisma.backofficeTask.findUnique({ where: { id: req.params.id } })
  if (!tarea) throw errors.notFound('Tarea no encontrada')
  if (tarea.status !== 'pendiente') throw errors.badRequest(`La tarea ya está ${tarea.status}`)

  const actualizada = await prisma.backofficeTask.update({
    where: { id: tarea.id },
    data: {
      name: ajustes.name ?? tarea.name,
      description: ajustes.description !== undefined ? ajustes.description : tarea.description,
      estimatedMinutes: ajustes.estimatedMinutes ?? tarea.estimatedMinutes,
      active: true,
      status: 'aprobada',
      processedBy: req.user.id,
      processedAt: new Date(),
    },
  })

  // Notificar al coordinador que la solicitó
  if (tarea.requestedBy) {
    const FRONT_AP = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
    await notificar({
      userId: tarea.requestedBy,
      type: 'solicitud_aprobada',
      title: `Solicitud aprobada: tarea "${actualizada.name}"`,
      message: `<p>El supervisor aprobó tu solicitud y la tarea ya forma parte del catálogo activo de Backoffice. Puedes asignarla a auxiliares liberadas o a personal con capacidad disponible en su jornada.</p>`,
      contexto: 'Notificación del módulo de Backoffice',
      criticidad: 'media',
      referenceId: actualizada.id,
      detalles: [
        ['Nombre de la tarea',     actualizada.name],
        ...(actualizada.description ? [['Descripción', actualizada.description]] : []),
        ...(actualizada.estimatedMinutes ? [['Tiempo estimado', `${actualizada.estimatedMinutes} min/unidad`]] : []),
        ['Estado',                 'Aprobada y activa'],
      ],
      accionUrl: `${FRONT_AP}/app/backoffice`,
      accionTexto: 'Asignar tarea',
    })
  }

  res.json(actualizada)
}

/**
 * Supervisor rechaza una solicitud pendiente con motivo obligatorio. La tarea
 * queda con estado='rechazada' (queda como historial) y se notifica al coord.
 */
export async function rechazarSolicitud(req, res) {
  const { reason: motivo } = rechazarSchema.parse(req.body)
  const tarea = await prisma.backofficeTask.findUnique({ where: { id: req.params.id } })
  if (!tarea) throw errors.notFound()
  if (tarea.status !== 'pendiente') throw errors.badRequest(`La tarea ya está ${tarea.status}`)

  const actualizada = await prisma.backofficeTask.update({
    where: { id: tarea.id },
    data: {
      status: 'rechazada',
      rejectionReason: motivo,
      active: false,
      processedBy: req.user.id,
      processedAt: new Date(),
    },
  })

  if (tarea.requestedBy) {
    await notificar({
      userId: tarea.requestedBy,
      type: 'solicitud_rechazada',
      title: `Solicitud rechazada: tarea "${tarea.name}"`,
      message: `<p>El supervisor revisó tu solicitud y decidió no incorporar la tarea al catálogo de Backoffice. Encuentras a continuación el motivo registrado por el supervisor para que puedas evaluarlo y, si lo consideras pertinente, presentar una nueva solicitud con los ajustes correspondientes.</p>`,
      contexto: 'Notificación del módulo de Tareas de Backoffice',
      criticidad: 'media',
      referenceId: actualizada.id,
      detalles: [
        ['Tarea solicitada',     tarea.name],
        ['Motivo del rechazo',   motivo],
        ['Fecha de decisión',    new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' })],
        ['Estado',               'Rechazada'],
      ],
    })
  }

  res.json({ ok: true })
}
