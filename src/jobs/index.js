import cron from 'node-cron'
import { jobAlertaOciosos, jobConsultoriosSinAsignar } from './alertas.js'
import { jobResumenDiario } from './resumenDiario.js'
import { jobAutoCierreSemana } from './autoCierreSemana.js'
import { jobSincronizarFestivos } from './sincronizarFestivos.js'

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

  // Auto-cierre de semanas vencidas — todos los días a las 2:00am
  cron.schedule('0 2 * * *', async () => {
    console.log('[JOB 2am] Cerrando semanas vencidas automáticamente...')
    try {
      const r = await jobAutoCierreSemana()
      console.log('[JOB 2am] Auto-cierre:', JSON.stringify(r))
    } catch (e) {
      console.error('[JOB 2am] Error:', e.message)
    }
  }, { timezone: TZ })

  // Sincronizar festivos de Colombia — 1 de enero a la 1am (siempre que cambia el año)
  cron.schedule('0 1 1 1 *', async () => {
    console.log('[JOB 1ene] Sincronizando festivos de Colombia para el año nuevo...')
    try {
      const r = await jobSincronizarFestivos()
      console.log('[JOB 1ene] Festivos sincronizados:', JSON.stringify(r))
    } catch (e) {
      console.error('[JOB 1ene] Error:', e.message)
    }
  }, { timezone: TZ })

  // Al arrancar el backend, asegurar que el año actual + siguiente estén cargados.
  // Bloqueado por try/catch — si falla no impide que arranquen los demás jobs.
  setImmediate(async () => {
    try {
      const r = await jobSincronizarFestivos()
      if (r.creados > 0) console.log(`📆 Festivos al arranque: ${r.creados} creados, ${r.omitidos} ya existían`)
    } catch (e) {
      console.error('[Festivos al arranque] Error:', e.message)
    }
  })

  console.log('⏰ Jobs programados: ociosos (6am diario), consultorios sin asignar (6am lunes), resumen diario (7am diario), auto-cierre semanas (2am diario), sync festivos (1ene 1am)')
}

// Mapa para ejecución manual vía endpoint (testing / disparo on-demand)
export const JOBS_MANUALES = {
  'alerta-ociosos': jobAlertaOciosos,
  'consultorios-sin-asignar': jobConsultoriosSinAsignar,
  'resumen-diario': jobResumenDiario,
  'auto-cierre-semana': jobAutoCierreSemana,
  'sincronizar-festivos': jobSincronizarFestivos,
}
