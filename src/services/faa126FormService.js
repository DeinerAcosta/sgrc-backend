import PDFDocument from 'pdfkit'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Genera el PDF del formato oficial F-AA-126 v04 "CONTINUIDAD DEL SERVICIO
 * CON LOS PRESTADORES DE SERVICIO OFTALMOLOGÍA - OTORRINOLARINGOLOGÍA". El
 * título de empresa cambia (FOCA → Fundación Oftalmológica del Caribe; VIU →
 * Clínica Oftalmológica del Caribe); el subtítulo de especialidades es el
 * mismo para ambas. Fecha actualización 26/08/2026.
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
 *   - Logo VIU/FOCA en la ESQUINA IZQUIERDA superior (fuera del box de cabecera)
 *   - Boxes Día/Mes/Año se llenan con los NÚMEROS de la fecha
 *   - Si empresa='ambas', el PDF sale con 2 PÁGINAS: primera con logo FOCA
 *     y segunda con logo VIU (mismo contenido, un ejemplar por empresa).
 *     Antes se dibujaban ambos logos apilados en la misma hoja.
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

// Cargo legible impreso en la caja "Profesional quien presta el servicio".
// Se deriva del `resource.type`; si no hay match, cae a "Prestador de servicio"
// (no dejamos el campo vacío en el PDF oficial).
const TIPO_A_CARGO = {
  oftalmologo:          'Oftalmólogo/a',
  optometra:            'Optómetra',
  otorrino:             'Otorrinolaringólogo/a',
  otorrinolaringologia: 'Otorrinolaringólogo/a',
  fonoaudiologa:        'Fonoaudiólogo/a',
  fonoaudiologo:        'Fonoaudiólogo/a',
  anestesiologo:        'Anestesiólogo/a',
  tecnico:              'Técnico/a de diagnóstico',
  auxiliar:             'Auxiliar de enfermería',
  auxiliar_enfermeria:  'Auxiliar de enfermería',
  asesor_servicios:     'Asesor/a de servicios',
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

// "Hoy" en zona horaria America/Bogota (UTC-5, sin DST).
// Sep-2026: antes se usaba fmtDdMmYyyy(new Date()) que formatea en UTC — los
// PDFs generados entre 19:00 y 23:59 hora Bogota salian con la fecha del dia
// siguiente porque UTC ya estaba en el dia siguiente. Este helper garantiza
// que "Fecha diligenciamiento" corresponda al calendario Bogota.
function fmtHoyBogota() {
  const partes = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date())
  const g = (t) => partes.find((p) => p.type === t)?.value ?? ''
  return `${g('day')}/${g('month')}/${g('year')}`
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

/**
 * Dibuja UNA página completa del formato F-AA-126 en el `doc` actual con el
 * logo que se le indique. Se llama una o dos veces desde generarFormatoFAA126
 * dependiendo de si la ausencia aplica a una o a ambas empresas.
 *
 * @param {PDFDocument} doc  El documento donde se está dibujando (ya con página abierta).
 * @param {object} ausencia   Payload de la ausencia (mismo shape de siempre).
 * @param {'foca'|'viu'|null} empresaLogo  Cual logo pintar en la esquina izquierda.
 *   null = ninguno (para ausencias legacy sin empresa registrada).
 */
function dibujarPaginaFormato(doc, ausencia, empresaLogo) {
  const nombreRecurso = ausencia?.resource?.name ?? 'PROFESIONAL'
  const tipoRecurso = ausencia?.resource?.type ?? ''
  const cargoRecurso = TIPO_A_CARGO[tipoRecurso] ?? 'Prestador de servicio'
  // F-AA-126 v05 (sep-14-2026): si la ausencia trae affectedProcess capturado
  // en el modal, se usa. Si no (ausencias legacy), se infiere del tipo de
  // recurso como antes (retrocompatible). Valores nuevos usan snake_case largo
  // — mapeamos al codigo corto que espera el resto del render.
  const PROCESO_LARGO_A_CORTO = { consulta_externa: 'externa', ayudas_diagnosticas: 'diagnostica', cirugia: 'cirugia' }
  const procesoAfectado = ausencia?.affectedProcess
    ? (PROCESO_LARGO_A_CORTO[ausencia.affectedProcess] ?? ausencia.affectedProcess)
    : (TIPO_A_PROCESO[tipoRecurso] ?? 'externa')
  // Tipo de novedad: default 'ausencia_periodo' (era el hardcoded historico).
  const tipoNovedad = ausencia?.noveltyType ?? 'ausencia_periodo'
  const [dSal, mSal, ySal] = partesFecha(ausencia?.startDate)
  const [dEnt, mEnt, yEnt] = partesFecha(ausencia?.endDate)
  const fechaDiligenciamiento = fmtHoyBogota()
  const observacion = ausencia?.makeupNotes ?? ausencia?.reason ?? ausencia?.actionTaken ?? ''

  // v04 · Empresa afectada — para pintar los checkboxes reflejamos el dato
  // ORIGINAL (foca/viu/ambas), no el logo elegido para esta hoja.
  const empresaCheck = ausencia?.affectedCompany ?? null

  // v04 · ¿DESEA REPONER? — bandera boolean o null.
  const deseaReponer = ausencia?.wantsMakeup

  // v04 · Motivo marcado — resolvemos del catálogo (motivoRef.codigo).
  const codigoMotivo = ausencia?.reasonRef?.code ?? ausencia?.type
  const motivoV04 = CODIGO_A_MOTIVO_V04[codigoMotivo] ?? null

  // v04 · Vo Bo — nombre del confirmador (usuario que confirmó la ausencia).
  const voBoNombre = ausencia?.confirmador?.name ?? ''

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

  // ==================== LOGO ESQUINA IZQUIERDA (sep-2026 · feedback usuario) ====================
  // Un solo logo, en la esquina superior izquierda del formato, alineado con
  // el borde izquierdo (LEFT). Si empresa='ambas', la funcion generarFormatoFAA126
  // pinta esta pagina con logo=foca y luego una segunda pagina con logo=viu.
  const logoTopY = 15
  const logoH = 35
  const logoW = 150
  try {
    const buf = empresaLogo === 'foca' ? logos.foca
              : empresaLogo === 'viu'  ? logos.viu
              : null
    if (buf) doc.image(buf, LEFT, logoTopY, { fit: [logoW, logoH] })
  } catch { /* logo corrupto o formato no soportado — el PDF sigue */ }

  // ==================== CABECERA (baja para dejar espacio al logo) ====================
  const H_TOP = 55
  doc.rect(LEFT, H_TOP, CONTENT_W, 60).stroke()
  // El título de empresa cambia: FOCA = Fundación, VIU = Clínica (legacy sin
  // empresa registrada mantiene Clínica por retrocompatibilidad). El subtítulo
  // de especialidades es el mismo en las dos empresas: Oftalmología +
  // Otorrinolaringología. Optometría se retiró del formato oficial (feedback
  // usuario 15-sep-2026).
  const esFoca = empresaLogo === 'foca'
  const tituloEmpresa = esFoca
    ? 'FUNDACIÓN OFTALMOLÓGICA DEL CARIBE'
    : 'CLÍNICA OFTALMOLÓGICA DEL CARIBE'
  const especialidadSubtitulo = 'OFTALMOLOGÍA - OTORRINOLARINGOLOGÍA'
  // Título central
  doc.rect(LEFT, H_TOP, CONTENT_W - 100, 30).stroke()
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    .text(tituloEmpresa, LEFT, H_TOP + 9, { width: CONTENT_W - 100, align: 'center' })
  doc.rect(LEFT, H_TOP + 30, CONTENT_W - 100, 30).stroke()
  doc.font('Helvetica-Bold').fontSize(9)
    .text('CONTINUIDAD DEL SERVICIO CON LOS PRESTADORES DE SERVICIO', LEFT, H_TOP + 35, { width: CONTENT_W - 100, align: 'center' })
    .text(especialidadSubtitulo, LEFT, H_TOP + 46, { width: CONTENT_W - 100, align: 'center' })

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

  // ==================== EMPRESA APLICA (v04) ====================
  let y = H_TOP + 60
  doc.rect(LEFT, y, CONTENT_W, 18).stroke()
  doc.font('Helvetica-Bold').fontSize(9).text('¿A QUÉ EMPRESA APLICA LA AUSENCIA?', LEFT + 3, y + 5)
  const empX = LEFT + 240
  drawCheckbox(empX, y + 4, empresaCheck === 'foca')
  doc.font('Helvetica').fontSize(9).text('FOCA', empX + 13, y + 4)
  drawCheckbox(empX + 80, y + 4, empresaCheck === 'viu')
  doc.text('VIU', empX + 93, y + 4)
  drawCheckbox(empX + 150, y + 4, empresaCheck === 'ambas')
  doc.text('AMBAS', empX + 163, y + 4)

  // ==================== DATOS DEL PROFESIONAL ====================
  // La caja crece a 50 (antes 40) para dar espacio a la línea de "Cargo:"
  // debajo del nombre. Las cajas de fecha a la derecha se mantienen 20+20=40
  // y quedan pegadas arriba; el resto (10px) es el pie de la caja izquierda.
  y += 18
  const profH = 50
  doc.rect(LEFT, y, CONTENT_W, profH).stroke()
  doc.rect(LEFT, y, 280, profH).stroke()
  doc.font('Helvetica').fontSize(8).text('Profesional quien presta el servicio:', LEFT + 3, y + 3)
  doc.font('Helvetica-Bold').fontSize(10).text(nombreRecurso.toUpperCase(), LEFT + 3, y + 15, { width: 274 })
  doc.font('Helvetica').fontSize(7).fillColor('#000').text('Cargo:', LEFT + 3, y + 35)
  doc.font('Helvetica-Bold').fontSize(9).text(cargoRecurso, LEFT + 30, y + 34, { width: 245 })

  doc.rect(LEFT + 280, y, CONTENT_W - 280 - 90, 20).stroke()
  doc.font('Helvetica').fontSize(8).text('Fecha de salida', LEFT + 285, y + 7)
  doc.rect(LEFT + 280, y + 20, CONTENT_W - 280 - 90, 20).stroke()
  doc.font('Helvetica').fontSize(8).text('Fecha de entrada', LEFT + 285, y + 27)

  const dmyX = RIGHT - 90
  drawFechaBoxes(dmyX, y,      dSal, mSal, ySal)
  drawFechaBoxes(dmyX, y + 20, dEnt, mEnt, yEnt)

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
  drawCheckbox(LEFT + 180, y + 8, tipoNovedad === 'cambio_permanente')
  doc.text('Cambio de horario de', LEFT + 215, y + 5).text('periodo determinado', LEFT + 215, y + 14)
  drawCheckbox(LEFT + 305, y + 8, tipoNovedad === 'cambio_periodo')
  doc.text('Ausencia de un período', LEFT + 340, y + 5).text('determinado', LEFT + 340, y + 14)
  drawCheckbox(LEFT + 440, y + 8, tipoNovedad === 'ausencia_periodo')

  // ==================== MOTIVO ====================
  y += 25
  doc.rect(LEFT, y, CONTENT_W, 30).stroke()
  doc.font('Helvetica').fontSize(8).text('MOTIVO:', LEFT + 3, y + 12)
  const motY1 = y + 4
  drawCheckbox(LEFT + 60, motY1, motivoV04 === 'enfermedad')
  doc.text('Incapacidad por enfermedad', LEFT + 72, motY1 + 1)
  drawCheckbox(LEFT + 200, motY1, motivoV04 === 'calamidad')
  doc.text('Ausencia por calamidad', LEFT + 212, motY1 + 1)
  drawCheckbox(LEFT + 335, motY1, motivoV04 === 'academico')
  doc.text('Evento académico', LEFT + 347, motY1 + 1)
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
      // Sep-2026: height + ellipsis para que vacaciones largas (20-30 dias)
      // no desborden la fila y pisen la del mes siguiente. Antes se pintaban
      // 3-4 lineas y ocultaban el label "OCTUBRE:", "NOVIEMBRE:" etc.
      doc.font('Helvetica').fontSize(8).text(dias.join(' · '), LEFT + 85, y + 4, {
        width: CONTENT_W - 90, height: rowH - 6, ellipsis: true,
      })
    }
    y += rowH
  })

  // ==================== ¿DESEA REPONER? ====================
  doc.rect(LEFT, y, CONTENT_W, 18).stroke()
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('¿DESEA REPONER?', LEFT + 3, y + 5)
  const repX = LEFT + 240
  drawCheckbox(repX, y + 4, deseaReponer === true)
  doc.font('Helvetica').fontSize(9).text('SÍ', repX + 13, y + 4)
  drawCheckbox(repX + 80, y + 4, deseaReponer === false)
  doc.text('NO', repX + 93, y + 4)
  y += 18

  // ==================== OBSERVACIONES ====================
  // Sep-2026: caja crece de 40 a 55px y el texto usa 32px de alto con
  // ellipsis. Antes truncaba silenciosamente notas de reposicion >2 lineas.
  const obsH = 55
  doc.rect(LEFT, y, CONTENT_W, obsH).stroke()
  doc.font('Helvetica-Bold').fontSize(8).text('OBSERVACIONES:', LEFT + 3, y + 3)
  doc.font('Helvetica').fontSize(7).text('Si desea reponer, detalle la fecha, horario y/o modalidad propuesta para la reposición.', LEFT + 100, y + 4, { width: CONTENT_W - 105 })
  doc.font('Helvetica').fontSize(9).text(observacion || '', LEFT + 3, y + 18, {
    width: CONTENT_W - 6, height: obsH - 22, ellipsis: true,
  })
  y += obsH

  // ==================== FIRMA + FECHA DILIGENCIAMIENTO ====================
  // Sep-2026 · feedback usuario: la caja crece a 55px para que la firma tenga
  // espacio suficiente y se lea claro. Cuando hay firma cargada, NO se
  // duplica el nombre debajo — el nombre completo del profesional ya aparece
  // arriba en la caja "Profesional quien presta el servicio". Sin firma, cae
  // al nombre tipografico como fallback.
  const firmaH = 55
  doc.rect(LEFT, y, CONTENT_W, firmaH).stroke()
  doc.rect(LEFT, y, 350, firmaH).stroke()
  doc.font('Helvetica').fontSize(8).text('Firma del prestador:', LEFT + 3, y + 3)
  if (firmaBuffer) {
    try {
      // Firma centrada horizontalmente dentro de la caja de 350x55.
      // Fit generoso: 230px ancho x 42px alto — deja 6px margen sup/inf y
      // 60px a cada lado. Con `align:'center'` PDFKit centra la imagen.
      doc.image(firmaBuffer, LEFT + 10, y + 8, { fit: [330, 42], align: 'center', valign: 'center' })
    } catch {
      // Imagen corrupta → cae al nombre tipografico
      doc.font('Helvetica-Bold').fontSize(11).text(nombreRecurso.toUpperCase(), LEFT + 3, y + 25, { width: 344, align: 'center' })
    }
  } else {
    // Sin firma cargada → nombre tipografico centrado
    doc.font('Helvetica-Bold').fontSize(11).text(nombreRecurso.toUpperCase(), LEFT + 3, y + 25, { width: 344, align: 'center' })
  }
  doc.font('Helvetica').fontSize(8).fillColor('#000').text('Fecha diligenciamiento:', LEFT + 360, y + 3)
  doc.font('Helvetica-Bold').fontSize(10).text(fechaDiligenciamiento, LEFT + 480, y + 25)
  y += firmaH

  // ==================== Vo Bo ====================
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
}

export function generarFormatoFAA126(ausencia) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 30, size: 'letter' })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      const empresa = ausencia?.affectedCompany ?? null

      // Sep-2026 · feedback usuario: si la ausencia aplica a AMBAS empresas,
      // el PDF sale con DOS páginas — un ejemplar independiente para FOCA y
      // otro para VIU. Cada página trae su propio logo en la esquina izquierda.
      // Los checkboxes de empresa (FOCA/VIU/AMBAS) se marcan igual en ambas.
      if (empresa === 'ambas') {
        dibujarPaginaFormato(doc, ausencia, 'foca')
        doc.addPage()
        dibujarPaginaFormato(doc, ausencia, 'viu')
      } else if (empresa === 'foca' || empresa === 'viu') {
        dibujarPaginaFormato(doc, ausencia, empresa)
      } else {
        // Legacy sin empresa registrada — una hoja sin logo (los datos siguen
        // completos, el checkbox de empresa queda todo vacio y se llena a mano).
        dibujarPaginaFormato(doc, ausencia, null)
      }

      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}
