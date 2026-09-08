import { describe, it, expect } from 'vitest'
import { validarEntorno } from './env.js'

const SECRETO_A = 'a'.repeat(48)
const SECRETO_B = 'b'.repeat(48)

const valido = {
  DATABASE_URL: 'mysql://user:pass@localhost:3306/sgrc',
  JWT_SECRET: SECRETO_A,
  REFRESH_SECRET: SECRETO_B,
}

describe('validarEntorno — el proceso no debe arrancar a medias', () => {
  it('acepta un entorno mínimo correcto', () => {
    const { env, avisos } = validarEntorno(valido)
    expect(avisos).toEqual([])
    expect(env.DATABASE_URL).toBe(valido.DATABASE_URL)
  })

  it('rellena los opcionales con sus valores por defecto', () => {
    const { env } = validarEntorno(valido)
    expect(env.PORT).toBe(3001)
    expect(env.NODE_ENV).toBe('development')
    expect(env.JWT_EXPIRES_IN).toBe('8h')
    expect(env.REFRESH_EXPIRES_IN).toBe('7d')
    expect(env.RATE_LIMIT_LOGIN).toBe(10)
    expect(env.RATE_LIMIT_GLOBAL).toBe(600)
  })

  it('convierte a número los valores numéricos que llegan como texto', () => {
    const { env } = validarEntorno({ ...valido, PORT: '8080', RATE_LIMIT_GLOBAL: '200' })
    expect(env.PORT).toBe(8080)
    expect(env.RATE_LIMIT_GLOBAL).toBe(200)
  })

  it('falla si falta DATABASE_URL, y lo dice por su nombre', () => {
    const { DATABASE_URL: _, ...sinBd } = valido
    expect(() => validarEntorno(sinBd)).toThrow(/DATABASE_URL/)
  })

  it('falla si falta JWT_SECRET — este era el caso que arrancaba y moría en el primer login', () => {
    const { JWT_SECRET: _, ...sinJwt } = valido
    expect(() => validarEntorno(sinJwt)).toThrow(/JWT_SECRET/)
  })

  it('falla si un secreto es demasiado corto', () => {
    expect(() => validarEntorno({ ...valido, JWT_SECRET: 'corto' })).toThrow(/32 caracteres/)
  })

  it('enumera TODO lo que falta de una vez, no solo lo primero', () => {
    try {
      validarEntorno({})
      throw new Error('debería haber fallado')
    } catch (e) {
      expect(e.message).toMatch(/DATABASE_URL/)
      expect(e.message).toMatch(/JWT_SECRET/)
      expect(e.message).toMatch(/REFRESH_SECRET/)
      expect(e.message).toMatch(/\.env\.example/)   // dice cómo arreglarlo
    }
  })

  it('rechaza un NODE_ENV que no reconoce', () => {
    expect(() => validarEntorno({ ...valido, NODE_ENV: 'produccion' })).toThrow()
  })

  it('avisa (sin impedir el arranque) si los dos secretos son el mismo', () => {
    // Si coinciden, un refresh token sirve como access token y la caducidad
    // de 8h deja de significar nada.
    const { avisos } = validarEntorno({ ...valido, REFRESH_SECRET: SECRETO_A })
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toMatch(/distintos/)
  })
})

describe('validarEntorno — protecciones específicas de producción', () => {
  const prod = { ...valido, NODE_ENV: 'production' }

  it('no arranca en producción con el secreto de ejemplo del repositorio', () => {
    expect(() => validarEntorno({
      ...prod,
      JWT_SECRET: 'cambiar-este-secret-en-produccion-min-32-caracteres-aleatorios',
    })).toThrow(/producción.*JWT_SECRET/s)
  })

  it('tampoco con el REFRESH_SECRET de ejemplo', () => {
    expect(() => validarEntorno({
      ...prod,
      REFRESH_SECRET: 'otro-secret-distinto-para-refresh-tokens-relleno-hasta-32',
    })).toThrow(/producción.*REFRESH_SECRET/s)
  })

  it('arranca en producción con secretos propios', () => {
    expect(() => validarEntorno(prod)).not.toThrow()
  })

  it('en desarrollo tolera los valores de ejemplo', () => {
    expect(() => validarEntorno({
      ...valido,
      JWT_SECRET: 'cambiar-este-secret-en-produccion-min-32-caracteres-aleatorios',
    })).not.toThrow()
  })
})
