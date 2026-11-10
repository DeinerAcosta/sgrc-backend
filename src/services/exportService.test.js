import { describe, it, expect, vi, afterEach } from 'vitest'
import ExcelJS from 'exceljs'
import { generarExcel } from './exportService.js'

afterEach(() => vi.useRealTimers())

describe('generarExcel — hora de generación (Nov-2026)', () => {
  it('sale en hora Colombia aunque el servidor esté en UTC', async () => {
    // 21:11 UTC = 4:11 p. m. en Bogotá. Antes el informe decía "9:11 p. m.".
    vi.useFakeTimers({ now: new Date('2026-11-10T21:11:59Z'), toFake: ['Date'] })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await generarExcel('productividad', []))
    const generado = wb.getWorksheet('Resumen').getRow(2).getCell(2).value
    expect(generado).toMatch(/10 de noviembre de 2026/)
    expect(generado).toMatch(/4:11/)
    expect(generado).not.toMatch(/9:11/)
  })
})
