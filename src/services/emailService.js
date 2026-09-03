import nodemailer from 'nodemailer'

/**
 * Servicio de email vía Nodemailer.
 *
 * Si SMTP_HOST está configurado en .env → envía emails reales.
 * Si NO está configurado → "log mode": imprime el email en consola.
 *
 * Esto permite que TODO el flujo de notificaciones funcione hoy mismo;
 * cuando el cliente entregue las credenciales SMTP, basta llenarlas en .env
 * y los emails salen de verdad — sin tocar código.
 */

let transporter = null
const smtpConfigurado = !!process.env.SMTP_HOST

if (smtpConfigurado) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? 587),
    secure: parseInt(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  })
  console.log('📧 Email: SMTP configurado —', process.env.SMTP_HOST)
} else {
  console.log('📧 Email: modo LOG (SMTP_HOST vacío en .env — los emails se imprimen en consola)')
}

/**
 * Envía un email. Devuelve { enviado: boolean, modo: 'smtp'|'log' }.
 * Nunca lanza error que tumbe la operación principal.
 */
export async function enviarEmail({ to, subject, html, text }) {
  if (!smtpConfigurado) {
    console.log('\n📧 [EMAIL — modo log]')
    console.log(`   Para:    ${to}`)
    console.log(`   Asunto:  ${subject}`)
    console.log(`   Cuerpo:  ${text ?? html?.replace(/<[^>]+>/g, '').trim().slice(0, 200)}`)
    console.log('')
    return { enviado: false, modo: 'log' }
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'SGRC <noreply@cofca.co>',
      to,
      subject,
      html,
      text,
    })
    return { enviado: true, modo: 'smtp' }
  } catch (e) {
    console.error('📧 Error enviando email:', e.message)
    return { enviado: false, modo: 'error', error: e.message }
  }
}

/** Prefijo estándar para todos los asuntos: marca + aplicativo. */
export const ASUNTO_PREFIJO = '[VIU · FOCA | SGRC]'

/**
 * Plantilla HTML profesional. Header con marca completa, cuerpo del mensaje,
 * tabla opcional con detalles estructurados (sede, fecha, tipo, etc.), CTA
 * opcional, y footer institucional.
 *
 * @param {string} titulo            - Título del email (h2)
 * @param {string} cuerpo            - HTML del cuerpo principal
 * @param {string} [accionUrl]       - URL para CTA opcional
 * @param {string} [accionTexto]     - Texto del CTA (default: "Ver detalle")
 * @param {Array<[string,string]>} [detalles] - Tabla de "etiqueta:valor" (sede, fecha, etc.)
 * @param {string} [contexto]        - Línea de contexto sobre el cuerpo (intro)
 */
export function plantillaEmail(titulo, cuerpo, accionUrl, accionTexto, detalles, contexto) {
  const tablaDetalles = Array.isArray(detalles) && detalles.length
    ? `<table style="width:100%;border-collapse:collapse;margin:14px 0;background:#f8fafc;border-radius:8px;overflow:hidden">
         ${detalles.map(([k, v]) => `
           <tr>
             <td style="padding:8px 12px;font-size:13px;color:#64748b;font-weight:500;width:42%;border-bottom:1px solid #e2e8f0;vertical-align:top">${k}</td>
             <td style="padding:8px 12px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0">${v}</td>
           </tr>`).join('')}
       </table>`
    : ''
  const introHTML = contexto
    ? `<div style="font-size:13px;color:#64748b;margin-bottom:12px">${contexto}</div>`
    : ''
  const fechaAhora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' })
  return `
  <div style="font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1A1A17;background:#f1f5f9;padding:20px">
    <div style="background:#1B2A6C;color:#fff;padding:22px 26px;border-radius:12px 12px 0 0">
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
        <tr>
          <td style="vertical-align:middle">
            <div style="display:inline-block;padding:6px 14px;background:rgba(255,255,255,0.16);border-radius:6px;font-size:14px;font-weight:700;letter-spacing:3px;color:#fff">VIU · FOCA</div>
          </td>
          <td style="vertical-align:middle;text-align:right;font-size:10px;letter-spacing:1px;opacity:.78;text-transform:uppercase;color:#fff">
            Clínica Oftalmológica Internacional<br>
            Fundación Oftalmológica del Caribe
          </td>
        </tr>
      </table>
      <div style="font-size:20px;font-weight:700;margin-top:16px;color:#fff">SGRC — Sistema de Gestión de Recursos Clínicos</div>
      <div style="font-size:12px;opacity:.85;margin-top:4px;color:#fff">Notificación automática del aplicativo</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:26px;border-radius:0 0 12px 12px">
      <h2 style="font-size:16px;margin:0 0 8px;color:#0f172a;font-weight:600">${titulo}</h2>
      ${introHTML}
      <div style="font-size:14px;line-height:1.6;color:#334155">${cuerpo}</div>
      ${tablaDetalles}
      ${accionUrl ? `<a href="${accionUrl}" style="display:inline-block;margin-top:14px;background:#1B2A6C;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500">${accionTexto ?? 'Ver detalle en el sistema'}</a>` : ''}
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;line-height:1.6">
        <strong style="color:#475569">VIU · FOCA</strong> — Clínica Oftalmológica Internacional · Fundación Oftalmológica del Caribe<br>
        Este es un correo automático generado por el SGRC el ${fechaAhora} (hora Colombia). No respondas a este mensaje.<br>
        Para soporte: <a href="mailto:desarrollo@cofca.com" style="color:#1B2A6C;text-decoration:none;font-weight:500">desarrollo@cofca.com</a>
      </div>
    </div>
  </div>`
}
