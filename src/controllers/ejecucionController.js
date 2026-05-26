import { z } from 'zod'
import { differenceInHours } from 'date-fns'
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

  // Si ya existe, validar bloqueo a 48h y actualizar
  const existente = await prisma.ejecucion.findUnique({ where: { asignacionId: data.asignacionId } })
  if (existente) {
    const horas = differenceInHours(new Date(), existente.registradoEn)
    if (horas >= 48 || existente.bloqueado) {
      throw errors.forbidden('El registro de ejecución se bloqueó después de 48 horas')
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
  let count = 0
  for (const data of registros) {
    const existente = await prisma.ejecucion.findUnique({ where: { asignacionId: data.asignacionId } })
    if (existente) {
      const horas = differenceInHours(new Date(), existente.registradoEn)
      if (horas >= 48 || existente.bloqueado) continue
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
  res.json({ count })
}
