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
// Login: 5 intentos por IP en 15 minutos (Especificación §6.1)
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN ?? 5),
  message: { message: 'Demasiados intentos de login. Intenta en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
}))

// Global: 100 req/min por IP
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL ?? 100),
  message: { message: 'Demasiadas peticiones. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
}))

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ============ CASE CONVERTERS (frontend snake_case ↔ backend camelCase) ============
// Aplica solo a /api — health check y otros endpoints no se tocan
app.use('/api', snakeBodyToCamel, camelResponseToSnake)

// ============ API ROUTES ============
app.use('/api', routes)

// ============ ERROR HANDLER ============
app.use(errorHandler)

// 404
app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada' }))

app.listen(PORT, () => {
  console.log(`🚀 SGRC Backend escuchando en http://localhost:${PORT}/api`)
  console.log(`   Health check: http://localhost:${PORT}/health`)
  iniciarJobs()
})
