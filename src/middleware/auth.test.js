import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = { user: { findUnique: vi.fn() } }
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }))

const verificar = vi.fn()
vi.mock('../lib/jwt.js', () => ({ verifyAccessToken: (t) => verificar(t) }))

const { requireAuth, requireRol, invalidarUsuarioEnCache, limpiarCacheUsuarios } =
  await import('./auth.js')

const TOKEN = 'Bearer token-firmado'

/** Ejecuta el middleware y devuelve { req, error } — error es lo que llegó a next(). */
async function correr(headers = { authorization: TOKEN }) {
  const req = { headers }
  let error
  await requireAuth(req, {}, (e) => { error = e })
  return { req, error }
}

const usuarioActivo = { id: 'u1', role: 'coordinador', active: true, sites: [{ siteId: 's1' }] }

beforeEach(() => {
  prismaMock.user.findUnique.mockReset()
  verificar.mockReset()
  verificar.mockReturnValue({ id: 'u1', role: 'coordinador', sites: ['s1'], resourceId: null })
  invalidarUsuarioEnCache('u1')
})

describe('requireAuth — validación del token', () => {
  it('rechaza si no hay cabecera Authorization', async () => {
    const { error } = await correr({})
    expect(error.status).toBe(401)
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })

  it('rechaza si la cabecera no empieza por Bearer', async () => {
    const { error } = await correr({ authorization: 'Basic abc' })
    expect(error.status).toBe(401)
  })

  it('rechaza si la firma no es válida, sin llegar a consultar la base', async () => {
    verificar.mockImplementation(() => { throw new Error('firma mala') })
    const { error } = await correr()
    expect(error.status).toBe(401)
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })
})

describe('requireAuth — revalidación contra la base', () => {
  it('deja pasar a un usuario activo', async () => {
    prismaMock.user.findUnique.mockResolvedValue(usuarioActivo)
    const { req, error } = await correr()
    expect(error).toBeUndefined()
    expect(req.user.id).toBe('u1')
    expect(req.user.sites).toEqual(['s1'])   // resueltas desde la BD, no del token
  })

  it('BLOQUEA a un usuario desactivado aunque su token siga siendo válido', async () => {
    // Este era el agujero: con la firma bien, desactivar a alguien no tenía
    // efecto hasta que caducara su JWT, hasta 8 horas después.
    prismaMock.user.findUnique.mockResolvedValue({ ...usuarioActivo, active: false })
    const { error } = await correr()
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/desactivada/)
  })

  it('bloquea si la cuenta ya no existe', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    const { error } = await correr()
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/no existe/)
  })

  it('el rol que vale es el de la BASE, no el del token', async () => {
    // Token emitido cuando era coordinador; entre medias lo ascendieron.
    prismaMock.user.findUnique.mockResolvedValue({ ...usuarioActivo, role: 'supervisor' })
    const { req } = await correr()
    expect(req.user.role).toBe('supervisor')
  })

  it('NO deja pasar si la base falla — no se abre en caso de error', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('conexión caída'))
    const { req, error } = await correr()
    expect(error).toBeDefined()
    expect(req.user).toBeUndefined()
  })
})

describe('requireAuth — caché de 60 segundos', () => {
  it('consulta la base una sola vez para varias peticiones seguidas', async () => {
    prismaMock.user.findUnique.mockResolvedValue(usuarioActivo)
    await correr()
    await correr()
    await correr()
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1)
  })

  it('invalidarUsuarioEnCache fuerza a releer en la siguiente petición', async () => {
    prismaMock.user.findUnique.mockResolvedValue(usuarioActivo)
    await correr()
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1)

    // El supervisor lo desactiva → el controlador invalida la entrada
    invalidarUsuarioEnCache('u1')
    prismaMock.user.findUnique.mockResolvedValue({ ...usuarioActivo, active: false })

    const { error } = await correr()
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2)
    expect(error.status).toBe(401)   // el cambio surte efecto de inmediato
  })

  it('no cachea entre usuarios distintos', async () => {
    prismaMock.user.findUnique.mockResolvedValue(usuarioActivo)
    await correr()

    verificar.mockReturnValue({ id: 'u2', role: 'recurso', sites: [] })
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u2', role: 'recurso', active: true, sites: [] })
    const { req } = await correr()

    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2)
    expect(req.user.id).toBe('u2')
  })

  it('limpiarCacheUsuarios no revienta con el caché vacío', () => {
    expect(() => limpiarCacheUsuarios()).not.toThrow()
  })
})

describe('requireRol', () => {
  const correrRol = (user, roles) => {
    let error
    requireRol(...roles)({ user }, {}, (e) => { error = e })
    return error
  }

  it('deja pasar al rol permitido', () => {
    expect(correrRol({ role: 'supervisor' }, ['supervisor'])).toBeUndefined()
  })

  it('bloquea al rol no permitido', () => {
    expect(correrRol({ role: 'recurso' }, ['supervisor']).status).toBe(403)
  })

  it('gerencia pasa cualquier comprobación', () => {
    expect(correrRol({ role: 'gerencia' }, ['supervisor'])).toBeUndefined()
    expect(correrRol({ role: 'gerencia' }, ['coordinador'])).toBeUndefined()
  })

  it('sin usuario en la request devuelve 401', () => {
    expect(correrRol(undefined, ['supervisor']).status).toBe(401)
  })
})

describe('requireAuth — las sedes también se revalidan', () => {
  it('manda la lista de la BASE, no la que trae el token', async () => {
    // El token se emitió cuando el coordinador tenía s1 y s2; después le
    // quitaron s2. Sin releerlas, seguiría entrando a s2 hasta 8h después.
    verificar.mockReturnValue({ id: 'u1', role: 'coordinador', sites: ['s1', 's2'] })
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1', role: 'coordinador', active: true, sites: [{ siteId: 's1' }],
    })

    const { req } = await correr()
    expect(req.user.sites).toEqual(['s1'])
    expect(req.user.sites).not.toContain('s2')
  })

  it('un coordinador sin sedes queda con la lista vacía, no con la del token', async () => {
    verificar.mockReturnValue({ id: 'u1', role: 'coordinador', sites: ['s1'] })
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1', role: 'coordinador', active: true, sites: [],
    })

    const { req } = await correr()
    expect(req.user.sites).toEqual([])
  })
})
