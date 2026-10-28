import { describe, it, expect } from 'vitest'
import { diasLaborables, ausenciaEnSemana, horasDisponibles } from './disponibilidadSemana.js'

const LUNES = '2026-10-26'
const SEMANA = diasLaborables(LUNES)

describe('diasLaborables', () => {
  it('lunes a sábado', () => {
    expect(SEMANA).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'])
  })
  it('sin los festivos', () => {
    expect(diasLaborables('2026-11-02', ['2026-11-02'])).toHaveLength(5)
  })
})

describe('ausenciaEnSemana', () => {
  it('el caso real: vacaciones del 27-oct al 12-nov en la semana del 26-oct', () => {
    const r = ausenciaEnSemana([{ startDate: '2026-10-27', endDate: '2026-11-12', motivo: 'Vacaciones / viaje' }], SEMANA)
    expect(r).toEqual({ diasAusente: 5, horasPermiso: 0, todaLaSemana: false, motivo: 'Vacaciones / viaje' })
  })

  it('ausente toda la semana', () => {
    const r = ausenciaEnSemana([{ startDate: '2026-10-20', endDate: '2026-11-12', motivo: 'Vacaciones / viaje' }], SEMANA)
    expect(r.todaLaSemana).toBe(true)
    expect(r.diasAusente).toBe(6)
  })

  it('un permiso por horas descuenta sus horas, no el día', () => {
    const r = ausenciaEnSemana([{ startDate: '2026-10-28', endDate: '2026-10-28', isPartial: true, absenceStartTime: '08:00', absenceEndTime: '10:30' }], SEMANA)
    expect(r).toMatchObject({ diasAusente: 0, horasPermiso: 2.5, todaLaSemana: false })
  })

  it('un permiso dentro de un día ya ausente no descuenta dos veces', () => {
    const r = ausenciaEnSemana([
      { startDate: '2026-10-28', endDate: '2026-10-28' },
      { startDate: '2026-10-28', endDate: '2026-10-28', isPartial: true, absenceStartTime: '08:00', absenceEndTime: '10:00' },
    ], SEMANA)
    expect(r).toMatchObject({ diasAusente: 1, horasPermiso: 0 })
  })

  it('el domingo no cuenta', () => {
    expect(ausenciaEnSemana([{ startDate: '2026-11-01', endDate: '2026-11-01' }], SEMANA).diasAusente).toBe(0)
  })

  it('sin ausencias', () => {
    expect(ausenciaEnSemana([], SEMANA)).toEqual({ diasAusente: 0, horasPermiso: 0, todaLaSemana: false, motivo: null })
  })
})

describe('horasDisponibles', () => {
  it('42 h con 5 de 6 días ausente quedan 7 h', () => {
    expect(horasDisponibles(42, SEMANA, { diasAusente: 5 })).toBe(7)
  })
  it('con un festivo y un permiso de 2 h', () => {
    expect(horasDisponibles(42, diasLaborables('2026-11-02', ['2026-11-02']), { horasPermiso: 2 })).toBe(33)
  })
  it('sin tope sigue sin tope', () => {
    expect(horasDisponibles(null, SEMANA)).toBeNull()
  })
  it('nunca negativo', () => {
    expect(horasDisponibles(42, SEMANA, { diasAusente: 6, horasPermiso: 3 })).toBe(0)
  })
})
