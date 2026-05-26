import { prisma } from '../lib/prisma.js'
import { notificarCoordinadoresDeSede } from '../services/notificacionService.js'
import { getSemanaActual } from '../lib/semana.js'

const hhmmAMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const horasFranja = (hi, hf) => (hhmmAMin(hf) - hhmmAMin(hi)) / 60

/**
 * RN-25: Alerta de recursos ociosos.
 * Job diario 6:00am — recorre recursos de salario fijo (auxiliares y optómetras).
 * Si tienen más de 4h disponibles sin asignar en la semana abierta → notifica
 * a los coordinadores de las sedes donde el recurso normalmente trabaja.
 *
 * Devuelve un resumen para logging / ejecución manual.
 */
export async function jobAlertaOciosos() {
  // La semana actual = la que contiene hoy (no la futura recién creada con 3 días de anticipación).
  const semana = await getSemanaActual()
  if (!semana) return { ok: true, semana: null, alertas: 0, mensaje: 'No hay semana actual' }

  const recursosFijos = await prisma.recurso.findMany({
    where: { activo: true, esquemaPago: { in: ['fijo', 'mixto'] } },
  })

  const asignaciones = await prisma.asignacion.findMany({
    where: { semanaId: semana.id, estado: { not: 'cancelada' } },
    include: { consultorio: { select: { sedeId: true } } },
  })

  let alertas = 0
  for (const r of recursosFijos) {
    const propias = asignaciones.filter((a) => a.recursoId === r.id || a.auxiliarId === r.id)
    const horas = propias.reduce((acc, a) => acc + horasFranja(a.horaInicio, a.horaFin), 0)
    const disponibles = r.horasMaxSemana - horas

    if (disponibles > 4) {
      // Sedes donde el recurso tiene asignaciones (o todas si no tiene ninguna)
      const sedeIds = [...new Set(propias.map((a) => a.consultorio.sedeId))]
      const sedes = sedeIds.length > 0
        ? sedeIds
        : (await prisma.sede.findMany({ where: { activa: true }, select: { id: true } })).map((s) => s.id)

      for (const sedeId of sedes) {
        await notificarCoordinadoresDeSede(sedeId, {
          tipo: 'recurso_ocioso',
          titulo: `${r.nombre} tiene ${disponibles.toFixed(1)}h sin asignar`,
          mensaje: `${r.nombre} (${r.tipo}) lleva ${horas.toFixed(1)}h de ${r.horasMaxSemana}h esta semana. Costo fijo sin utilizar — asígnale horas o backoffice.`,
          criticidad: 'alta',
        })
      }
      alertas++
    }
  }

  return { ok: true, semana: semana.id, recursos_revisados: recursosFijos.length, alertas }
}

/**
 * Alerta de consultorios sin asignar.
 * Job lunes 6:00am — recorre consultorios activos. Si un consultorio no tiene
 * NINGUNA asignación en la semana abierta → notifica al coordinador de su sede.
 */
export async function jobConsultoriosSinAsignar() {
  // Lunes 6am: la semana actual ya arrancó (hoy es lunes), así fechaInicio <= now.
  const semana = await getSemanaActual()
  if (!semana) return { ok: true, semana: null, alertas: 0, mensaje: 'No hay semana actual' }

  const consultorios = await prisma.consultorio.findMany({
    where: { activo: true },
    include: { sede: { select: { id: true, nombre: true } } },
  })

  const asignaciones = await prisma.asignacion.findMany({
    where: { semanaId: semana.id, estado: { not: 'cancelada' } },
    select: { consultorioId: true },
  })
  const consConAsignacion = new Set(asignaciones.map((a) => a.consultorioId))

  let alertas = 0
  for (const c of consultorios) {
    if (!consConAsignacion.has(c.id)) {
      await notificarCoordinadoresDeSede(c.sede.id, {
        tipo: 'consultorio_sin_asignar',
        titulo: `${c.nombre} sin asignaciones esta semana`,
        mensaje: `El consultorio ${c.nombre} (${c.especialidad}) de ${c.sede.nombre} no tiene ninguna asignación en la semana abierta. Programa recursos o márcalo inactivo.`,
        criticidad: 'media',
      })
      alertas++
    }
  }

  return { ok: true, semana: semana.id, consultorios_revisados: consultorios.length, alertas }
}
