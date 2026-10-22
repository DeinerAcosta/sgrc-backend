import { describe, it, expect } from 'vitest'
import { prioridadDeReemplazo, compararPorPrioridad } from './prioridadReemplazo.js'

describe('prioridadDeReemplazo', () => {
  it('1 · la auxiliar cuyo médico está ausente va primero, aunque tenga muchas horas', () => {
    expect(prioridadDeReemplazo({ liberadaPorAusencia: true, horasSemana: 44, topeSemanal: 42 }).prioridad).toBe(1)
  })

  it('2 · la que no ha completado sus 42 h', () => {
    const p = prioridadDeReemplazo({ liberadaPorAusencia: false, horasSemana: 30, topeSemanal: null })
    expect(p.prioridad).toBe(2)
    expect(p.motivo).toBe('Lleva 30 h de 42 h esta semana')
  })

  it('3 · la de otra jornada, ya completa', () => {
    const p = prioridadDeReemplazo({ liberadaPorAusencia: false, horasSemana: 42, topeSemanal: 42, esMismoDia: false })
    expect(p.prioridad).toBe(3)
    expect(p.avisoMismoDia).toBe(false)
  })

  it('3 · llamarla el mismo día queda marcado como excepción', () => {
    expect(prioridadDeReemplazo({ liberadaPorAusencia: false, horasSemana: 42, topeSemanal: 42, esMismoDia: true }).avisoMismoDia).toBe(true)
  })

  it('usa su propio tope si lo tiene', () => {
    expect(prioridadDeReemplazo({ liberadaPorAusencia: false, horasSemana: 30, topeSemanal: 30 }).prioridad).toBe(3)
  })
})

describe('compararPorPrioridad', () => {
  it('ordena por prioridad, luego misma sede, luego menos horas', () => {
    const lista = [
      { n: 'c', prioridad: 2, misma_sede: false, horas_semana: 10 },
      { n: 'a', prioridad: 1, misma_sede: false, horas_semana: 40 },
      { n: 'b', prioridad: 2, misma_sede: true, horas_semana: 30 },
      { n: 'd', prioridad: 2, misma_sede: true, horas_semana: 20 },
    ]
    expect(lista.sort(compararPorPrioridad).map((x) => x.n)).toEqual(['a', 'd', 'b', 'c'])
  })
})
