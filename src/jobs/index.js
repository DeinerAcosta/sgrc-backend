import cron from 'node-cron'
import { jobAlertaOciosos, jobConsultoriosSinAsignar } from './alertas.js'
import { jobResumenDiario } from './resumenDiario.js'

/**
 * Programación de jobs automáticos del SGRC.
 * Zona horaria: America/Bogota (RN-07 — todas las sedes operan en UTC-5).
 */

const TZ = 'America/Bogota'

export function iniciarJobs() {
  // RN-25: alerta de recursos ociosos — todos los días a las 6:00am
  cron.schedule('0 6 * * *', async () => {
    console.log('[JOB 6am] Ejecutando alerta de recursos ociosos...')
    try {
      const r = await jobAlertaOciosos()
      console.log('[JOB 6am] Ociosos:', JSON.stringify(r))
    } catch (e) {
      console.error('[JOB 6am] Error:', e.message)
    }
  }, { timezone: TZ })

  // Consultorios sin asignar — lunes a las 6:00am
  cron.schedule('0 6 * * 1', async () => {
    console.log('[JOB lunes] Ejecutando alerta de consultorios sin asignar...')
    try {
      const r = await jobConsultoriosSinAsignar()
      console.log('[JOB lunes] Consultorios:', JSON.stringify(r))
    } catch (e) {
      console.error('[JOB lunes] Error:', e.message)
    }
  }, { timezone: TZ })

  // Resumen diario del horario — todos los días a las 7:00am
  cron.schedule('0 7 * * *', async () => {
    console.log('[JOB 7am] Enviando resumen diario del horario...')
    try {
      const r = await jobResumenDiario()
      console.log('[JOB 7am] Resumen diario:', JSON.stringify(r))
    } catch (e) {
      console.error('[JOB 7am] Error:', e.message)
    }
  }, { timezone: TZ })

  console.log('⏰ Jobs programados: ociosos (6am diario), consultorios sin asignar (6am lunes), resumen diario (7am diario)')
}

// Mapa para ejecución manual vía endpoint (testing / disparo on-demand)
export const JOBS_MANUALES = {
  'alerta-ociosos': jobAlertaOciosos,
  'consultorios-sin-asignar': jobConsultoriosSinAsignar,
  'resumen-diario': jobResumenDiario,
}
