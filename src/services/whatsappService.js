/**
 * Servicio de WhatsApp vía WhatsApp Business API.
 *
 * Si WHATSAPP_API_URL + WHATSAPP_API_TOKEN están configurados → envía mensajes reales.
 * Si NO → "log mode": imprime el mensaje en consola.
 *
 * La organización ya tiene cuenta de WhatsApp Business (Levantamiento §12) —
 * solo falta que TI entregue las credenciales (punto abierto #5). Mientras
 * tanto el flujo completo funciona en log mode.
 */

const waConfigurado = !!(process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN)

if (waConfigurado) {
  console.log('📱 WhatsApp: API configurada')
} else {
  console.log('📱 WhatsApp: modo LOG (WHATSAPP_API_URL/TOKEN vacíos — los mensajes se imprimen en consola)')
}

/**
 * Envía un mensaje de WhatsApp. Nunca lanza error que tumbe la operación.
 * @param {string} celular - número destino (formato internacional)
 * @param {string} mensaje - texto del mensaje
 */
export async function enviarWhatsApp(celular, mensaje) {
  if (!celular) return { enviado: false, modo: 'sin_celular' }

  if (!waConfigurado) {
    console.log('\n📱 [WHATSAPP — modo log]')
    console.log(`   Para:    ${celular}`)
    console.log(`   Mensaje: ${mensaje}`)
    console.log('')
    return { enviado: false, modo: 'log' }
  }

  try {
    const res = await fetch(process.env.WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: celular,
        type: 'text',
        text: { body: mensaje },
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('📱 Error WhatsApp API:', res.status, err)
      return { enviado: false, modo: 'error' }
    }
    return { enviado: true, modo: 'api' }
  } catch (e) {
    console.error('📱 Error enviando WhatsApp:', e.message)
    return { enviado: false, modo: 'error', error: e.message }
  }
}
