import { describe, it, expect } from 'vitest'
import { coberturaDeAusencia, bucketAntelacion, bucketSla, diasEntreFechas, mesDeFecha } from './coberturaTablero.js'

describe('coberturaDeAusencia', () => {
  it('los turnos que cubren cuentan (antes daba 0% con casos cubiertos)', () => {
    expect(coberturaDeAusencia({ total: 22, cubiertos: 22 })).toEqual({ pacientesCubiertos: 22, pacientesSinCobertura: 0, repuesta: true })
  })
  it('cubierta en parte: repartidos los pacientes, no repuesta', () => {
    expect(coberturaDeAusencia({ total: 29, cubiertos: 20 })).toEqual({ pacientesCubiertos: 20, pacientesSinCobertura: 9, repuesta: false })
  })
  it('no cuenta más cubiertos que pacientes', () => {
    expect(coberturaDeAusencia({ total: 10, cubiertos: 24 }).pacientesCubiertos).toBe(10)
  })
  it('una reposición aprobada sin turnos cubre el caso entero (flujo del médico)', () => {
    expect(coberturaDeAusencia({ total: 15, cubiertos: 0, reposicion: true }).repuesta).toBe(true)
  })
  it('sin pacientes ni reposición no es repuesta', () => {
    expect(coberturaDeAusencia({ total: 0 }).repuesta).toBe(false)
  })
})

describe('bucketAntelacion · regla de 20 días', () => {
  it.each([[-2, 'retroactivo'], [0, 'retroactivo'], [1, 'uno_a_siete'], [7, 'uno_a_siete'], [8, 'ocho_a_diecinueve'], [19, 'ocho_a_diecinueve'], [20, 'veinte_o_mas'], [45, 'veinte_o_mas']])(
    '%i días → %s', (d, b) => expect(bucketAntelacion(d)).toBe(b))
})

describe('bucketSla', () => {
  it.each([[-1, 'adelantada'], [0, 'mismo_dia'], [3, 'uno_a_siete'], [15, 'ocho_a_treinta'], [31, 'mas_30']])('%i → %s', (d, b) => expect(bucketSla(d)).toBe(b))
})

describe('fechas @db.Date sin correr el día', () => {
  it('días entre fechas', () => {
    expect(diasEntreFechas(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-05T00:00:00Z'))).toBe(4)
    expect(diasEntreFechas('2026-10-05', '2026-10-01')).toBe(-4)
  })
  it('el día 1 es de su mes', () => {
    expect(mesDeFecha(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10')
  })
})
