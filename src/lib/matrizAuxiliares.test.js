import { describe, it, expect } from 'vitest'
import { validarFranjas, horasDelDiaMatriz, estadoAuxiliarEnTurno } from './matrizAuxiliares.js'

describe('estadoAuxiliarEnTurno — turno de 07:00 a 13:00', () => {
  const e = (p) => estadoAuxiliarEnTurno({ ini: '07:00', fin: '13:00', ...p })
  it('sin nada ese día → sin_asignar', () => {
    expect(e({})).toBe('sin_asignar')
  })
  it('con turno en la tarde → disponible', () => {
    expect(e({ franjas: [{ ini: '14:00', fin: '19:00' }] })).toBe('disponible')
  })
  it('turno que empieza justo cuando este termina no se cruza', () => {
    expect(e({ franjas: [{ ini: '13:00', fin: '19:00' }] })).toBe('disponible')
  })
  it('turno que se cruza → asignado', () => {
    expect(e({ franjas: [{ ini: '12:00', fin: '16:00' }] })).toBe('asignado')
  })
  it('ausencia de día completo → ausente, aunque tenga turnos', () => {
    expect(e({ ausencias: [{ isPartial: false }], franjas: [{ ini: '07:00', fin: '13:00' }] })).toBe('ausente')
  })
  it('permiso por horas que toca el turno → ausente', () => {
    expect(e({ ausencias: [{ isPartial: true, absenceStartTime: '09:00', absenceEndTime: '11:00' }] })).toBe('ausente')
  })
  it('permiso por horas en la tarde no la saca del turno de la mañana', () => {
    expect(e({ ausencias: [{ isPartial: true, absenceStartTime: '14:00', absenceEndTime: '16:00' }] })).toBe('sin_asignar')
  })
  it('permiso por horas sin horas registradas cuenta como todo el día', () => {
    expect(e({ ausencias: [{ isPartial: true }] })).toBe('ausente')
  })
})

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
