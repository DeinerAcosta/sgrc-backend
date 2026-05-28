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
  const { sede_id, fecha } = req.query
  if (!sede_id) throw errors.badRequest('sede_id requerido')
  if (!fecha) throw errors.badRequest('fecha requerida (YYYY-MM-DD)')

  const dia = parseISO(fecha)
  if (Number.isNaN(dia.getTime())) throw errors.badRequest('fecha inválida')
  const diaSemana = DOW[dia.getDay()]

  // Buscar la semana que contiene esa fecha
  const semana = await prisma.semana.findFirst({
    where: { fechaInicio: { lte: dia }, fechaFin: { gte: dia } },
  })

  const sede = await prisma.sede.findUnique({ where: { id: sede_id } })
  if (!sede) throw errors.notFound('Sede no encontrada')

  let asignaciones = []
  if (semana) {
    asignaciones = await prisma.asignacion.findMany({
      where: {
        semanaId: semana.id,
        diaSemana,
        estado: { not: 'cancelada' },
        consultorio: { sedeId: sede_id },
      },
      include: {
        consultorio: { select: { id: true, nombre: true, especialidad: true } },
        recurso: { select: { id: true, nombre: true, tipo: true, especialidad: true } },
        auxiliar: { select: { id: true, nombre: true } },
      },
      orderBy: [{ horaInicio: 'asc' }, { consultorio: { nombre: 'asc' } }],
    })
  }

  // Ausencias confirmadas que afectan a estas personas ese día
  const recursoIds = [...new Set(asignaciones.flatMap((a) => [a.recursoId, a.auxiliarId]).filter(Boolean))]
  const ausencias = await prisma.ausencia.findMany({
    where: {
      recursoId: { in: recursoIds },
      fechaInicio: { lte: endOfDay(dia) },
      fechaFin: { gte: startOfDay(dia) },
      estado: 'confirmada',
    },
    select: { recursoId: true, tipo: true, esParcial: true, horaInicioAusencia: true, horaFinAusencia: true },
  })
  const ausPorRecurso = Object.fromEntries(ausencias.map((a) => [a.recursoId, a]))

  // Anotar cada asignación con su estado de cobertura
  const items = asignaciones.map((a) => {
    const ausR = ausPorRecurso[a.recursoId]
    const ausA = a.auxiliarId ? ausPorRecurso[a.auxiliarId] : null
    return {
      id: a.id,
      hora_inicio: a.horaInicio,
      hora_fin: a.horaFin,
      consultorio: a.consultorio,
      recurso: a.recurso,
      auxiliar: a.auxiliar,
      pacientes_capacidad: a.pacientesCapacidad,
      es_horas_extras: a.esHorasExtras,
      ausencia_recurso: ausR ? { tipo: ausR.tipo, parcial: ausR.esParcial, desde: ausR.horaInicioAusencia, hasta: ausR.horaFinAusencia } : null,
      ausencia_auxiliar: ausA ? { tipo: ausA.tipo, parcial: ausA.esParcial, desde: ausA.horaInicioAusencia, hasta: ausA.horaFinAusencia } : null,
    }
  })

  const resumen = {
    asignaciones_total: items.length,
    pacientes_capacidad_total: items.reduce((acc, x) => acc + (x.pacientes_capacidad ?? 0), 0),
    recursos_distintos: new Set(items.map((x) => x.recurso?.id).filter(Boolean)).size,
    ausencias_del_dia: ausencias.length,
  }

  res.json({
    sede: { id: sede.id, nombre: sede.nombre, ciudad: sede.ciudad },
    fecha,
    dia_semana: diaSemana,
    semana_id: semana?.id ?? null,
    resumen,
    items,
  })
}
