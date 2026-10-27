import { describe, it, expect } from 'vitest'
import { coberturaDeAusencia, bucketAntelacion, bucketSla, diasEntreFechas, mesDeFecha, concentracionTop } from './coberturaTablero.js'

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

// 27-oct · PROYECTOS-3799 · la concentración se mide sobre el 10%.
describe('concentracionTop', () => {
  it('toma el 10% de los profesionales con más pacientes (hacia arriba)', () => {
    // 12 profesionales → n = 2 (1,2 hacia arriba): 50 + 30 de 100
    const c = concentracionTop([5, 30, 2, 50, 3, 1, 4, 0, 1, 2, 1, 1])
    expect(c).toEqual({ pct_profesionales: 10, n: 2, total_profesionales: 12, pacientes_top: 80, total_pacientes: 100, pct_impacto: 80 })
  })
  it('con menos de 10 profesionales toma al menos 1', () => {
    expect(concentracionTop([10, 20, 30]).n).toBe(1)
    expect(concentracionTop([10, 20, 30]).pct_impacto).toBe(50)
  })
  it('exactamente 10 / 20 profesionales → 1 / 2', () => {
    expect(concentracionTop(Array(10).fill(1)).n).toBe(1)
    expect(concentracionTop(Array(20).fill(1)).n).toBe(2)
    expect(concentracionTop(Array(21).fill(1)).n).toBe(3)
  })
  it('no ordena por días ni recorta: cuentan los de 0 pacientes', () => {
    const c = concentracionTop([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])
    expect(c).toMatchObject({ n: 2, total_profesionales: 11, pacientes_top: 9, pct_impacto: 100 })
  })
  it('sin profesionales o sin pacientes da 0 sin dividir por cero', () => {
    expect(concentracionTop([])).toMatchObject({ n: 0, total_profesionales: 0, pct_impacto: 0 })
    expect(concentracionTop([0, 0]).pct_impacto).toBe(0)
  })
  it('redondea a un decimal', () => {
    expect(concentracionTop([1, 1, 1]).pct_impacto).toBe(33.3)
  })
})
