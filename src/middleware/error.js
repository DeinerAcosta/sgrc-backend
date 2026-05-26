import { ZodError } from 'zod'
import { HttpError } from '../lib/errors.js'

/** Captura cualquier error lanzado en rutas/controladores y devuelve JSON estándar */
export function errorHandler(err, req, res, next) {
  // Validación zod
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: 'Datos inválidos',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  // Error semántico controlado
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, ...err.extras })
  }

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({ message: 'Valor único duplicado', target: err.meta?.target })
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ message: 'Registro no encontrado' })
  }

  // Fallback
  console.error('[ERROR no manejado]', err)
  return res.status(500).json({
    message: process.env.NODE_ENV === 'production' ? 'Error interno' : err.message,
  })
}

/** Wrapper para async handlers — captura rejects sin try/catch */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
