import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { TIPOS_QUE_IMPACTAN_PACIENTES } from '../lib/resourceTypes.js'
import { DIAS_MATRIZ, validarFranjas, estadoAuxiliarEnTurno } from '../lib/matrizAuxiliares.js'
import { horarioEfectivoAuxEnAsig, participaEn } from '../lib/timeSlots.js'
import { SELECT_AUXILIARES, whereParticipa } from '../lib/auxiliaresTurno.js'
import { horasEfectivasConDescanso } from '../lib/workHours.js'
import { filasExportMatriz, excelMatriz, pdfMatriz } from '../services/matrizExport.js'

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
  franjas: (c.ranges ?? []).map((f) => {
    const prof = c.professionals.find((p) => p.id === f.professionalId)?.name
    return `${f.ini}-${f.fin}${f.lunch ? ` (almuerzo ${f.lunch.ini}-${f.lunch.fin})` : ''}${prof ? ` ${prof}` : ''}`
  }).join(' · '),
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
  ranges: z.array(z.object({
    ini: z.string(),
    fin: z.string(),
    // Nov-2026 · El profesional de ESA franja y su almuerzo (opcionales).
    professionalId: z.string().uuid().optional().nullable(),
    lunch: z.object({ ini: z.string(), fin: z.string() }).optional().nullable(),
  })).default([]),
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
  // Los profesionales del día = los de sus franjas (en orden) + los que lleguen
  // sueltos (la forma de antes). La tabla de profesionales del día se mantiene
  // para los filtros y para quien todavía la lea.
  const ids = [...new Set([...franjas.map((f) => f.professionalId).filter(Boolean), ...body.professionalIds])]

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

const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const turnoQuerySchema = z.object({
  week_id: z.string().uuid(),
  weekday: z.enum(DIAS_SEMANA),
  start_time: z.string().regex(HHMM_RE),
  end_time: z.string().regex(HHMM_RE),
  // El profesional del turno: decide quién sale preseleccionada (Matriz).
  professional_id: z.string().uuid().optional(),
  // Al editar, el propio turno no cuenta como "ya asignada a esa hora".
  exclude_assignment_id: z.string().uuid().optional(),
  // En diagnóstico el apoyo es otro técnico.
  type: z.enum(['auxiliar', 'tecnico']).default('auxiliar'),
})

/**
 * GET /assistant-matrix/shift
 *
 * Nov-2026 · Hector: al asignar en el Programador, la auxiliar sale
 * PRESELECCIONADA según la Matriz y la lista es una cuadrícula con, para el día
 * y la hora del turno: estado, recurso par (de la Matriz), horas del día,
 * horario que ya tiene y sede. Las horas de la semana ya vienen en
 * GET /resources?week_id=…; aquí va solo lo que depende del día y la hora.
 *
 * Ausencias: confirmadas y pendientes (una pendiente ya avisa que no viene).
 */
export async function shift(req, res) {
  const q = turnoQuerySchema.parse(req.query)
  if (q.end_time <= q.start_time) throw errors.badRequest('La hora fin debe ser después de la de inicio')
  const semana = await prisma.week.findUnique({ where: { id: q.week_id }, select: { startDate: true } })
  if (!semana) throw errors.notFound('No existe esa semana')
  const fecha = new Date(semana.startDate.getTime() + DIAS_SEMANA.indexOf(q.weekday) * 86_400_000)

  const personas = await prisma.resource.findMany({
    where: { active: true, OR: [{ type: q.type }, { supportTypes: { contains: q.type } }] },
    select: { id: true, type: true },
  })
  const ids = personas.map((p) => p.id)
  const tipoDe = new Map(personas.map((p) => [p.id, p.type]))

  const [turnos, ausencias, malla] = await Promise.all([
    prisma.assignment.findMany({
      where: {
        weekId: q.week_id,
        weekday: q.weekday,
        status: { not: 'cancelada' },
        ...whereParticipa(ids),
      },
      select: {
        id: true, resourceId: true, startTime: true, endTime: true,
        assistants: SELECT_AUXILIARES,
        room: { select: { name: true, site: { select: { name: true } } } },
      },
    }),
    prisma.absence.findMany({
      where: {
        source: 'sgrc',
        status: { in: ['confirmada', 'pendiente'] },
        resourceId: { in: ids },
        startDate: { lte: fecha },
        endDate: { gte: fecha },
      },
      select: { resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true, status: true, reasonRef: { select: { name: true } }, type: true },
    }),
    prisma.assistantMatrixDay.findMany({
      where: { assistantId: { in: ids }, weekday: q.weekday },
      include: diaInclude,
    }),
  ])

  const items = ids.map((id) => {
    // Nov-2026 · Hector: al EDITAR un turno, la auxiliar que ya va en él debe
    // mostrar ese horario, sus horas y su sede ("no marca la hora que tiene
    // asignada"). Se muestran todos sus turnos del día; el estado se calcula
    // sin el turno que se edita (si no, saldría "Asignado" en su propio turno).
    const franjas = turnos
      .filter((t) => participaEn(t, id))
      .map((t) => {
        const ef = horarioEfectivoAuxEnAsig(t, id)
        return {
          ini: ef.ini, fin: ef.fin, descanso: ef.descanso, consultorio: t.room?.name ?? null, sede: t.room?.site?.name ?? null,
          esteTurno: !!q.exclude_assignment_id && t.id === q.exclude_assignment_id,
        }
      })
      .sort((a, b) => (a.ini < b.ini ? -1 : 1))
    const otras = franjas.filter((f) => !f.esteTurno)
    const susAusencias = ausencias.filter((a) => a.resourceId === id)
    const celda = malla.find((m) => m.assistantId === id)
    const par = celda?.professionals.map((p) => ({ id: p.resource.id, name: p.resource.name })) ?? []
    // Nov-2026 · Con profesional por franja, es su pareja si una franja CON ESE
    // profesional toca el horario del turno; y su hora por defecto sale de esas
    // franjas. Las celdas viejas (sin profesional por franja) siguen igual.
    const rangos = Array.isArray(celda?.ranges) ? celda.ranges : []
    const conProf = rangos.some((r) => r.professionalId)
    const delProf = q.professional_id ? rangos.filter((r) => r.professionalId === q.professional_id) : []
    const toca = (r) => r.ini < q.end_time && q.start_time < r.fin
    const esPareja = !!q.professional_id && (conProf
      ? delProf.some(toca)
      : par.some((p) => p.id === q.professional_id))
    const horasDia = franjas.reduce((s, f) => s + horasEfectivasConDescanso(f.ini, f.fin, tipoDe.get(id), f.descanso), 0)
    const aus = susAusencias[0]
    return {
      id,
      estado: estadoAuxiliarEnTurno({ ausencias: susAusencias, franjas: otras, ini: q.start_time, fin: q.end_time }),
      motivoAusencia: aus ? `${aus.reasonRef?.name ?? aus.type}${aus.status === 'pendiente' ? ' (sin confirmar)' : ''}` : null,
      recursosPar: par,
      preseleccionada: esPareja,
      horasDia: Math.round(horasDia * 10) / 10,
      horario: franjas,
      sedes: [...new Set(franjas.map((f) => f.sede).filter(Boolean))],
      // Nov-2026 · Sus franjas de ese día en la Matriz (la malla fija), para
      // que el Programador proponga el sub-horario con el que entra al turno.
      // Vacío si no tiene celda ese día.
      franjasMatriz: (conProf && delProf.length ? delProf : rangos).map((r) => ({ ini: r.ini, fin: r.fin, lunch: r.lunch ?? null })),
    }
  })
  res.json(items)
}

const exportSchema = z.object({
  format: z.enum(['pdf', 'xlsx']).default('pdf'),
  // Las auxiliares que se ven en pantalla, ya filtradas y en su orden.
  assistantIds: z.array(z.string().uuid()).max(500),
  // Los días que se ven (todos, o el del filtro "Día").
  days: z.array(z.enum(DIAS_MATRIZ)).min(1).max(7),
  // Los filtros en texto, para el encabezado del archivo.
  filtersText: z.string().max(300).optional().nullable(),
})

/**
 * POST /assistant-matrix/export
 * Nov-2026 · Hector: descargar la Matriz en Excel o PDF con cualquier filtro.
 * Se exporta exactamente lo que se ve: esas auxiliares, en ese orden, esos días.
 */
export async function exportar(req, res) {
  const body = exportSchema.parse(req.body ?? {})
  const dias = DIAS_MATRIZ.filter((d) => body.days.includes(d))
  const [auxiliares, celdas] = await Promise.all([
    prisma.resource.findMany({
      where: { id: { in: body.assistantIds }, type: 'auxiliar' },
      select: { id: true, name: true, maxHoursPerWeek: true },
    }),
    prisma.assistantMatrixDay.findMany({
      where: { assistantId: { in: body.assistantIds } },
      include: diaInclude,
    }),
  ])
  const porId = new Map(auxiliares.map((a) => [a.id, a]))
  const ordenadas = body.assistantIds.map((id) => porId.get(id)).filter(Boolean)
  const mapa = new Map(celdas.map((c) => [`${c.assistantId}:${c.weekday}`, aCelda(c)]))
  const filas = filasExportMatriz(ordenadas, mapa, dias, DIAS_MATRIZ)

  await registrarAuditoria({
    userId: req.user.id,
    action: 'exportar_matriz',
    entity: 'matriz_auxiliares',
    entityId: body.format,
    newValue: { formato: body.format, dias, filtros: body.filtersText ?? null, registros: filas.length },
    ipAddress: getIp(req),
  })

  const fecha = new Date().toISOString().slice(0, 10)
  const nombre = `matriz_asignaciones_${dias.length === 1 ? `${dias[0]}_` : ''}${fecha}`
  if (body.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`)
    return res.send(await excelMatriz(filas, dias, body.filtersText))
  }
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}.pdf"`)
  return res.send(await pdfMatriz(filas, dias, body.filtersText))
}
