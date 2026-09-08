import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import helmet from 'helmet'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import { validarEntorno } from './lib/env.js'
import { avisoProgramacionLibre } from './lib/schedulingMode.js'
import routes from './routes/index.js'
import { errorHandler } from './middleware/error.js'
import { snakeBodyToCamel, camelResponseToSnake } from './middleware/caseConverter.js'
import { iniciarJobs } from './jobs/index.js'
import { prisma } from './lib/prisma.js'
import { limpiarCacheExpirado, invalidarCache } from './lib/cache.js'
import { limpiarCacheUsuarios } from './middleware/auth.js'

// Se valida ANTES de construir la app: si falta algo, el proceso muere aquí con
// un mensaje claro en vez de arrancar y fallar luego en el primer login.
let PORT
try {
  const { env, avisos } = validarEntorno()
  PORT = env.PORT
  for (const aviso of avisos) console.warn(`⚠️  ${aviso}`)
} catch (e) {
  console.error(`\n❌ ${e.message}\n`)
  process.exit(1)
}

const app = express()

// ============ SEGURIDAD ============
// CSP: en desarrollo estorba (Vite inyecta scripts y estilos en caliente), en
// producción es la principal mitigación de un XSS — y el token de sesión vive en
// localStorage, así que aquí importa de verdad.
//
// Antes estaba desactivada de forma incondicional, con un comentario que decía
// "habilitar en producción" que nunca se llegó a cumplir.
//
// La API solo devuelve JSON: no sirve HTML, ni scripts, ni estilos. Por eso la
// política puede ser tan cerrada. Si algún día se sirve el frontend desde este
// mismo proceso, habrá que abrirla.
const enProduccion = process.env.NODE_ENV === 'production'
app.use(helmet({
  contentSecurityPolicy: enProduccion
    ? {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      }
    : false,
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

// Compresión gzip de las respuestas. Los informes y el programador devuelven
// arrays JSON grandes; sobre la red de una sede eso pesa más que el tiempo de
// consulta. Va antes de las rutas para que cubra todo /api.
app.use(compression())

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
//
// EXCEPCIONES (fix sep-2026): hay mutaciones de alta frecuencia que no pueden
// alterar NINGÚN informe ni KPI. Si se dejan pasar, el caché no llega nunca a
// cumplir su TTL y deja de servir para lo único que existe.
//
// El caso grave era el heartbeat de presencia: el frontend lo llama cada 30s por
// usuario conectado (hooks/useHeartbeat.js). Con ~100 usuarios son 3,3 PUT por
// segundo → 3,3 borrados de caché por segundo contra un TTL de 30s. En la
// práctica el caché de informes estaba SIEMPRE frío y cada dashboard se
// recalculaba entero desde la BD.
//
// Criterio para añadir una ruta aquí: la mutación solo puede tocar columnas que
// ningún informe lee (presencia, marcas de leído). Ante la duda, NO añadirla —
// invalidar de más es lento, invalidar de menos es servir datos viejos.
const MUTACIONES_SIN_IMPACTO_EN_INFORMES = [
  /^\/usuarios\/me\/heartbeat$/,   // solo escribe usuario.ultima_actividad
  /^\/notificaciones\//,           // solo marca notificaciones como leídas
]

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (MUTACIONES_SIN_IMPACTO_EN_INFORMES.some((re) => re.test(req.path))) return next()
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
  // Se avisa en cada arranque a propósito: es un modo temporal y no debería
  // quedarse activo por olvido.
  const aviso = avisoProgramacionLibre()
  if (aviso) console.warn(aviso)
  iniciarJobs()
})

// Limpieza periódica del caché en memoria para que no crezca indefinidamente.
const limpiezaCache = setInterval(() => {
  limpiarCacheExpirado()
  limpiarCacheUsuarios()   // estado de usuario que usa requireAuth (TTL 60s)
}, 60_000)
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
