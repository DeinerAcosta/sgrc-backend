import { describe, it, expect, vi, beforeEach } from 'vitest'
import ExcelJS from 'exceljs'

// Prisma simulado: solo lo que lee armarGridSemana.
const prismaMock = {
  week: { findUnique: vi.fn() },
  site: { findUnique: vi.fn() },
  assignment: { findMany: vi.fn() },
  room: { findMany: vi.fn() },
}
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }))

const { exportarSemana } = await import('./assignmentController.js')

const respuesta = () => {
  const res = { headers: {} }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.send = (b) => { res.body = b; return res }
  return res
}

beforeEach(() => {
  prismaMock.week.findUnique.mockResolvedValue({
    id: 's1', startDate: new Date('2026-11-02T00:00:00Z'), endDate: new Date('2026-11-08T00:00:00Z'),
  })
  prismaMock.site.findUnique.mockResolvedValue({ id: 'st', name: 'Sede 3 Alkarawi', city: null })
  prismaMock.room.findMany.mockResolvedValue([
    { id: 'c7', name: 'Consultorio 7', specialty: 'oftalmologia' },
    { id: 'c8', name: 'Consultorio 8', specialty: 'oftalmologia' },
  ])
  prismaMock.assignment.findMany.mockResolvedValue([
    {
      roomId: 'c7', weekday: 'martes', startTime: '08:00', endTime: '12:00', patientCapacity: 24,
      resource: { name: 'Dra. Pérez', type: 'oftalmologo' },
      // Nov-2026 · La lista de auxiliares: la 1ª con sub-horario, la 2ª hereda.
      assistants: [
        { resourceId: 'a1', startTime: '08:00', endTime: '10:00', position: 0, resource: { name: 'Marnedis Peralta' } },
        { resourceId: 'a2', startTime: '10:00', endTime: '12:00', position: 1, resource: { name: 'Luz Mery' } },
        { resourceId: 'a3', startTime: null, endTime: null, position: 2, resource: { name: 'Sara Díaz' } },
      ],
    },
    {
      roomId: 'c8', weekday: 'lunes', startTime: '07:00', endTime: '13:00', patientCapacity: 30,
      resource: { name: 'Dr. Ruiz', type: 'oftalmologo' },
      assistants: [{ resourceId: 'a4', startTime: null, endTime: null, position: 0, resource: { name: 'Ana Ruiz' } }],
    },
  ])
})

describe('exportarSemana — un solo día (Nov-2026)', () => {
  it('Excel del martes: solo los turnos del martes, con la fecha del día y TODAS las auxiliares con su sub-horario', async () => {
    const res = respuesta()
    await exportarSemana({ query: { week_id: 's1', site_id: 'st', format: 'xlsx', day: 'martes' } }, res)

    expect(res.headers['Content-Disposition']).toContain('horarios_Sede_3_Alkarawi_2026-11-03.xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body)
    const ws = wb.worksheets[0]
    expect(ws.getCell('A2').value).toBe('Martes 2026-11-03')
    expect(ws.getRow(5).values.slice(1)).toEqual(['Consultorio 7', 'Dra. Pérez', '08:00–12:00', 'Marnedis Peralta (08:00–10:00), Luz Mery (10:00–12:00), Sara Díaz', 24])
    expect(ws.rowCount).toBe(5)   // título, fecha, vacío, encabezado y un turno
  })

  it('PDF del día sale como PDF', async () => {
    const res = respuesta()
    await exportarSemana({ query: { week_id: 's1', site_id: 'st', format: 'pdf', day: 'lunes' } }, res)
    expect(res.headers['Content-Type']).toBe('application/pdf')
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('rechaza un día que no existe', async () => {
    await expect(exportarSemana({ query: { week_id: 's1', site_id: 'st', day: 'feriado' } }, respuesta()))
      .rejects.toThrow('Día inválido')
  })

  it('sin día sigue saliendo la semana, y ya no dice "undefined pac."', async () => {
    const res = respuesta()
    await exportarSemana({ query: { week_id: 's1', site_id: 'st', format: 'xlsx' } }, res)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body)
    const texto = JSON.stringify(wb.worksheets[0].getSheetValues())
    expect(texto).toContain('24 pac.')
    expect(texto).toContain('Aux: Marnedis Peralta, Luz Mery, Sara Díaz')
    expect(texto).not.toContain('undefined')
  })
})
