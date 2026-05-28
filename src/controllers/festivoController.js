import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { festivosColombia } from '../lib/festivosColombia.js'

const festivoSchema = z.object({
  fecha: z.string(), // YYYY-MM-DD
  descripcion: z.string().min(1).max(200),
})

export async function list(req, res) {
  const { desde, hasta } = req.query
  const where = {}
  if (desde) where.fecha = { gte: new Date(desde) }
  if (hasta) where.fecha = { ...(where.fecha ?? {}), lte: new Date(hasta) }
  const festivos = await prisma.festivo.findMany({ where, orderBy: { fecha: 'asc' } })
  res.json(festivos)
}

export async function create(req, res) {
  const data = festivoSchema.parse(req.body)
  const f = await prisma.festivo.create({
    data: { fecha: new Date(data.fecha), descripcion: data.descripcion },
  })
  res.status(201).json(f)
}

export async function remove(req, res) {
  await prisma.festivo.delete({ where: { fecha: new Date(req.params.fecha) } })
  res.json({ ok: true })
}

/**
 * POST /festivos/sincronizar-colombia
 * Body opcional: { year?: number, years?: number[] }. Sin body → año actual + próximo.
 *
 * Carga los festivos oficiales de Colombia (18 al año) en la BD. Si una fecha
 * ya existe respeta la descripción (no sobrescribe — el supervisor pudo
 * personalizarla). Devuelve { creados, omitidos, año(s) procesado(s) }.
 */
const syncSchema = z.object({
  year: z.number().int().min(2020).max(2100).optional(),
  years: z.array(z.number().int().min(2020).max(2100)).optional(),
})
export async function sincronizarColombia(req, res) {
  const body = syncSchema.parse(req.body ?? {})
  const ahora = new Date()
  const yearsAProcesar = body.years
    ? body.years
    : body.year
    ? [body.year]
    : [ahora.getUTCFullYear(), ahora.getUTCFullYear() + 1]

  let creados = 0
  let omitidos = 0
  const detallePorAnio = {}

  for (const year of yearsAProcesar) {
    const items = festivosColombia(year)
    let cAnio = 0; let oAnio = 0
    for (const item of items) {
      // Upsert idempotente: si ya existe la fecha no la tocamos (descripción puede
      // estar personalizada por el supervisor). Si no, la creamos.
      const existente = await prisma.festivo.findUnique({ where: { fecha: item.fecha } })
      if (existente) { oAnio++; continue }
      await prisma.festivo.create({ data: { fecha: item.fecha, descripcion: item.descripcion } })
      cAnio++
    }
    creados += cAnio
    omitidos += oAnio
    detallePorAnio[year] = { creados: cAnio, omitidos: oAnio }
  }

  res.status(201).json({ ok: true, creados, omitidos, años: yearsAProcesar, detalle: detallePorAnio })
}

/** GET /festivos/calendario-colombia?year=YYYY — devuelve los festivos calculados (no persiste) */
export async function previewColombia(req, res) {
  const year = parseInt(req.query.year) || new Date().getUTCFullYear()
  if (year < 2020 || year > 2100) throw errors.badRequest('Año fuera de rango (2020-2100)')
  const items = festivosColombia(year).map((it) => ({
    fecha: it.fecha.toISOString().slice(0, 10),
    descripcion: it.descripcion,
  }))
  res.json({ year, items })
}

