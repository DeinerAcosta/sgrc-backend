import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { notificar, notificarSupervisores } from '../services/notificacionService.js'

const tareaSchema = z.object({
  nombre: z.string().min(1).max(150),
  descripcion: z.string().optional().nullable(),
  tiempoEstimadoMinutos: z.number().int().min(1).max(480),
  activa: z.boolean().optional(),
})

const solicitudSchema = z.object({
  nombre: z.string().min(1).max(150),
  justificacion: z.string().max(1000).optional().nullable(),
  tiempoEstimadoMinutos: z.number().int().min(1).max(480).optional().nullable(),
})

const aprobarSchema = z.object({
  nombre: z.string().min(1).max(150).optional(),
  descripcion: z.string().optional().nullable(),
  tiempoEstimadoMinutos: z.number().int().min(1).max(480).optional(),
})

const rechazarSchema = z.object({
  motivo: z.string().min(5, 'El motivo es obligatorio (mín 5 caracteres)'),
})

/**
 * GET /tareas-backoffice
 * Por defecto solo devuelve tareas activas y aprobadas (las que el coordinador
 * puede asignar). El supervisor puede pedir all=true o estado=<x> para ver todas.
 */
export async function list(req, res) {
  const { all, estado } = req.query
  let where
  if (estado) where = { estado }
  else if (all === 'true') where = {}
  else where = { activa: true, estado: 'aprobada' }
  const tareas = await prisma.tareaBackoffice.findMany({ where, orderBy: { createdAt: 'desc' } })
  res.json(tareas)
}

export async function create(req, res) {
  const data = tareaSchema.parse(req.body)
  const t = await prisma.tareaBackoffice.create({
    data: { ...data, creadaPor: req.user.id, activa: data.activa ?? true, estado: 'aprobada' },
  })
  res.status(201).json(t)
}

export async function update(req, res) {
  const data = tareaSchema.partial().parse(req.body)
  const t = await prisma.tareaBackoffice.update({ where: { id: req.params.id }, data })
  res.json(t)
}

/**
 * Un coordinador solicita crear una tarea que aún no existe en el catálogo.
 * Crea la tarea en estado 'pendiente' (activa=false) — NO se puede asignar
 * hasta que el supervisor la apruebe en su panel. Notifica al supervisor.
 */
export async function solicitar(req, res) {
  const data = solicitudSchema.parse(req.body)
  const solicitante = await prisma.usuario.findUnique({ where: { id: req.user.id } })
  const nombreSolic = solicitante?.nombre ?? 'Un coordinador'

  // Validar duplicado por nombre (case-insensitive) entre tareas aprobadas o ya pendientes
  const duplicada = await prisma.tareaBackoffice.findFirst({
    where: { nombre: data.nombre, estado: { in: ['aprobada', 'pendiente'] } },
  })
  if (duplicada) throw errors.conflict(`Ya existe una tarea "${data.nombre}" en estado ${duplicada.estado}`)

  const tarea = await prisma.tareaBackoffice.create({
    data: {
      nombre: data.nombre,
      descripcion: data.justificacion ?? null,
      tiempoEstimadoMinutos: data.tiempoEstimadoMinutos ?? 60,
      activa: false,
      estado: 'pendiente',
      solicitadaPor: req.user.id,
      justificacion: data.justificacion,
      creadaPor: req.user.id,
    },
  })

  const partes = [`${nombreSolic} solicita crear la tarea de backoffice "${data.nombre}".`]
  if (data.tiempoEstimadoMinutos) partes.push(`Tiempo estimado sugerido: ${data.tiempoEstimadoMinutos} min/unidad.`)
  if (data.justificacion) partes.push(`Justificación: ${data.justificacion}`)
  partes.push('Apruébala o recházala desde "Tareas backoffice".')

  await notificarSupervisores({
    tipo: 'solicitud_tarea_backoffice',
    titulo: 'Solicitud de nueva tarea de backoffice',
    mensaje: partes.join(' '),
    criticidad: 'media',
    referenciaId: tarea.id,
  })

  res.status(201).json({ ok: true, tareaId: tarea.id })
}

/**
 * Supervisor aprueba una solicitud pendiente. Puede ajustar nombre/desc/tiempo
 * antes de activarla. Notifica al coordinador que la solicitó.
 */
export async function aprobarSolicitud(req, res) {
  const ajustes = aprobarSchema.parse(req.body ?? {})
  const tarea = await prisma.tareaBackoffice.findUnique({ where: { id: req.params.id } })
  if (!tarea) throw errors.notFound('Tarea no encontrada')
  if (tarea.estado !== 'pendiente') throw errors.badRequest(`La tarea ya está ${tarea.estado}`)

  const actualizada = await prisma.tareaBackoffice.update({
    where: { id: tarea.id },
    data: {
      nombre: ajustes.nombre ?? tarea.nombre,
      descripcion: ajustes.descripcion !== undefined ? ajustes.descripcion : tarea.descripcion,
      tiempoEstimadoMinutos: ajustes.tiempoEstimadoMinutos ?? tarea.tiempoEstimadoMinutos,
      activa: true,
      estado: 'aprobada',
      procesadaPor: req.user.id,
      procesadaEn: new Date(),
    },
  })

  // Notificar al coordinador que la solicitó
  if (tarea.solicitadaPor) {
    await notificar({
      usuarioId: tarea.solicitadaPor,
      tipo: 'solicitud_aprobada',
      titulo: 'Tu solicitud de tarea de backoffice fue aprobada',
      mensaje: `La tarea "${actualizada.nombre}" ya está disponible. Asígnala a auxiliares liberadas desde Backoffice.`,
      criticidad: 'media',
      referenciaId: actualizada.id,
    })
  }

  res.json(actualizada)
}

/**
 * Supervisor rechaza una solicitud pendiente con motivo obligatorio. La tarea
 * queda con estado='rechazada' (queda como historial) y se notifica al coord.
 */
export async function rechazarSolicitud(req, res) {
  const { motivo } = rechazarSchema.parse(req.body)
  const tarea = await prisma.tareaBackoffice.findUnique({ where: { id: req.params.id } })
  if (!tarea) throw errors.notFound()
  if (tarea.estado !== 'pendiente') throw errors.badRequest(`La tarea ya está ${tarea.estado}`)

  const actualizada = await prisma.tareaBackoffice.update({
    where: { id: tarea.id },
    data: {
      estado: 'rechazada',
      motivoRechazo: motivo,
      activa: false,
      procesadaPor: req.user.id,
      procesadaEn: new Date(),
    },
  })

  if (tarea.solicitadaPor) {
    await notificar({
      usuarioId: tarea.solicitadaPor,
      tipo: 'solicitud_rechazada',
      titulo: 'Tu solicitud de tarea de backoffice fue rechazada',
      mensaje: `La tarea "${tarea.nombre}" no fue aprobada. Motivo: ${motivo}`,
      criticidad: 'media',
      referenciaId: actualizada.id,
    })
  }

  res.json({ ok: true })
}
