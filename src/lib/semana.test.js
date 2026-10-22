import { describe, it, expect } from 'vitest'
import { lunesDeLaSemana, domingoDeLaSemana } from './semana.js'

const dia = (d) => d.toISOString().slice(0, 10)

describe('lunesDeLaSemana', () => {
  it('un lunes es su propia semana (antes, con el proceso en Bogotá, daba el lunes anterior)', () => {
    expect(dia(lunesDeLaSemana('2026-10-19'))).toBe('2026-10-19')
  })

  it('de martes a domingo vuelve al lunes de esa semana', () => {
    expect(dia(lunesDeLaSemana('2026-10-21'))).toBe('2026-10-19')
    expect(dia(lunesDeLaSemana('2026-10-24'))).toBe('2026-10-19')
    expect(dia(lunesDeLaSemana('2026-10-25'))).toBe('2026-10-19')   // el domingo cierra la semana
  })

  it('el domingo anterior pertenece a la semana anterior', () => {
    expect(dia(lunesDeLaSemana('2026-10-18'))).toBe('2026-10-12')
  })

  it('cruza meses y años', () => {
    expect(dia(lunesDeLaSemana('2026-11-01'))).toBe('2026-10-26')
    expect(dia(lunesDeLaSemana('2027-01-01'))).toBe('2026-12-28')
  })

  it('ignora la hora si la trae y rechaza lo que no es fecha', () => {
    expect(dia(lunesDeLaSemana('2026-10-22T23:30:00-05:00'))).toBe('2026-10-19')
    expect(lunesDeLaSemana('no-es-fecha')).toBeNull()
  })
})

describe('domingoDeLaSemana', () => {
  it('son seis días después del lunes', () => {
    expect(dia(domingoDeLaSemana(lunesDeLaSemana('2026-10-19')))).toBe('2026-10-25')
    expect(dia(domingoDeLaSemana(lunesDeLaSemana('2026-12-30')))).toBe('2027-01-03')
  })
})
