import { verifyAccessToken } from '../lib/jwt.js'
import { errors } from '../lib/errors.js'

/** Verifica que el request traiga un JWT válido en Authorization: Bearer */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return next(errors.unauthorized('Token no provisto'))
  }
  const token = header.slice(7)
  try {
    const payload = verifyAccessToken(token)
    req.user = payload // { id, rol, sedes? }
    return next()
  } catch (e) {
    return next(errors.unauthorized('Token inválido o expirado'))
  }
}

/** Verifica que el usuario tenga uno de los roles permitidos */
export function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(errors.unauthorized())
    if (!roles.includes(req.user.rol)) {
      return next(errors.forbidden(`Solo permitido para: ${roles.join(', ')}`))
    }
    return next()
  }
}

/** Verifica que el usuario tenga acceso a la sede solicitada */
export function requireSedeAccess(getSedeId) {
  return (req, res, next) => {
    const sedeId = typeof getSedeId === 'function' ? getSedeId(req) : req.params[getSedeId]
    if (!sedeId) return next()
    // directivo y supervisor ven todas las sedes
    if (['directivo', 'supervisor'].includes(req.user.rol)) return next()
    // coordinador solo sus sedes
    if (req.user.rol === 'coordinador' && req.user.sedes?.includes(sedeId)) return next()
    return next(errors.forbidden('No tienes acceso a esta sede'))
  }
}
