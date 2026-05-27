import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { notificarSupervisores } from '../services/notificacionService.js'

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

/**
 * Un coordinador solicita crear una tarea de backoffice que aún no existe en el
 * catálogo. NO crea la tarea (el alta es potestad del supervisor — HU-S-06):
 * notifica a los supervisores para que la revisen y la den de alta.
 */
export async function solicitar(req, res) {
  const data = solicitudSchema.parse(req.body)
  const solicitante = await prisma.usuario.findUnique({ where: { id: req.user.id } })
  const nombreSolic = solicitante?.nombre ?? 'Un coordinador'

  const partes = [`${nombreSolic} solicita crear la tarea de backoffice "${data.nombre}".`]
  if (data.tiempoEstimadoMinutos) partes.push(`Tiempo estimado sugerido: ${data.tiempoEstimadoMinutos} min/unidad.`)
  if (data.justificacion) partes.push(`Justificación: ${data.justificacion}`)
  partes.push('Revísala en "Tareas backoffice" para darla de alta.')

  const notificados = await notificarSupervisores({
    tipo: 'solicitud_tarea_backoffice',
    titulo: 'Solicitud de nueva tarea de backoffice',
    mensaje: partes.join(' '),
    criticidad: 'media',
  })

  if (notificados === 0) throw errors.badRequest('No hay supervisores activos a quienes notificar')
  res.status(201).json({ ok: true, notificados })
}
