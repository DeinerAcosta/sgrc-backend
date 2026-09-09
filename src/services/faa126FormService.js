import PDFDocument from 'pdfkit'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Genera el PDF del formato oficial F-AA-126 v04 "CONTINUIDAD DEL SERVICIO
 * CON LOS PRESTADORES DE SERVICIO OFTALMOLOGÍA - OPTOMETRÍA" de Clínica
 * Oftalmológica del Caribe (fecha actualización 26/08/2026).
 *
 * Diferencias con v03:
 *   - Bloque "¿A QUÉ EMPRESA APLICA LA AUSENCIA?" con FOCA/VIU/AMBAS
 *   - Motivos expandidos (7 opciones, incluye "Traslado a sedes externas")
 *   - Bloque "¿DESEA REPONER?" SÍ/NO
 *   - Observaciones sobre reposición
 *   - "Vo Bo:" con nombre del confirmador
 *
 * PROYECTOS-3255 #5.1:
 *   - Logo condicional en cabecera segun ausencia.affectedCompany (foca/viu/ambas)
 *   - Firma del profesional al pie si resource.signatureUrl esta definida
 *
 * Sep-2026 · feedback usuario:
 *   - Logos VIU/FOCA van ARRIBA del formato (fuera del box de cabecera)
 *   - Los boxes Día/Mes/Año se llenan con los NÚMEROS (no la fecha DD/MM/YYYY al costado)
 *
 * El proceso afectado se infiere del tipo de recurso:
 *   - oftalmólogo, optómetra, otorrino, fonoaudiólogo → Consulta externa
 *   - anestesiólogo → Cirugía
 *   - técnico → Ayudas diagnósticas
 */

// Logos PNG en backend/src/assets/brand/. Cache en memoria — se cargan una vez.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BRAND_DIR = path.join(__dirname, '..', 'assets', 'brand')

let _logoCache = null
function cargarLogos() {
  if (_logoCache) return _logoCache
  const readSafe = (name) => {
    try { return fs.readFileSync(path.join(BRAND_DIR, name)) } catch { return null }
  }
  _logoCache = {
    viu: readSafe('viu-azul-horizontal.png'),
    foca: readSafe('foca-azul.png'),
  }
  return _logoCache
}

/**
 * Carga la firma del profesional. signatureUrl puede venir como:
 *   - data URL base64: "data:image/png;base64,iVBORw..." (formato que usa el
 *     frontend AdminResourcesPage al subir la imagen — es el caso normal)
 *   - path absoluto: "/opt/sgrc/uploads/firmas/xxx.png" (legacy / carga manual)
 *   - path relativo al backend: "uploads/firmas/xxx.png"
 * Devuelve Buffer o null si no existe / no se puede leer.
 */
function cargarFirma(signatureUrl) {
  if (!signatureUrl || typeof signatureUrl !== 'string') return null
  // Data URL base64 → decodificar la parte que va despues de la coma.
  // Sep-2026: este es el formato que usa el frontend al subir la firma
  // (FileReader.readAsDataURL). Antes solo se soportaban paths de disco.
  if (signatureUrl.startsWith('data:')) {
    const comma = signatureUrl.indexOf(',')
    if (comma < 0) return null
    try {
      return Buffer.from(signatureUrl.slice(comma + 1), 'base64')
    } catch {
      return null
    }
  }
  // Fallback: path de disco (compatibilidad con cargas manuales via mysql).
  try {
    const resolved = path.isAbsolute(signatureUrl)
      ? signatureUrl
      : path.join(__dirname, '..', '..', signatureUrl)
    return fs.readFileSync(resolved)
  } catch {
    return null
  }
}

const MESES = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
]

const TIPO_A_PROCESO = {
  oftalmologo: 'externa',
  optometra: 'externa',
  otorrino: 'externa',
  fonoaudiologa: 'externa',
  anestesiologo: 'cirugia',
  tecnico: 'diagnostica',
}

// Mapa codigo → checkbox del formato v04. Un mismo motivo del catálogo puede
// no calzar con ningún checkbox del papel; en ese caso caemos al genérico.
const CODIGO_A_MOTIVO_V04 = {
  enfermedad:              'enfermedad',
  medico_sin_acompanamiento_del_tutor: 'enfermedad',
  calamidad:               'calamidad',
  academico:               'academico',
  capacitacion:            'academico',
  familiar:                'familiar',
  personal_llega_tarde:    'familiar',
  vacaciones:              'vacaciones',
  vacaciones_fellow:       'vacaciones',
  licencia_no_remunerada:  'licencia',
  licencia_remunerada:     'licencia',   // el formato agrupa ambas en "Licencia no remunerada"
  traslado_sedes_externas: 'traslado',
  traslado_de_sedes:       'traslado',
  sede_externa:            'traslado',
  cambio_sede:             'traslado',
  regional:                'traslado',
  brigada:                 'traslado',
  tercer_nivel:            'traslado',
}

function fmtDdMmYyyy(d) {
  if (!d) return ''
  const dt = new Date(d)
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = dt.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// Devuelve [dd, mm, yyyy] como strings pad. Si la fecha esta vacia, ['','','']
// para que el PDF muestre los boxes vacios en vez de "00/00/1970".
function partesFecha(d) {
  if (!d) return ['', '', '']
  const dt = new Date(d)
  return [
    String(dt.getUTCDate()).padStart(2, '0'),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCFullYear()),
  ]
}

export function generarFormatoFAA126(ausencia) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 30, size: 'letter' })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      const nombreRecurso = ausencia?.resource?.name ?? 'PROFESIONAL'
      const tipoRecurso = ausencia?.resource?.type ?? ''
      const procesoAfectado = TIPO_A_PROCESO[tipoRecurso] ?? 'externa'
      const [dSal, mSal, ySal] = partesFecha(ausencia?.startDate)
      const [dEnt, mEnt, yEnt] = partesFecha(ausencia?.endDate)
      const fechaDiligenciamiento = fmtDdMmYyyy(new Date())
      const observacion = ausencia?.makeupNotes ?? ausencia?.reason ?? ausencia?.actionTaken ?? ''

      // v04 · Empresa afectada (foca/viu/ambas). Sin fallback — si no vino
      // (ausencia legacy pre-v04), los tres checkboxes quedan vacíos y se
      // llenan a mano. Antes marcábamos 'ambas' por defecto, lo que
      // falseaba el dato oficial en PDFs de ausencias históricas.
      const empresa = ausencia?.affectedCompany ?? null

      // v04 · ¿DESEA REPONER? — bandera boolean o null. Solo marcamos SÍ o NO
      // cuando el usuario respondió; si es null, ambos checkboxes vacíos.
      const deseaReponer = ausencia?.wantsMakeup

      // v04 · Motivo marcado — resolvemos del catálogo (motivoRef.codigo).
      const codigoMotivo = ausencia?.reasonRef?.code ?? ausencia?.type
      const motivoV04 = CODIGO_A_MOTIVO_V04[codigoMotivo] ?? null

      // v04 · Vo Bo — nombre del confirmador (usuario que confirmó la ausencia).
      const voBoNombre = ausencia?.confirmador?.name ?? ''

      // PROYECTOS-3255 #5.1 — Logos (viu/foca) y firma del profesional cargados
      // del disco. Silencioso si el archivo no existe: el PDF sigue funcionando
      // sin logo / sin firma, no rompe la generación.
      const logos = cargarLogos()
      const firmaBuffer = cargarFirma(ausencia?.resource?.signatureUrl)

      // Determinar días reprogramados por mes desde impactoPorDia (JSON)
      const diasPorMes = Array.from({ length: 12 }, () => [])
      const impactoPorDia = ausencia?.dailyImpact ?? []
      if (Array.isArray(impactoPorDia)) {
        for (const it of impactoPorDia) {
          if (!it?.date) continue
          const dt = new Date(it.date)
          const m = dt.getUTCMonth()
          const d = dt.getUTCDate()
          const pac = it.pacientes ?? 0
          diasPorMes[m].push(pac > 0 ? `${String(d).padStart(2,'0')} (${pac} pac.)` : String(d).padStart(2,'0'))
        }
      }

      const PAGE_W = doc.page.width
      const LEFT = 30
      const RIGHT = PAGE_W - 30
      const CONTENT_W = RIGHT - LEFT

      const drawCheckbox = (x, y, marcado) => {
        doc.rect(x, y, 9, 9).stroke()
        if (marcado) doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('X', x + 1.5, y - 0.5)
      }

      // Helper: pinta una fila de 3 boxes Día/Mes/Año con headers arriba y numero abajo.
      // Sep-2026 · feedback usuario: la fecha va DENTRO de los boxes, no al costado.
      const drawFechaBoxes = (x, y, dd, mm, yyyy) => {
        doc.rect(x, y, 30, 20).stroke().rect(x + 30, y, 30, 20).stroke().rect(x + 60, y, 30, 20).stroke()
        doc.font('Helvetica').fontSize(5.5).fillColor('#666')
          .text('Día', x, y + 1, { width: 30, align: 'center' })
          .text('Mes', x + 30, y + 1, { width: 30, align: 'center' })
          .text('Año', x + 60, y + 1, { width: 30, align: 'center' })
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
          .text(dd || '',  x,      y + 8, { width: 30, align: 'center' })
          .text(mm || '',  x + 30, y + 8, { width: 30, align: 'center' })
          .text(yyyy || '', x + 60, y + 8, { width: 30, align: 'center' })
      }

      // ==================== LOGOS (ARRIBA DE TODO · sep-2026) ====================
      // Los logos van fuera del box de cabecera, en la parte superior del formato.
      // Segun empresa afectada: foca → solo FOCA · viu → solo VIU · ambas/null → ambos.
      const logoTopY = 15
      const logoH = 30
      try {
        if (empresa === 'foca' && logos.foca) {
          doc.image(logos.foca, LEFT + 210, logoTopY, { fit: [180, logoH] })
        } else if (empresa === 'viu' && logos.viu) {
          doc.image(logos.viu, LEFT + 210, logoTopY, { fit: [180, logoH] })
        } else {
          // 'ambas' o legacy sin empresa → ambos logos lado a lado, centrados.
          if (logos.foca) doc.image(logos.foca, LEFT + 130, logoTopY, { fit: [140, logoH] })
          if (logos.viu)  doc.image(logos.viu,  LEFT + 300, logoTopY, { fit: [140, logoH] })
        }
      } catch { /* logo corrupto o formato no soportado — el PDF sigue */ }

      // ==================== CABECERA (baja 25px por logos) ====================
      const H_TOP = 55  // header top: era 30, ahora 55 para dejar espacio a los logos
      doc.rect(LEFT, H_TOP, CONTENT_W, 60).stroke()
      // Título central (sin logos adentro — ahora van arriba)
      doc.rect(LEFT, H_TOP, CONTENT_W - 100, 30).stroke()
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
        .text('CLÍNICA OFTALMOLÓGICA DEL CARIBE', LEFT, H_TOP + 9, { width: CONTENT_W - 100, align: 'center' })
      doc.rect(LEFT, H_TOP + 30, CONTENT_W - 100, 30).stroke()
      doc.font('Helvetica-Bold').fontSize(9)
        .text('CONTINUIDAD DEL SERVICIO CON LOS PRESTADORES DE SERVICIO', LEFT, H_TOP + 35, { width: CONTENT_W - 100, align: 'center' })
        .text('OFTALMOLOGÍA - OPTOMETRÍA', LEFT, H_TOP + 46, { width: CONTENT_W - 100, align: 'center' })

      // Columna derecha: código / versión / fecha
      const rightBoxX = RIGHT - 100
      doc.rect(rightBoxX, H_TOP, 60, 20).stroke()
      doc.font('Helvetica').fontSize(8).fillColor('#000').text('Código:', rightBoxX + 3, H_TOP + 7)
      doc.rect(rightBoxX + 60, H_TOP, 40, 20).stroke()
      doc.font('Helvetica-Bold').fontSize(8).text('F-AA-126', rightBoxX + 63, H_TOP + 7)

      doc.rect(rightBoxX, H_TOP + 20, 60, 20).stroke()
      doc.font('Helvetica').fontSize(8).text('Versión:', rightBoxX + 3, H_TOP + 27)
      doc.rect(rightBoxX + 60, H_TOP + 20, 40, 20).stroke()
      doc.font('Helvetica-Bold').fontSize(8).text('04', rightBoxX + 63, H_TOP + 27)

      doc.rect(rightBoxX, H_TOP + 40, 60, 20).stroke()
      doc.font('Helvetica').fontSize(7.5).text('Fecha\nactualización:', rightBoxX + 3, H_TOP + 42, { width: 55 })
      doc.rect(rightBoxX + 60, H_TOP + 40, 40, 20).stroke()
      doc.font('Helvetica-Bold').fontSize(8).text('26/08/2026', rightBoxX + 63, H_TOP + 47)

      // ==================== EMPRESA APLICA (v04 NUEVO) ====================
      let y = H_TOP + 60
      doc.rect(LEFT, y, CONTENT_W, 18).stroke()
      doc.font('Helvetica-Bold').fontSize(9).text('¿A QUÉ EMPRESA APLICA LA AUSENCIA?', LEFT + 3, y + 5)
      // Checkboxes empresa
      const empX = LEFT + 240
      drawCheckbox(empX, y + 4, empresa === 'foca')
      doc.font('Helvetica').fontSize(9).text('FOCA', empX + 13, y + 4)
      drawCheckbox(empX + 80, y + 4, empresa === 'viu')
      doc.text('VIU', empX + 93, y + 4)
      drawCheckbox(empX + 150, y + 4, empresa === 'ambas')
      doc.text('AMBAS', empX + 163, y + 4)

      // ==================== DATOS DEL PROFESIONAL ====================
      y += 18
      doc.rect(LEFT, y, CONTENT_W, 40).stroke()
      doc.rect(LEFT, y, 280, 40).stroke()
      doc.font('Helvetica').fontSize(8).text('Profesional quien presta el servicio:', LEFT + 3, y + 3)
      doc.font('Helvetica-Bold').fontSize(11).text(nombreRecurso.toUpperCase(), LEFT + 3, y + 18, { width: 274 })

      // Etiquetas "Fecha de salida" / "Fecha de entrada" (sin fecha al costado —
      // los numeros ahora van en los boxes Día/Mes/Año a la derecha).
      doc.rect(LEFT + 280, y, CONTENT_W - 280 - 90, 20).stroke()
      doc.font('Helvetica').fontSize(8).text('Fecha de salida', LEFT + 285, y + 7)
      doc.rect(LEFT + 280, y + 20, CONTENT_W - 280 - 90, 20).stroke()
      doc.font('Helvetica').fontSize(8).text('Fecha de entrada', LEFT + 285, y + 27)

      // Boxes Día/Mes/Año CON los numeros dentro (sep-2026 · feedback usuario).
      const dmyX = RIGHT - 90
      drawFechaBoxes(dmyX, y,      dSal, mSal, ySal)  // fecha salida
      drawFechaBoxes(dmyX, y + 20, dEnt, mEnt, yEnt)  // fecha entrada

      // ==================== PROCESO QUE AFECTA ====================
      y += 40
      doc.rect(LEFT, y, CONTENT_W, 20).stroke()
      doc.font('Helvetica').fontSize(8).text('Proceso que afecta:', LEFT + 3, y + 6)
      doc.text('Consulta externa', LEFT + 100, y + 6)
      drawCheckbox(LEFT + 175, y + 5, procesoAfectado === 'externa')
      doc.text('Ayudas diagnósticas', LEFT + 210, y + 6)
      drawCheckbox(LEFT + 300, y + 5, procesoAfectado === 'diagnostica')
      doc.text('Cirugía', LEFT + 335, y + 6)
      drawCheckbox(LEFT + 370, y + 5, procesoAfectado === 'cirugia')

      // ==================== TIPO DE NOVEDAD ====================
      y += 20
      doc.rect(LEFT, y, CONTENT_W, 25).stroke()
      doc.font('Helvetica').fontSize(8)
        .text('Tipo de novedad:', LEFT + 3, y + 9)
      doc.text('Cambio permanente', LEFT + 100, y + 5).text('de horario', LEFT + 100, y + 14)
      drawCheckbox(LEFT + 180, y + 8, false)
      doc.text('Cambio de horario de', LEFT + 215, y + 5).text('periodo determinado', LEFT + 215, y + 14)
      drawCheckbox(LEFT + 305, y + 8, false)
      doc.text('Ausencia de un período', LEFT + 340, y + 5).text('determinado', LEFT + 340, y + 14)
      drawCheckbox(LEFT + 440, y + 8, true)

      // ==================== MOTIVO (v04 EXPANDIDO) ====================
      y += 25
      doc.rect(LEFT, y, CONTENT_W, 30).stroke()
      doc.font('Helvetica').fontSize(8).text('MOTIVO:', LEFT + 3, y + 12)
      // Fila 1: enfermedad · calamidad · académico
      const motY1 = y + 4
      drawCheckbox(LEFT + 60, motY1, motivoV04 === 'enfermedad')
      doc.text('Incapacidad por enfermedad', LEFT + 72, motY1 + 1)
      drawCheckbox(LEFT + 200, motY1, motivoV04 === 'calamidad')
      doc.text('Ausencia por calamidad', LEFT + 212, motY1 + 1)
      drawCheckbox(LEFT + 335, motY1, motivoV04 === 'academico')
      doc.text('Evento académico', LEFT + 347, motY1 + 1)
      // Fila 2: familiar · vacaciones · licencia · traslado
      const motY2 = y + 17
      drawCheckbox(LEFT + 60, motY2, motivoV04 === 'familiar')
      doc.text('Evento familiar', LEFT + 72, motY2 + 1)
      drawCheckbox(LEFT + 155, motY2, motivoV04 === 'vacaciones')
      doc.text('Vacaciones / viajes', LEFT + 167, motY2 + 1)
      drawCheckbox(LEFT + 265, motY2, motivoV04 === 'licencia')
      doc.text('Licencia no remunerada', LEFT + 277, motY2 + 1)
      drawCheckbox(LEFT + 405, motY2, motivoV04 === 'traslado')
      doc.text('Traslado a sedes externas', LEFT + 417, motY2 + 1)

      // ==================== PERÍODO DE AUSENCIA POR MES ====================
      y += 30
      doc.rect(LEFT, y, CONTENT_W, 15).fill('#D9D9D9').stroke().fillColor('#000')
      doc.font('Helvetica-Bold').fontSize(9)
        .text('PERÍODO DE AUSENCIA DEL SERVICIO PRESTADO (DÍA/MES/AÑO)', LEFT + 3, y + 3, { width: CONTENT_W, align: 'center' })

      y += 15
      const rowH = 22
      MESES.forEach((mes, idx) => {
        const dias = diasPorMes[idx]
        doc.rect(LEFT, y, 80, rowH).stroke()
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(`${mes}:`, LEFT + 3, y + 3)
        doc.font('Helvetica').fontSize(7).text('Día reprogramación:', LEFT + 3, y + 13)
        doc.rect(LEFT + 80, y, CONTENT_W - 80, rowH).stroke()
        if (dias.length > 0) {
          doc.font('Helvetica').fontSize(8).text(dias.join(' · '), LEFT + 85, y + 7, { width: CONTENT_W - 90 })
        }
        y += rowH
      })

      // ==================== ¿DESEA REPONER? (v04 NUEVO) ====================
      doc.rect(LEFT, y, CONTENT_W, 18).stroke()
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('¿DESEA REPONER?', LEFT + 3, y + 5)
      const repX = LEFT + 240
      drawCheckbox(repX, y + 4, deseaReponer === true)
      doc.font('Helvetica').fontSize(9).text('SÍ', repX + 13, y + 4)
      drawCheckbox(repX + 80, y + 4, deseaReponer === false)
      doc.text('NO', repX + 93, y + 4)
      y += 18

      // ==================== OBSERVACIONES (v04 texto ampliado) ====================
      doc.rect(LEFT, y, CONTENT_W, 40).stroke()
      doc.font('Helvetica-Bold').fontSize(8).text('OBSERVACIONES:', LEFT + 3, y + 3)
      doc.font('Helvetica').fontSize(7).text('Si desea reponer, detalle la fecha, horario y/o modalidad propuesta para la reposición.', LEFT + 100, y + 4, { width: CONTENT_W - 105 })
      doc.font('Helvetica').fontSize(9).text(observacion || '', LEFT + 3, y + 18, { width: CONTENT_W - 6, height: 20 })
      y += 40

      // ==================== FIRMA + FECHA DILIGENCIAMIENTO ====================
      // PROYECTOS-3255 #5.1 — Firma escaneada del profesional (opcional).
      // Si el recurso tiene signatureUrl y la imagen se pudo leer, se pinta
      // ANTES del nombre; si no, el nombre queda como firma tipografica (comportamiento previo).
      doc.rect(LEFT, y, CONTENT_W, 30).stroke()
      doc.rect(LEFT, y, 350, 30).stroke()
      doc.font('Helvetica').fontSize(8).text('Firma del prestador:', LEFT + 3, y + 3)
      if (firmaBuffer) {
        try {
          // Firma a la izquierda del nombre, alto ~22px para que quepa en la caja de 30px
          doc.image(firmaBuffer, LEFT + 100, y + 4, { fit: [80, 22] })
          doc.font('Helvetica-Bold').fontSize(9).text(nombreRecurso.toUpperCase(), LEFT + 185, y + 14, { width: 160 })
        } catch {
          // Fallback si la imagen esta corrupta
          doc.font('Helvetica-Bold').fontSize(10).text(nombreRecurso.toUpperCase(), LEFT + 110, y + 12)
        }
      } else {
        doc.font('Helvetica-Bold').fontSize(10).text(nombreRecurso.toUpperCase(), LEFT + 110, y + 12)
      }
      doc.font('Helvetica').fontSize(8).text('Fecha diligenciamiento:', LEFT + 360, y + 3)
      doc.font('Helvetica-Bold').fontSize(10).text(fechaDiligenciamiento, LEFT + 480, y + 12)
      y += 30

      // ==================== Vo Bo (v04 · nombre confirmador) ====================
      doc.rect(LEFT, y, CONTENT_W, 20).stroke()
      doc.font('Helvetica').fontSize(8).text('Vo Bo:', LEFT + 3, y + 6)
      if (voBoNombre) {
        doc.font('Helvetica-Bold').fontSize(10).text(voBoNombre.toUpperCase(), LEFT + 40, y + 5, { width: CONTENT_W - 45 })
      }
      y += 20

      // ==================== NOTA ====================
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
        .text('NOTA:', LEFT, y + 5, { continued: true })
        .font('Helvetica').text(' Las ausencias deben ser informadas con 20 días de anticipación.', { continued: false })

      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}
