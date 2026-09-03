import { prisma } from '../lib/prisma.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { emailsRecursoActivados } from '../services/notificationService.js'

const DOW = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado']

/**
 * Resumen diario del horario por sede.
 *
 * Cada mañana a las 07:00 (America/Bogota), por cada sede activa:
 *   - Calcula las asignaciones del día.
 *   - Envía a cada recurso PROGRAMADO un email con su jornada.
 *   - Envía a los coordinadores de la sede un email con el resumen completo.
 *
 * Tolerante a errores: nunca tumba el cron — registra y sigue.
 */
export async function jobResumenDiario(fechaOverride = null) {
  const dia = fechaOverride ?? new Date()
  const diaSemana = DOW[dia.getDay()]
  const fechaTxt = dia.toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long' })

  const sedes = await prisma.site.findMany({ where: { active: true } })
  let emailsEnviados = 0
  let sedesProcessed = 0

  // La semana que contiene el día es la MISMA para todas las sedes, así que se
  // resuelve una sola vez. Antes estaba dentro del bucle y se repetía idéntica
  // una vez por sede.
  const semana = await prisma.week.findFirst({
    where: { startDate: { lte: dia }, endDate: { gte: dia } },
  })
  if (!semana) return { emailsEnviados: 0, sedesProcessed: 0, reason: 'no hay semana que contenga ese día' }

  for (const sede of sedes) {
    try {
      const asigs = await prisma.assignment.findMany({
        where: {
          weekId: semana.id,
          weekday: diaSemana,
          status: { not: 'cancelada' },
          room: { siteId: sede.id },
        },
        include: {
          room: { select: { name: true, specialty: true } },
          resource: { include: { user: true } },
          assistant: { include: { user: true } },
        },
        orderBy: { startTime: 'asc' },
      })
      if (asigs.length === 0) continue
      sedesProcessed++

      // === 1) Email individual a cada recurso/auxiliar programado ===
      const filasPorUsuario = new Map() // usuarioId -> [filas html]
      const acumular = (usuario, fila) => {
        if (!usuario || !usuario.email) return
        if (!filasPorUsuario.has(usuario.id)) filasPorUsuario.set(usuario.id, { user: usuario, filas: [] })
        filasPorUsuario.get(usuario.id).filas.push(fila)
      }
      const filasSede = []
      for (const a of asigs) {
        const fila = {
          horario: `${a.startTime}–${a.endTime}`,
          room: a.room?.name ?? '—',
          resource: a.resource?.name ?? '—',
          assistant: a.assistant?.name ?? '—',
          pacientes: a.patientCapacity ?? 0,
        }
        filasSede.push(fila)
        acumular(a.resource?.user, fila)
        if (a.assistantId) acumular(a.assistant?.user, fila)
      }

      // Si el switch de emails-a-recursos está en off (cuadre de personal),
      // saltamos el bloque individual y solo notificamos a coordinadores abajo.
      const enviarARecursos = emailsRecursoActivados()
      for (const { user: usuario, filas } of (enviarARecursos ? filasPorUsuario.values() : [])) {
        const totalPac = filas.reduce((acc, f) => acc + f.pacientes, 0)
        const html = `Hola ${usuario.name},<br><br>Este es tu horario de hoy <strong>${fechaTxt}</strong> en <strong>${sede.name}</strong>:<br><br>
          ${tabla(filas)}<br>
          <div style="margin-top:8px;font-size:13px;color:#555">Total pacientes programados: <strong>${totalPac}</strong></div>
          <div style="margin-top:8px;font-size:12px;color:#999">Recuerda registrar tu ejecución antes del lunes 23:59 siguiente al sábado (o el día hábil posterior si el lunes es festivo).</div>`
        await enviarEmail({
          to: usuario.email,
          subject: `[VIU · FOCA | SGRC] Tu horario de hoy — ${fechaTxt}`,
          html: plantillaEmail('Tu horario de hoy', html),
          text: `Hoy ${fechaTxt} tienes ${filas.length} franja(s) programada(s) en ${sede.name}.`,
        })
        emailsEnviados++
      }

      // === 2) Email a los coordinadores de la sede con el resumen completo ===
      const vinculos = await prisma.userSite.findMany({
        where: { siteId: sede.id },
        include: { user: true },
      })
      const coordinadores = vinculos.map((v) => v.user).filter((u) => u.role === 'coordinador' && u.active)
      const totalPacSede = filasSede.reduce((acc, f) => acc + f.pacientes, 0)
      for (const u of coordinadores) {
        const html = `Hola ${u.name},<br><br>Resumen del horario de hoy <strong>${fechaTxt}</strong> en <strong>${sede.name}</strong>:<br><br>
          ${tabla(filasSede)}<br>
          <div style="margin-top:8px;font-size:13px;color:#555">Asignaciones: <strong>${filasSede.length}</strong> · Pacientes programados: <strong>${totalPacSede}</strong></div>`
        await enviarEmail({
          to: u.email,
          subject: `[VIU · FOCA | SGRC] Resumen diario ${sede.name} — ${fechaTxt}`,
          html: plantillaEmail(`Resumen diario · ${sede.name}`, html),
          text: `Resumen ${sede.name} hoy ${fechaTxt}: ${filasSede.length} asignaciones, ${totalPacSede} pacientes.`,
        })
        emailsEnviados++
      }
    } catch (e) {
      console.error(`[RESUMEN DIARIO] Error en sede ${sede.name}:`, e.message)
    }
  }

  return { sedesProcessed, emailsEnviados }
}

/** Tabla HTML mínima para emails. */
function tabla(filas) {
  if (!filas.length) return '<div style="color:#999">Sin asignaciones.</div>'
  const head = `<tr style="background:#f4f4f5;color:#333;font-weight:600">
    <th align="left" style="padding:8px">Horario</th>
    <th align="left" style="padding:8px">Consultorio</th>
    <th align="left" style="padding:8px">Recurso</th>
    <th align="left" style="padding:8px">Auxiliar</th>
    <th align="right" style="padding:8px">Pac.</th>
  </tr>`
  const body = filas.map((f) => `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.horario}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.room}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.resource}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.assistant}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${f.pacientes}</td>
  </tr>`).join('')
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">${head}${body}</table>`
}
