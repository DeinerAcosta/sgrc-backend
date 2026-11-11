import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { TIPOS_QUE_IMPACTAN_PACIENTES } from '../lib/resourceTypes.js'
import { DIAS_MATRIZ, validarFranjas } from '../lib/matrizAuxiliares.js'

/**
 * MATRIZ DE ASIGNACIONES (nov-2026)
 * =================================
 *
 * La malla fija de las auxiliares: qué horario hace cada una cada día de la
 * semana y con qué profesionales va. Antes vivía en la hoja HORARIO
 * AUXILIARES del Excel LISTADO AUXILIARES.
 *
 * Es una plantilla, no una semana: no toca el Programador ni las horas reales.
 */

const PROFESIONAL_SELECT = { id: true, name: true, type: true, specialty: true, active: true }

const diaInclude = {
  professionals: {
    orderBy: { position: 'asc' },
    include: { resource: { select: PROFESIONAL_SELECT } },
  },
}

/** La celda tal como la pinta el frontend. */
const aCelda = (d) => ({
  id: d.id,
  assistantId: d.assistantId,
  weekday: d.weekday,
  ranges: d.ranges ?? [],
  note: d.note ?? '',
  professionals: d.professionals.map((p) => p.resource),
  updatedAt: d.updatedAt,
})

/** Lo que queda en la auditoría, legible sin consultar otras tablas. */
const resumen = (c) => c && ({
  dia: c.weekday,
  franjas: (c.ranges ?? []).map((f) => `${f.ini}-${f.fin}`).join(' '),
  profesionales: c.professionals.map((p) => p.name).join(', '),
  nota: c.note || null,
})

/**
 * GET /assistant-matrix
 * Las auxiliares activas, los profesionales que se pueden elegir y las celdas
 * de la malla, en una sola llamada: la pantalla es una tabla y no tiene más.
 */
export async function get(req, res) {
  const [auxiliares, profesionales, dias] = await Promise.all([
    prisma.resource.findMany({
      where: { type: 'auxiliar', active: true },
      select: { id: true, name: true, maxHoursPerWeek: true },
      orderBy: { name: 'asc' },
    }),
    prisma.resource.findMany({
      where: { type: { in: [...TIPOS_QUE_IMPACTAN_PACIENTES] }, active: true },
      select: PROFESIONAL_SELECT,
      orderBy: { name: 'asc' },
    }),
    prisma.assistantMatrixDay.findMany({
      where: { assistant: { type: 'auxiliar', active: true } },
      include: diaInclude,
    }),
  ])
  res.json({ assistants: auxiliares, professionals: profesionales, cells: dias.map(aCelda) })
}

const celdaSchema = z.object({
  ranges: z.array(z.object({ ini: z.string(), fin: z.string() })).default([]),
  professionalIds: z.array(z.string().uuid()).max(6).default([]),
  note: z.string().trim().max(500).optional().nullable(),
})

/**
 * PUT /assistant-matrix/:assistantId/:weekday
 * Guarda una celda completa (franjas + profesionales + nota). Si llega vacía
 * se borra: un día sin nada es un día sin fila.
 */
export async function saveCell(req, res) {
  const { assistantId, weekday } = req.params
  if (!DIAS_MATRIZ.includes(weekday)) throw errors.badRequest(`Día inválido: "${weekday}"`)
  const body = celdaSchema.parse(req.body ?? {})

  const { franjas, error } = validarFranjas(body.ranges)
  if (error) throw errors.badRequest(error)
  const nota = body.note?.trim() || null
  const ids = [...new Set(body.professionalIds)]

  const auxiliar = await prisma.resource.findUnique({ where: { id: assistantId }, select: { id: true, name: true, type: true } })
  if (!auxiliar) throw errors.notFound('No existe esa auxiliar')
  if (auxiliar.type !== 'auxiliar') throw errors.badRequest('La matriz es solo para auxiliares')

  if (ids.length) {
    const validos = await prisma.resource.findMany({
      where: { id: { in: ids }, type: { in: [...TIPOS_QUE_IMPACTAN_PACIENTES] } },
      select: { id: true },
    })
    if (validos.length !== ids.length) throw errors.badRequest('Alguno de los profesionales no existe o no es un profesional')
  }

  const anterior = await prisma.assistantMatrixDay.findUnique({
    where: { assistantId_weekday: { assistantId, weekday } },
    include: diaInclude,
  })
  const antes = anterior ? aCelda(anterior) : null

  const vacia = !franjas.length && !ids.length && !nota
  let despues = null
  if (vacia) {
    if (anterior) await prisma.assistantMatrixDay.delete({ where: { id: anterior.id } })
  } else {
    const guardada = await prisma.$transaction(async (tx) => {
      const dia = await tx.assistantMatrixDay.upsert({
        where: { assistantId_weekday: { assistantId, weekday } },
        create: { assistantId, weekday, ranges: franjas, note: nota },
        update: { ranges: franjas, note: nota },
      })
      await tx.assistantMatrixProfessional.deleteMany({ where: { dayId: dia.id } })
      if (ids.length) {
        await tx.assistantMatrixProfessional.createMany({
          data: ids.map((resourceId, position) => ({ dayId: dia.id, resourceId, position })),
        })
      }
      return tx.assistantMatrixDay.findUnique({ where: { id: dia.id }, include: diaInclude })
    })
    despues = aCelda(guardada)
  }

  if (antes || despues) {
    await registrarAuditoria({
      userId: req.user.id,
      action: vacia ? 'matriz_vaciar_dia' : 'matriz_guardar_dia',
      entity: 'matriz_auxiliares',
      entityId: `${assistantId}:${weekday}`,
      oldValue: antes && { auxiliar: auxiliar.name, ...resumen(antes) },
      newValue: despues && { auxiliar: auxiliar.name, ...resumen(despues) },
      ipAddress: getIp(req),
    })
  }

  res.json(despues ?? { assistantId, weekday, ranges: [], note: '', professionals: [] })
}
