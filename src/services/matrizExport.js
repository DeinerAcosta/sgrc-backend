import PDFDocument from 'pdfkit'
import ExcelJS from 'exceljs'
import { horasPorFranjaMatriz } from '../lib/matrizAuxiliares.js'
import { fechaHora } from '../lib/fechas.js'

/**
 * DESCARGA DE LA MATRIZ DE ASIGNACIONES FIJAS (nov-2026)
 * ======================================================
 *
 * Hector: "descargar tanto en Excel y PDF, funcional con cualquier campo de
 * filtro". El frontend manda las auxiliares que ve (ya filtradas y en su
 * orden) y los días que se ven; aquí se arma lo mismo que la pantalla: una
 * fila por auxiliar y, por día, Horario | Horas | Profesional, más el total.
 */

export const DIA_LABEL = {
  lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves',
  viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo',
}

const MARINO = '#1B2A6C'
const fmt = (h) => (Math.round(h * 10) / 10).toString().replace('.', ',')

/**
 * Lo que va en cada celda, ya en texto: una línea por franja.
 * @param {object[]} auxiliares [{ id, name, maxHoursPerWeek }] en el orden de la pantalla
 * @param {Map} celdas          `${auxId}:${dia}` → { ranges, note, professionals: [{id,name}] }
 * @param {string[]} dias       los días que se ven
 * @param {string[]} todosLosDias para el total de la semana (siempre la semana entera)
 */
export function filasExportMatriz(auxiliares, celdas, dias, todosLosDias) {
  return auxiliares.map((a) => {
    const porDia = Object.fromEntries(dias.map((d) => {
      const c = celdas.get(`${a.id}:${d}`)
      if (!c) return [d, null]
      const rangos = Array.isArray(c.ranges) ? c.ranges : []
      const horas = horasPorFranjaMatriz(rangos)
      const nombre = (id) => c.professionals.find((p) => p.id === id)?.name
      const porFranja = rangos.some((r) => r.professionalId)
      return [d, {
        horario: rangos.map((r) => `${r.ini}–${r.fin}${r.lunch ? ` (almuerzo ${r.lunch.ini}–${r.lunch.fin})` : ''}`),
        horas: horas.map(fmt),
        profesional: porFranja
          ? rangos.map((r) => nombre(r.professionalId) ?? '—')
          : [c.professionals.map((p) => p.name).join(', ')].filter(Boolean),
        nota: c.note || '',
      }]
    }))
    const total = todosLosDias.reduce((s, d) => {
      const c = celdas.get(`${a.id}:${d}`)
      return s + horasPorFranjaMatriz(Array.isArray(c?.ranges) ? c.ranges : []).reduce((x, y) => x + y, 0)
    }, 0)
    return { nombre: a.name, porDia, total, tope: a.maxHoursPerWeek ?? null }
  })
}

const textoProfesional = (c) => [...c.profesional, ...(c.nota ? [c.nota] : [])].join('\n')

export async function excelMatriz(filas, dias, filtrosTexto) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SGRC'
  const ws = wb.addWorksheet('Matriz de asignaciones')
  const nCols = 1 + dias.length * 3 + 1
  const borde = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
  const marino = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A6C' } }
  const claro = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EBF3' } }

  ws.mergeCells(1, 1, 1, nCols)
  ws.getCell(1, 1).value = 'Matriz de asignaciones fijas'
  ws.getCell(1, 1).font = { size: 14, bold: true, color: { argb: 'FF1B2A6C' } }
  ws.mergeCells(2, 1, 2, nCols)
  ws.getCell(2, 1).value = `${filas.length} auxiliares${filtrosTexto ? ` · ${filtrosTexto}` : ''} · Generado: ${fechaHora(new Date())}`
  ws.getCell(2, 1).font = { size: 9, color: { argb: 'FF6B7280' } }

  // Dos filas de títulos: los días (combinados) y Horario | Horas | Profesional.
  const f1 = 4, f2 = 5
  ws.mergeCells(f1, 1, f2, 1)
  ws.getCell(f1, 1).value = 'Auxiliar'
  dias.forEach((d, i) => {
    const c0 = 2 + i * 3
    ws.mergeCells(f1, c0, f1, c0 + 2)
    ws.getCell(f1, c0).value = DIA_LABEL[d].toUpperCase()
    ;['Horario', 'Horas', 'Profesional'].forEach((t, k) => { ws.getCell(f2, c0 + k).value = t })
  })
  ws.mergeCells(f1, nCols, f2, nCols)
  ws.getCell(f1, nCols).value = 'Total horas'
  for (const fila of [f1, f2]) {
    for (let c = 1; c <= nCols; c++) {
      const cell = ws.getCell(fila, c)
      const sub = fila === f2 && c > 1 && c < nCols
      cell.fill = sub ? claro : marino
      cell.font = { bold: true, size: 9, color: { argb: sub ? 'FF0F1948' : 'FFFFFFFF' } }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      cell.border = borde
    }
  }

  filas.forEach((f, idx) => {
    const valores = [f.nombre]
    let lineas = 1
    for (const d of dias) {
      const c = f.porDia[d]
      if (!c) { valores.push('—', '', ''); continue }
      valores.push(c.horario.join('\n'), c.horas.join('\n'), textoProfesional(c))
      lineas = Math.max(lineas, c.horario.length, c.profesional.length + (c.nota ? 1 : 0))
    }
    valores.push(f.total ? Number(fmt(f.total).replace(',', '.')) : '—')
    const row = ws.addRow(valores)
    row.height = Math.max(18, lineas * 14)
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = borde
      cell.font = { size: 9, bold: col === 1 || col === nCols }
      cell.alignment = { wrapText: true, vertical: 'top', horizontal: col === 1 || (col - 2) % 3 !== 1 ? 'left' : 'center' }
      if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } }
    })
    const total = row.getCell(nCols)
    total.alignment = { horizontal: 'center', vertical: 'top' }
    if (f.tope != null && f.total > f.tope) {
      total.font = { size: 9, bold: true, color: { argb: 'FFDC2626' } }
      total.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } }
    }
  })

  ws.getColumn(1).width = 26
  dias.forEach((_, i) => {
    ws.getColumn(2 + i * 3).width = 24
    ws.getColumn(3 + i * 3).width = 7
    ws.getColumn(4 + i * 3).width = 24
  })
  ws.getColumn(nCols).width = 10
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: f2 }]
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function pdfMatriz(filas, dias, filtrosTexto) {
  return new Promise((resolve, reject) => {
    try {
      // Toda la semana no cabe en A4: A3 apaisado. Uno o dos días, A4 apaisado.
      const doc = new PDFDocument({ margin: 25, size: dias.length > 3 ? 'A3' : 'A4', layout: 'landscape' })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const x0 = 25
      const ancho = doc.page.width - 50
      const anchoAux = 110
      const anchoTotal = 42
      const anchoDia = (ancho - anchoAux - anchoTotal) / dias.length
      const anchoHorario = anchoDia * 0.36, anchoHoras = anchoDia * 0.18, anchoProf = anchoDia * 0.46

      const encabezado = () => {
        doc.fillColor(MARINO).fontSize(15).font('Helvetica-Bold').text('Matriz de asignaciones fijas', x0, 25)
        doc.fillColor('#6B7280').fontSize(8).font('Helvetica')
          .text(`${filas.length} auxiliares${filtrosTexto ? ` · ${filtrosTexto}` : ''} · Generado: ${fechaHora(new Date())}`, x0, 45)
        let y = 62
        doc.rect(x0, y, anchoAux, 30).fill(MARINO)
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('Auxiliar', x0 + 4, y + 11)
        dias.forEach((d, i) => {
          const x = x0 + anchoAux + i * anchoDia
          doc.rect(x, y, anchoDia, 15).fill(MARINO)
          doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text(DIA_LABEL[d].toUpperCase(), x, y + 4, { width: anchoDia, align: 'center' })
          doc.rect(x, y + 15, anchoDia, 15).fill('#E8EBF3')
          doc.fillColor('#0F1948').fontSize(7)
            .text('Horario', x + 3, y + 19, { width: anchoHorario - 3 })
            .text('Horas', x + anchoHorario, y + 19, { width: anchoHoras, align: 'center' })
            .text('Profesional', x + anchoHorario + anchoHoras + 2, y + 19, { width: anchoProf - 2 })
          doc.moveTo(x, y).lineTo(x, y + 30).strokeColor('#FFFFFF').lineWidth(0.5).stroke()
        })
        const xt = x0 + anchoAux + dias.length * anchoDia
        doc.rect(xt, y, anchoTotal, 30).fill(MARINO)
        doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold').text('Total horas', xt, y + 7, { width: anchoTotal, align: 'center' })
        return y + 30
      }

      let y = encabezado()
      filas.forEach((f, idx) => {
        // Alto de la fila: la celda con más líneas (franjas, profesionales, nota).
        doc.fontSize(7).font('Helvetica')
        let alto = 16
        for (const d of dias) {
          const c = f.porDia[d]
          if (!c) continue
          const hHor = doc.heightOfString(c.horario.join('\n'), { width: anchoHorario - 6 })
          const hProf = doc.heightOfString(textoProfesional(c), { width: anchoProf - 6 })
          alto = Math.max(alto, hHor + 8, hProf + 8)
        }
        doc.font('Helvetica-Bold')
        alto = Math.max(alto, doc.heightOfString(f.nombre, { width: anchoAux - 8 }) + 8)
        if (y + alto > doc.page.height - 25) { doc.addPage(); y = encabezado() }

        const fondo = idx % 2 === 0 ? '#FFFFFF' : '#F9FAFB'
        doc.rect(x0, y, ancho, alto).fill(fondo)
        doc.fillColor('#111827').fontSize(7.5).font('Helvetica-Bold').text(f.nombre, x0 + 4, y + 4, { width: anchoAux - 8 })
        dias.forEach((d, i) => {
          const x = x0 + anchoAux + i * anchoDia
          const c = f.porDia[d]
          doc.fontSize(7).font('Helvetica')
          if (!c) {
            doc.fillColor('#D1D5DB').text('—', x, y + 4, { width: anchoDia, align: 'center' })
          } else {
            doc.fillColor('#374151').text(c.horario.join('\n'), x + 3, y + 4, { width: anchoHorario - 6, lineGap: 0 })
            doc.fillColor('#111827').font('Helvetica-Bold').text(c.horas.join('\n'), x + anchoHorario, y + 4, { width: anchoHoras, align: 'center' })
            doc.fillColor('#111827').font('Helvetica').text(textoProfesional(c), x + anchoHorario + anchoHoras + 2, y + 4, { width: anchoProf - 6 })
          }
          doc.moveTo(x, y).lineTo(x, y + alto).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
        })
        const xt = x0 + anchoAux + dias.length * anchoDia
        const pasa = f.tope != null && f.total > f.tope
        if (pasa) doc.rect(xt, y, anchoTotal, alto).fill('#FEF2F2')
        doc.fillColor(pasa ? '#DC2626' : '#111827').fontSize(7.5).font('Helvetica-Bold')
          .text(f.total ? fmt(f.total) : '—', xt, y + 4, { width: anchoTotal, align: 'center' })
        doc.moveTo(x0, y + alto).lineTo(x0 + ancho, y + alto).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
        y += alto
      })
      if (!filas.length) doc.fillColor('#9CA3AF').fontSize(9).text('Ninguna auxiliar coincide con el filtro.', x0, y + 10)
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
