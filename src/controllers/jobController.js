import { errors } from '../lib/errors.js'
import { JOBS_MANUALES } from '../jobs/index.js'

/**
 * POST /jobs/run/:nombre — ejecuta un job manualmente (solo supervisor).
 * Útil para disparar las alertas sin esperar al cron, y para pruebas.
 */
export async function ejecutar(req, res) {
  const { nombre } = req.params
  const job = JOBS_MANUALES[nombre]
  if (!job) {
    throw errors.notFound(`Job desconocido. Disponibles: ${Object.keys(JOBS_MANUALES).join(', ')}`)
  }
  const resultado = await job()
  res.json({ job: nombre, ejecutado_en: new Date().toISOString(), resultado })
}
