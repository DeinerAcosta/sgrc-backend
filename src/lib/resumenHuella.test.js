import { describe, it, expect } from 'vitest'
import { huellaResumen } from './resumenHuella.js'

// La huella es lo que evita que el coordinador reciba siete veces la misma
// lista en una semana. Se guarda en `referenceId` de la notificacion y la
// corrida del dia siguiente la compara antes de mandar nada.
//
// Se prueba aparte porque es la pieza con la que se puede callar un aviso por
// error: si dos listas distintas dieran la misma huella, el coordinador
// dejaria de enterarse de un cambio real.

const A = { id: 'r-a', horas: 10 }
const B = { id: 'r-b', horas: 20 }
const C = { id: 'r-c', horas: 0 }
const SEM = 'semana-1'

describe('huellaResumen — no manda si nada cambio', () => {
  it('la misma lista da la misma huella', () => {
    expect(huellaResumen(SEM, [C], [A, B])).toBe(huellaResumen(SEM, [C], [A, B]))
  })

  it('el orden de la lista no cambia la huella', () => {
    expect(huellaResumen(SEM, [C], [A, B])).toBe(huellaResumen(SEM, [C], [B, A]))
  })
})

describe('huellaResumen — si manda cuando algo cambio', () => {
  it('entra un recurso nuevo', () => {
    expect(huellaResumen(SEM, [C], [A])).not.toBe(huellaResumen(SEM, [C], [A, B]))
  })

  it('sale un recurso porque ya se programo', () => {
    expect(huellaResumen(SEM, [C], [A, B])).not.toBe(huellaResumen(SEM, [C], [A]))
  })

  it('AVANCE REAL: mismo recurso, mas horas asignadas', () => {
    // Sin esto, un coordinador que subio a alguien de 10 h a 30 h no volveria
    // a ver el correo aunque la situacion mejoro de verdad.
    const antes = huellaResumen(SEM, [], [{ id: 'r-a', horas: 10 }])
    const despues = huellaResumen(SEM, [], [{ id: 'r-a', horas: 30 }])
    expect(antes).not.toBe(despues)
  })

  it('un recurso pasa de "sin programar" a "por completar"', () => {
    const sinProgramar = huellaResumen(SEM, [{ id: 'r-a', horas: 0 }], [])
    const porCompletar = huellaResumen(SEM, [], [{ id: 'r-a', horas: 8 }])
    expect(sinProgramar).not.toBe(porCompletar)
  })

  it('SEMANA NUEVA: la misma lista en otra semana si manda correo', () => {
    // Al abrir una semana nueva todo el mundo arranca sin programar. Si la
    // huella ignorara la semana, el primer resumen no saldria nunca.
    expect(huellaResumen('semana-1', [C], [A])).not.toBe(huellaResumen('semana-2', [C], [A]))
  })
})

describe('huellaResumen — casos borde', () => {
  it('listas vacias dan una huella estable', () => {
    expect(huellaResumen(SEM, [], [])).toBe(huellaResumen(SEM, [], []))
  })

  it('devuelve una cadena corta y estable, apta para referenceId', () => {
    const h = huellaResumen(SEM, [C], [A, B])
    expect(h).toMatch(/^[0-9a-f]{40}$/)
  })

  it('no confunde los dos bloques entre si', () => {
    // Mismo id en un bloque o en el otro debe dar huellas distintas.
    expect(huellaResumen(SEM, [{ id: 'x', horas: 0 }], []))
      .not.toBe(huellaResumen(SEM, [], [{ id: 'x', horas: 0 }]))
  })
})
