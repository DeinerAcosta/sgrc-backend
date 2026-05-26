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

/** Plantilla HTML mínima con branding SGRC */
export function plantillaEmail(titulo, cuerpo, accionUrl, accionTexto) {
  return `
  <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1A1A17">
    <div style="background:#185FA5;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
      <div style="font-size:18px;font-weight:600">SGRC</div>
      <div style="font-size:12px;opacity:.8">Sistema de Gestión de Recursos Clínicos</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
      <h2 style="font-size:16px;margin:0 0 12px">${titulo}</h2>
      <div style="font-size:14px;line-height:1.6;color:#374151">${cuerpo}</div>
      ${accionUrl ? `<a href="${accionUrl}" style="display:inline-block;margin-top:16px;background:#185FA5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px">${accionTexto ?? 'Ver detalle'}</a>` : ''}
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f0f0f0;font-size:12px;color:#9ca3af">
        Notificación automática del SGRC · Clínica Oftalmológica Internacional
      </div>
    </div>
  </div>`
}
