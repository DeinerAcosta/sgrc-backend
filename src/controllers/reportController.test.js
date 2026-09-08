import { describe, it, expect, vi, beforeEach } from 'vitest'

// Prisma simulado: estos tests fijan el comportamiento de la agregación, no el
// de la base de datos. Cada test define qué devuelve cada consulta y comprueba
// los números que salen — que es justo lo que el refactor de la tanda 2 podía
// romper sin que nadie se enterara hasta ver un informe raro en pantalla.
const prismaMock = {
  week: { findMany: vi.fn(), findUnique: vi.fn() },
  assignment: { findMany: vi.fn() },
  room: { count: vi.fn() },
  absence: { findMany: vi.fn() },
  // PROYECTOS-3255 #1.1: cargarFestivosDelRango → prisma.holiday.findMany
  holiday: { findMany: vi.fn() },
  // PROYECTOS-3255 #3.1: dataProductividad parte de recursos activos
  resource: { findMany: vi.fn() },
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
    // Sin festivos: base por semana = base teorica (mantiene compat historica)
    prismaMock.holiday.findMany.mockResolvedValue([])
  }

  it('usa 4 consultas para N semanas, no 4 por semana', async () => {
    montar()
    await metricasDeSemanas([S1, S2, S3])
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.room.count).toHaveBeenCalledTimes(1)
    expect(prismaMock.absence.findMany).toHaveBeenCalledTimes(1)
    // PROYECTOS-3255 #1.1: una consulta extra por los festivos del rango
    expect(prismaMock.holiday.findMany).toHaveBeenCalledTimes(1)
    // Antes: 3 semanas × 4 consultas = 12. Ahora: 4.
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
    prismaMock.holiday.findMany.mockResolvedValue([])   // sin festivos
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

describe('dataProductividad — filtros, left-join a recursos activos y promedios', () => {
  // Asigs de la unica doctora con actividad (Dra. Perez, r1). weekId presente
  // para que el aggregador cuente semanasActivas correctamente (PROYECTOS-3255 #3.3).
  const asigs = [
    {
      resourceId: 'r1', weekId: 's1', startTime: '08:00', endTime: '17:00', patientCapacity: 30,
      resource: { type: 'oftalmologo' },
      execution: { patientsSeen: 27 },
      room: { siteId: 'st2', site: { name: 'Sede 2' } },
    },
    {
      resourceId: 'r1', weekId: 's1', startTime: '08:00', endTime: '12:00', patientCapacity: 16,
      resource: { type: 'oftalmologo' },
      execution: null,
      room: { siteId: 'st2', site: { name: 'Sede 2' } },
    },
  ]
  // PROYECTOS-3255 #3.1: dos recursos activos — solo r1 tiene asignaciones.
  // r2 debe aparecer con 0h y pct_cumplimiento null.
  const recursosActivos = [
    { id: 'r1', name: 'Dra. Pérez', type: 'oftalmologo' },
    { id: 'r2', name: 'Dr. Zuluaga', type: 'oftalmologo' },
  ]

  const montarBase = () => {
    prismaMock.assignment.findMany.mockResolvedValue(asigs)
    prismaMock.resource.findMany.mockResolvedValue(recursosActivos)
    prismaMock.holiday.findMany.mockResolvedValue([])
    // PROYECTOS-3255 #1.3: dataProductividad carga ausencias medicas cuando hay
    // desde/hasta. Sin ausencias, el flag dias_incapacidad queda en 0.
    prismaMock.absence.findMany.mockResolvedValue([])
  }

  it('acota por las semanas que solapan desde/hasta', async () => {
    prismaMock.week.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    montarBase()

    await dataProductividad({ desde: '2026-06-01', hasta: '2026-06-14' })

    // Las semanas se resuelven por solape, no por contención
    const wSemana = prismaMock.week.findMany.mock.calls[0][0].where
    expect(wSemana.startDate.lte).toEqual(new Date('2026-06-14'))
    expect(wSemana.endDate.gte).toEqual(new Date('2026-06-01'))

    // La consulta grande va filtrada por esos ids (antes no filtraba nada)
    const wAsig = prismaMock.assignment.findMany.mock.calls[0][0].where
    expect(wAsig.weekId).toEqual({ in: ['s1', 's2'] })
  })

  it('sin rango cae a la ventana por defecto de 12 semanas, no a la tabla entera', async () => {
    // Mismo mock para las 2 llamadas a week.findMany: (a) semanaIdsEnRango y
    // (b) la segunda por id para calcular nMeses (necesita startDate/endDate).
    prismaMock.week.findMany.mockResolvedValue([{
      id: 's1',
      startDate: new Date('2026-06-01T00:00:00Z'),
      endDate: new Date('2026-06-07T00:00:00Z'),
    }])
    montarBase()

    await dataProductividad({})

    const args = prismaMock.week.findMany.mock.calls[0][0]
    expect(args.take).toBe(12)
    expect(args.orderBy).toEqual({ startDate: 'desc' })
    expect(prismaMock.assignment.findMany.mock.calls[0][0].where.weekId).toEqual({ in: ['s1'] })
  })

  it('PROYECTOS-3255 #3.1 — incluye TODOS los recursos activos aunque no haya semanas en el rango', async () => {
    // Rango fuera del historico → semanaIds = []
    prismaMock.week.findMany.mockResolvedValue([])
    prismaMock.resource.findMany.mockResolvedValue(recursosActivos)
    prismaMock.holiday.findMany.mockResolvedValue([])
    prismaMock.assignment.findMany.mockResolvedValue([])
    prismaMock.absence.findMany.mockResolvedValue([])

    const filas = await dataProductividad({ desde: '2030-01-01', hasta: '2030-01-07' })
    // Antes: [] — ahora devuelve las 2 filas de recursos activos con 0h
    expect(filas).toHaveLength(2)
    for (const f of filas) {
      expect(f.h_prog).toBe(0)
      expect(f.h_ejec).toBe(0)
      expect(f.pac_prog).toBe(0)
      expect(f.pac_at).toBe(0)
      expect(f.pct_cumplimiento).toBeNull()   // sin actividad → null, no 0
    }
    // La consulta de asignaciones NO se dispara sin semanas en el rango (thunk vacio)
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(0)
  })

  it('PROYECTOS-3255 #3.1 — agrega horas efectivas y cumplimiento; incluye recursos sin asignaciones al final', async () => {
    prismaMock.week.findMany.mockResolvedValue([{ id: 's1', startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2026-06-07T00:00:00Z') }])
    montarBase()

    const filas = await dataProductividad({})
    expect(filas).toHaveLength(2)

    // r1 con actividad va primero
    const [activa, inactiva] = filas
    expect(activa.resource).toBe('Dra. Pérez')
    expect(activa.type).toBe('oftalmologo')
    expect(activa.site).toBe('Sede 2')
    expect(activa.h_prog).toBe(12.5)       // 8,5 (9h − 30 min almuerzo) + 4
    expect(activa.h_ejec).toBe(8.5)        // solo la franja con execution
    expect(activa.pac_prog).toBe(46)       // 30 + 16
    expect(activa.pac_at).toBe(27)
    expect(activa.pct_cumplimiento).toBe(Math.round((27 / 46) * 100))
    // El campo interno _sedeIds NO se debe filtrar hacia afuera
    expect(activa).not.toHaveProperty('_sedeIds')

    // r2 sin asignaciones — aparece con ceros y pct null, al final
    expect(inactiva.resource).toBe('Dr. Zuluaga')
    expect(inactiva.h_prog).toBe(0)
    expect(inactiva.h_ejec).toBe(0)
    expect(inactiva.pct_cumplimiento).toBeNull()
    // Sin asignaciones no tiene sede resuelta
    expect(inactiva.site).toBe('—')
  })

  it('PROYECTOS-3255 #3.3 — prom_h_semanal divide por semanas ACTIVAS del recurso (no por todo el rango)', async () => {
    // Rango de 4 semanas, pero el recurso solo tuvo asignaciones en s1.
    // Su promedio semanal debe representar cuanto trabajo cuando trabajo (h_ejec/1),
    // no diluirse contra las 4 semanas del rango (h_ejec/4 = 2.1) — que ocultaria
    // su carga real durante las semanas activas.
    prismaMock.week.findMany.mockResolvedValue([
      { id: 's1', startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2026-06-07T00:00:00Z') },
      { id: 's2', startDate: new Date('2026-06-08T00:00:00Z'), endDate: new Date('2026-06-14T00:00:00Z') },
      { id: 's3', startDate: new Date('2026-06-15T00:00:00Z'), endDate: new Date('2026-06-21T00:00:00Z') },
      { id: 's4', startDate: new Date('2026-06-22T00:00:00Z'), endDate: new Date('2026-06-28T00:00:00Z') },
    ])
    montarBase()   // asigs tienen weekId='s1' → 1 semana activa, 1 mes activo (junio)

    const [activa] = await dataProductividad({ desde: '2026-06-01', hasta: '2026-06-28' })
    expect(activa.prom_h_semanal).toBe(8.5)   // h_ejec / 1 semana activa
    expect(activa.prom_h_mensual).toBe(8.5)   // h_ejec / 1 mes activo (junio)
  })

  it('PROYECTOS-3255 #3.3 — recurso activo en 2 meses distintos: divide por 2', async () => {
    // Dos semanas de actividad en meses distintos (sep-oct) → mesesActivos=2
    prismaMock.week.findMany.mockResolvedValue([
      { id: 's1', startDate: new Date('2026-09-28T00:00:00Z'), endDate: new Date('2026-10-04T00:00:00Z') },
      { id: 's2', startDate: new Date('2026-10-05T00:00:00Z'), endDate: new Date('2026-10-11T00:00:00Z') },
    ])
    prismaMock.resource.findMany.mockResolvedValue(recursosActivos)
    prismaMock.holiday.findMany.mockResolvedValue([])
    prismaMock.absence.findMany.mockResolvedValue([])
    // r1 con 8h en cada semana
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        resourceId: 'r1', weekId: 's1', startTime: '08:00', endTime: '17:00', patientCapacity: 30,
        resource: { type: 'oftalmologo' },
        execution: { patientsSeen: 30 },
        room: { siteId: 'st2', site: { name: 'Sede 2' } },
      },
      {
        resourceId: 'r1', weekId: 's2', startTime: '08:00', endTime: '17:00', patientCapacity: 30,
        resource: { type: 'oftalmologo' },
        execution: { patientsSeen: 28 },
        room: { siteId: 'st2', site: { name: 'Sede 2' } },
      },
    ])

    const [activa] = await dataProductividad({ desde: '2026-09-28', hasta: '2026-10-11' })
    // h_ejec = 17 (2 franjas de 8.5). 2 semanas activas, 2 meses activos (sep 28 y oct 5).
    expect(activa.h_ejec).toBe(17)
    expect(activa.prom_h_semanal).toBe(8.5)     // 17 / 2
    expect(activa.prom_h_mensual).toBe(8.5)     // 17 / 2 meses
  })

  it('PROYECTOS-3255 #3.1 — orden: primero activos por %desc, despues inactivos alfabeticos', async () => {
    // 3 recursos: 2 con actividad (uno con % mayor), 1 sin actividad
    prismaMock.week.findMany.mockResolvedValue([{
      id: 's1',
      startDate: new Date('2026-06-01T00:00:00Z'),
      endDate: new Date('2026-06-07T00:00:00Z'),
    }])
    prismaMock.resource.findMany.mockResolvedValue([
      { id: 'r1', name: 'Dra. Pérez', type: 'oftalmologo' },
      { id: 'r2', name: 'Dr. Zuluaga', type: 'oftalmologo' },
      { id: 'r3', name: 'Dra. Martínez', type: 'oftalmologo' },
    ])
    prismaMock.holiday.findMany.mockResolvedValue([])
    // r1: 27/46 = 59%   r3: 30/30 = 100%   r2: sin asignaciones
    prismaMock.assignment.findMany.mockResolvedValue([
      ...asigs,  // r1 (Dra. Perez) — weekId='s1'
      {
        resourceId: 'r3', weekId: 's1', startTime: '08:00', endTime: '17:00', patientCapacity: 30,
        resource: { type: 'oftalmologo' },
        execution: { patientsSeen: 30 },
        room: { siteId: 'st2', site: { name: 'Sede 2' } },
      },
    ])

    const filas = await dataProductividad({})
    expect(filas.map((f) => f.resource)).toEqual([
      'Dra. Martínez',   // 100% — primero
      'Dra. Pérez',      // 59% — segundo
      'Dr. Zuluaga',     // sin actividad — al final
    ])
  })
})
