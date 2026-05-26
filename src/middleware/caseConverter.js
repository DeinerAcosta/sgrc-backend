/**
 * Convierte automáticamente:
 *  - Las respuestas del backend de camelCase → snake_case
 *  - Los bodies de los requests de snake_case → camelCase
 *
 * Esto permite que el frontend (que sigue la convención snake_case del SGRC
 * según Levantamiento §11 — `fecha_inicio`, `recurso_id`, etc.) hable con
 * un backend que internamente usa Prisma en camelCase.
 *
 * Respeta tipos especiales (Date, Decimal de Prisma, Buffer) — solo convierte
 * plain objects.
 */

const camelToSnake = (str) => str.replace(/([A-Z])/g, (l) => `_${l.toLowerCase()}`)
const snakeToCamel = (str) => str.replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase())

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

const convertKeys = (value, fn) => {
  if (Array.isArray(value)) return value.map((item) => convertKeys(item, fn))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[fn(k)] = convertKeys(v, fn)
    }
    return out
  }
  return value
}

/** Middleware: snake_case en cuerpos de request → camelCase para los controllers/Zod */
export function snakeBodyToCamel(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = convertKeys(req.body, snakeToCamel)
  }
  next()
}

/** Middleware: camelCase en respuestas → snake_case para el frontend */
export function camelResponseToSnake(req, res, next) {
  const originalJson = res.json.bind(res)
  res.json = (data) => originalJson(convertKeys(data, camelToSnake))
  next()
}
