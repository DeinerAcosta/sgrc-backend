import { z } from 'zod'
import { format } from 'date-fns'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const ESTADOS = ['completa', 'parcial', 'no_ejecutada']

const crearSchema = z.object({
  asignacionId: z.string().uuid(),
  pacientesAtendidos: z.number().int().min(0),
  estadoJornada: z.enum(ESTADOS).optional(),
  observaciones: z.string().optional(),
})

const batchSchema = z.object({
  registros: z.array(crearSchema),
})

/**
 * Fecha límite para registrar la ejecución de las asignaciones de una semana.
 * Regla de negocio: la semana corre domingo → sábado y el viernes 23:59 cierra
 * el registro. Después de eso no se acepta crear/editar ejecuciones de esa semana.
 *
 * fechaInicio viene de MySQL @db.Date como UTC-midnight del día calendario; por eso
 * leemos el día de la semana en UTC (getUTCDay) para evitar shifts de zona horaria,
 * y luego construimos el viernes a las 23:59:59 en LOCAL time. Funciona igual para
 * semanas Sunday-start (esquema nuevo) y Monday-start (datos viejos).
 */
function cierreEjecucionDe(semana) {
  const d = new Date(semana.fechaInicio)
  const dowUtc = d.getUTCDay()                    // 0=dom, ..., 5=vie, 6=sab
  const distAlViernes = (5 - dowUtc + 7) % 7
  const yyyy = d.getUTCFullYear()
  const mm = d.getUTCMonth()
  const dd = d.getUTCDate() + distAlViernes
  return new Date(yyyy, mm, dd, 23, 59, 59, 999)  // viernes 23:59:59 LOCAL
}

export async function pendientesDelDia(req, res) {
  const { semana_id, dia } = req.query
  if (!semana_id || !dia) throw errors.badRequest('Parámetros requeridos: semana_id, dia')
  const asigs = await prisma.asignacion.findMany({
    where: { semanaId: semana_id, diaSemana: dia, estado: { not: 'cancelada' } },
    include: {
      consultorio: true,
      recurso: true,
      ejecucion: true,
    },
  })
  res.json(asigs)
}

export async function get(req, res) {
  const { asignacion_id } = req.query
  if (!asignacion_id) throw errors.badRequest('asignacion_id requerido')
  const e = await prisma.ejecucion.findUnique({ where: { asignacionId: asignacion_id } })
  res.json(e)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)

  // Cierre semanal: solo se puede registrar/editar hasta el viernes 23:59 de la semana de la asignación.
  const asig = await prisma.asignacion.findUnique({
    where: { id: data.asignacionId },
    include: { semana: true },
  })
  if (!asig) throw errors.notFound('Asignación no encontrada')
  const cierre = cierreEjecucionDe(asig.semana)
  if (new Date() > cierre) {
    throw errors.forbidden(`El registro de ejecución de esta semana cerró el viernes ${format(cierre, 'd MMM HH:mm')}`)
  }

  // Si ya existe, validar bloqueo manual y actualizar
  const existente = await prisma.ejecucion.findUnique({ where: { asignacionId: data.asignacionId } })
  if (existente) {
    if (existente.bloqueado) {
      throw errors.forbidden('Este registro de ejecución está bloqueado')
    }
    const actualizada = await prisma.ejecucion.update({
      where: { asignacionId: data.asignacionId },
      data: {
        pacientesAtendidos: data.pacientesAtendidos,
        estadoJornada: data.estadoJornada ?? 'completa',
        observaciones: data.observaciones,
      },
    })
    return res.json(actualizada)
  }

  const nueva = await prisma.ejecucion.create({
    data: {
      asignacionId: data.asignacionId,
      pacientesAtendidos: data.pacientesAtendidos,
      estadoJornada: data.estadoJornada ?? 'completa',
      observaciones: data.observaciones,
      registradoPor: req.user.id,
    },
  })
  res.status(201).json(nueva)
}

export async function saveDay(req, res) {
  const { registros } = batchSchema.parse(req.body)

  // Una sola consulta para todas las asignaciones del batch (cada una con su semana)
  const ids = registros.map((r) => r.asignacionId)
  const asigs = await prisma.asignacion.findMany({
    where: { id: { in: ids } },
    include: { semana: true },
  })
  const asigMap = Object.fromEntries(asigs.map((a) => [a.id, a]))

  let count = 0
  let bloqueadas = 0
  let fueraDePlazo = 0
  for (const data of registros) {
    const asig = asigMap[data.asignacionId]
    if (!asig) continue

    const cierre = cierreEjecucionDe(asig.semana)
    if (new Date() > cierre) { fueraDePlazo++; continue }

    const existente = await prisma.ejecucion.findUnique({ where: { asignacionId: data.asignacionId } })
    if (existente) {
      if (existente.bloqueado) { bloqueadas++; continue }
      await prisma.ejecucion.update({
        where: { asignacionId: data.asignacionId },
        data: {
          pacientesAtendidos: data.pacientesAtendidos,
          estadoJornada: data.estadoJornada ?? 'completa',
          observaciones: data.observaciones,
        },
      })
    } else {
      await prisma.ejecucion.create({
        data: {
          asignacionId: data.asignacionId,
          pacientesAtendidos: data.pacientesAtendidos,
          estadoJornada: data.estadoJornada ?? 'completa',
          observaciones: data.observaciones,
          registradoPor: req.user.id,
        },
      })
    }
    count++
  }
  res.json({ count, bloqueadas, fueraDePlazo })
}
