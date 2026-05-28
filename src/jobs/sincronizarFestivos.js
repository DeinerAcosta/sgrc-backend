import { prisma } from '../lib/prisma.js'
import { festivosColombia } from '../lib/festivosColombia.js'

/**
 * Asegura que existan festivos cargados para el año actual y el siguiente.
 * Idempotente: si una fecha ya existe se respeta su descripción (el supervisor
 * puede haberla personalizado). Solo crea las que faltan.
 *
 * Cron: 1 de enero a la 1:00am America/Bogota — al cambiar de año, asegura
 * que el siguiente esté disponible.
 *
 * También se ejecuta al arranque del backend (vía iniciarJobs) para asegurar
 * que las primeras semanas trabajen contra un calendario completo.
 */
export async function jobSincronizarFestivos() {
  const ahora = new Date()
  const yearActual = ahora.getUTCFullYear()
  const yearSiguiente = yearActual + 1

  let creados = 0
  let omitidos = 0
  for (const year of [yearActual, yearSiguiente]) {
    const items = festivosColombia(year)
    for (const it of items) {
      const existente = await prisma.festivo.findUnique({ where: { fecha: it.fecha } })
      if (existente) { omitidos++; continue }
      await prisma.festivo.create({ data: { fecha: it.fecha, descripcion: it.descripcion } })
      creados++
    }
  }
  return { creados, omitidos, años: [yearActual, yearSiguiente] }
}
