import { describe, it, expect } from 'vitest'
import { auxiliaresDe, horarioEfectivoAuxEnAsig, solapaConAux, participaEn } from './timeSlots.js'
import {
  listaAuxiliaresDelBody, filasAuxiliares, errorDeFormaAuxiliares, serializarAsignacion,
  puedeSerApoyo, textoAuxiliares, whereParticipa,
} from './auxiliaresTurno.js'

// Nov-2026 · Hector: un turno lleva las auxiliares que hagan falta, en
// secuencia hasta cubrir el horario del médico. Doc 07-13 con tres auxiliares.
const turno = {
  resourceId: 'doc', startTime: '07:00', endTime: '13:00',
  assistants: [
    { resourceId: 'c', startTime: '11:00', endTime: '13:00', position: 2, resource: { id: 'c', name: 'Caro', type: 'auxiliar' } },
    { resourceId: 'a', startTime: '07:00', endTime: '09:00', position: 0, resource: { id: 'a', name: 'Ana', type: 'auxiliar' } },
    { resourceId: 'b', startTime: null, endTime: null, position: 1, resource: { id: 'b', name: 'Beto', type: 'auxiliar' } },
  ],
}

describe('auxiliaresDe', () => {
  it('ordena por posición y resuelve la hora heredada del turno', () => {
    expect(auxiliaresDe(turno)).toMatchObject([
      { resourceId: 'a', ini: '07:00', fin: '09:00', position: 0 },
      { resourceId: 'b', ini: '07:00', fin: '13:00', position: 1 },
      { resourceId: 'c', ini: '11:00', fin: '13:00', position: 2 },
    ])
  })

  it('sin lista (consulta que no la pidió) devuelve vacío', () => {
    expect(auxiliaresDe({ startTime: '07:00', endTime: '13:00' })).toEqual([])
  })

  it('el horario efectivo de cada una, en cualquier posición', () => {
    expect(horarioEfectivoAuxEnAsig(turno, 'c')).toMatchObject({ ini: '11:00', fin: '13:00' })
    expect(horarioEfectivoAuxEnAsig(turno, 'b')).toMatchObject({ ini: '07:00', fin: '13:00' })
    // El profesional (o alguien que no está) toma el del turno
    expect(horarioEfectivoAuxEnAsig(turno, 'doc')).toMatchObject({ ini: '07:00', fin: '13:00' })
  })

  it('la 3ª ocupada de 11 a 13 choca con 12-14 pero no con 09-11', () => {
    expect(solapaConAux(turno, 'c', '12:00', '14:00')).toBe(true)
    expect(solapaConAux(turno, 'c', '09:00', '11:00')).toBe(false)
  })

  it('participaEn encuentra a la persona como profesional o como cualquier auxiliar', () => {
    expect(participaEn(turno, 'doc')).toBe(true)
    expect(participaEn(turno, 'c')).toBe(true)
    expect(participaEn(turno, 'z')).toBe(false)
  })
})

describe('listaAuxiliaresDelBody', () => {
  it('la lista nueva manda y se normaliza', () => {
    expect(listaAuxiliaresDelBody({
      assistants: [{ resourceId: 'a', startTime: '07:00', endTime: '09:00' }, { resourceId: 'b' }],
      assistantId: 'x',
    })).toMatchObject([
      { resourceId: 'a', startTime: '07:00', endTime: '09:00' },
      { resourceId: 'b', startTime: null, endTime: null },
    ])
  })

  it('la forma vieja (2 auxiliares fijas) se convierte a la lista', () => {
    expect(listaAuxiliaresDelBody({
      assistantId: 'a', assistantStartTime: '07:00', assistantEndTime: '09:00', assistant2Id: 'b',
    })).toEqual([
      { resourceId: 'a', startTime: '07:00', endTime: '09:00' },
      { resourceId: 'b', startTime: null, endTime: null },
    ])
  })

  it('sin nada de auxiliares devuelve null (al editar: no tocar); assistantId null = vaciar', () => {
    expect(listaAuxiliaresDelBody({ startTime: '07:00' })).toBeNull()
    expect(listaAuxiliaresDelBody({ assistantId: undefined })).toBeNull()
    expect(listaAuxiliaresDelBody({ assistantId: null })).toEqual([])
    expect(listaAuxiliaresDelBody({ assistants: [] })).toEqual([])
  })
})

describe('filasAuxiliares', () => {
  it('guarda la hora solo si difiere del turno (y entonces las dos), en el orden recibido', () => {
    const t = { startTime: '07:00', endTime: '13:00' }
    expect(filasAuxiliares([
      { resourceId: 'a', startTime: '07:00', endTime: '09:00' },
      { resourceId: 'b', startTime: '07:00', endTime: '13:00' },
      { resourceId: 'c', startTime: null, endTime: '13:00' },
      { resourceId: 'd', startTime: '09:00', endTime: null },
    ], t)).toMatchObject([
      { resourceId: 'a', startTime: '07:00', endTime: '09:00', position: 0 },
      { resourceId: 'b', startTime: null, endTime: null, position: 1 },
      { resourceId: 'c', startTime: null, endTime: null, position: 2 },
      { resourceId: 'd', startTime: '09:00', endTime: '13:00', position: 3 },
    ])
  })
})

describe('errorDeFormaAuxiliares', () => {
  const t = { resourceId: 'doc', startTime: '07:00', endTime: '13:00' }
  const nombres = new Map([['a', 'Ana'], ['b', 'Beto'], ['c', 'Caro']])

  it('tres en secuencia y una solapada están bien (la cobertura completa no se exige)', () => {
    expect(errorDeFormaAuxiliares([
      { resourceId: 'a', startTime: '07:00', endTime: '09:00' },
      { resourceId: 'b', startTime: '08:00', endTime: '11:00' },
      { resourceId: 'c', startTime: '11:00', endTime: '12:00' },
    ], t, nombres)).toBeNull()
  })

  it('rechaza la misma persona dos veces', () => {
    expect(errorDeFormaAuxiliares([{ resourceId: 'a' }, { resourceId: 'a' }], t, nombres)).toContain('Ana está repetida')
  })

  it('rechaza que el profesional sea su propia auxiliar', () => {
    expect(errorDeFormaAuxiliares([{ resourceId: 'doc' }], t, nombres)).toContain('es el profesional del turno')
  })

  it('rechaza un sub-horario fuera del turno o al revés, nombrando a la auxiliar', () => {
    expect(errorDeFormaAuxiliares([{ resourceId: 'c', startTime: '12:00', endTime: '14:00' }], t, nombres))
      .toBe('El horario de la auxiliar Caro (12:00–14:00) debe estar dentro del horario del recurso principal (07:00–13:00)')
    expect(errorDeFormaAuxiliares([{ resourceId: 'b', startTime: '10:00', endTime: '09:00' }], t, nombres))
      .toContain('Horario de auxiliar inválido (Beto)')
  })
})

describe('puedeSerApoyo', () => {
  it('auxiliar en oftalmología; técnico en diagnóstico; contando supportTypes', () => {
    expect(puedeSerApoyo({ type: 'auxiliar' }, 'oftalmologia')).toBe(true)
    expect(puedeSerApoyo({ type: 'tecnico' }, 'oftalmologia')).toBe(false)
    expect(puedeSerApoyo({ type: 'tecnico', supportTypes: 'auxiliar' }, 'oftalmologia')).toBe(true)
    expect(puedeSerApoyo({ type: 'tecnico' }, 'diagnostico')).toBe(true)
    expect(puedeSerApoyo({ type: 'auxiliar' }, 'diagnostico')).toBe(false)
  })
})

describe('serializarAsignacion', () => {
  it('devuelve la lista ordenada y los campos viejos de la 1ª y la 2ª', () => {
    const s = serializarAsignacion(turno)
    expect(s.assistants.map((x) => x.resourceId)).toEqual(['a', 'b', 'c'])
    expect(s.assistantId).toBe('a')
    expect(s.assistant).toEqual({ id: 'a', name: 'Ana', type: 'auxiliar' })
    expect(s.assistantStartTime).toBe('07:00')
    expect(s.assistantEndTime).toBe('09:00')
    expect(s.assistant2Id).toBe('b')
    expect(s.assistant2StartTime).toBeNull()
  })

  it('sin auxiliares, los campos viejos en null; sin `assistants`, no toca nada', () => {
    const s = serializarAsignacion({ id: 'x', assistants: [] })
    expect(s.assistantId).toBeNull()
    expect(s.assistant2).toBeNull()
    expect(serializarAsignacion({ id: 'x' })).toEqual({ id: 'x' })
  })
})

describe('textoAuxiliares / whereParticipa', () => {
  it('lista todas con su sub-horario cuando lo tienen', () => {
    expect(textoAuxiliares(turno)).toBe('Ana (07:00–09:00), Beto, Caro (11:00–13:00)')
    expect(textoAuxiliares(turno, { conHorario: false })).toBe('Ana, Beto, Caro')
  })

  it('busca a la persona como profesional o en cualquier posición de la lista', () => {
    expect(whereParticipa('r1')).toEqual({ OR: [{ resourceId: 'r1' }, { assistants: { some: { resourceId: 'r1' } } }] })
    expect(whereParticipa(['r1', 'r2'])).toEqual({
      OR: [{ resourceId: { in: ['r1', 'r2'] } }, { assistants: { some: { resourceId: { in: ['r1', 'r2'] } } } }],
    })
  })
})

// Nov-2026 · Hector: descanso (almuerzo) de la auxiliar dentro de su horario,
// cubierto OBLIGATORIAMENTE por otra auxiliar con ese mismo horario.
describe('descanso de la auxiliar', () => {
  const t = { resourceId: 'doc', startTime: '07:00', endTime: '16:00' }
  const conRelevo = [
    { resourceId: 'a', breakStartTime: '12:00', breakEndTime: '13:00' },
    { resourceId: 'b', startTime: '12:00', endTime: '13:00', coversBreakOf: 0 },
  ]
  it('con quien lo cubre en ese horario, está bien', () => {
    expect(errorDeFormaAuxiliares(conRelevo, t)).toBeNull()
  })
  it('sin quien lo cubra, no deja guardar', () => {
    expect(errorDeFormaAuxiliares([conRelevo[0]], t)).toMatch(/Falta la auxiliar que cubre el descanso/)
  })
  it('quien lo cubre debe tener exactamente el horario del descanso', () => {
    const l = [conRelevo[0], { ...conRelevo[1], endTime: '14:00' }]
    expect(errorDeFormaAuxiliares(l, t)).toMatch(/su horario debe ser 12:00–13:00/)
  })
  it('el descanso va dentro del horario de la auxiliar', () => {
    const l = [{ resourceId: 'a', startTime: '07:00', endTime: '12:00', breakStartTime: '12:00', breakEndTime: '13:00' }, conRelevo[1]]
    expect(errorDeFormaAuxiliares(l, t)).toMatch(/debe estar dentro de su horario/)
  })
  it('se guarda y se lee de vuelta', () => {
    const filas = filasAuxiliares(listaAuxiliaresDelBody({ assistants: conRelevo }), t)
    expect(filas[0]).toMatchObject({ breakStartTime: '12:00', breakEndTime: '13:00', coversBreakOf: null })
    expect(filas[1]).toMatchObject({ startTime: '12:00', endTime: '13:00', coversBreakOf: 0 })
    expect(horarioEfectivoAuxEnAsig({ ...t, assistants: filas }, 'a')).toEqual({ ini: '07:00', fin: '16:00', descanso: { ini: '12:00', fin: '13:00' } })
  })
})
