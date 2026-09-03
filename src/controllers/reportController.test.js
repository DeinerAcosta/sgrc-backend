import { describe, it, expect, vi, beforeEach } from 'vitest'

// Prisma simulado: estos tests fijan el comportamiento de la agregación, no el
// de la base de datos. Cada test define qué devuelve cada consulta y comprueba
// los números que salen — que es justo lo que el refactor de la tanda 2 podía
// romper sin que nadie se enterara hasta ver un informe raro en pantalla.
const prismaMock = {
  week: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  room: { count: vi.fn() },
  absence: { findMany: vi.fn() },
}
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }))

const { metricasDeSemanas, dataProductividad } = await import('./reportController.js')

const semana = (id, inicio, fin) => ({
  id,
  startDate: new Date(`${inicio}T00:00:00Z`),
  endDate: new Date(`${fin}T00:00:00Z`),
})

const S1 = semana('s1', '2026-06-01', '2026-06-07')
const S2 = semana('s2', '2026-06-08', '2026-06-14')
const S3 = semana('s3', '2026-06-15', '2026-06-21')

beforeEach(() => {
  for (const modelo of Object.values(prismaMock)) {
    for (const fn of Object.values(modelo)) fn.mockReset()
  }
})

// Reimplementación EXACTA de la lógica anterior (una tanda de 4 consultas por
// semana). Sirve de oráculo: el resultado nuevo tiene que coincidir con el que
// daba el código que había antes del refactor.
function metricasViejas(sem, { asigs, consultoriosBase, absences: ausencias }) {
  const propias = asigs.filter((a) => a.weekId === sem.id)
  const hhmm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
  const pacientes = propias.reduce((acc, a) => acc + (a.patientCapacity ?? 0), 0)
  const progMin = propias.reduce((acc, a) => acc + (hhmm(a.endTime) - hhmm(a.startTime)), 0)
  const ejecMin = propias.reduce((acc, a) => acc + (a.execution ? hhmm(a.endTime) - hhmm(a.startTime) : 0), 0)
  const baseTotal = consultoriosBase * (5 * 720 + 240)
  const solapan = ausencias.filter((au) => au.startDate <= sem.endDate && au.endDate >= sem.startDate)
  return {
    pacientes,
    horas_ejec: Math.round((ejecMin / 60) * 10) / 10,
    ocupacion: baseTotal > 0 ? Math.round((progMin / baseTotal) * 100) : 0,
    absences: solapan.length,
    costo_ausentismo: solapan.reduce((acc, au) => acc + Number(au.opportunityCost ?? 0), 0),
  }
}

describe('metricasDeSemanas — agregación en lote del comparativo', () => {
  const asigs = [
    // S1: 2 franjas de 4h, una ejecutada
    { weekId: 's1', startTime: '08:00', endTime: '12:00', patientCapacity: 16, execution: { id: 'e1' } },
    { weekId: 's1', startTime: '14:00', endTime: '18:00', patientCapacity: 16, execution: null },
    // S2: 1 franja de 9h, ejecutada
    { weekId: 's2', startTime: '08:00', endTime: '17:00', patientCapacity: 34, execution: { id: 'e2' } },
    // S3: sin asignaciones
  ]
  const ausencias = [
    // solapa S1 y S2
    { startDate: new Date('2026-06-05T00:00:00Z'), endDate: new Date('2026-06-10T00:00:00Z'), opportunityCost: '1250.55' },
    // solo S2
    { startDate: new Date('2026-06-09T00:00:00Z'), endDate: new Date('2026-06-09T00:00:00Z'), opportunityCost: '300.20' },
    // solo S2 — sin coste registrado
    { startDate: new Date('2026-06-11T00:00:00Z'), endDate: new Date('2026-06-11T00:00:00Z'), opportunityCost: null },
  ]

  const montar = () => {
    prismaMock.assignment.findMany.mockResolvedValue(asigs)
    prismaMock.room.count.mockResolvedValue(10)   // baseTotal = 38.400 min
    prismaMock.absence.findMany.mockResolvedValue(ausencias)
  }

  it('usa 3 consultas para N semanas, no 4 por semana', async () => {
    montar()
    await metricasDeSemanas([S1, S2, S3])
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.room.count).toHaveBeenCalledTimes(1)
    expect(prismaMock.absence.findMany).toHaveBeenCalledTimes(1)
    // Antes: 3 semanas × 4 consultas = 12. Ahora: 3.
  })

  it('pide las asignaciones de todas las semanas en un solo IN', async () => {
    montar()
    await metricasDeSemanas([S1, S2, S3])
    const where = prismaMock.assignment.findMany.mock.calls[0][0].where
    expect(where.weekId.in.sort()).toEqual(['s1', 's2', 's3'])
  })

  it('acota las ausencias al rango que cubre todas las semanas pedidas', async () => {
    montar()
    await metricasDeSemanas([S1, S2, S3])
    const where = prismaMock.absence.findMany.mock.calls[0][0].where
    expect(where.startDate.lte).toEqual(S3.endDate)   // el fin más tardío
    expect(where.endDate.gte).toEqual(S1.startDate)   // el inicio más temprano
  })

  it('da exactamente los mismos números que la implementación anterior', async () => {
    montar()
    const out = await metricasDeSemanas([S1, S2, S3])
    for (const s of [S1, S2, S3]) {
      expect(out.get(s.id), `semana ${s.id}`)
        .toEqual(metricasViejas(s, { asigs, consultoriosBase: 10, absences: ausencias }))
    }
  })

  it('calcula bien los valores concretos de cada semana', async () => {
    montar()
    const out = await metricasDeSemanas([S1, S2, S3])

    // S1: 8h programadas, 4h ejecutadas, 32 pacientes, 1 ausencia de 1.250,55
    expect(out.get('s1')).toEqual({
      pacientes: 32,
      horas_ejec: 4,
      ocupacion: Math.round((480 / 38400) * 100),
      absences: 1,
      costo_ausentismo: 1250.55,
    })

    // S2: 9h programadas y ejecutadas, 34 pacientes, 3 ausencias
    expect(out.get('s2')).toEqual({
      pacientes: 34,
      horas_ejec: 9,
      ocupacion: Math.round((540 / 38400) * 100),
      absences: 3,
      costo_ausentismo: 1550.75,          // 1250,55 + 300,20 + 0
    })

    // S3: sin actividad
    expect(out.get('s3')).toEqual({
      pacientes: 0, horas_ejec: 0, ocupacion: 0, absences: 0, costo_ausentismo: 0,
    })
  })

  it('suma el dinero sin error de coma flotante', async () => {
    // 0,1 + 0,2 en float da 0.30000000000000004. Las columnas son Decimal(12,2),
    // así que el total tiene que salir exacto igual que el SUM de SQL.
    prismaMock.assignment.findMany.mockResolvedValue([])
    prismaMock.room.count.mockResolvedValue(1)
    prismaMock.absence.findMany.mockResolvedValue([
      { startDate: S1.startDate, endDate: S1.endDate, opportunityCost: '0.10' },
      { startDate: S1.startDate, endDate: S1.endDate, opportunityCost: '0.20' },
    ])
    const out = await metricasDeSemanas([S1])
    expect(out.get('s1').costo_ausentismo).toBe(0.3)
  })

  it('deduplica las semanas repetidas (la A y la B suelen estar en la serie)', async () => {
    montar()
    const out = await metricasDeSemanas([S1, S2, S1, S2, S1])
    expect(out.size).toBe(2)
    const where = prismaMock.assignment.findMany.mock.calls[0][0].where
    expect(where.weekId.in).toHaveLength(2)
  })

  it('devuelve un mapa vacío sin semanas y no toca la base', async () => {
    expect((await metricasDeSemanas([])).size).toBe(0)
    expect((await metricasDeSemanas([null, undefined])).size).toBe(0)
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled()
  })
})

describe('dataProductividad — el filtro de fechas ya no es decorativo', () => {
  const asigs = [
    {
      resourceId: 'r1', startTime: '08:00', endTime: '17:00', patientCapacity: 30,
      resource: { name: 'Dra. Pérez', type: 'oftalmologo' },
      execution: { patientsSeen: 27 },
      room: { site: { name: 'Sede 2' } },
    },
    {
      resourceId: 'r1', startTime: '08:00', endTime: '12:00', patientCapacity: 16,
      resource: { name: 'Dra. Pérez', type: 'oftalmologo' },
      execution: null,
      room: { site: { name: 'Sede 2' } },
    },
  ]

  it('acota por las semanas que solapan desde/hasta', async () => {
    prismaMock.week.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    prismaMock.assignment.findMany.mockResolvedValue(asigs)

    await dataProductividad({ desde: '2026-06-01', hasta: '2026-06-14' })

    // Las semanas se resuelven por solape, no por contención
    const wSemana = prismaMock.week.findMany.mock.calls[0][0].where
    expect(wSemana.startDate.lte).toEqual(new Date('2026-06-14'))
    expect(wSemana.endDate.gte).toEqual(new Date('2026-06-01'))

    // Y la consulta grande va filtrada por esos ids (antes no filtraba nada)
    const wAsig = prismaMock.assignment.findMany.mock.calls[0][0].where
    expect(wAsig.weekId).toEqual({ in: ['s1', 's2'] })
  })

  it('sin rango cae a la ventana por defecto de 12 semanas, no a la tabla entera', async () => {
    prismaMock.week.findMany.mockResolvedValue([{ id: 's1' }])
    prismaMock.assignment.findMany.mockResolvedValue(asigs)

    await dataProductividad({})

    const args = prismaMock.week.findMany.mock.calls[0][0]
    expect(args.take).toBe(12)
    expect(args.orderBy).toEqual({ startDate: 'desc' })
    expect(prismaMock.assignment.findMany.mock.calls[0][0].where.weekId).toEqual({ in: ['s1'] })
  })

  it('devuelve vacío sin consultar asignaciones si no hay semanas en el rango', async () => {
    prismaMock.week.findMany.mockResolvedValue([])
    expect(await dataProductividad({ desde: '2030-01-01', hasta: '2030-01-07' })).toEqual([])
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled()
  })

  it('agrega horas efectivas y cumplimiento por recurso', async () => {
    prismaMock.week.findMany.mockResolvedValue([{ id: 's1' }])
    prismaMock.assignment.findMany.mockResolvedValue(asigs)

    const [fila] = await dataProductividad({})
    expect(fila).toEqual({
      resource: 'Dra. Pérez',
      type: 'oftalmologo',
      site: 'Sede 2',
      h_prog: 12.5,        // 8,5 (9h − 30 min de almuerzo) + 4
      h_ejec: 8.5,         // solo la franja con ejecución
      pac_prog: 46,        // 30 + 16
      pac_at: 27,
      pct_cumplimiento: Math.round((27 / 46) * 100),
    })
  })
})
