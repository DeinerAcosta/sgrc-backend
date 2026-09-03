import { startOfDay, endOfDay, parseISO } from 'date-fns'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

const DOW = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado']

/**
 * GET /horario-diario?sede_id=&fecha=YYYY-MM-DD
 *
 * Devuelve el horario completo de una sede para un día específico:
 *   - Cada asignación de ese día con consultorio, recurso, auxiliar, horario.
 *   - Las ausencias confirmadas del personal de ese día (afectan visibilidad).
 *   - Indicadores agregados por sede: total asignaciones, capacidad, horas.
 *
 * Se usa para la pantalla "Resumen diario" del coordinador y para el job
 * que envía email automático a las 07:00 al personal programado.
 */
export async function get(req, res) {
  const { site_id: sede_id, date: fecha } = req.query
  if (!sede_id) throw errors.badRequest('sede_id requerido')
  if (!fecha) throw errors.badRequest('fecha requerida (YYYY-MM-DD)')

  const dia = parseISO(fecha)
  if (Number.isNaN(dia.getTime())) throw errors.badRequest('fecha inválida')
  const diaSemana = DOW[dia.getDay()]

  // Buscar la semana que contiene esa fecha
  const semana = await prisma.week.findFirst({
    where: { startDate: { lte: dia }, endDate: { gte: dia } },
  })

  const sede = await prisma.site.findUnique({ where: { id: sede_id } })
  if (!sede) throw errors.notFound('Sede no encontrada')

  // Verificar si esa fecha es festivo (RN-06) — el frontend lo destaca y lo
  // muestra al recurso y al coordinador en el resumen.
  const festivo = await prisma.holiday.findUnique({ where: { date: dia } })

  let asignaciones = []
  if (semana) {
    asignaciones = await prisma.assignment.findMany({
      where: {
        weekId: semana.id,
        weekday: diaSemana,
        status: { not: 'cancelada' },
        room: { siteId: sede_id },
      },
      include: {
        room: { select: { id: true, name: true, specialty: true } },
        resource: { select: { id: true, name: true, type: true, specialty: true } },
        assistant: { select: { id: true, name: true } },
      },
      orderBy: [{ startTime: 'asc' }, { room: { name: 'asc' } }],
    })
    // Re-orden secundario natural numérico dentro de la misma franja horaria
    asignaciones.sort((a, b) => {
      if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1
      return a.room.name.localeCompare(b.room.name, 'es', { numeric: true, sensitivity: 'base' })
    })
  }

  // Ausencias confirmadas que afectan a estas personas ese día
  const recursoIds = [...new Set(asignaciones.flatMap((a) => [a.resourceId, a.assistantId]).filter(Boolean))]
  const ausencias = await prisma.absence.findMany({
    where: {
      resourceId: { in: recursoIds },
      startDate: { lte: endOfDay(dia) },
      endDate: { gte: startOfDay(dia) },
      status: 'confirmada',
    },
    select: { resourceId: true, type: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
  })
  const ausPorRecurso = Object.fromEntries(ausencias.map((a) => [a.resourceId, a]))

  // Anotar cada asignación con su estado de cobertura
  const items = asignaciones.map((a) => {
    const ausR = ausPorRecurso[a.resourceId]
    const ausA = a.assistantId ? ausPorRecurso[a.assistantId] : null
    return {
      id: a.id,
      start_time: a.startTime,
      end_time: a.endTime,
      room: a.room,
      resource: a.resource,
      assistant: a.assistant,
      patient_capacity: a.patientCapacity,
      is_overtime: a.isOvertime,
      ausencia_recurso: ausR ? { type: ausR.type, parcial: ausR.isPartial, desde: ausR.absenceStartTime, hasta: ausR.absenceEndTime } : null,
      ausencia_auxiliar: ausA ? { type: ausA.type, parcial: ausA.isPartial, desde: ausA.absenceStartTime, hasta: ausA.absenceEndTime } : null,
    }
  })

  const resumen = {
    asignaciones_total: items.length,
    pacientes_capacidad_total: items.reduce((acc, x) => acc + (x.patient_capacity ?? 0), 0),
    recursos_distintos: new Set(items.map((x) => x.resource?.id).filter(Boolean)).size,
    ausencias_del_dia: ausencias.length,
  }

  res.json({
    site: { id: sede.id, name: sede.name, city: sede.city },
    date: fecha,
    weekday: diaSemana,
    es_festivo: !!festivo,
    festivo_descripcion: festivo?.description ?? null,
    week_id: semana?.id ?? null,
    resumen,
    items,
  })
}
