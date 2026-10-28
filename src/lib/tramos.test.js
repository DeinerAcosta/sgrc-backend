import { describe, it, expect } from 'vitest'
import { huecosDeFranja, pacientesDelTramo, horaDeCorte, parteAfectada, ausenciasSeCruzan, errorEnFechasDeAusencia } from './tramos.js'

const FRANJA = { desde: '07:00', hasta: '11:00' }

describe('huecosDeFranja', () => {
  it('sin nadie que cubra, toda la franja es hueco', () => {
    expect(huecosDeFranja(FRANJA, [])).toEqual([{ desde: '07:00', hasta: '11:00' }])
  })

  it('cubierta por un tramo al inicio, queda el final', () => {
    expect(huecosDeFranja(FRANJA, [{ desde: '07:00', hasta: '09:00' }]))
      .toEqual([{ desde: '09:00', hasta: '11:00' }])
  })

  it('un tramo en el medio deja dos huecos', () => {
    expect(huecosDeFranja(FRANJA, [{ desde: '08:00', hasta: '09:30' }]))
      .toEqual([{ desde: '07:00', hasta: '08:00' }, { desde: '09:30', hasta: '11:00' }])
  })

  it('dos tramos que la cubren entera no dejan hueco, vengan en el orden que vengan', () => {
    expect(huecosDeFranja(FRANJA, [
      { desde: '09:00', hasta: '11:00' },
      { desde: '07:00', hasta: '09:00' },
    ])).toEqual([])
  })

  it('tramos que se pisan o se salen de la franja se recortan y se funden', () => {
    expect(huecosDeFranja(FRANJA, [
      { desde: '06:00', hasta: '08:30' },
      { desde: '08:00', hasta: '10:00' },
      { desde: '10:30', hasta: '12:00' },
    ])).toEqual([{ desde: '10:00', hasta: '10:30' }])
  })
})

describe('pacientesDelTramo', () => {
  it('la franja entera son todos sus pacientes', () => {
    expect(pacientesDelTramo(10, FRANJA, FRANJA)).toBe(10)
  })

  it('la mitad del horario, la mitad de los pacientes', () => {
    expect(pacientesDelTramo(10, FRANJA, { desde: '07:00', hasta: '09:00' })).toBe(5)
  })

  it('cualquier partición suma EXACTAMENTE el total (redondeo acumulado)', () => {
    // Por separado, 10 en tres tercios redondearía a 3 + 3 + 3 = 9 y el caso
    // no se cerraría nunca. Acumulado: 3 + 4 + 3 = 10.
    const tercios = [
      { desde: '07:00', hasta: '08:20' },
      { desde: '08:20', hasta: '09:40' },
      { desde: '09:40', hasta: '11:00' },
    ]
    const partes = tercios.map((t) => pacientesDelTramo(10, FRANJA, t))
    expect(partes.reduce((a, b) => a + b, 0)).toBe(10)
  })

  it('suma exacta también con particiones desiguales y números feos', () => {
    const franja = { desde: '07:00', hasta: '13:00' }
    for (const total of [1, 7, 22, 33, 37]) {
      const cortes = ['07:00', '07:45', '09:10', '11:05', '12:20', '13:00']
      let suma = 0
      for (let i = 0; i < cortes.length - 1; i++) {
        suma += pacientesDelTramo(total, franja, { desde: cortes[i], hasta: cortes[i + 1] })
      }
      expect(suma).toBe(total)
    }
  })

  it('sin pacientes o con franja vacía, cero', () => {
    expect(pacientesDelTramo(0, FRANJA, FRANJA)).toBe(0)
    expect(pacientesDelTramo(10, { desde: '09:00', hasta: '09:00' }, FRANJA)).toBe(0)
  })
})

describe('horaDeCorte', () => {
  const franja = { desde: '07:00', hasta: '13:00' }

  it('10 de 16 pacientes entre 07:00 y 13:00 terminan a las 10:45', () => {
    expect(horaDeCorte(16, franja, '07:00', 10)).toBe('10:45')
  })

  it('el tramo tiene justo los pacientes pedidos, y el resto cuadra', () => {
    for (let n = 1; n < 16; n++) {
      const corte = horaDeCorte(16, franja, '07:00', n)
      expect(pacientesDelTramo(16, franja, { desde: '07:00', hasta: corte })).toBe(n)
      expect(pacientesDelTramo(16, franja, { desde: corte, hasta: '13:00' })).toBe(16 - n)
    }
  })

  it('con muchos pacientes por hora sigue siendo exacto', () => {
    const corta = { desde: '08:00', hasta: '10:00' }
    for (let n = 1; n < 40; n++) {
      expect(pacientesDelTramo(40, corta, { desde: '08:00', hasta: horaDeCorte(40, corta, '08:00', n) })).toBe(n)
    }
  })
})

describe('parteAfectada', () => {
  const manana = { startTime: '07:00', endTime: '13:00', patientCapacity: 22 }
  const tarde = { startTime: '13:00', endTime: '19:00', patientCapacity: 22 }

  it('día completo: el turno entero', () => {
    expect(parteAfectada(manana, { isPartial: false })).toEqual({ desde: '07:00', hasta: '13:00', pacientes: 22 })
  })

  it('el caso del Dr. Ortega: falta 07–13, la mañana cuenta entera y la tarde no se cae', () => {
    const ausencia = { isPartial: true, absenceStartTime: '07:00', absenceEndTime: '13:00' }
    expect(parteAfectada(manana, ausencia)).toEqual({ desde: '07:00', hasta: '13:00', pacientes: 22 })
    expect(parteAfectada(tarde, ausencia)).toBeNull()
  })

  it('falta 07–11 en un turno de 07–13 con 22: solo esas cuatro horas', () => {
    const ausencia = { isPartial: true, absenceStartTime: '07:00', absenceEndTime: '11:00' }
    expect(parteAfectada(manana, ausencia)).toEqual({ desde: '07:00', hasta: '11:00', pacientes: 15 })
  })

  it('la parte que falta y la que atiende suman el turno', () => {
    const falta = parteAfectada(manana, { isPartial: true, absenceStartTime: '07:00', absenceEndTime: '11:00' })
    const atiende = parteAfectada(manana, { isPartial: true, absenceStartTime: '11:00', absenceEndTime: '13:00' })
    expect(falta.pacientes + atiende.pacientes).toBe(22)
  })

  it('parcial sin horas cargadas se trata como día completo', () => {
    expect(parteAfectada(manana, { isPartial: true })).toEqual({ desde: '07:00', hasta: '13:00', pacientes: 22 })
  })
})

describe('ausenciasSeCruzan', () => {
  const parcial = (desde, hasta, fecha = '2026-10-27') =>
    ({ startDate: fecha, endDate: fecha, isPartial: true, absenceStartTime: desde, absenceEndTime: hasta })
  const completa = (inicio, fin = inicio) => ({ startDate: inicio, endDate: fin, isPartial: false })

  it('dos permisos seguidos el mismo día (08–09 y 09–10:30) no se cruzan', () => {
    expect(ausenciasSeCruzan(parcial('08:00', '09:00'), parcial('09:00', '10:30'))).toBe(false)
  })

  it('dos permisos que se pisan el mismo día sí se cruzan', () => {
    expect(ausenciasSeCruzan(parcial('08:00', '09:00'), parcial('08:30', '10:00'))).toBe(true)
  })

  it('el mismo permiso registrado dos veces se cruza', () => {
    expect(ausenciasSeCruzan(parcial('08:00', '09:00'), parcial('08:00', '09:00'))).toBe(true)
  })

  it('un permiso dentro de una ausencia de día completo se cruza', () => {
    expect(ausenciasSeCruzan(completa('2026-10-26', '2026-10-28'), parcial('09:00', '10:00'))).toBe(true)
  })

  it('días distintos no se cruzan aunque las horas coincidan', () => {
    expect(ausenciasSeCruzan(parcial('08:00', '09:00', '2026-10-27'), parcial('08:00', '09:00', '2026-10-28'))).toBe(false)
  })

  it('una parcial sin horas cargadas cuenta como día completo', () => {
    expect(ausenciasSeCruzan({ ...parcial('08:00', '09:00'), absenceEndTime: null }, parcial('10:00', '11:00'))).toBe(true)
  })

  it('acepta fechas como Date a medianoche UTC', () => {
    const a = { ...parcial('08:00', '09:00'), startDate: new Date('2026-10-27T00:00:00Z'), endDate: new Date('2026-10-27T00:00:00Z') }
    expect(ausenciasSeCruzan(a, parcial('09:00', '10:30'))).toBe(false)
  })
})

describe('errorEnFechasDeAusencia', () => {
  it('acepta un día, un rango y un permiso por horas bien escritos', () => {
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27' })).toBeNull()
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27', endDate: '2026-11-12' })).toBeNull()
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27', isPartial: true, absenceStartTime: '08:00', absenceEndTime: '09:00' })).toBeNull()
  })

  it('rechaza la fecha final antes de la inicial (el caso real del 27-nov al 11-nov)', () => {
    expect(errorEnFechasDeAusencia({ startDate: '2026-11-27', endDate: '2026-11-11' }))
      .toBe('La fecha final no puede ser anterior a la fecha de inicio.')
  })

  it('rechaza fechas que no son fechas', () => {
    expect(errorEnFechasDeAusencia({ startDate: 'mañana' })).toBe('La fecha de inicio no es válida.')
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27', endDate: '12/11/2026' })).toBe('La fecha final no es válida.')
  })

  it('rechaza un permiso cuya hora final no es posterior a la inicial', () => {
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27', isPartial: true, absenceStartTime: '10:00', absenceEndTime: '09:00' }))
      .toBe('La hora final debe ser posterior a la hora de inicio.')
    expect(errorEnFechasDeAusencia({ startDate: '2026-10-27', isPartial: true, absenceStartTime: '09:00', absenceEndTime: '09:00' }))
      .toBe('La hora final debe ser posterior a la hora de inicio.')
  })
})
