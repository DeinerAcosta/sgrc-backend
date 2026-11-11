import { describe, it, expect } from 'vitest'
import { validarFranjas, horasDelDiaMatriz } from './matrizAuxiliares.js'

describe('validarFranjas', () => {
  it('ordena las franjas por hora de inicio', () => {
    const r = validarFranjas([{ ini: '13:00', fin: '17:00' }, { ini: '07:30', fin: '12:00' }])
    expect(r.franjas).toEqual([{ ini: '07:30', fin: '12:00' }, { ini: '13:00', fin: '17:00' }])
  })
  it('acepta un día vacío', () => {
    expect(validarFranjas([]).franjas).toEqual([])
  })
  it('rechaza formato que no es HH:MM', () => {
    expect(validarFranjas([{ ini: '7:30', fin: '12:00' }]).error).toMatch(/HH:MM/)
    expect(validarFranjas([{ ini: '24:00', fin: '25:00' }]).error).toMatch(/HH:MM/)
  })
  it('rechaza fin antes o igual al inicio', () => {
    expect(validarFranjas([{ ini: '12:00', fin: '12:00' }]).error).toMatch(/después/)
  })
  it('rechaza franjas que se cruzan', () => {
    expect(validarFranjas([{ ini: '08:00', fin: '13:00' }, { ini: '12:00', fin: '17:00' }]).error).toMatch(/se cruzan/)
  })
  it('permite franjas pegadas', () => {
    expect(validarFranjas([{ ini: '08:00', fin: '12:00' }, { ini: '12:00', fin: '14:00' }]).franjas).toHaveLength(2)
  })
  it('rechaza más de 4 franjas y lo que no es lista', () => {
    const f = { ini: '08:00', fin: '09:00' }
    expect(validarFranjas([f, f, f, f, f]).error).toMatch(/Máximo/)
    expect(validarFranjas('08:00-12:00').error).toBeTruthy()
  })
})

describe('horasDelDiaMatriz — la misma cuenta del Excel', () => {
  const h = (...pares) => horasDelDiaMatriz(pares.map(([ini, fin]) => ({ ini, fin })))
  it('dos franjas se suman tal cual (el hueco es el almuerzo)', () => {
    expect(h(['07:30', '12:00'], ['13:00', '17:00'])).toBe(8.5)
    expect(h(['08:00', '12:00'], ['14:00', '18:00'])).toBe(8)
  })
  it('una franja corrida de más de 7h descuenta 1h', () => {
    expect(h(['08:00', '16:00'])).toBe(7)
    expect(h(['08:00', '18:00'])).toBe(9)
    expect(h(['07:00', '16:00'])).toBe(8)
  })
  it('una franja de 7h o menos no descuenta', () => {
    expect(h(['07:30', '14:30'])).toBe(7)
    expect(h(['08:00', '14:00'])).toBe(6)
    expect(h(['08:00', '12:00'])).toBe(4)
  })
  it('día vacío = 0', () => {
    expect(h()).toBe(0)
  })
})
