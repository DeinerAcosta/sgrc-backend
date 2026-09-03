import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { festivosColombia } from '../lib/colombiaHolidays.js'

const festivoSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  description: z.string().min(1).max(200),
})

/**
 * Convierte 'YYYY-MM-DD' en Date, o lanza 400.
 *
 * Sin esto, `new Date('basura')` produce un Invalid Date que Prisma rechaza ya
 * en el driver: la petición moría con un 500 y un volcado interno en vez de
 * decirle al cliente que la fecha venía mal. Lo destapó la matriz de roles.
 */
function fechaOFallo(valor, campo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw errors.badRequest(`${campo} debe tener formato YYYY-MM-DD (recibido: "${valor}")`)
  }
  const d = new Date(valor + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) throw errors.badRequest(`${campo} no es una fecha real: "${valor}"`)
  return d
}

export async function list(req, res) {
  const { desde, hasta } = req.query
  const where = {}
  if (desde) where.date = { gte: fechaOFallo(desde, 'desde') }
  if (hasta) where.date = { ...(where.date ?? {}), lte: fechaOFallo(hasta, 'hasta') }
  const festivos = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } })
  res.json(festivos)
}

export async function create(req, res) {
  const data = festivoSchema.parse(req.body)
  const f = await prisma.holiday.create({
    data: { date: new Date(data.date), description: data.description },
  })
  res.status(201).json(f)
}

export async function remove(req, res) {
  const fecha = fechaOFallo(req.params.date, 'fecha')
  const existente = await prisma.holiday.findUnique({ where: { date: fecha } })
  if (!existente) throw errors.notFound('No hay ningún festivo en esa fecha')
  await prisma.holiday.delete({ where: { date: fecha } })
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
      const existente = await prisma.holiday.findUnique({ where: { date: item.date } })
      if (existente) { oAnio++; continue }
      await prisma.holiday.create({ data: { date: item.date, description: item.description } })
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
    date: it.date.toISOString().slice(0, 10),
    description: it.description,
  }))
  res.json({ year, items })
}

