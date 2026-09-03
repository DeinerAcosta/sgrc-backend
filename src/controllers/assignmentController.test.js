import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = {
  resource: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  room: { findUnique: vi.fn() },
}
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }))

const { sugerirReemplazos } = await import('./assignmentController.js')

// Doble mínimo de req/res: el handler solo lee query y llama a res.json.
const ejecutar = async (query) => {
  let payload
  await sugerirReemplazos({ query }, { json: (d) => { payload = d } })
  return payload
}

const FRANJA = { type: 'oftalmologo', day: 'lunes', start_time: '14:00', end_time: '18:00', week_id: 's1' }

const recurso = (id, nombre) => ({ id, name: nombre, type: 'oftalmologo', active: true })
const asig = (recursoId, horaInicio, horaFin, sedeId = 'sedeA') => ({
  resourceId: recursoId, assistantId: null, startTime: horaInicio, endTime: horaFin, room: { siteId: sedeId },
})

beforeEach(() => {
  prismaMock.resource.findMany.mockReset()
  prismaMock.assignment.findMany.mockReset()
  prismaMock.room.findUnique.mockReset()
})

describe('sugerirReemplazos — disponibilidad real', () => {
  it('NO sugiere a quien ya tiene una franja solapada, aunque tenga otras que no solapan', async () => {
    // Este era el bug: con findFirst se devolvía UNA asignación. Si la primera
    // (07:00-11:00) no solapaba con las 14:00-18:00 pedidas, la doctora salía
    // como disponible pese a tener también 15:00-19:00 ese mismo día.
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([
      asig('r1', '07:00', '11:00'),   // no solapa
      asig('r1', '15:00', '19:00'),   // SÍ solapa con 14:00-18:00
    ])

    expect(await ejecutar(FRANJA)).toEqual([])
  })

  it('sí sugiere a quien tiene franjas ese día pero ninguna solapa', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([
      asig('r1', '07:00', '11:00'),
      asig('r1', '11:00', '13:00'),
    ])

    const out = await ejecutar(FRANJA)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('r1')
  })

  it('trata como libres las franjas que solo se tocan en el borde', async () => {
    // Terminar a las 14:00 no impide empezar a las 14:00.
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([asig('r1', '08:00', '14:00')])
    expect(await ejecutar(FRANJA)).toHaveLength(1)

    prismaMock.assignment.findMany.mockResolvedValue([asig('r1', '18:00', '20:00')])
    expect(await ejecutar(FRANJA)).toHaveLength(1)
  })

  it('también descarta a quien está ocupado como AUXILIAR en la franja', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([
      { resourceId: 'otro', assistantId: 'r1', startTime: '15:00', endTime: '19:00', room: { siteId: 'sedeA' } },
    ])
    expect(await ejecutar(FRANJA)).toEqual([])
  })

  it('sugiere a quien no tiene ninguna franja ese día', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez'), recurso('r2', 'Dr. Gómez')])
    prismaMock.assignment.findMany.mockResolvedValue([asig('r1', '15:00', '19:00')])

    const out = await ejecutar(FRANJA)
    expect(out.map((r) => r.id)).toEqual(['r2'])
  })
})

describe('sugerirReemplazos — coste en consultas', () => {
  it('usa 2 consultas para N candidatos, no una por candidato', async () => {
    prismaMock.resource.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => recurso(`r${i}`, `Recurso ${i}`))
    )
    prismaMock.assignment.findMany.mockResolvedValue([])

    await ejecutar(FRANJA)

    expect(prismaMock.resource.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(1)
    // Antes: 1 + 25 consultas. Ahora: 2.
  })

  it('no consulta asignaciones si no hay candidatos del tipo', async () => {
    prismaMock.resource.findMany.mockResolvedValue([])
    expect(await ejecutar(FRANJA)).toEqual([])
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled()
  })
})

describe('sugerirReemplazos — misma_sede', () => {
  it('distingue la sede propia de la que requiere desplazamiento', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez'), recurso('r2', 'Dr. Gómez')])
    prismaMock.assignment.findMany.mockResolvedValue([
      asig('r1', '07:00', '11:00', 'sedeA'),   // trabaja en la sede del hueco
      asig('r2', '07:00', '11:00', 'sedeB'),   // trabaja en otra sede
    ])
    prismaMock.room.findUnique.mockResolvedValue({ siteId: 'sedeA' })

    const out = await ejecutar({ ...FRANJA, room_id: 'c1' })
    expect(out.find((r) => r.id === 'r1').misma_sede).toBe(true)
    expect(out.find((r) => r.id === 'r2').misma_sede).toBe(false)
  })

  it('acepta sede_id directo sin necesidad de resolver el consultorio', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([asig('r1', '07:00', '11:00', 'sedeB')])

    const out = await ejecutar({ ...FRANJA, site_id: 'sedeA' })
    expect(out[0].misma_sede).toBe(false)
    expect(prismaMock.room.findUnique).not.toHaveBeenCalled()
  })

  it('sin sede de referencia mantiene el comportamiento anterior (todos misma_sede)', async () => {
    prismaMock.resource.findMany.mockResolvedValue([recurso('r1', 'Dra. Pérez')])
    prismaMock.assignment.findMany.mockResolvedValue([asig('r1', '07:00', '11:00', 'sedeB')])

    const out = await ejecutar(FRANJA)
    expect(out[0].misma_sede).toBe(true)
  })
})

describe('sugerirReemplazos — validación', () => {
  it('exige tipo, día y franja', async () => {
    await expect(ejecutar({ type: 'oftalmologo', day: 'lunes' }))
      .rejects.toThrow(/Parámetros requeridos/)
  })
})
