import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { expandirRangoHabil } from '../lib/workdays.js'

const emptyToUndef = (v) => (v === '' ? undefined : v)

const asignarSchema = z.object({
  assistantId: z.string().uuid(),
  siteId: z.string().uuid(),
  backofficeTaskId: z.string().uuid(),
  sourceAbsenceId: z.preprocess(emptyToUndef, z.string().uuid().optional()),
  // Modo 1 día: `dia` requerido. Modo rango: `fechaInicio` + `fechaFin`.
  // Si ambos vienen, se prefiere el rango. Si solo viene `dia`, es 1 día.
  day: z.preprocess(emptyToUndef, z.string().optional()),
  startDate: z.preprocess(emptyToUndef, z.string().optional()),
  endDate: z.preprocess(emptyToUndef, z.string().optional()),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  // Opciones para el modo rango:
  sabadoMedioDia: z.boolean().optional(),
}).refine(
  (d) => d.day || (d.startDate && d.endDate),
  { message: 'Debes enviar `dia` o el rango `fechaInicio`+`fechaFin`' },
)

const hhmmAMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const registrarSchema = z.object({
  backofficeAssignmentId: z.string().uuid(),
  taskId: z.string().uuid(),
  unitsCompleted: z.number().int().min(0),
  actualMinutes: z.number().int().min(0),
  notes: z.string().optional(),
})

/**
 * Asignar auxiliar a backoffice (HU-C-17, RN-36).
 *
 * Soporta dos modos:
 *   1) UN día: body con `dia`. Comportamiento histórico.
 *   2) RANGO: body con `fechaInicio` + `fechaFin`. Itera días hábiles
 *      (lun–vie y sáb hasta 12:00; salta domingos y festivos). Crea N
 *      registros en transacción, agrupados por `grupo_id`. Los días con
 *      conflicto se omiten y se reportan — los demás se crean igual.
 *
 * Respuesta común:
 *   { creadas: [...], omitidas: [{fecha, motivo}], grupoId }
 */
export async function asignar(req, res) {
  const data = asignarSchema.parse(req.body)

  const aux = await prisma.resource.findUnique({ where: { id: data.assistantId } })
  if (!aux) throw errors.notFound('Auxiliar no encontrada')

  const horasNuevas = hhmmAMin(data.endTime) - hhmmAMin(data.startTime)
  if (horasNuevas <= 0) throw errors.badRequest('Hora fin debe ser mayor a hora inicio')
  const topeDiarioMin = (aux.maxHoursPerDay ?? 10) * 60

  // --- Determinar los días a procesar ---------------------------------------
  let dias // [{fecha:'YYYY-MM-DD', horaInicio, horaFin, ajustado}]
  if (data.startDate && data.endDate) {
    // Modo rango: cargar festivos del periodo y expandir
    const festivosDb = await prisma.holiday.findMany({
      where: {
        date: {
          gte: new Date(data.startDate + 'T00:00:00Z'),
          lte: new Date(data.endDate + 'T00:00:00Z'),
        },
      },
    })
    const festivosSet = new Set(festivosDb.map((f) => f.date.toISOString().slice(0, 10)))
    try {
      dias = expandirRangoHabil({
        startDate: data.startDate,
        endDate: data.endDate,
        startTime: data.startTime,
        endTime: data.endTime,
        holidays: festivosSet,
        sabadoMedioDia: data.sabadoMedioDia ?? true,
      })
    } catch (e) {
      throw errors.badRequest(e.message)
    }
    if (dias.length === 0) {
      throw errors.badRequest('El rango no incluye ningún día hábil (todo cae en domingos/festivos o sábado sin franja válida)')
    }
  } else {
    dias = [{ date: data.day, startTime: data.startTime, endTime: data.endTime, ajustado: false }]
  }

  const grupoId = dias.length > 1 ? randomUUID() : null

  // --- Procesar día a día dentro de una transacción ------------------------
  // "Crear los demás y reportar el omitido" — recolectamos errores por día sin
  // abortar el lote.
  const out = await prisma.$transaction(async (tx) => {
    const creadas = []
    const omitidas = []

    for (const d of dias) {
      const horasNuevasDia = hhmmAMin(d.endTime) - hhmmAMin(d.startTime)
      if (horasNuevasDia <= 0) {
        omitidas.push({ date: d.date, reason: 'Franja horaria inválida en ese día' })
        continue
      }

      // Tope diario por aux: contar las horas que ya tiene ese día
      const horasOtras = await tx.backofficeAssignment.findMany({
        where: { assistantId: data.assistantId, day: new Date(d.date + 'T00:00:00Z') },
      })
      const horasDia = horasOtras.reduce(
        (acc, a) => acc + (hhmmAMin(a.endTime) - hhmmAMin(a.startTime)),
        0,
      )
      if ((horasDia + horasNuevasDia) > topeDiarioMin) {
        omitidas.push({
          date: d.date,
          reason: `Tope diario superado (ya tiene ${(horasDia / 60).toFixed(1)}h ese día — máx ${aux.maxHoursPerDay ?? 10}h)`,
        })
        continue
      }

      const creada = await tx.backofficeAssignment.create({
        data: {
          assistantId: data.assistantId,
          siteId: data.siteId,
          backofficeTaskId: data.backofficeTaskId,
          sourceAbsenceId: data.sourceAbsenceId,
          day: new Date(d.date + 'T00:00:00Z'),
          startTime: d.startTime,
          endTime: d.endTime,
          assignedBy: req.user.id,
          groupId: grupoId,
        },
        include: { assistant: true, site: true, task: true },
      })
      creadas.push({ ...creada, ajustadoSabado: d.ajustado })
    }

    return { created: creadas, skipped: omitidas, groupId: grupoId }
  })

  // Compat: si solo 1 día y se creó OK, devolvemos shape histórico (objeto único).
  // Si rango o hay omitidas, devolvemos el shape nuevo.
  if (!grupoId && out.created.length === 1 && out.skipped.length === 0) {
    return res.status(201).json(out.created[0])
  }
  res.status(201).json(out)
}

export async function listAsignaciones(req, res) {
  const { assistant_id: auxiliar_id, site_id: sede_id, day: dia } = req.query
  const where = {}
  if (auxiliar_id) where.assistantId = auxiliar_id
  if (sede_id) where.siteId = sede_id
  if (dia) where.day = new Date(dia)
  const list = await prisma.backofficeAssignment.findMany({
    where,
    include: { assistant: true, site: true, task: true, executions: true },
    orderBy: { day: 'desc' },
  })
  res.json(list)
}

/**
 * GET /backoffice-execution — lista las ejecuciones de backoffice.
 *
 * El frontend la llamaba desde siempre (`backofficeService.ejecucionList`) pero
 * el backend nunca la registró: devolvía 404 y la pantalla se quedaba vacía sin
 * decir por qué. Se destapó al cruzar las rutas de los dos lados.
 *
 * Filtra por auxiliar a través de la asignación, que es donde vive ese dato, y
 * devuelve la asignación incluida porque es lo que espera el cliente.
 */
export async function listEjecuciones(req, res) {
  const { assistant_id: auxiliarId, backoffice_assignment_id: asignacionId } = req.query

  const where = {}
  if (asignacionId) where.backofficeAssignmentId = asignacionId
  if (auxiliarId) where.assignment = { assistantId: auxiliarId }

  const list = await prisma.backofficeExecution.findMany({
    where,
    include: {
      assignment: { include: { assistant: true, site: true, task: true } },
    },
    orderBy: { recordedAt: 'desc' },
    take: 200,
  })
  res.json(list)
}

/** Auxiliar registra ejecución (HU-R-11, RN-37) */
export async function registrar(req, res) {
  const data = registrarSchema.parse(req.body)
  const e = await prisma.backofficeExecution.create({
    data: { ...data, recordedBy: req.user.id },
  })
  res.status(201).json(e)
}

/** Pendientes de la auxiliar para hoy */
export async function pendientesAuxiliar(req, res) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const asigs = await prisma.backofficeAssignment.findMany({
    where: { assistantId: req.params.assistantId, day: hoy },
    include: { task: true, site: true, executions: true },
  })
  res.json(asigs)
}
