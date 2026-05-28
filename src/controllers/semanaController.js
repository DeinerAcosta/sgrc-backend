import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { differenceInDays, addDays, startOfWeek } from 'date-fns'

const crearSemanaSchema = z.object({
  fechaInicio: z.string(), // YYYY-MM-DD
})

export async function list(req, res) {
  const semanas = await prisma.semana.findMany({ orderBy: { fechaInicio: 'desc' }, take: 60 })
  res.json(semanas)
}

/** RN-01: anticipación mínima de 3 días */
export async function create(req, res) {
  const { fechaInicio } = crearSemanaSchema.parse(req.body)
  const inicio = new Date(fechaInicio)
  if (Number.isNaN(inicio.getTime())) throw errors.badRequest('Fecha inválida')
  // Semana corre domingo → sábado. weekStartsOn: 0 = domingo (date-fns).
  const domingo = startOfWeek(inicio, { weekStartsOn: 0 })
  const diff = differenceInDays(domingo, new Date())
  if (diff < 3) {
    throw errors.badRequest('La programación debe crearse con al menos 3 días de anticipación')
  }
  const fin = addDays(domingo, 6)
  const sem = await prisma.semana.create({
    data: {
      fechaInicio: domingo,
      fechaFin: fin,
      estado: 'abierta',
    },
  })
  res.status(201).json(sem)
}

export async function cerrar(req, res) {
  const sem = await prisma.semana.update({
    where: { id: req.params.id },
    data: { estado: 'cerrada', cerradaPor: req.user.id, cerradaEn: new Date() },
  })
  res.json(sem)
}

/** RN-03: copiar semana anterior — duplica todas las asignaciones */
export async function copiar(req, res) {
  const { fechaInicio } = req.body
  const origen = await prisma.semana.findUnique({
    where: { id: req.params.id },
    include: { asignaciones: true },
  })
  if (!origen) throw errors.notFound()

  const inicio = startOfWeek(new Date(fechaInicio), { weekStartsOn: 0 })
  if (differenceInDays(inicio, new Date()) < 3) {
    throw errors.badRequest('La nueva semana debe crearse con al menos 3 días de anticipación')
  }
  const fin = addDays(inicio, 6)

  const nueva = await prisma.semana.create({
    data: {
      fechaInicio: inicio,
      fechaFin: fin,
      estado: 'abierta',
      asignaciones: {
        create: origen.asignaciones.map((a) => ({
          recursoId: a.recursoId,
          auxiliarId: a.auxiliarId,
          consultorioId: a.consultorioId,
          diaSemana: a.diaSemana,
          horaInicio: a.horaInicio,
          horaFin: a.horaFin,
          pacientesCapacidad: a.pacientesCapacidad,
        })),
      },
    },
    include: { asignaciones: true },
  })
  res.status(201).json(nueva)
}
