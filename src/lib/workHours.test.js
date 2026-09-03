import { describe, it, expect } from 'vitest'
import {
  hhmmAMinutos,
  horasDeFranja,
  horasEfectivasFranja,
  minutosAlmuerzo,
  minutosUnion,
  horasUnionPorDia,
  JORNADA_LEGAL_SEMANAL,
} from './workHours.js'

// Estas funciones son la ÚNICA fuente de verdad sobre horas del sistema: de
// ellas salen la ocupación por consultorio, la utilización contra el tope
// semanal, la productividad por recurso y la capacidad de pacientes. Cualquier
// refactor de los informes tiene que dejar estos números intactos.

describe('hhmmAMinutos', () => {
  it('convierte HH:MM a minutos desde medianoche', () => {
    expect(hhmmAMinutos('00:00')).toBe(0)
    expect(hhmmAMinutos('07:00')).toBe(420)
    expect(hhmmAMinutos('12:00')).toBe(720)
    expect(hhmmAMinutos('13:00')).toBe(780)
    expect(hhmmAMinutos('19:00')).toBe(1140)
    expect(hhmmAMinutos('08:30')).toBe(510)
  })
})

describe('horasDeFranja (brutas — presencia y reserva de consultorio)', () => {
  it('no descuenta almuerzo: mide la franja completa', () => {
    expect(horasDeFranja('08:00', '17:00')).toBe(9)
    expect(horasDeFranja('07:00', '13:00')).toBe(6)
    expect(horasDeFranja('08:00', '12:30')).toBe(4.5)
  })
})

describe('minutosAlmuerzo — RN-11 v4 (jul-2026)', () => {
  it('no descuenta en turnos de menos de 6h', () => {
    // 5h59 — justo por debajo del umbral
    expect(minutosAlmuerzo(359, 480, 839, 'auxiliar')).toBe(0)
    expect(minutosAlmuerzo(359, 480, 839, 'oftalmologo')).toBe(0)
  })

  it('descuenta a partir de 6h exactas (el umbral es inclusivo)', () => {
    expect(minutosAlmuerzo(360, 480, 840, 'auxiliar')).toBe(60)
    expect(minutosAlmuerzo(360, 480, 840, 'oftalmologo')).toBe(30)
  })

  it('descuenta 30 min a los rotativos y 60 al resto', () => {
    const seis = [360, 480, 840]
    for (const tipo of ['oftalmologo', 'anestesiologo', 'optometra', 'fonoaudiologa', 'otorrino']) {
      expect(minutosAlmuerzo(...seis, tipo), `rotativo: ${tipo}`).toBe(30)
    }
    for (const tipo of ['auxiliar', 'asesor_servicios', 'tecnico', null]) {
      expect(minutosAlmuerzo(...seis, tipo), `no rotativo: ${tipo}`).toBe(60)
    }
  })

  describe('excepción de técnicos de ayudas diagnósticas', () => {
    it('el matutino corrido 07:00-13:00 no descuenta almuerzo', () => {
      expect(minutosAlmuerzo(360, 420, 780, 'tecnico')).toBe(0)
    })

    it('el vespertino corrido 13:00-19:00 no descuenta almuerzo', () => {
      expect(minutosAlmuerzo(360, 780, 1140, 'tecnico')).toBe(0)
    })

    it('cualquier otro turno de técnico sí descuenta 60 min', () => {
      // 08:00-17:00 — turno largo, cabe el receso
      expect(minutosAlmuerzo(540, 480, 1020, 'tecnico')).toBe(60)
      // 07:00-18:00
      expect(minutosAlmuerzo(660, 420, 1080, 'tecnico')).toBe(60)
      // 07:00-14:00 — empieza como el matutino pero no termina a las 13:00
      expect(minutosAlmuerzo(420, 420, 840, 'tecnico')).toBe(60)
    })

    it('la excepción es SOLO para técnicos, no para otros tipos en esa misma franja', () => {
      expect(minutosAlmuerzo(360, 420, 780, 'auxiliar')).toBe(60)
      expect(minutosAlmuerzo(360, 420, 780, 'oftalmologo')).toBe(30)
    })
  })
})

describe('horasEfectivasFranja (productivas — se comparan contra el tope semanal)', () => {
  it('descuenta el almuerzo que corresponde al tipo', () => {
    // 08:00-17:00 = 9h brutas
    expect(horasEfectivasFranja('08:00', '17:00', 'asesor_servicios')).toBe(8)     // -60 min
    expect(horasEfectivasFranja('08:00', '17:00', 'oftalmologo')).toBe(8.5)        // -30 min
  })

  it('deja intacto el turno corto', () => {
    expect(horasEfectivasFranja('08:00', '12:00', 'auxiliar')).toBe(4)
    expect(horasEfectivasFranja('14:00', '18:00', 'oftalmologo')).toBe(4)
  })

  it('respeta el turno corrido del técnico', () => {
    expect(horasEfectivasFranja('07:00', '13:00', 'tecnico')).toBe(6)
    expect(horasEfectivasFranja('13:00', '19:00', 'tecnico')).toBe(6)
    // el mismo horario para un auxiliar sí pierde la hora
    expect(horasEfectivasFranja('07:00', '13:00', 'auxiliar')).toBe(5)
  })

  it('devuelve 0 si la franja es nula o invertida', () => {
    expect(horasEfectivasFranja('10:00', '10:00', 'auxiliar')).toBe(0)
    expect(horasEfectivasFranja('17:00', '08:00', 'auxiliar')).toBe(0)
  })

  it('sin tipo de recurso aplica la regla general de 60 min', () => {
    expect(horasEfectivasFranja('08:00', '17:00')).toBe(8)
  })
})

describe('caso real documentado: el asesor repartido entre dos sedes', () => {
  // Del comentario de dataOcupacionAsesores: 20h en Sede 2 + 20h en Mall Plaza.
  // Lo que se reparte proporcionalmente son las horas EFECTIVAS, no las brutas.
  it('una jornada 08:00-17:00 aporta 8h efectivas, no 9', () => {
    const jornada = horasEfectivasFranja('08:00', '17:00', 'asesor_servicios')
    expect(jornada).toBe(8)
    expect(jornada * 5).toBe(40)                       // semana de 5 días
    expect(jornada * 5).toBeLessThan(JORNADA_LEGAL_SEMANAL)  // cabe en las 44h
  })
})

describe('JORNADA_LEGAL_SEMANAL', () => {
  it('es el fallback de 44h de la Ley 2101 mientras no haya parámetro en BD', () => {
    expect(JORNADA_LEGAL_SEMANAL).toBe(44)
  })
})

describe('minutosUnion — solapes contados una sola vez', () => {
  it('devuelve 0 sin intervalos', () => {
    expect(minutosUnion([])).toBe(0)
  })

  it('suma intervalos disjuntos', () => {
    // 08:00-10:00 y 14:00-16:00 = 120 + 120
    expect(minutosUnion([{ start: 480, end: 600 }, { start: 840, end: 960 }])).toBe(240)
  })

  it('cuenta una sola vez los intervalos idénticos', () => {
    const sala = { start: 420, end: 780 }   // 07:00-13:00
    expect(minutosUnion([sala, { ...sala }, { ...sala }])).toBe(360)
  })

  it('fusiona intervalos que se solapan parcialmente', () => {
    // 08:00-12:00 + 11:00-15:00 = 08:00-15:00 = 420 min
    expect(minutosUnion([{ start: 480, end: 720 }, { start: 660, end: 900 }])).toBe(420)
  })

  it('fusiona intervalos que se tocan justo en el borde', () => {
    // 08:00-12:00 + 12:00-14:00 = un bloque de 6h
    expect(minutosUnion([{ start: 480, end: 720 }, { start: 720, end: 840 }])).toBe(360)
  })

  it('absorbe un intervalo contenido dentro de otro', () => {
    expect(minutosUnion([{ start: 480, end: 1020 }, { start: 600, end: 660 }])).toBe(540)
  })

  it('no depende del orden de entrada', () => {
    const ivs = [{ start: 840, end: 960 }, { start: 480, end: 600 }, { start: 540, end: 700 }]
    expect(minutosUnion(ivs)).toBe(minutosUnion([...ivs].reverse()))
  })

  it('no muta el array recibido', () => {
    const ivs = [{ start: 840, end: 960 }, { start: 480, end: 600 }]
    const copia = JSON.parse(JSON.stringify(ivs))
    minutosUnion(ivs)
    expect(ivs).toEqual(copia)
  })
})

describe('horasUnionPorDia — la doctora multi-consultorio', () => {
  const salas = (n, dia = 'lunes', hi = '07:00', hf = '13:00') =>
    Array.from({ length: n }, () => ({ weekday: dia, startTime: hi, endTime: hf }))

  it('cubrir 3 salas de 07:00 a 13:00 son 6h presentes, no 18', () => {
    // Es el bug del 257% de utilización: la suma ingenua daba 18h.
    expect(horasUnionPorDia(salas(3), 'oftalmologo')).toBe(5.5)   // 6h − 30 min de almuerzo
    expect(horasUnionPorDia(salas(1), 'oftalmologo')).toBe(5.5)   // idéntico con una sola sala
  })

  it('acumula días distintos por separado', () => {
    const dos = [...salas(2, 'lunes'), ...salas(2, 'martes')]
    expect(horasUnionPorDia(dos, 'oftalmologo')).toBe(11)         // 5,5 + 5,5
  })

  it('aplica el almuerzo al bloque del día, no a cada franja suelta', () => {
    // 07:00-11:00 + 11:00-13:00 = un bloque de 6h → descuenta como un 07:00-13:00
    const partido = [
      { weekday: 'lunes', startTime: '07:00', endTime: '11:00' },
      { weekday: 'lunes', startTime: '11:00', endTime: '13:00' },
    ]
    expect(horasUnionPorDia(partido, 'oftalmologo')).toBe(5.5)
    // por separado ninguna llega a 6h, así que sin agrupar no descontaría nada
    expect(horasEfectivasFranja('07:00', '11:00', 'oftalmologo')
         + horasEfectivasFranja('11:00', '13:00', 'oftalmologo')).toBe(6)
  })

  it('respeta la excepción del técnico sobre el bloque unido', () => {
    expect(horasUnionPorDia(salas(2, 'lunes'), 'tecnico')).toBe(6)      // 07:00-13:00 corrido
    expect(horasUnionPorDia(salas(2, 'lunes'), 'auxiliar')).toBe(5)     // el resto pierde 60 min
  })

  it('ignora franjas nulas o invertidas en lugar de restar tiempo', () => {
    const conBasura = [
      ...salas(1),
      { weekday: 'lunes', startTime: '10:00', endTime: '10:00' },
      { weekday: 'lunes', startTime: '18:00', endTime: '09:00' },
    ]
    expect(horasUnionPorDia(conBasura, 'oftalmologo')).toBe(5.5)
  })

  it('devuelve 0 sin asignaciones', () => {
    expect(horasUnionPorDia([], 'oftalmologo')).toBe(0)
  })
})
