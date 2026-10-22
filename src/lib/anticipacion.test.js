import { describe, it, expect } from 'vitest'
import { DIAS_PROGRAMADA, esProgramada, diasDeAnticipacion } from './anticipacion.js'

describe('esProgramada', () => {
  it('el umbral es 20 días', () => {
    expect(DIAS_PROGRAMADA).toBe(20)
  })

  it.each([0, 1, 2, 3, 6, 7, 15, 16, 19])('%i días de anticipación es imprevista', (dias) => {
    expect(esProgramada(dias)).toBe(false)
  })

  it.each([20, 21, 30, 90])('%i días de anticipación es programada', (dias) => {
    expect(esProgramada(dias)).toBe(true)
  })

  it('una ausencia ya ocurrida (días negativos) es imprevista', () => {
    expect(esProgramada(-3)).toBe(false)
  })

  it('sin dato no se da por programada', () => {
    expect(esProgramada(null)).toBe(false)
    expect(esProgramada(undefined)).toBe(false)
  })
})

describe('diasDeAnticipacion', () => {
  // 20-oct-2026 a las 11:00 de Colombia (16:00 UTC).
  const MANANA = new Date('2026-10-20T16:00:00Z')

  it('cuenta días de calendario, sin restar la hora del registro', () => {
    expect(diasDeAnticipacion('2026-11-09', MANANA)).toBe(20)
    expect(esProgramada(diasDeAnticipacion('2026-11-09', MANANA))).toBe(true)
  })

  it('el mismo día es 0 y el día siguiente es 1', () => {
    expect(diasDeAnticipacion('2026-10-20', MANANA)).toBe(0)
    expect(diasDeAnticipacion('2026-10-21', MANANA)).toBe(1)
  })

  it('una fecha pasada da días negativos', () => {
    expect(diasDeAnticipacion('2026-10-17', MANANA)).toBe(-3)
  })

  it('a las 22:00 de Colombia (ya es otro día en UTC) sigue contando desde el día de Colombia', () => {
    const NOCHE = new Date('2026-10-21T03:00:00Z')   // 20-oct 22:00 en Colombia
    expect(diasDeAnticipacion('2026-11-09', NOCHE)).toBe(20)
  })

  it('acepta la fecha con hora (toma solo el día)', () => {
    expect(diasDeAnticipacion('2026-11-09T00:00:00.000Z', MANANA)).toBe(20)
  })
})
