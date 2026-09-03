import { prisma } from '../lib/prisma.js'
import { enviarEmail, plantillaEmail, ASUNTO_PREFIJO } from './emailService.js'
import { enviarWhatsApp } from './whatsappService.js'

/**
 * Switch operativo: cuando vale "false" en .env, NO se mandan emails a los
 * usuarios con rol "recurso" (las notificaciones in-app se siguen creando
 * normalmente). Pensado para silenciar la bandeja durante cuadres de personal
 * o periodos de configuración masiva, sin perder la trazabilidad en la app.
 * Default = true (comportamiento original).
 */
export function emailsRecursoActivados() {
  return process.env.EMAIL_NOTIFY_RECURSOS !== 'false'
}

/**
 * Switch del canal WhatsApp. Default = false (desactivado). El canal no está
 * en uso operativo — el proveedor no está contratado y las 58k+ filas
 * "whatsapp" acumuladas nunca se enviaron. Para reactivar en el futuro,
 * poner WHATSAPP_NOTIFY_ENABLED=true en .env y configurar WHATSAPP_API_*.
 */
export function whatsappActivado() {
  return process.env.WHATSAPP_NOTIFY_ENABLED === 'true'
}

/** Quita tags HTML del valor (para versión plain-text del email). */
function stripHtml(v) { return String(v ?? '').replace(/<[^>]+>/g, '') }

/**
 * Servicio central de notificaciones — Levantamiento §9.
 *
 * Criticidad determina los canales (RN-26 — sin restricción horaria):
 *   - baja  → solo app
 *   - media → app + email
 *   - alta  → app + email + whatsapp
 *
 * Email llega a TODOS los roles según su criticidad (incluido directivo, para
 * que las novedades importantes —ausencias, conflictos— le lleguen al correo
 * asociado a su perfil). WhatsApp se reserva para coordinadores/recursos en
 * criticidad alta — el directivo no recibe WhatsApp porque su flujo es
 * consultar dashboards, no responder push.
 *
 * Crea un registro en `notificaciones` por cada canal usado y dispara los
 * envíos en paralelo. Nunca lanza error que tumbe la operación principal.
 */
export async function notificar({
  userId: usuarioId,
  type: tipo,
  title: titulo,
  message: mensaje,
  criticidad = 'media',
  referenceId: referenciaId = null,
  // Tabla opcional [['Sede','Mall Plaza'], ['Día','Martes 25/06'], …] que se
  // renderiza en el email para hacerlo informativo y profesional. La notificación
  // in-app solo guarda `mensaje` plano — los detalles los ve completos en el email.
  detalles = null,
  // Línea de contexto (intro) que va arriba del cuerpo del email.
  contexto = null,
  // CTA opcional: link + texto del botón.
  accionUrl = null,
  accionTexto = null,
}) {
  try {
    const usuario = await prisma.user.findUnique({ where: { id: usuarioId } })
    if (!usuario || !usuario.active) return

    const esDirectivo = usuario.role === 'directivo'
    const esRecurso = usuario.role === 'recurso'
    const canales = ['app']
    if (criticidad === 'media' || criticidad === 'alta') canales.push('email')
    if (!esDirectivo && criticidad === 'alta' && whatsappActivado()) canales.push('whatsapp')

    // Silenciador temporal de email a recursos (ver emailsRecursoActivados).
    // Mantiene la notificación in-app pero quita el email durante cuadres.
    if (esRecurso && !emailsRecursoActivados()) {
      const i = canales.indexOf('email')
      if (i >= 0) canales.splice(i, 1)
    }

    // Registrar en BD — un registro por canal
    for (const canal of canales) {
      await prisma.notification.create({
        data: {
          userId: usuarioId,
          type: tipo,
          title: titulo,
          message: mensaje,
          channel: canal,
          referenceId: referenciaId,
          sent: canal === 'app', // app se considera "enviada" al crearse
        },
      })
    }

    // Disparar envíos externos
    const envios = []
    if (canales.includes('email')) {
      // Versión plain-text del email (para clientes que no renderizan HTML).
      const textoPlano = [
        titulo,
        '',
        contexto ?? '',
        mensaje,
        ...(detalles?.length ? ['', ...detalles.map(([k, v]) => `${k}: ${stripHtml(v)}`)] : []),
        accionUrl ? `\n${accionTexto ?? 'Ver detalle'}: ${accionUrl}` : '',
      ].filter(Boolean).join('\n')
      envios.push(
        enviarEmail({
          to: usuario.email,
          subject: `${ASUNTO_PREFIJO} ${titulo}`,
          html: plantillaEmail(titulo, mensaje, accionUrl, accionTexto, detalles, contexto),
          text: textoPlano,
        })
      )
    }
    if (canales.includes('whatsapp')) {
      envios.push(enviarWhatsApp(usuario.phone, `*SGRC — ${titulo}*\n${mensaje}`))
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
  const vinculos = await prisma.userSite.findMany({
    where: { siteId: sedeId },
    include: { user: true },
  })
  const coordinadores = vinculos
    .filter((v) => v.user.role === 'coordinador' && v.user.active)
    .map((v) => v.user.id)

  await Promise.allSettled(
    coordinadores.map((id) => notificar({ ...payload, userId: id }))
  )
  return coordinadores.length
}

/**
 * Notifica a TODOS los directivos activos del sistema (app + email).
 * Útil para eventos relevantes a nivel gerencial: ausencias confirmadas,
 * conflictos no resueltos, picos de horas extras, etc.
 */
export async function notificarDirectivos(payload) {
  const directivos = await prisma.user.findMany({
    where: { role: 'directivo', active: true },
  })
  await Promise.allSettled(
    directivos.map((u) => notificar({ ...payload, userId: u.id }))
  )
  return directivos.length
}

/**
 * Notifica a TODOS los supervisores activos del sistema.
 * Usado cuando un coordinador solicita crear una nueva tarea de backoffice:
 * el alta del catálogo es potestad del supervisor (HU-S-06), así que se le avisa.
 */
export async function notificarSupervisores(payload) {
  const supervisores = await prisma.user.findMany({
    where: { role: 'supervisor', active: true },
  })
  await Promise.allSettled(
    supervisores.map((u) => notificar({ ...payload, userId: u.id }))
  )
  return supervisores.length
}

/**
 * Envía correo a los buzones fijos de Dirección Médica (ago-2026).
 * NO crea registro in-app porque estos buzones no son usuarios del sistema —
 * son cuentas institucionales que reciben la copia informativa. Los destinatarios
 * se toman de la variable EMAIL_DIRECCION_MEDICA (lista separada por comas);
 * el default cubre los dos buzones actuales para funcionar sin cambios de .env.
 */
export async function notificarDireccionMedica({
  title: titulo,
  message: mensaje,
  detalles = null,
  contexto = null,
  accionUrl = null,
  accionTexto = null,
}) {
  const raw = process.env.EMAIL_DIRECCION_MEDICA
    || 'secretariadirmedica@cofca.com,direccionmedica@cofca.com'
  const destinatarios = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!destinatarios.length) return 0

  const textoPlano = [
    titulo,
    '',
    contexto ?? '',
    mensaje,
    ...(detalles?.length ? ['', ...detalles.map(([k, v]) => `${k}: ${stripHtml(v)}`)] : []),
    accionUrl ? `\n${accionTexto ?? 'Ver detalle'}: ${accionUrl}` : '',
  ].filter(Boolean).join('\n')

  const envios = destinatarios.map((to) =>
    enviarEmail({
      to,
      subject: `${ASUNTO_PREFIJO} ${titulo}`,
      html: plantillaEmail(titulo, mensaje, accionUrl, accionTexto, detalles, contexto),
      text: textoPlano,
    }).catch((e) => console.error(`[DIR-MEDICA email ${to}]`, e.message))
  )
  await Promise.allSettled(envios)
  return destinatarios.length
}

/**
 * Notifica a todos los coordinadores de la ciudad de una sede (RN-05).
 */
export async function notificarCoordinadoresDeCiudad(sedeId, payload) {
  const sede = await prisma.site.findUnique({ where: { id: sedeId } })
  if (!sede) return 0
  const sedesCiudad = await prisma.site.findMany({ where: { city: sede.city } })
  let total = 0
  for (const s of sedesCiudad) {
    total += await notificarCoordinadoresDeSede(s.id, payload)
  }
  return total
}
