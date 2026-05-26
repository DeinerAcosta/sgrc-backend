import PDFDocument from 'pdfkit'
import ExcelJS from 'exceljs'

/**
 * Servicio de exportación de informes — HU-D-07.
 * Genera PDF (PDFKit) o Excel (ExcelJS) en memoria y devuelve un Buffer.
 */

const COLOR_BRAND = '#185FA5'
const COLOR_GRIS = '#6B7280'

/** Etiquetas legibles para cada tipo de informe */
const TITULOS = {
  ocupacion: 'Ocupación de Consultorios',
  productividad: 'Productividad por Recurso',
  ausentismo: 'Ausentismo y Ranking',
  subutilizacion: 'Recursos Subutilizados',
  impacto: 'Impacto Económico de Ausencias',
  'horas-prog-ejec': 'Horas Programadas vs Ejecutadas',
}

/**
 * Genera un PDF con branding SGRC: encabezado, filtros aplicados, tabla de datos.
 * @returns {Promise<Buffer>}
 */
export function generarPDF(tipo, filas, filtros = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      // Encabezado
      doc.fillColor(COLOR_BRAND).fontSize(18).font('Helvetica-Bold')
        .text('SGRC', 40, 40)
      doc.fillColor(COLOR_GRIS).fontSize(9).font('Helvetica')
        .text('Sistema de Gestión de Recursos Clínicos · Clínica Oftalmológica Internacional', 40, 62)
      doc.fillColor('#1A1A17').fontSize(14).font('Helvetica-Bold')
        .text(TITULOS[tipo] ?? tipo, 40, 82)
      doc.fillColor(COLOR_GRIS).fontSize(8).font('Helvetica')
        .text(`Generado: ${new Date().toLocaleString('es-CO')}`, 40, 102)
      if (Object.keys(filtros).length) {
        doc.text(`Filtros: ${JSON.stringify(filtros)}`, 40, 113)
      }

      // Tabla
      if (!filas || filas.length === 0) {
        doc.moveDown(3).fillColor(COLOR_GRIS).fontSize(11)
          .text('Sin datos para los filtros seleccionados.', 40, 140)
        doc.end()
        return
      }

      const columnas = Object.keys(filas[0])
      const startX = 40
      let y = 135
      const colWidth = (760) / columnas.length

      // Header de tabla
      doc.fillColor('#FFFFFF').rect(startX, y, 760, 20).fill(COLOR_BRAND)
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
      columnas.forEach((col, i) => {
        doc.text(col.replace(/_/g, ' ').toUpperCase(), startX + i * colWidth + 4, y + 6, {
          width: colWidth - 8, ellipsis: true,
        })
      })
      y += 20

      // Filas
      doc.font('Helvetica').fontSize(8)
      filas.forEach((fila, idx) => {
        if (y > 520) { doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' }); y = 40 }
        if (idx % 2 === 0) doc.fillColor('#F8F9FA').rect(startX, y, 760, 18).fill()
        doc.fillColor('#1A1A17')
        columnas.forEach((col, i) => {
          const val = fila[col]
          doc.text(val === null || val === undefined ? '—' : String(val),
            startX + i * colWidth + 4, y + 5, { width: colWidth - 8, ellipsis: true })
        })
        y += 18
      })

      // Pie
      doc.fillColor(COLOR_GRIS).fontSize(7)
        .text(`${filas.length} registros · SGRC ${new Date().getFullYear()}`, 40, 560)

      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * Genera un Excel con dos hojas: "Datos" (filas crudas) y "Resumen" (metadata).
 * @returns {Promise<Buffer>}
 */
export async function generarExcel(tipo, filas, filtros = {}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SGRC'
  wb.created = new Date()

  // Hoja de datos
  const ws = wb.addWorksheet('Datos')
  if (filas && filas.length > 0) {
    const columnas = Object.keys(filas[0])
    ws.columns = columnas.map((c) => ({
      header: c.replace(/_/g, ' ').toUpperCase(),
      key: c,
      width: Math.max(14, c.length + 4),
    }))
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF185FA5' } }
    filas.forEach((f) => ws.addRow(f))
    // bordes suaves
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        }
      })
    })
  } else {
    ws.addRow(['Sin datos para los filtros seleccionados'])
  }

  // Hoja de resumen
  const resumen = wb.addWorksheet('Resumen')
  resumen.columns = [{ width: 24 }, { width: 50 }]
  resumen.addRow(['Informe', TITULOS[tipo] ?? tipo])
  resumen.addRow(['Generado', new Date().toLocaleString('es-CO')])
  resumen.addRow(['Total de registros', filas?.length ?? 0])
  resumen.addRow(['Filtros aplicados', JSON.stringify(filtros)])
  resumen.addRow(['Sistema', 'SGRC — Clínica Oftalmológica Internacional'])
  resumen.getColumn(1).font = { bold: true }

  return wb.xlsx.writeBuffer()
}
