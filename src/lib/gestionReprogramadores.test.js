import { describe, it, expect } from 'vitest'
import { resumirGestion } from './gestionReprogramadores.js'

const nombres = new Map([['r1', 'Laura'], ['r2', 'Pedro']])

describe('resumirGestion', () => {
  it('suma por reprogramador y separa turno nuevo de llamada', () => {
    const casos = [
      { id: 'a1', reschedulerId: 'r1', rescheduleStatus: 'resuelta', patientsAffected: 20, patientsReached: 15, patientsNoAnswer: 5 },
      { id: 'a2', reschedulerId: 'r1', rescheduleStatus: 'asignada', patientsAffected: 10, patientsReached: 4, patientsNoAnswer: 1 },
    ]
    const { reprogramadores: [laura], totales } = resumirGestion(casos, new Map([['a1', 12]]), nombres)
    expect(laura).toMatchObject({
      nombre: 'Laura', casos: 2, terminados: 1, llamando: 1, pacientes: 30,
      con_turno_nuevo: 12, por_llamada: 18, llamados: 25, contestaron: 19, no_contestaron: 6, por_llamar: 5,
      pct_contestaron: 76, pct_terminados: 50,
    })
    expect(totales.casos).toBe(2)
  })

  it('el número real de la líder manda sobre el estimado', () => {
    const casos = [{ id: 'a1', reschedulerId: 'r2', patientsAffected: 20, patientsConfirmed: 8 }]
    expect(resumirGestion(casos, new Map(), nombres).reprogramadores[0].pacientes).toBe(8)
  })

  it('los pacientes con turno nuevo no pasan de los pacientes del caso', () => {
    const casos = [{ id: 'a1', reschedulerId: 'r2', patientsAffected: 10 }]
    const [f] = resumirGestion(casos, new Map([['a1', 24]]), nombres).reprogramadores
    expect(f.con_turno_nuevo).toBe(10)
    expect(f.por_llamada).toBe(0)
  })

  it('sin llamadas, el porcentaje es 0 y no NaN', () => {
    const [f] = resumirGestion([{ id: 'a1', reschedulerId: 'r1', patientsAffected: 5 }], new Map(), nombres).reprogramadores
    expect(f.pct_contestaron).toBe(0)
    expect(f.por_llamar).toBe(5)
  })

  it('un reprogramador que ya no existe sale como usuario retirado', () => {
    const [f] = resumirGestion([{ id: 'a1', reschedulerId: 'x9', patientsAffected: 1 }], new Map(), nombres).reprogramadores
    expect(f.nombre).toBe('Usuario retirado')
  })
})
