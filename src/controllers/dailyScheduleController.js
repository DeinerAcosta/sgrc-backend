import { startOfDay, endOfDay, parseISO } from 'date-fns'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { auxiliaresDe, idsAuxiliaresDe } from '../lib/timeSlots.js'
import { INCLUDE_AUXILIARES } from '../lib/auxiliaresTurno.js'

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
        assistants: INCLUDE_AUXILIARES,
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
  const recursoIds = [...new Set(asignaciones.flatMap((a) => [a.resourceId, ...idsAuxiliaresDe(a)]).filter(Boolean))]
  const ausencias = await prisma.absence.findMany({
    where: {
      source: 'sgrc',   // Oct-2026 · Sin el histórico del Excel: solo lo registrado en el SGRC.
      resourceId: { in: recursoIds },
      startDate: { lte: endOfDay(dia) },
      endDate: { gte: startOfDay(dia) },
      status: 'confirmada',
    },
    select: { resourceId: true, type: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
  })
  // Oct-2026 · Una persona puede tener dos permisos el mismo día (08–09 y
  // 09–10:30): se guardan todos y a cada turno le toca el que pisa su horario.
  // Una parcial que no lo pisa no lo marca (antes un permiso de la mañana
  // pintaba "ausente" también el turno de la tarde).
  const ausPorRecurso = new Map()
  for (const a of ausencias) {
    if (!ausPorRecurso.has(a.resourceId)) ausPorRecurso.set(a.resourceId, [])
    ausPorRecurso.get(a.resourceId).push(a)
  }
  const ausenciaDelTurno = (recursoId, turno) => (ausPorRecurso.get(recursoId) ?? []).find((x) =>
    !x.isPartial || !x.absenceStartTime || !x.absenceEndTime ||
    (x.absenceStartTime < turno.endTime && x.absenceEndTime > turno.startTime)) ?? null

  // Anotar cada asignación con su estado de cobertura
  const items = asignaciones.map((a) => {
    const ausR = ausenciaDelTurno(a.resourceId, a)
    const fmtAus = (x) => (x ? { type: x.type, parcial: x.isPartial, desde: x.absenceStartTime, hasta: x.absenceEndTime } : null)
    // Nov-2026 · Cada auxiliar del turno contra SU horario en él (su
    // sub-horario si cubre solo una parte), no contra el del médico.
    const auxiliares = auxiliaresDe(a).map((x) => {
      const fila = a.assistants.find((y) => y.resourceId === x.resourceId)
      return {
        resource_id: x.resourceId,
        start_time: fila?.startTime ?? null,
        end_time: fila?.endTime ?? null,
        position: x.position,
        resource: fila?.resource ?? null,
        ausencia: fmtAus(ausenciaDelTurno(x.resourceId, { startTime: x.ini, endTime: x.fin })),
      }
    })
    // La primera auxiliar ausente (compatibilidad: antes solo había una).
    const ausA = auxiliares.find((x) => x.ausencia)
    return {
      id: a.id,
      start_time: a.startTime,
      end_time: a.endTime,
      room: a.room,
      resource: a.resource,
      assistants: auxiliares,
      assistant: auxiliares[0]?.resource ?? null,
      patient_capacity: a.patientCapacity,
      is_overtime: a.isOvertime,
      ausencia_recurso: ausR ? { type: ausR.type, parcial: ausR.isPartial, desde: ausR.absenceStartTime, hasta: ausR.absenceEndTime } : null,
      ausencia_auxiliar: ausA ? { ...ausA.ausencia, resource_id: ausA.resource_id } : null,
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
