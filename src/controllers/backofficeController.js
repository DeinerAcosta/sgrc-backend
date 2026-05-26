import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const asignarSchema = z.object({
  auxiliarId: z.string().uuid(),
  sedeId: z.string().uuid(),
  tareaBackofficeId: z.string().uuid(),
  ausenciaOrigenId: z.string().uuid().optional(),
  dia: z.string(),
  horaInicio: z.string().regex(/^\d{2}:\d{2}$/),
  horaFin: z.string().regex(/^\d{2}:\d{2}$/),
})

const registrarSchema = z.object({
  asignacionBackofficeId: z.string().uuid(),
  tareaId: z.string().uuid(),
  unidadesCompletadas: z.number().int().min(0),
  tiempoRealMinutos: z.number().int().min(0),
  observaciones: z.string().optional(),
})

/** Asignar auxiliar liberada a backoffice (HU-C-17, RN-36) */
export async function asignar(req, res) {
  const data = asignarSchema.parse(req.body)

  // Validar que no supere su límite diario
  const aux = await prisma.recurso.findUnique({ where: { id: data.auxiliarId } })
  if (!aux) throw errors.notFound('Auxiliar no encontrada')

  const horasOtras = await prisma.asignacionBackoffice.findMany({
    where: { auxiliarId: data.auxiliarId, dia: new Date(data.dia) },
  })
  const horasNuevas = (parseInt(data.horaFin.slice(0, 2)) * 60 + parseInt(data.horaFin.slice(3))) -
                     (parseInt(data.horaInicio.slice(0, 2)) * 60 + parseInt(data.horaInicio.slice(3)))
  const horasDia = horasOtras.reduce((acc, a) => {
    const m = (parseInt(a.horaFin.slice(0, 2)) * 60 + parseInt(a.horaFin.slice(3))) -
              (parseInt(a.horaInicio.slice(0, 2)) * 60 + parseInt(a.horaInicio.slice(3)))
    return acc + m
  }, 0)
  if ((horasDia + horasNuevas) > (aux.horasMaxDia ?? 10) * 60) {
    throw errors.badRequest(`${aux.nombre} superaría su límite de ${aux.horasMaxDia ?? 10}h diarias`)
  }

  const asig = await prisma.asignacionBackoffice.create({
    data: { ...data, dia: new Date(data.dia), asignadoPor: req.user.id },
    include: { auxiliar: true, sede: true, tarea: true },
  })
  res.status(201).json(asig)
}

export async function listAsignaciones(req, res) {
  const { auxiliar_id, dia } = req.query
  const where = {}
  if (auxiliar_id) where.auxiliarId = auxiliar_id
  if (dia) where.dia = new Date(dia)
  const list = await prisma.asignacionBackoffice.findMany({
    where,
    include: { auxiliar: true, sede: true, tarea: true, ejecuciones: true },
    orderBy: { dia: 'desc' },
  })
  res.json(list)
}

/** Auxiliar registra ejecución (HU-R-11, RN-37) */
export async function registrar(req, res) {
  const data = registrarSchema.parse(req.body)
  const e = await prisma.ejecucionBackoffice.create({
    data: { ...data, registradoPor: req.user.id },
  })
  res.status(201).json(e)
}

/** Pendientes de la auxiliar para hoy */
export async function pendientesAuxiliar(req, res) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const asigs = await prisma.asignacionBackoffice.findMany({
    where: { auxiliarId: req.params.auxiliarId, dia: hoy },
    include: { tarea: true, sede: true, ejecuciones: true },
  })
  res.json(asigs)
}
