import { describe, it, expect } from 'vitest'
import { validarLote, crearValidadorLote, MOTIVOS } from './batchValidationService.js'

// ---------------------------------------------------------------------------
// Escenario base: dos sedes en ciudades distintas, tres consultorios.
// ---------------------------------------------------------------------------
const SEMANA = 'sem-1'

const consultorios = new Map([
  ['c1', { id: 'c1', name: 'Consultorio 1', siteId: 'sedeA', specialty: 'oftalmologia', requiresAssistant: true,  site: { name: 'Sede 2', city: 'Barranquilla' } }],
  ['c2', { id: 'c2', name: 'Consultorio 2', siteId: 'sedeA', specialty: 'oftalmologia', requiresAssistant: true,  site: { name: 'Sede 2', city: 'Barranquilla' } }],
  ['c3', { id: 'c3', name: 'Consultorio 3', siteId: 'sedeB', specialty: 'optometria',   requiresAssistant: false, site: { name: 'Riohacha',city: 'Riohacha' } }],
])

const recursos = new Map([
  ['dra',   { id: 'dra',   name: 'Dra. Pérez',  active: true, type: 'oftalmologo',      multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: null, slotMinutes: 15 }],
  ['multi', { id: 'multi', name: 'Dra. Gómez',  active: true, type: 'oftalmologo',      multiRoom: true,  maxHoursPerDay: 10, maxHoursPerWeek: null, slotMinutes: 15 }],
  ['aux1',  { id: 'aux1',  name: 'Ana Aux',     active: true, type: 'auxiliar',         multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: 44,   slotMinutes: 15 }],
  ['aux2',  { id: 'aux2',  name: 'Beto Aux',    active: true, type: 'auxiliar',         multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: 44,   slotMinutes: 15 }],
  ['asesor',{ id: 'asesor',name: 'Cinthia',     active: true, type: 'asesor_servicios', multiRoom: false, maxHoursPerDay: 8,  maxHoursPerWeek: 44,   slotMinutes: 15 }],
  ['baja',  { id: 'baja',  name: 'Ex Empleado', active: false,type: 'auxiliar',         multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: 44,   slotMinutes: 15 }],
])

const asig = (over = {}) => ({
  weekId: SEMANA,
  weekday: 'lunes',
  roomId: 'c1',
  resourceId: 'dra',
  assistantId: null,
  assistant2Id: null,
  assistantStartTime: null,
  assistantEndTime: null,
  assistant2StartTime: null,
  assistant2EndTime: null,
  startTime: '08:00',
  endTime: '12:00',
  ...over,
})

const estado = (over = {}) => ({
  assignments: [],
  resources: recursos,
  rooms: consultorios,
  sedesCerradas: new Set(),
  puedeEditarCerrada: false,
  ...over,
})

// ---------------------------------------------------------------------------

describe('RN-08 · el recurso ya está ocupado en esa franja', () => {
  it('OMITE la copia si el profesional ya está asignado a esa hora', () => {
    // Es el caso que motivó todo esto: copiar una semana cuando la doctora ya
    // tenía horario ese día en otra sede creaba dos consultas a la misma hora.
    const existente = asig({ roomId: 'c2', startTime: '09:00', endTime: '13:00' })
    const { aceptadas, skipped: omitidas } = validarLote([asig()], estado({ assignments: [existente] }))

    expect(aceptadas).toHaveLength(0)
    expect(omitidas).toHaveLength(1)
    expect(omitidas[0].reason).toBe(MOTIVOS.RECURSO_OCUPADO)
    expect(omitidas[0].message).toContain('Dra. Pérez')
    expect(omitidas[0].message).toContain('Consultorio 2')
    expect(omitidas[0].message).toContain('09:00')
  })

  it('ACEPTA si las franjas solo se tocan en el borde', () => {
    const existente = asig({ roomId: 'c2', startTime: '12:00', endTime: '16:00' })
    const { aceptadas, skipped: omitidas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(aceptadas).toHaveLength(1)
    expect(omitidas).toHaveLength(0)
  })

  it('ACEPTA si la ocupación es en OTRO día', () => {
    const existente = asig({ weekday: 'martes', roomId: 'c2' })
    const { aceptadas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(aceptadas).toHaveLength(1)
  })

  it('ACEPTA si la ocupación es en otra SEMANA', () => {
    const existente = asig({ weekId: 'sem-2', roomId: 'c2' })
    const { aceptadas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(aceptadas).toHaveLength(1)
  })

  it('detecta también cuando el profesional figura como AUXILIAR en la otra', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi', assistantId: 'dra' })
    const { skipped: omitidas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(omitidas[0].reason).toBe(MOTIVOS.RECURSO_OCUPADO)
  })

  it('un médico multi-consultorio SÍ puede cubrir varias salas a la vez', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi' })
    const { aceptadas } = validarLote(
      [asig({ resourceId: 'multi' })],
      estado({ assignments: [existente] })
    )
    expect(aceptadas).toHaveLength(1)
  })
})

describe('validación incremental dentro del propio lote', () => {
  it('copiar dos veces la misma franja acepta una y omite la otra', () => {
    // Sin validar de forma incremental, ninguna choca con lo que HABÍA y las
    // dos entrarían, dejando el solape creado por la propia copia.
    const { aceptadas, skipped: omitidas } = validarLote([asig(), asig({ roomId: 'c2' })], estado())
    expect(aceptadas).toHaveLength(1)
    expect(omitidas).toHaveLength(1)
    expect(omitidas[0].reason).toBe(MOTIVOS.RECURSO_OCUPADO)
  })

  it('copiar la misma asignación a cinco días distintos las acepta todas', () => {
    const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']
    const { aceptadas, skipped: omitidas } = validarLote(dias.map((d) => asig({ weekday: d })), estado())
    expect(aceptadas).toHaveLength(5)
    expect(omitidas).toHaveLength(0)
  })

  it('respeta el orden: la primera candidata gana', () => {
    const a = asig({ roomId: 'c1' })
    const b = asig({ roomId: 'c2' })
    const { aceptadas } = validarLote([a, b], estado())
    expect(aceptadas[0].roomId).toBe('c1')
  })
})

describe('RN-09 · una sola ciudad por día', () => {
  it('OMITE si el profesional ya trabaja ese día en otra ciudad', () => {
    const existente = asig({ roomId: 'c3', startTime: '14:00', endTime: '18:00' })
    const { skipped: omitidas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(omitidas[0].reason).toBe(MOTIVOS.DOS_CIUDADES)
    expect(omitidas[0].message).toContain('Riohacha')
    expect(omitidas[0].message).toContain('Barranquilla')
  })

  it('ACEPTA dos consultorios de la MISMA ciudad en franjas distintas', () => {
    const existente = asig({ roomId: 'c2', startTime: '14:00', endTime: '18:00' })
    const { aceptadas } = validarLote([asig()], estado({ assignments: [existente] }))
    expect(aceptadas).toHaveLength(1)
  })
})

describe('RN-08 · auxiliares', () => {
  it('OMITE si la auxiliar ya está ocupada a esa hora', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi', assistantId: 'aux1' })
    const { skipped: omitidas } = validarLote([asig({ assistantId: 'aux1' })], estado({ assignments: [existente] }))
    expect(omitidas[0].reason).toBe(MOTIVOS.AUXILIAR_OCUPADO)
    expect(omitidas[0].message).toContain('Ana Aux')
  })

  it('respeta los sub-horarios: 07-09 y 09-15 no chocan', () => {
    // Sin mirar el sub-horario se comparaba contra el horario del doctor y
    // salían conflictos inexistentes.
    const existente = asig({
      roomId: 'c2', resourceId: 'multi',
      startTime: '07:00', endTime: '15:00',
      assistantId: 'aux1', assistantStartTime: '07:00', assistantEndTime: '09:00',
    })
    const candidata = asig({
      startTime: '07:00', endTime: '15:00',
      assistantId: 'aux1', assistantStartTime: '09:00', assistantEndTime: '15:00',
      resourceId: 'dra',
    })
    const { skipped: omitidas } = validarLote([candidata], estado({ assignments: [existente] }))
    // La aux no choca; si algo falla será por la doctora, no por ella
    expect(omitidas.map((o) => o.reason)).not.toContain(MOTIVOS.AUXILIAR_OCUPADO)
  })

  it('la misma aux SÍ puede asistir al mismo doctor multi-consultorio en dos salas', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi', assistantId: 'aux1' })
    const { aceptadas } = validarLote(
      [asig({ resourceId: 'multi', assistantId: 'aux1' })],
      estado({ assignments: [existente] })
    )
    expect(aceptadas).toHaveLength(1)
  })

  it('detecta el conflicto del segundo auxiliar', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi', assistantId: 'aux2' })
    const { skipped: omitidas } = validarLote(
      [asig({ assistantId: 'aux1', assistant2Id: 'aux2' })],
      estado({ assignments: [existente] })
    )
    expect(omitidas[0].reason).toBe(MOTIVOS.AUXILIAR_OCUPADO)
    expect(omitidas[0].message).toContain('#2')
  })

  it('no exige auxiliar libre si el consultorio no la requiere', () => {
    const existente = asig({ roomId: 'c2', resourceId: 'multi', assistantId: 'aux1' })
    const candidata = asig({ roomId: 'c3', resourceId: 'asesor', assistantId: 'aux1' })
    const { skipped: omitidas } = validarLote([candidata], estado({ assignments: [existente] }))
    // c3 tiene requiereAuxiliar:false → no se comprueba el conflicto de aux1
    expect(omitidas.map((o) => o.reason)).not.toContain(MOTIVOS.AUXILIAR_OCUPADO)
  })
})

describe('RN-13 · tope diario', () => {
  it('OMITE si la copia supera el tope diario del recurso', () => {
    // asesor: tope 8h. Ya tiene 08:00-14:00 (6h brutas − 60 min almuerzo = 5h).
    // La copia añade 14:00-18:00 (4h) → 9h > 8h.
    const existente = asig({ roomId: 'c3', resourceId: 'asesor', startTime: '08:00', endTime: '14:00' })
    const candidata = asig({ roomId: 'c3', resourceId: 'asesor', startTime: '14:00', endTime: '18:00' })
    const { skipped: omitidas } = validarLote([candidata], estado({ assignments: [existente] }))
    expect(omitidas[0].reason).toBe(MOTIVOS.TOPE_DIARIO)
    expect(omitidas[0].message).toContain('8h')
  })

  it('los rotativos no tienen tope diario', () => {
    // oftalmólogo: turnos partidos largos permitidos
    const existente = asig({ roomId: 'c2', resourceId: 'multi', startTime: '07:00', endTime: '13:00' })
    const candidata = asig({ resourceId: 'multi', startTime: '13:00', endTime: '19:00' })
    const { aceptadas } = validarLote([candidata], estado({ assignments: [existente] }))
    expect(aceptadas).toHaveLength(1)
  })
})

describe('sede con el cierre semanal procesado', () => {
  it('OMITE para un coordinador', () => {
    const { skipped: omitidas } = validarLote(
      [asig()],
      estado({ sedesCerradas: new Set([`${SEMANA}|sedeA`]) })
    )
    expect(omitidas[0].reason).toBe(MOTIVOS.SEDE_CERRADA)
    expect(omitidas[0].message).toContain('Sede 2')
  })

  it('ACEPTA para supervisor/gerencia', () => {
    const { aceptadas } = validarLote(
      [asig()],
      estado({ sedesCerradas: new Set([`${SEMANA}|sedeA`]), puedeEditarCerrada: true })
    )
    expect(aceptadas).toHaveLength(1)
  })

  it('el cierre de una sede no bloquea otra', () => {
    const { aceptadas } = validarLote(
      [asig()],
      estado({ sedesCerradas: new Set([`${SEMANA}|sedeB`]) })
    )
    expect(aceptadas).toHaveLength(1)
  })
})

describe('entidades que ya no valen', () => {
  it('OMITE si el recurso está inactivo', () => {
    const { skipped: omitidas } = validarLote([asig({ resourceId: 'baja' })], estado())
    expect(omitidas[0].reason).toBe(MOTIVOS.RECURSO_INVALIDO)
    expect(omitidas[0].message).toContain('inactivo')
  })

  it('OMITE si el recurso ya no existe', () => {
    const { skipped: omitidas } = validarLote([asig({ resourceId: 'fantasma' })], estado())
    expect(omitidas[0].reason).toBe(MOTIVOS.RECURSO_INVALIDO)
  })

  it('OMITE si el consultorio ya no existe', () => {
    const { skipped: omitidas } = validarLote([asig({ roomId: 'fantasma' })], estado())
    expect(omitidas[0].reason).toBe(MOTIVOS.CONSULTORIO_INVALIDO)
  })

  it('OMITE una franja invertida o nula', () => {
    const { skipped: omitidas } = validarLote([asig({ startTime: '12:00', endTime: '08:00' })], estado())
    expect(omitidas[0].reason).toBe(MOTIVOS.FRANJA_INVALIDA)
  })
})

describe('campos derivados', () => {
  it('marca las horas nocturnas', () => {
    const { aceptadas } = validarLote([asig({ startTime: '14:00', endTime: '19:00' })], estado())
    expect(aceptadas[0].hasNightHours).toBe(true)
  })

  it('no marca nocturnas una franja que acaba a las 18:00', () => {
    const { aceptadas } = validarLote([asig({ startTime: '14:00', endTime: '18:00' })], estado())
    expect(aceptadas[0].hasNightHours).toBe(false)
  })

  it('marca horas extras al superar el tope semanal', () => {
    const c = asig({ resourceId: 'aux1', startTime: '08:00', endTime: '12:00', _horasSemanaPrevias: 42 })
    const { aceptadas } = validarLote([c], estado())
    expect(aceptadas[0].isOvertime).toBe(true)   // 42 + 4 = 46 > 44
  })

  it('no marca horas extras a quien no tiene tope semanal', () => {
    const c = asig({ resourceId: 'dra', _horasSemanaPrevias: 200 })
    const { aceptadas } = validarLote([c], estado())
    expect(aceptadas[0].isOvertime).toBe(false)
  })

  it('las horas extras NO bloquean, solo marcan', () => {
    const c = asig({ resourceId: 'aux1', _horasSemanaPrevias: 100 })
    const { aceptadas, skipped: omitidas } = validarLote([c], estado())
    expect(omitidas).toHaveLength(0)
    expect(aceptadas[0].isOvertime).toBe(true)
  })
})

describe('lote vacío y uso directo del validador', () => {
  it('un lote vacío no rompe nada', () => {
    expect(validarLote([], estado())).toEqual({ aceptadas: [], skipped: [] })
  })

  it('validar() no modifica el estado hasta que se llama a aceptar()', () => {
    const v = crearValidadorLote(estado())
    const c = asig()
    expect(v.validar(c).ok).toBe(true)
    expect(v.validar(c).ok).toBe(true)   // sigue libre: no se aceptó
    v.aceptar(c)
    expect(v.validar(asig({ roomId: 'c2' })).ok).toBe(false)
  })
})

describe('aislamiento por sede en el lote (S-1)', () => {
  const soloSedeA = new Set(['sedeA'])

  it('OMITE lo que cae en una sede que no es del coordinador', () => {
    // c3 pertenece a sedeB. Sin esto, un coordinador podía copiar el día de
    // otra sede — o el de TODAS, dejando el filtro de sede vacío.
    const { aceptadas, skipped: omitidas } = validarLote(
      [asig({ roomId: 'c3', resourceId: 'asesor' })],
      estado({ sedesPermitidas: soloSedeA }),
    )
    expect(aceptadas).toHaveLength(0)
    expect(omitidas[0].reason).toBe(MOTIVOS.FUERA_DE_MI_SEDE)
    expect(omitidas[0].message).toContain('Riohacha')
  })

  it('ACEPTA lo que cae en su propia sede', () => {
    const { aceptadas } = validarLote([asig()], estado({ sedesPermitidas: soloSedeA }))
    expect(aceptadas).toHaveLength(1)
  })

  it('separa el lote: copia lo suyo y descarta lo ajeno', () => {
    const { aceptadas, skipped: omitidas } = validarLote(
      [asig(), asig({ roomId: 'c3', resourceId: 'asesor', weekday: 'martes' })],
      estado({ sedesPermitidas: soloSedeA }),
    )
    expect(aceptadas).toHaveLength(1)
    expect(aceptadas[0].roomId).toBe('c1')
    expect(omitidas[0].reason).toBe(MOTIVOS.FUERA_DE_MI_SEDE)
  })

  it('sin restricción (supervisor/gerencia) pasa todo', () => {
    const { aceptadas } = validarLote(
      [asig(), asig({ roomId: 'c3', resourceId: 'asesor', weekday: 'martes' })],
      estado({ sedesPermitidas: null }),
    )
    expect(aceptadas).toHaveLength(2)
  })

  it('un coordinador sin sedes vinculadas no copia nada', () => {
    const { aceptadas, skipped: omitidas } = validarLote([asig()], estado({ sedesPermitidas: new Set() }))
    expect(aceptadas).toHaveLength(0)
    expect(omitidas[0].reason).toBe(MOTIVOS.FUERA_DE_MI_SEDE)
  })

  it('se comprueba ANTES que el cierre: el motivo que se reporta es el de sede', () => {
    // Si la sede ni siquiera es suya, "está cerrada" sería un mensaje confuso.
    const { skipped: omitidas } = validarLote(
      [asig({ roomId: 'c3', resourceId: 'asesor' })],
      estado({ sedesPermitidas: soloSedeA, sedesCerradas: new Set([`${SEMANA}|sedeB`]) }),
    )
    expect(omitidas[0].reason).toBe(MOTIVOS.FUERA_DE_MI_SEDE)
  })
})
