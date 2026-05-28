import { prisma } from '../lib/prisma.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'

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

  const sedes = await prisma.sede.findMany({ where: { activa: true } })
  let emailsEnviados = 0
  let sedesProcessed = 0

  for (const sede of sedes) {
    try {
      // Semana que contiene este día
      const semana = await prisma.semana.findFirst({
        where: { fechaInicio: { lte: dia }, fechaFin: { gte: dia } },
      })
      if (!semana) continue

      const asigs = await prisma.asignacion.findMany({
        where: {
          semanaId: semana.id,
          diaSemana,
          estado: { not: 'cancelada' },
          consultorio: { sedeId: sede.id },
        },
        include: {
          consultorio: { select: { nombre: true, especialidad: true } },
          recurso: { include: { usuario: true } },
          auxiliar: { include: { usuario: true } },
        },
        orderBy: { horaInicio: 'asc' },
      })
      if (asigs.length === 0) continue
      sedesProcessed++

      // === 1) Email individual a cada recurso/auxiliar programado ===
      const filasPorUsuario = new Map() // usuarioId -> [filas html]
      const acumular = (usuario, fila) => {
        if (!usuario || !usuario.email) return
        if (!filasPorUsuario.has(usuario.id)) filasPorUsuario.set(usuario.id, { usuario, filas: [] })
        filasPorUsuario.get(usuario.id).filas.push(fila)
      }
      const filasSede = []
      for (const a of asigs) {
        const fila = {
          horario: `${a.horaInicio}–${a.horaFin}`,
          consultorio: a.consultorio?.nombre ?? '—',
          recurso: a.recurso?.nombre ?? '—',
          auxiliar: a.auxiliar?.nombre ?? '—',
          pacientes: a.pacientesCapacidad ?? 0,
        }
        filasSede.push(fila)
        acumular(a.recurso?.usuario, fila)
        if (a.auxiliarId) acumular(a.auxiliar?.usuario, fila)
      }

      for (const { usuario, filas } of filasPorUsuario.values()) {
        const totalPac = filas.reduce((acc, f) => acc + f.pacientes, 0)
        const html = `Hola ${usuario.nombre},<br><br>Este es tu horario de hoy <strong>${fechaTxt}</strong> en <strong>${sede.nombre}</strong>:<br><br>
          ${tabla(filas)}<br>
          <div style="margin-top:8px;font-size:13px;color:#555">Total pacientes programados: <strong>${totalPac}</strong></div>
          <div style="margin-top:8px;font-size:12px;color:#999">Recuerda registrar tu ejecución antes del viernes 23:59.</div>`
        await enviarEmail({
          to: usuario.email,
          subject: `[SGRC] Tu horario de hoy — ${fechaTxt}`,
          html: plantillaEmail('Tu horario de hoy', html),
          text: `Hoy ${fechaTxt} tienes ${filas.length} franja(s) programada(s) en ${sede.nombre}.`,
        })
        emailsEnviados++
      }

      // === 2) Email a los coordinadores de la sede con el resumen completo ===
      const vinculos = await prisma.usuarioSede.findMany({
        where: { sedeId: sede.id },
        include: { usuario: true },
      })
      const coordinadores = vinculos.map((v) => v.usuario).filter((u) => u.rol === 'coordinador' && u.activo)
      const totalPacSede = filasSede.reduce((acc, f) => acc + f.pacientes, 0)
      for (const u of coordinadores) {
        const html = `Hola ${u.nombre},<br><br>Resumen del horario de hoy <strong>${fechaTxt}</strong> en <strong>${sede.nombre}</strong>:<br><br>
          ${tabla(filasSede)}<br>
          <div style="margin-top:8px;font-size:13px;color:#555">Asignaciones: <strong>${filasSede.length}</strong> · Pacientes programados: <strong>${totalPacSede}</strong></div>`
        await enviarEmail({
          to: u.email,
          subject: `[SGRC] Resumen diario ${sede.nombre} — ${fechaTxt}`,
          html: plantillaEmail(`Resumen diario · ${sede.nombre}`, html),
          text: `Resumen ${sede.nombre} hoy ${fechaTxt}: ${filasSede.length} asignaciones, ${totalPacSede} pacientes.`,
        })
        emailsEnviados++
      }
    } catch (e) {
      console.error(`[RESUMEN DIARIO] Error en sede ${sede.nombre}:`, e.message)
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
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.consultorio}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.recurso}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee">${f.auxiliar}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${f.pacientes}</td>
  </tr>`).join('')
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">${head}${body}</table>`
}
