import { describe, it, expect } from 'vitest'
import { fechaDeTurno, bloqueoQueCubre, diasBloqueados, mensajeBloqueo } from './bloqueosSede.js'

const B = { id: 'b1', siteId: 's1', desde: '2026-10-21', hasta: '2026-10-23', reason: 'sin personal', liftedAt: null }

describe('fechaDeTurno', () => {
  it('ubica el día por nombre dentro de la semana (que empieza en domingo)', () => {
    expect(fechaDeTurno('2026-10-18', 'domingo')).toBe('2026-10-18')
    expect(fechaDeTurno('2026-10-18', 'miercoles')).toBe('2026-10-21')
    expect(fechaDeTurno(new Date('2026-10-18T00:00:00Z'), 'sabado')).toBe('2026-10-24')
  })
})

describe('bloqueoQueCubre', () => {
  it('cubre los días del rango, bordes incluidos, solo en su sede', () => {
    expect(bloqueoQueCubre([B], 's1', '2026-10-21')).toBe(B)
    expect(bloqueoQueCubre([B], 's1', '2026-10-23')).toBe(B)
    expect(bloqueoQueCubre([B], 's1', '2026-10-24')).toBeNull()
    expect(bloqueoQueCubre([B], 's2', '2026-10-22')).toBeNull()
  })

  it('un bloqueo levantado ya no cubre nada', () => {
    expect(bloqueoQueCubre([{ ...B, liftedAt: new Date() }], 's1', '2026-10-22')).toBeNull()
  })
})

describe('diasBloqueados', () => {
  it('recorta el bloqueo al rango pedido', () => {
    expect([...diasBloqueados([B], 's1', '2026-10-22', '2026-10-31')]).toEqual(['2026-10-22', '2026-10-23'])
  })

  it('sin bloqueos de esa sede, vacío', () => {
    expect(diasBloqueados([B], 's2', '2026-10-18', '2026-10-24').size).toBe(0)
  })
})

describe('mensajeBloqueo', () => {
  it('dice qué sede, de cuándo a cuándo y por qué', () => {
    expect(mensajeBloqueo(B, 'Sede 1')).toBe('La sede Sede 1 está bloqueada del 2026-10-21 al 2026-10-23 (sin personal). No se puede programar en ella.')
  })
})
