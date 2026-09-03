import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = {
  assignment: { findMany: vi.fn(), createMany: vi.fn() },
  resource: { findMany: vi.fn() },
  room: { findMany: vi.fn() },
  weekSiteClosure: { findMany: vi.fn() },
}
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }))

const { copiarAsignacionesValidadas } = await import('./assignmentCopyService.js')

const SEM = 'sem-destino'

const CONSULTORIOS = [
  { id: 'c1', name: 'Consultorio 1', siteId: 'sedeA', specialty: 'oftalmologia', requiresAssistant: false, site: { name: 'Sede 2', city: 'Barranquilla' } },
  { id: 'c2', name: 'Consultorio 2', siteId: 'sedeB', specialty: 'oftalmologia', requiresAssistant: false, site: { name: 'Mall Plaza', city: 'Barranquilla' } },
]

const RECURSOS = [
  { id: 'dra', name: 'Dra. Pérez', active: true, type: 'oftalmologo', multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: null, slotMinutes: 15 },
  { id: 'aux', name: 'Ana Aux', active: true, type: 'auxiliar', multiRoom: false, maxHoursPerDay: 10, maxHoursPerWeek: 44, slotMinutes: 15 },
]

const candidata = (over = {}) => ({
  weekId: SEM,
  weekday: 'lunes',
  roomId: 'c1',
  resourceId: 'dra',
  assistantId: null,
  assistant2Id: null,
  startTime: '08:00',
  endTime: '12:00',
  ...over,
})

/** Configura el mock: `existentes` son las asignaciones ya presentes en la semana. */
function montar({ existentes = [], closures: cierres = [] } = {}) {
  prismaMock.assignment.findMany.mockResolvedValue(existentes)
  prismaMock.resource.findMany.mockResolvedValue(RECURSOS)
  prismaMock.room.findMany.mockResolvedValue(CONSULTORIOS)
  prismaMock.weekSiteClosure.findMany.mockResolvedValue(cierres)
  prismaMock.assignment.createMany.mockResolvedValue({ count: 0 })
}

beforeEach(() => {
  for (const modelo of Object.values(prismaMock)) {
    for (const fn of Object.values(modelo)) fn.mockReset()
  }
})

describe('copiarAsignacionesValidadas — el caso que motivó el cambio', () => {
  it('AVISA en vez de crear el solape cuando el profesional ya está asignado', () => {
    // Copiar una semana con alcance de sede cancela solo las asignaciones de ESA
    // sede. Si la doctora ya tenía horario esa semana en otra sede, la copia le
    // encimaba una segunda consulta a la misma hora, sin decir nada.
    montar({
      existentes: [{
        weekId: SEM, weekday: 'lunes', roomId: 'c2',
        resourceId: 'dra', assistantId: null, assistant2Id: null,
        startTime: '09:00', endTime: '13:00',
        assistantStartTime: null, assistantEndTime: null,
        assistant2StartTime: null, assistant2EndTime: null,
      }],
    })

    return copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] }).then((r) => {
      expect(r.copied).toBe(0)
      expect(r.skipped).toBe(1)
      expect(r.errors[0].reason).toBe('recurso_ocupado')
      expect(r.errors[0].resource).toBe('Dra. Pérez')
      expect(r.errors[0].room).toBe('Consultorio 1')
      expect(r.errors[0].day).toBe('lunes')
      expect(r.errors[0].message).toContain('Consultorio 2')
      // Y sobre todo: NO se insertó nada
      expect(prismaMock.assignment.createMany).not.toHaveBeenCalled()
    })
  })

  it('copia lo que sí cabe y omite solo lo que choca', async () => {
    montar({
      existentes: [{
        weekId: SEM, weekday: 'lunes', roomId: 'c2',
        resourceId: 'dra', assistantId: null, assistant2Id: null,
        startTime: '09:00', endTime: '13:00',
        assistantStartTime: null, assistantEndTime: null,
        assistant2StartTime: null, assistant2EndTime: null,
      }],
    })

    const r = await copiarAsignacionesValidadas(
      [candidata({ weekday: 'lunes' }), candidata({ weekday: 'martes' }), candidata({ weekday: 'miercoles' })],
      { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] },
    )

    expect(r.copied).toBe(2)      // martes y miércoles
    expect(r.skipped).toBe(1)      // lunes choca
    const insertadas = prismaMock.assignment.createMany.mock.calls[0][0].data
    expect(insertadas.map((a) => a.weekday).sort()).toEqual(['martes', 'miercoles'])
  })
})

describe('coste en consultas', () => {
  it('usa un número fijo de consultas, no una por asignación', async () => {
    montar()
    const muchas = Array.from({ length: 30 }, (_, i) =>
      candidata({ weekday: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'][i % 5], startTime: `0${(i % 5) + 6}:00`, endTime: `0${(i % 5) + 7}:00` })
    )

    await copiarAsignacionesValidadas(muchas, { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })

    // 2 findMany de asignaciones (ids + estado) + recurso + consultorio + cierres
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.resource.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.room.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.weekSiteClosure.findMany).toHaveBeenCalledTimes(1)
    // Y UN solo insert para todas
    expect(prismaMock.assignment.createMany).toHaveBeenCalledTimes(1)
    // Antes: 30 transacciones × ~12 consultas = ~360 idas y vueltas.
  })

  it('no toca la base con un lote vacío', async () => {
    montar()
    const r = await copiarAsignacionesValidadas([], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(r).toEqual({ copied: 0, skipped: 0, errors: [], created: [] })
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled()
  })

  it('no llama a createMany si no pasó ninguna', async () => {
    montar({ closures: [{ weekId: SEM, siteId: 'sedeA' }] })
    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(r.copied).toBe(0)
    expect(prismaMock.assignment.createMany).not.toHaveBeenCalled()
  })
})

describe('permisos de sede cerrada', () => {
  it('el coordinador no puede copiar a una sede con el cierre procesado', async () => {
    montar({ closures: [{ weekId: SEM, siteId: 'sedeA' }] })
    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(r.errors[0].reason).toBe('sede_cerrada')
  })

  it('supervisor y gerencia sí pueden', async () => {
    for (const rol of ['supervisor', 'gerencia']) {
      montar({ closures: [{ weekId: SEM, siteId: 'sedeA' }] })
      const r = await copiarAsignacionesValidadas([candidata()], { userRol: rol, userSedes: ['sedeA', 'sedeB'] })
      expect(r.copied, `rol ${rol}`).toBe(1)
    }
  })

  it('con PROGRAMACION_LIBRE el coordinador también puede (modo temporal)', async () => {
    vi.stubEnv('PROGRAMACION_LIBRE', 'true')
    montar({ closures: [{ weekId: SEM, siteId: 'sedeA' }] })
    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(r.copied).toBe(1)
    vi.unstubAllEnvs()
  })

  it('PROGRAMACION_LIBRE levanta el calendario, NO los solapes', async () => {
    // Es la garantía importante del modo: se puede escribir en semanas vencidas
    // y sedes cerradas, pero nadie acaba con dos consultas a la misma hora.
    vi.stubEnv('PROGRAMACION_LIBRE', 'true')
    montar({
      closures: [{ weekId: SEM, siteId: 'sedeA' }],
      existentes: [{
        weekId: SEM, weekday: 'lunes', roomId: 'c2',
        resourceId: 'dra', assistantId: null, assistant2Id: null,
        startTime: '09:00', endTime: '13:00',
        assistantStartTime: null, assistantEndTime: null,
        assistant2StartTime: null, assistant2EndTime: null,
      }],
    })

    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })

    expect(r.copied).toBe(0)
    expect(r.errors[0].reason).toBe('recurso_ocupado')   // el solape SIGUE bloqueando
    vi.unstubAllEnvs()
  })
})

describe('campos que se guardan', () => {
  it('calcula la capacidad de pacientes si el origen no la traía', async () => {
    montar()
    await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    const fila = prismaMock.assignment.createMany.mock.calls[0][0].data[0]
    // 08:00-12:00 = 240 min, sin almuerzo (<6h), intervalo 15 → 16
    expect(fila.patientCapacity).toBe(16)
  })

  it('respeta la capacidad del origen si venía informada', async () => {
    montar()
    await copiarAsignacionesValidadas([candidata({ patientCapacity: 9 })], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(prismaMock.assignment.createMany.mock.calls[0][0].data[0].patientCapacity).toBe(9)
  })

  it('arrastra los sub-horarios de las auxiliares', async () => {
    montar()
    await copiarAsignacionesValidadas([candidata({
      assistantId: 'aux', assistantStartTime: '08:00', assistantEndTime: '10:00',
    })], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    const fila = prismaMock.assignment.createMany.mock.calls[0][0].data[0]
    expect(fila.assistantId).toBe('aux')
    expect(fila.assistantStartTime).toBe('08:00')
    expect(fila.assistantEndTime).toBe('10:00')
  })

  it('marca las horas nocturnas', async () => {
    montar()
    await copiarAsignacionesValidadas([candidata({ startTime: '14:00', endTime: '19:00' })], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] })
    expect(prismaMock.assignment.createMany.mock.calls[0][0].data[0].hasNightHours).toBe(true)
  })

  it('marca horas extras según lo que el recurso ya lleva esa semana', async () => {
    // La aux ya tiene 40h efectivas en la semana (5 días × 8h netas).
    const previas = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].map((d) => ({
      weekId: SEM, weekday: d, roomId: 'c2',
      resourceId: 'aux', assistantId: null, assistant2Id: null,
      startTime: '08:00', endTime: '17:00',   // 9h brutas − 60 min = 8h efectivas
      assistantStartTime: null, assistantEndTime: null,
      assistant2StartTime: null, assistant2EndTime: null,
    }))
    montar({ existentes: previas })

    const r = await copiarAsignacionesValidadas(
      [candidata({ resourceId: 'aux', weekday: 'sabado', startTime: '08:00', endTime: '13:00' })],
      { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'] },
    )

    expect(r.copied).toBe(1)
    // 40h previas + 5h nuevas = 45h > 44h de tope → marcada, pero NO bloqueada
    expect(prismaMock.assignment.createMany.mock.calls[0][0].data[0].isOvertime).toBe(true)
  })
})

describe('uso dentro de una transacción', () => {
  it('usa el cliente que se le pase en lugar del global', async () => {
    const tx = {
      assignment: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      resource: { findMany: vi.fn().mockResolvedValue(RECURSOS) },
      room: { findMany: vi.fn().mockResolvedValue(CONSULTORIOS) },
      weekSiteClosure: { findMany: vi.fn().mockResolvedValue([]) },
    }

    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: ['sedeA', 'sedeB'], client: tx })

    expect(r.copied).toBe(1)
    expect(tx.assignment.createMany).toHaveBeenCalled()
    expect(prismaMock.assignment.createMany).not.toHaveBeenCalled()
  })
})

describe('aislamiento por sede (S-1)', () => {
  it('el coordinador NO copia hacia una sede que no es suya', async () => {
    // c2 pertenece a sedeB. Antes esto entraba sin más.
    montar()
    const r = await copiarAsignacionesValidadas(
      [candidata({ roomId: 'c2' })],
      { userRol: 'coordinador', userSedes: ['sedeA'] },
    )
    expect(r.copied).toBe(0)
    expect(r.errors[0].reason).toBe('fuera_de_mi_sede')
    expect(r.errors[0].message).toContain('Mall Plaza')
    expect(prismaMock.assignment.createMany).not.toHaveBeenCalled()
  })

  it('copia lo de su sede y descarta lo ajeno en el mismo lote', async () => {
    montar()
    const r = await copiarAsignacionesValidadas(
      [candidata({ roomId: 'c1' }), candidata({ roomId: 'c2', weekday: 'martes' })],
      { userRol: 'coordinador', userSedes: ['sedeA'] },
    )
    expect(r.copied).toBe(1)
    expect(r.skipped).toBe(1)
    expect(prismaMock.assignment.createMany.mock.calls[0][0].data[0].roomId).toBe('c1')
  })

  it('supervisor y gerencia copian a cualquier sede', async () => {
    for (const rol of ['supervisor', 'gerencia']) {
      montar()
      const r = await copiarAsignacionesValidadas(
        [candidata({ roomId: 'c2' })],
        { userRol: rol, userSedes: [] },
      )
      expect(r.copied, `rol ${rol}`).toBe(1)
    }
  })

  it('un coordinador sin sedes vinculadas no copia nada', async () => {
    // Es el efecto que hay que vigilar al activar esto: si usuarios_sedes está
    // incompleto, el coordinador se queda bloqueado. De ahí el script
    // `npm run revisar:sedes`.
    montar()
    const r = await copiarAsignacionesValidadas([candidata()], { userRol: 'coordinador', userSedes: [] })
    expect(r.copied).toBe(0)
    expect(r.errors[0].reason).toBe('fuera_de_mi_sede')
  })

  it('PROGRAMACION_LIBRE NO exime del aislamiento por sede', async () => {
    // El modo temporal levanta el CALENDARIO, no los permisos.
    vi.stubEnv('PROGRAMACION_LIBRE', 'true')
    montar()
    const r = await copiarAsignacionesValidadas(
      [candidata({ roomId: 'c2' })],
      { userRol: 'coordinador', userSedes: ['sedeA'] },
    )
    expect(r.copied).toBe(0)
    expect(r.errors[0].reason).toBe('fuera_de_mi_sede')
    vi.unstubAllEnvs()
  })
})
