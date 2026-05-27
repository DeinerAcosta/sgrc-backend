import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import routes from './routes/index.js'
import { errorHandler } from './middleware/error.js'
import { snakeBodyToCamel, camelResponseToSnake } from './middleware/caseConverter.js'
import { iniciarJobs } from './jobs/index.js'
import { prisma } from './lib/prisma.js'
import { limpiarCacheExpirado, invalidarCache } from './lib/cache.js'

const app = express()
const PORT = process.env.PORT || 3001

// ============ SEGURIDAD ============
app.use(helmet({
  contentSecurityPolicy: false, // dev — habilitar en producción
}))

// CORS — múltiples orígenes separados por coma
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim())
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('Origen no permitido por CORS'))
  },
  credentials: true,
}))

app.use(express.json({ limit: '2mb' }))
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'))

// ============ RATE LIMITING ============
// IMPORTANTE: limitamos por CUENTA/USUARIO, no por IP. En la clínica los ~100
// usuarios salen por una misma IP pública (NAT corporativo); un límite por IP
// los trataría como uno solo y los bloquearía a todos. Por eso la clave es el
// email (login) o el token (resto), no la IP.

// Login: solo cuenta intentos FALLIDOS por cuenta (un login correcto no consume
// cuota → 100 personas entrando a la vez no se bloquean). Protege cada cuenta de
// fuerza bruta de forma independiente.
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN ?? 10),
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null
    return email ? `login:${email}` : `ip:${req.ip}`
  },
  validate: false,
  message: { message: 'Demasiados intentos fallidos para esta cuenta. Intenta en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
}))

// Global: por usuario autenticado (token) — cada uno tiene su propia cuota,
// independiente de cuántos compartan la IP. Sin token (login/health) cae a IP.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL ?? 600),
  keyGenerator: (req) => {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) return `tok:${auth.slice(-32)}`
    return `ip:${req.ip}`
  },
  validate: false,
  message: { message: 'Demasiadas peticiones. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
}))

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ============ CASE CONVERTERS (frontend snake_case ↔ backend camelCase) ============
// Aplica solo a /api — health check y otros endpoints no se tocan
app.use('/api', snakeBodyToCamel, camelResponseToSnake)

// Invalidar el caché de informes tras cualquier mutación exitosa (POST/PUT/DELETE)
// → los dashboards e informes reflejan los cambios al instante, sin esperar el TTL.
// Las lecturas concurrentes siguen protegidas: el caché se reconstruye en la
// siguiente petición.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) invalidarCache()
    })
  }
  next()
})

// ============ API ROUTES ============
app.use('/api', routes)

// ============ ERROR HANDLER ============
app.use(errorHandler)

// 404
app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada' }))

const server = app.listen(PORT, () => {
  console.log(`🚀 SGRC Backend escuchando en http://localhost:${PORT}/api`)
  console.log(`   Health check: http://localhost:${PORT}/health`)
  iniciarJobs()
})

// Limpieza periódica del caché en memoria para que no crezca indefinidamente.
const limpiezaCache = setInterval(limpiarCacheExpirado, 60_000)
limpiezaCache.unref?.() // no impedir que el proceso termine por este timer

// ============ APAGADO ELEGANTE (graceful shutdown) ============
// En la nube, al desplegar/escalar, el orquestador envía SIGTERM. Cerramos el
// servidor (deja de aceptar conexiones nuevas y espera a las en curso) y luego
// desconectamos Prisma. Evita cortar peticiones a medias y fugas de conexiones.
let apagando = false
async function apagar(signal) {
  if (apagando) return
  apagando = true
  console.log(`\n${signal} recibido — cerrando servidor...`)
  clearInterval(limpiezaCache)
  server.close(async () => {
    try {
      await prisma.$disconnect()
      console.log('Conexiones cerradas. Adiós.')
      process.exit(0)
    } catch (e) {
      console.error('Error al desconectar Prisma:', e)
      process.exit(1)
    }
  })
  // Si algo se cuelga, forzar salida a los 10s
  setTimeout(() => {
    console.error('Cierre forzado tras timeout.')
    process.exit(1)
  }, 10_000).unref?.()
}

process.on('SIGTERM', () => apagar('SIGTERM'))
process.on('SIGINT', () => apagar('SIGINT'))
