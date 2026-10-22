import { describe, it, expect } from 'vitest'
import { diasDeAusencia } from './absenceService.js'

// Oct-2026 · Las fechas se guardan a medianoche UTC. Leerlas con la hora local
// de Colombia corría cada día uno atrás: el martes 20 salía lunes 19.
describe('diasDeAusencia', () => {
  it('el martes 20 guardado a medianoche UTC es martes, no lunes', () => {
    const d = new Date('2026-10-20T00:00:00.000Z')
    expect(diasDeAusencia({ startDate: d, endDate: d })).toEqual([{ date: '2026-10-20', day: 'martes' }])
  })

  it('un rango de tres días da los tres, en orden', () => {
    const r = diasDeAusencia({
      startDate: new Date('2026-10-19T00:00:00.000Z'),
      endDate: new Date('2026-10-21T00:00:00.000Z'),
    })
    expect(r.map((x) => `${x.date} ${x.day}`)).toEqual([
      '2026-10-19 lunes', '2026-10-20 martes', '2026-10-21 miercoles',
    ])
  })

  it('una fecha a medianoche de Colombia (05:00 UTC) cuenta como el mismo día', () => {
    const r = diasDeAusencia({
      startDate: new Date('2026-10-20T05:00:00.000Z'),
      endDate: new Date('2026-10-20T00:00:00.000Z'),
    })
    expect(r).toEqual([{ date: '2026-10-20', day: 'martes' }])
  })
})
