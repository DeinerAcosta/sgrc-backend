import { verifyAccessToken } from '../lib/jwt.js'
import { errors } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'

// ============================================================================
// REVALIDACIÓN DEL USUARIO CONTRA LA BASE (con caché corta)
// ============================================================================
// El JWT dura 8h y lleva dentro el rol y las sedes. Si solo se verifica la
// firma, desactivar a alguien, cambiarle el rol o quitarle una sede NO surte
// efecto hasta que su token caduque: hasta ocho horas de acceso indebido.
//
// Consultar la BD en cada petición sería absurdo (el heartbeat solo ya son 3
// peticiones por segundo), así que se cachea el estado de cada usuario 60
// segundos en memoria. La ventana baja de 8 horas a 1 minuto y el coste es
// aproximadamente una consulta por usuario y minuto.
//
// Es caché POR INSTANCIA, igual que el de informes: con varias réplicas cada
// una tiene la suya, y el peor caso sigue siendo 60 segundos.
const TTL_USUARIO = 60_000
const cacheUsuarios = new Map()

async function estadoDelUsuario(id) {
  const ahora = Date.now()
  const hit = cacheUsuarios.get(id)
  if (hit && hit.expira > ahora) return hit.value

  const fila = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      active: true,
      // Las sedes también se traen: el token las lleva dentro, y sin releerlas
      // quitarle una sede a un coordinador no surtía efecto hasta que caducara
      // su JWT (hasta 8h de acceso a una sede que ya no es suya).
      sites: { select: { siteId: true } },
    },
  })
  const usuario = fila && {
    id: fila.id,
    role: fila.role,
    active: fila.active,
    sites: fila.sites.map((s) => s.siteId),
  }
  cacheUsuarios.set(id, { value: usuario, expira: ahora + TTL_USUARIO })
  return usuario
}

/** Olvida el estado cacheado de un usuario para que el cambio surta efecto ya.
 *  Llamar desde donde se desactive o se cambie el rol de alguien. */
export function invalidarUsuarioEnCache(id) {
  cacheUsuarios.delete(id)
}

/** Limpia las entradas caducadas para que el Map no crezca sin límite. */
export function limpiarCacheUsuarios() {
  const ahora = Date.now()
  for (const [k, v] of cacheUsuarios.entries()) if (v.expira <= ahora) cacheUsuarios.delete(k)
}

/** Verifica que el request traiga un JWT válido en Authorization: Bearer */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return next(errors.unauthorized('Token no provisto'))
  }
  const token = header.slice(7)

  let payload
  try {
    payload = verifyAccessToken(token)
  } catch {
    return next(errors.unauthorized('Token inválido o expirado'))
  }

  try {
    const usuario = await estadoDelUsuario(payload.id)
    if (!usuario) return next(errors.unauthorized('La cuenta ya no existe'))
    if (!usuario.active) return next(errors.unauthorized('La cuenta está desactivada'))

    // Mandan el rol y las sedes de la BD, no los del token: si se le cambió el
    // rol o se le quitó una sede, el cambio aplica en cuanto caduca la caché
    // (60s), sin esperar a que expire el JWT.
    req.user = { ...payload, role: usuario.role, sites: usuario.sites }
    return next()
  } catch (e) {
    // Si la base no responde, NO dejamos pasar a ciegas.
    return next(e)
  }
}

/** Verifica que el usuario tenga uno de los roles permitidos.
 * GERENCIA es super-usuario: siempre pasa cualquier check. */
export function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(errors.unauthorized())
    // Gerencia tiene acceso TOTAL al sistema — pasa cualquier verificación
    if (req.user.role === 'gerencia') return next()
    if (!roles.includes(req.user.role)) {
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
    // gerencia, directivo y supervisor ven todas las sedes
    if (['gerencia', 'directivo', 'supervisor'].includes(req.user.role)) return next()
    // coordinador solo sus sedes
    if (req.user.role === 'coordinador' && req.user.sites?.includes(sedeId)) return next()
    return next(errors.forbidden('No tienes acceso a esta sede'))
  }
}
