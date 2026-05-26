import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { crearAsignacion } from '../services/asignacionService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar } from '../services/notificacionService.js'

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']

const crearSchema = z.object({
  semanaId: z.string().uuid(),
  recursoId: z.string().uuid(),
  auxiliarId: z.string().uuid().optional().nullable(),
  consultorioId: z.string().uuid(),
  diaSemana: z.enum(DIAS),
  horaInicio: z.string().regex(/^\d{2}:\d{2}$/),
  horaFin: z.string().regex(/^\d{2}:\d{2}$/),
  esReemplazo: z.boolean().optional(),
  ausenciaCubiertaId: z.string().uuid().optional().nullable(),
  motivoSupervisor: z.string().optional(),
})

export async function list(req, res) {
  const { semana_id, sede_id, recurso_id, dia } = req.query
  const where = { estado: { not: 'cancelada' } }
  if (semana_id) where.semanaId = semana_id
  if (recurso_id) where.OR = [{ recursoId: recurso_id }, { auxiliarId: recurso_id }]
  if (dia) where.diaSemana = dia

  const list = await prisma.asignacion.findMany({
    where,
    include: {
      recurso: true,
      auxiliar: true,
      consultorio: { include: { sede: true } },
    },
    orderBy: [{ diaSemana: 'asc' }, { horaInicio: 'asc' }],
  })

  // Filtro post-query por sede (porque la relación es a través de consultorio)
  const filtradas = sede_id ? list.filter((a) => a.consultorio.sedeId === sede_id) : list
  res.json(filtradas)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const result = await crearAsignacion(data, { id: req.user.id, rol: req.user.rol })

  if (result.fueSupervisor) {
    await registrarAuditoria({
      usuarioId: req.user.id,
      accion: 'modificar_semana_cerrada',
      entidad: 'asignaciones',
      entidadId: result.asignacion.id,
      valorNuevo: { tipo: 'create', recursoId: data.recursoId, consultorioId: data.consultorioId },
      motivo: data.motivoSupervisor,
      ipAddress: getIp(req),
    })
  }

  // HU-R-07: notificar al recurso (y a la auxiliar si aplica) de su nueva asignación
  const a = result.asignacion
  const destinatarios = await prisma.usuario.findMany({
    where: { recursoId: { in: [a.recursoId, a.auxiliarId].filter(Boolean) } },
  })
  for (const u of destinatarios) {
    await notificar({
      usuarioId: u.id,
      tipo: 'asignacion_cambiada',
      titulo: 'Nueva asignación en tu horario',
      mensaje: `Tienes una asignación el ${a.diaSemana} de ${a.horaInicio} a ${a.horaFin} en ${a.consultorio?.nombre ?? 'un consultorio'}.`,
      criticidad: 'media',
      referenciaId: a.id,
    })
  }

  res.status(201).json(result.asignacion)
}

export async function remove(req, res) {
  const a = await prisma.asignacion.findUnique({
    where: { id: req.params.id },
    include: { ejecucion: true, semana: true },
  })
  if (!a) throw errors.notFound()

  // RN — semana cerrada solo supervisor
  if (a.semana.estado === 'cerrada' && req.user.rol !== 'supervisor') {
    throw errors.forbidden('Semana cerrada — solo supervisor puede modificar')
  }

  // RN-17: si tiene ejecución registrada, marcar como cancelada (no eliminar)
  if (a.ejecucion) {
    const updated = await prisma.asignacion.update({
      where: { id: req.params.id },
      data: { estado: 'cancelada' },
    })
    return res.json({ ok: true, cancelada: true, asignacion: updated })
  }

  await prisma.asignacion.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
}

/** GET /recursos/sugeridos — sugiere reemplazos para una franja (HU-C-12, RN-38) */
export async function sugerirReemplazos(req, res) {
  const { tipo, dia, hora_inicio, hora_fin, ciudad, semana_id } = req.query
  if (!tipo || !dia || !hora_inicio || !hora_fin) {
    throw errors.badRequest('Parámetros requeridos: tipo, dia, hora_inicio, hora_fin')
  }

  // Candidatos activos del tipo solicitado
  const candidatos = await prisma.recurso.findMany({
    where: { tipo, activo: true },
  })

  // Filtrar los que NO tengan conflicto en esa franja/día
  const sedesCiudad = ciudad
    ? (await prisma.sede.findMany({ where: { ciudad } })).map((s) => s.id)
    : []

  const disponibles = []
  for (const r of candidatos) {
    const conflicto = await prisma.asignacion.findFirst({
      where: {
        semanaId: semana_id || undefined,
        diaSemana: dia,
        estado: { not: 'cancelada' },
        OR: [{ recursoId: r.id }, { auxiliarId: r.id }],
      },
    })
    const hayConflicto = conflicto &&
      !(hora_fin <= conflicto.horaInicio || hora_inicio >= conflicto.horaFin)
    if (!hayConflicto) {
      disponibles.push({
        ...r,
        misma_sede: !ciudad || sedesCiudad.length === 0 || true, // simplificado
      })
    }
  }

  res.json(disponibles)
}
