import { describe, it, expect } from 'vitest'
import { filasExportMatriz, excelMatriz, pdfMatriz } from './matrizExport.js'

// Nov-2026 · Hector: descargar la Matriz en Excel/PDF con cualquier filtro.
const auxiliares = [{ id: 'a', name: 'Angela', maxHoursPerWeek: 44 }, { id: 'b', name: 'Beatriz', maxHoursPerWeek: 44 }]
const celdas = new Map([
  ['a:lunes', {
    ranges: [{ ini: '08:00', fin: '12:00', professionalId: 'p1' }, { ini: '13:00', fin: '17:00', professionalId: 'p2' }],
    note: 'LASER',
    professionals: [{ id: 'p1', name: 'Dr. Uno' }, { id: 'p2', name: 'Dr. Dos' }],
  }],
  ['a:martes', {
    ranges: [{ ini: '08:00', fin: '17:00', professionalId: 'p1', lunch: { ini: '12:00', fin: '13:00' } }],
    note: '', professionals: [{ id: 'p1', name: 'Dr. Uno' }],
  }],
])
const SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']

describe('filasExportMatriz', () => {
  it('una línea por franja con su profesional, el almuerzo y el total de la semana', () => {
    const [a, b] = filasExportMatriz(auxiliares, celdas, ['lunes', 'martes'], SEMANA)
    expect(a.porDia.lunes).toEqual({ horario: ['08:00–12:00', '13:00–17:00'], horas: ['4', '4'], profesional: ['Dr. Uno', 'Dr. Dos'], nota: 'LASER' })
    expect(a.porDia.martes.horario).toEqual(['08:00–17:00 (almuerzo 12:00–13:00)'])
    expect(a.porDia.martes.horas).toEqual(['8'])
    expect(a.total).toBe(16)
    expect(b.porDia.lunes).toBeNull()
  })
  it('con un solo día, solo ese día (el total sigue siendo la semana)', () => {
    const [a] = filasExportMatriz(auxiliares, celdas, ['martes'], SEMANA)
    expect(Object.keys(a.porDia)).toEqual(['martes'])
    expect(a.total).toBe(16)
  })
  it('genera el Excel y el PDF', async () => {
    const filas = filasExportMatriz(auxiliares, celdas, SEMANA, SEMANA)
    const xlsx = await excelMatriz(filas, SEMANA, 'Estado: Asignado')
    expect(xlsx.subarray(0, 2).toString()).toBe('PK')
    const pdf = await pdfMatriz(filas, SEMANA, 'Estado: Asignado')
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  })
})
