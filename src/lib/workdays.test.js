import { describe, it, expect } from 'vitest'
import { expandirRangoHabil, contarDiasHabiles } from './workdays.js'

// Semana de referencia (verificada con getUTCDay):
//   2026-06-01 lunes · 06-02 martes · 06-03 miércoles · 06-04 jueves
//   2026-06-05 viernes · 06-06 SÁBADO · 06-07 DOMINGO · 06-08 lunes
const LUNES = '2026-06-01'
const SABADO = '2026-06-06'
const DOMINGO = '2026-06-07'
const LUNES_SIG = '2026-06-08'

const base = { startTime: '08:00', endTime: '17:00' }

describe('expandirRangoHabil — semana completa', () => {
  it('devuelve L-S y omite el domingo', () => {
    const dias = expandirRangoHabil({ ...base, startDate: LUNES, endDate: DOMINGO })
    expect(dias.map((d) => d.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06',
    ])
    expect(dias.map((d) => d.weekday)).toEqual([
      'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
    ])
  })

  it('un rango de un solo domingo devuelve vacío', () => {
    expect(expandirRangoHabil({ ...base, startDate: DOMINGO, endDate: DOMINGO })).toEqual([])
  })
})

describe('regla del sábado (media jornada hasta las 12:00)', () => {
  it('recorta la hora de fin a las 12:00 y lo marca como ajustado', () => {
    const [sab] = expandirRangoHabil({ ...base, startDate: SABADO, endDate: SABADO })
    expect(sab).toEqual({
      date: SABADO,
      weekday: 'sabado',
      startTime: '08:00',
      endTime: '12:00',
      ajustado: true,
    })
  })

  it('no toca la franja si ya termina antes de las 12:00', () => {
    const [sab] = expandirRangoHabil({
      startDate: SABADO, endDate: SABADO, startTime: '08:00', endTime: '11:00',
    })
    expect(sab.endTime).toBe('11:00')
    expect(sab.ajustado).toBe(false)
  })

  it('termina exactamente a las 12:00 sin marcarse como ajustado', () => {
    const [sab] = expandirRangoHabil({
      startDate: SABADO, endDate: SABADO, startTime: '08:00', endTime: '12:00',
    })
    expect(sab.endTime).toBe('12:00')
    expect(sab.ajustado).toBe(false)
  })

  it('omite el sábado por completo si el turno empieza a las 12:00 o después', () => {
    const tarde = expandirRangoHabil({
      startDate: SABADO, endDate: SABADO, startTime: '12:00', endTime: '18:00',
    })
    expect(tarde).toEqual([])

    const masTarde = expandirRangoHabil({
      startDate: SABADO, endDate: SABADO, startTime: '14:00', endTime: '18:00',
    })
    expect(masTarde).toEqual([])
  })

  it('con sabadoMedioDia=false el sábado se trata como domingo', () => {
    const dias = expandirRangoHabil({
      ...base, startDate: LUNES, endDate: DOMINGO, sabadoMedioDia: false,
    })
    expect(dias).toHaveLength(5)
    expect(dias.some((d) => d.weekday === 'sabado')).toBe(false)
  })
})

describe('festivos (RN-06)', () => {
  it('salta los días del set de festivos', () => {
    const dias = expandirRangoHabil({
      ...base,
      startDate: LUNES,
      endDate: '2026-06-05',
      holidays: new Set(['2026-06-03']),   // miércoles festivo
    })
    expect(dias.map((d) => d.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05',
    ])
  })

  it('un festivo en sábado también se salta', () => {
    const dias = expandirRangoHabil({
      ...base, startDate: SABADO, endDate: SABADO, holidays: new Set([SABADO]),
    })
    expect(dias).toEqual([])
  })
})

describe('validación de entrada', () => {
  it('rechaza fechas inválidas', () => {
    expect(() => expandirRangoHabil({ ...base, startDate: 'no-es-fecha', endDate: LUNES }))
      .toThrow(/inválidas/)
  })

  it('rechaza un rango invertido', () => {
    expect(() => expandirRangoHabil({ ...base, startDate: LUNES_SIG, endDate: LUNES }))
      .toThrow(/fecha_inicio debe ser <= fecha_fin/)
  })

  it('acepta un rango de un solo día hábil', () => {
    expect(expandirRangoHabil({ ...base, startDate: LUNES, endDate: LUNES })).toHaveLength(1)
  })
})

describe('contarDiasHabiles', () => {
  it('coincide con la longitud de expandirRangoHabil', () => {
    const args = { ...base, startDate: LUNES, endDate: LUNES_SIG }
    expect(contarDiasHabiles(args)).toBe(expandirRangoHabil(args).length)
    expect(contarDiasHabiles(args)).toBe(7)   // L-S (6) + lunes siguiente, sin domingo
  })

  it('descuenta los festivos del conteo', () => {
    const args = {
      ...base, startDate: LUNES, endDate: LUNES_SIG, holidays: new Set(['2026-06-02']),
    }
    expect(contarDiasHabiles(args)).toBe(6)
  })
})
