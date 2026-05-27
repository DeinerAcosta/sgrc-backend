import { prisma } from '../lib/prisma.js'
import { enviarEmail, plantillaEmail } from './emailService.js'
import { enviarWhatsApp } from './whatsappService.js'

/**
 * Servicio central de notificaciones — Levantamiento §9.
 *
 * Criticidad determina los canales (RN-26 — sin restricción horaria):
 *   - baja  → solo app
 *   - media → app + email
 *   - alta  → app + email + whatsapp
 *
 * RN-28: los directivos NO reciben push/whatsapp — solo consultan su dashboard.
 * Por eso si el destinatario es directivo, se omiten email y whatsapp.
 *
 * Crea un registro en `notificaciones` por cada canal usado y dispara los
 * envíos en paralelo. Nunca lanza error que tumbe la operación principal.
 */
export async function notificar({
  usuarioId,
  tipo,
  titulo,
  mensaje,
  criticidad = 'media',
  referenciaId = null,
}) {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } })
    if (!usuario || !usuario.activo) return

    const esDirectivo = usuario.rol === 'directivo'
    const canales = ['app']
    if (!esDirectivo && (criticidad === 'media' || criticidad === 'alta')) canales.push('email')
    if (!esDirectivo && criticidad === 'alta') canales.push('whatsapp')

    // Registrar en BD — un registro por canal
    for (const canal of canales) {
      await prisma.notificacion.create({
        data: {
          usuarioId,
          tipo,
          titulo,
          mensaje,
          canal,
          referenciaId,
          enviada: canal === 'app', // app se considera "enviada" al crearse
        },
      })
    }

    // Disparar envíos externos
    const envios = []
    if (canales.includes('email')) {
      envios.push(
        enviarEmail({
          to: usuario.email,
          subject: `[SGRC] ${titulo}`,
          html: plantillaEmail(titulo, mensaje),
          text: `${titulo}\n\n${mensaje}`,
        })
      )
    }
    if (canales.includes('whatsapp')) {
      envios.push(enviarWhatsApp(usuario.celular, `*SGRC — ${titulo}*\n${mensaje}`))
    }
    await Promise.allSettled(envios)
  } catch (e) {
    console.error('[NOTIFICACION] Error:', e.message)
  }
}

/**
 * Notifica a TODOS los coordinadores de una sede.
 * Usado cuando se reporta una ausencia, conflicto, etc.
 */
export async function notificarCoordinadoresDeSede(sedeId, payload) {
  const vinculos = await prisma.usuarioSede.findMany({
    where: { sedeId },
    include: { usuario: true },
  })
  const coordinadores = vinculos
    .filter((v) => v.usuario.rol === 'coordinador' && v.usuario.activo)
    .map((v) => v.usuario.id)

  await Promise.allSettled(
    coordinadores.map((id) => notificar({ ...payload, usuarioId: id }))
  )
  return coordinadores.length
}

/**
 * Notifica a TODOS los supervisores activos del sistema.
 * Usado cuando un coordinador solicita crear una nueva tarea de backoffice:
 * el alta del catálogo es potestad del supervisor (HU-S-06), así que se le avisa.
 */
export async function notificarSupervisores(payload) {
  const supervisores = await prisma.usuario.findMany({
    where: { rol: 'supervisor', activo: true },
  })
  await Promise.allSettled(
    supervisores.map((u) => notificar({ ...payload, usuarioId: u.id }))
  )
  return supervisores.length
}

/**
 * Notifica a todos los coordinadores de la ciudad de una sede (RN-05).
 */
export async function notificarCoordinadoresDeCiudad(sedeId, payload) {
  const sede = await prisma.sede.findUnique({ where: { id: sedeId } })
  if (!sede) return 0
  const sedesCiudad = await prisma.sede.findMany({ where: { ciudad: sede.ciudad } })
  let total = 0
  for (const s of sedesCiudad) {
    total += await notificarCoordinadoresDeSede(s.id, payload)
  }
  return total
}
