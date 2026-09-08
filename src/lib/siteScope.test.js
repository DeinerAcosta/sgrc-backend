import { describe, it, expect } from 'vitest'
import { sedesDeUsuario, puedeEnSede, assertSedePermitida } from './siteScope.js'

const coord = { role: 'coordinador', sites: ['sedeA', 'sedeB'] }
const sup = { role: 'supervisor', sites: [] }
const ger = { role: 'gerencia', sites: [] }
const dir = { role: 'directivo', sites: [] }

describe('sedesDeUsuario', () => {
  it('devuelve null (sin restricción) para los roles globales', () => {
    expect(sedesDeUsuario(sup)).toBeNull()
    expect(sedesDeUsuario(ger)).toBeNull()
    expect(sedesDeUsuario(dir)).toBeNull()
  })

  it('devuelve el conjunto propio del coordinador', () => {
    expect([...sedesDeUsuario(coord)]).toEqual(['sedeA', 'sedeB'])
  })

  it('sin usuario devuelve conjunto vacío — no acceso global', () => {
    // Importante que sea vacío y no null: un fallo que deje user sin definir no
    // debe convertirse en permiso total.
    expect(sedesDeUsuario(null).size).toBe(0)
    expect(sedesDeUsuario(undefined).size).toBe(0)
  })

  it('un coordinador sin sedes no puede en ninguna', () => {
    expect(sedesDeUsuario({ role: 'coordinador' }).size).toBe(0)
    expect(sedesDeUsuario({ role: 'coordinador', sites: [] }).size).toBe(0)
  })
})

describe('puedeEnSede', () => {
  it('el coordinador puede en las suyas', () => {
    expect(puedeEnSede(coord, 'sedeA')).toBe(true)
    expect(puedeEnSede(coord, 'sedeB')).toBe(true)
  })

  it('el coordinador NO puede en las ajenas', () => {
    expect(puedeEnSede(coord, 'sedeC')).toBe(false)
  })

  it('los roles globales pueden en cualquiera', () => {
    for (const u of [sup, ger, dir]) {
      expect(puedeEnSede(u, 'sedeC'), `rol ${u.role}`).toBe(true)
    }
  })

  it('una sede indefinida nunca pasa para el coordinador', () => {
    expect(puedeEnSede(coord, null)).toBe(false)
    expect(puedeEnSede(coord, undefined)).toBe(false)
    expect(puedeEnSede(coord, '')).toBe(false)
  })
})

describe('assertSedePermitida', () => {
  it('no lanza si tiene acceso', () => {
    expect(() => assertSedePermitida(coord, 'sedeA')).not.toThrow()
    expect(() => assertSedePermitida(sup, 'sedeC')).not.toThrow()
  })

  it('lanza 403 si no lo tiene', () => {
    try {
      assertSedePermitida(coord, 'sedeC')
      throw new Error('debería haber lanzado')
    } catch (e) {
      expect(e.status).toBe(403)
    }
  })

  it('el mensaje nombra la sede y dice qué revisar', () => {
    // Un "no tienes permiso" seco deja al coordinador sin saber si el problema
    // es suyo o de su configuración de sedes.
    try {
      assertSedePermitida(coord, 'sedeC', 'Riohacha')
    } catch (e) {
      expect(e.message).toContain('Riohacha')
      expect(e.message).toContain('sedes asignadas')
    }
  })
})
