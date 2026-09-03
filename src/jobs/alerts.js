import { prisma } from '../lib/prisma.js'
import { notificar, notificarCoordinadoresDeSede } from '../services/notificationService.js'
import { getSemanaActual } from '../lib/week.js'
import { horasEfectivasFranja } from '../lib/workHours.js'

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
  if (!semana) return { ok: true, week: null, alertas: 0, message: 'No hay semana actual' }

  const recursosFijos = await prisma.resource.findMany({
    where: { active: true, payScheme: { in: ['fijo', 'mixto'] } },
    include: { user: { include: { sites: { include: { site: { select: { name: true } } } } } } },
  })

  const asignaciones = await prisma.assignment.findMany({
    where: { weekId: semana.id, status: { not: 'cancelada' } },
    include: { room: { select: { siteId: true, site: { select: { name: true } } } } },
  })

  const TIPOS_LABEL = {
    oftalmologo: 'Oftalmólogo', anestesiologo: 'Anestesiólogo', optometra: 'Optómetra',
    assistant: 'Auxiliar de enfermería', tecnico: 'Técnico de diagnóstico', asesor_servicios: 'Asesor de servicios',
  }
  const fechaSemana = (d) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })

  let alertas = 0
  for (const r of recursosFijos) {
    const propias = asignaciones.filter((a) => a.resourceId === r.id || a.assistantId === r.id)
    // Comparamos horas EFECTIVAS (descontando almuerzo) contra el tope semanal,
    // que también está en horas efectivas (Ley 2101). Antes contábamos brutas
    // y los recursos parecían menos ociosos de lo que realmente eran.
    const horas = propias.reduce((acc, a) => acc + horasEfectivasFranja(a.startTime, a.endTime, r.type), 0)
    const disponibles = r.maxHoursPerWeek - horas

    if (disponibles > 4) {
      const sedesAsignaciones = [...new Set(propias.map((a) => a.room.site?.name).filter(Boolean))]
      const sedesUsuario = (r.user?.sites ?? []).map((us) => us.site.name)
      const sedesTodas = [...new Set([...sedesAsignaciones, ...sedesUsuario])]
      const sedesStr = sedesTodas.length > 0 ? sedesTodas.join(', ') : '(sin sede asignada)'
      const pctOcupado = ((horas / r.maxHoursPerWeek) * 100).toFixed(0)
      const pctOcioso = (100 - Number(pctOcupado)).toFixed(0)

      const payload = {
        type: 'recurso_ocioso',
        title: `Recurso con ${disponibles.toFixed(1)}h sin asignar: ${r.name}`,
        message: `<p>El recurso <strong>${r.name}</strong> lleva <strong>${horas.toFixed(1)} h asignadas</strong> de un tope contractual de <strong>${r.maxHoursPerWeek} h semanales</strong>, lo que equivale a <strong>${disponibles.toFixed(1)} h sin asignar</strong> en la semana en curso.</p>
        <p>Al tratarse de un recurso de salario fijo, las horas no asignadas representan <strong>costo operativo subutilizado</strong>. Se recomienda completar su agenda con asignaciones de programación o tareas de backoffice antes del cierre semanal del registro (lunes 23:59 siguiente al sábado, o el día hábil posterior si el lunes es festivo).</p>`,
        contexto: `Alerta automática del módulo de Productividad — Regla de Negocio RN-25: Detección de recursos ociosos`,
        criticidad: 'alta',
        detalles: [
          ['Recurso',              `${r.name}`],
          ['Tipo de recurso',      TIPOS_LABEL[r.type] ?? r.type],
          ['Sede(s) habituales',   sedesStr],
          ['Semana evaluada',      `${fechaSemana(semana.startDate)} — ${fechaSemana(semana.endDate)}`],
          ['Horas asignadas',      `<strong>${horas.toFixed(1)} h</strong> (${pctOcupado}% del tope)`],
          ['Horas sin asignar',    `<strong style="color:#dc2626">${disponibles.toFixed(1)} h</strong> (${pctOcioso}% ocioso)`],
          ['Tope contractual',     `${r.maxHoursPerWeek} h / semana`],
          ['Acción sugerida',      'Asignar agenda en el Programador o derivar a tareas de Backoffice'],
        ],
        accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/programador`,
        accionTexto: 'Abrir el Programador',
      }
      // Ruta de notificación:
      //   1) Si el recurso tiene coord-líder asignado → notificar SOLO a ese coord (caso normal: cada
      //      auxiliar/asesor/técnico tiene un líder responsable de su productividad).
      //   2) Si NO tiene coord-líder pero SÍ tiene asignaciones → notificar a las sedes donde está
      //      asignado (fallback razonable: alguien que sí trabaja con él).
      //   3) Si no tiene ni líder ni asignaciones → NO alertar. Antes el job mandaba la alerta a
      //      todas las sedes activas, lo que generaba spam a coordinadores que no manejan el
      //      recurso (caso reportado por coordinador con 4 alertas diarias de personal ajeno).
      if (r.leadCoordinatorId) {
        await notificar({ userId: r.leadCoordinatorId, ...payload })
        alertas++
      } else {
        const sedeIds = [...new Set(propias.map((a) => a.room.siteId))]
        if (sedeIds.length > 0) {
          for (const sedeId of sedeIds) {
            await notificarCoordinadoresDeSede(sedeId, payload)
          }
          alertas++
        }
        // else: sin líder y sin asignaciones → silencio. Supervisor lo verá en el catálogo.
      }
    }
  }

  return { ok: true, week: semana.id, recursos_revisados: recursosFijos.length, alertas }
}

/**
 * Alerta de consultorios sin asignar.
 * Job lunes 6:00am — recorre consultorios activos. Si un consultorio no tiene
 * NINGUNA asignación en la semana abierta → notifica al coordinador de su sede.
 */
export async function jobConsultoriosSinAsignar() {
  // Lunes 6am: la semana actual ya arrancó (hoy es lunes), así fechaInicio <= now.
  const semana = await getSemanaActual()
  if (!semana) return { ok: true, week: null, alertas: 0, message: 'No hay semana actual' }

  const consultorios = await prisma.room.findMany({
    where: { active: true },
    include: { site: { select: { id: true, name: true } } },
  })

  const asignaciones = await prisma.assignment.findMany({
    where: { weekId: semana.id, status: { not: 'cancelada' } },
    select: { roomId: true },
  })
  const consConAsignacion = new Set(asignaciones.map((a) => a.roomId))

  const fechaSemana = (d) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
  const ESPECIALIDADES_LABEL = {
    oftalmologia: 'Oftalmología', optometria: 'Optometría', anestesiologia: 'Anestesiología',
    diagnostico: 'Diagnóstico', asesoria: 'Asesoría',
  }

  let alertas = 0
  for (const c of consultorios) {
    if (!consConAsignacion.has(c.id)) {
      await notificarCoordinadoresDeSede(c.site.id, {
        type: 'consultorio_sin_asignar',
        title: `Consultorio sin asignaciones: ${c.name} (${c.site.name})`,
        message: `<p>El consultorio <strong>${c.name}</strong> de la sede <strong>${c.site.name}</strong> no presenta ninguna asignación de recursos en la semana en curso.</p>
        <p>Un consultorio sin asignaciones representa <strong>capacidad instalada subutilizada</strong>. Se recomienda programar recursos durante la semana o, si el consultorio no estará en uso, marcarlo como inactivo desde el módulo de Sedes y consultorios.</p>`,
        contexto: `Alerta automática del módulo de Ocupación — Revisión semanal de consultorios activos`,
        criticidad: 'media',
        detalles: [
          ['Consultorio',          c.name],
          ['Sede',                 c.site.name],
          ['Especialidad',         ESPECIALIDADES_LABEL[c.specialty] ?? c.specialty],
          ['Semana evaluada',      `${fechaSemana(semana.startDate)} — ${fechaSemana(semana.endDate)}`],
          ['Asignaciones programadas', '<strong style="color:#dc2626">0</strong>'],
          ['Acción sugerida',      'Programar recursos desde el Programador, o desactivar el consultorio si no se va a usar'],
        ],
        accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/programador`,
        accionTexto: 'Abrir el Programador',
      })
      alertas++
    }
  }

  return { ok: true, week: semana.id, consultorios_revisados: consultorios.length, alertas }
}
