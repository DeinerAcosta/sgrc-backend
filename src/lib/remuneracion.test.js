import { describe, it, expect } from 'vitest'
import { esRemunerada, sePuedeCambiarRemuneracion } from './remuneracion.js'

describe('esRemunerada', () => {
  it('sin dato guardado, sale del tipo', () => {
    expect(esRemunerada({ type: 'vacaciones', isPaid: null })).toBe(true)
    expect(esRemunerada({ type: 'no_presentacion', isPaid: null })).toBe(false)
    expect(esRemunerada({ type: 'otra' })).toBe(false)
  })

  it('lo que asignó Agendas manda sobre el tipo', () => {
    expect(esRemunerada({ type: 'vacaciones', isPaid: false })).toBe(false)
    expect(esRemunerada({ type: 'otra', isPaid: true })).toBe(true)
  })

  it('la licencia remunerada lo es siempre', () => {
    expect(esRemunerada({ type: 'licencia_remunerada', isPaid: false })).toBe(true)
    expect(sePuedeCambiarRemuneracion({ type: 'licencia_remunerada' })).toBe(false)
    expect(sePuedeCambiarRemuneracion({ type: 'licencia_no_remunerada' })).toBe(true)
  })
})
