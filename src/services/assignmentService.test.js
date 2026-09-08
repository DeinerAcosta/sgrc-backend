import { describe, it, expect } from 'vitest'
import { calcularCapacidad } from './assignmentService.js'

// calcularCapacidad decide cuántos pacientes se programan en una franja, así que
// alimenta `pacientes_capacidad` y, a través de él, el % de cumplimiento de todos
// los informes de productividad. Delega el almuerzo en minutosAlmuerzo(), que ya
// está cubierto en lib/horarios.test.js — aquí se fija el contrato del redondeo
// y de la interacción con el intervalo.

describe('calcularCapacidad — RN-11', () => {
  it('divide los minutos disponibles entre el intervalo, redondeando hacia abajo', () => {
    // 08:00-12:00 = 240 min, sin almuerzo (< 6h), intervalo 15 → 16 pacientes
    expect(calcularCapacidad('08:00', '12:00', 15, 'oftalmologo')).toBe(16)
    // 240 / 20 = 12
    expect(calcularCapacidad('08:00', '12:00', 20, 'oftalmologo')).toBe(12)
    // 240 / 30 = 8
    expect(calcularCapacidad('08:00', '12:00', 30, 'oftalmologo')).toBe(8)
  })

  it('nunca devuelve una fracción de paciente', () => {
    // 08:00-11:50 = 230 min; 230 / 15 = 15,33 → 15
    expect(calcularCapacidad('08:00', '11:50', 15, 'oftalmologo')).toBe(15)
    expect(Number.isInteger(calcularCapacidad('08:00', '11:50', 15, 'oftalmologo'))).toBe(true)
  })

  it('descuenta el almuerzo corto de los rotativos en jornadas de 6h o más', () => {
    // 08:00-17:00 = 540 min − 30 (rotativo) = 510; 510 / 15 = 34
    expect(calcularCapacidad('08:00', '17:00', 15, 'oftalmologo')).toBe(34)
  })

  it('descuenta 60 min al resto de tipos en la misma franja', () => {
    // 540 − 60 = 480; 480 / 15 = 32
    expect(calcularCapacidad('08:00', '17:00', 15, 'asesor_servicios')).toBe(32)
    expect(calcularCapacidad('08:00', '17:00', 15, 'auxiliar')).toBe(32)
  })

  it('respeta el turno corrido del técnico (sin descuento)', () => {
    // 07:00-13:00 = 360 min sin descuento; 360 / 15 = 24
    expect(calcularCapacidad('07:00', '13:00', 15, 'tecnico')).toBe(24)
    // el mismo horario para un auxiliar pierde 60 min → 300 / 15 = 20
    expect(calcularCapacidad('07:00', '13:00', 15, 'auxiliar')).toBe(20)
  })

  it('usa 15 min como intervalo por defecto si no llega uno válido', () => {
    expect(calcularCapacidad('08:00', '12:00', 0, 'oftalmologo')).toBe(16)
    expect(calcularCapacidad('08:00', '12:00', null, 'oftalmologo')).toBe(16)
    expect(calcularCapacidad('08:00', '12:00', undefined, 'oftalmologo')).toBe(16)
  })

  it('devuelve 0 en franjas nulas o invertidas', () => {
    expect(calcularCapacidad('10:00', '10:00', 15, 'oftalmologo')).toBe(0)
    expect(calcularCapacidad('17:00', '08:00', 15, 'oftalmologo')).toBe(0)
  })

  it('el umbral de las 6h es inclusivo y se nota en la capacidad', () => {
    // 5h59 (08:00-13:59) = 359 min sin descuento → 23
    expect(calcularCapacidad('08:00', '13:59', 15, 'auxiliar')).toBe(23)
    // 6h00 (08:00-14:00) = 360 − 60 = 300 → 20. Un minuto más de turno
    // reduce la capacidad: es el efecto esperado del almuerzo obligatorio.
    expect(calcularCapacidad('08:00', '14:00', 15, 'auxiliar')).toBe(20)
  })
})
