/**
 * HISTÓRICO DE REPROGRAMACIONES (enero-octubre 2026) — reglas de la carga
 * =====================================================================
 *
 * Agendas llevó la reprogramación en un Excel, una hoja por mes, antes del
 * SGRC. scripts/importar-reprogramaciones.js lo carga como ausencias con
 * origen 'historico' para que el tablero de Reprogramaciones muestre esos
 * meses. Aquí vive todo lo que decide CÓMO se traduce cada fila, sin base de
 * datos, para probarlo y revisarlo:
 *
 *   · normalizar   el Excel escribe lo mismo de varias formas
 *                  ("CONSULTA", "CONSULTA ", "CONSUTA"; "Sí", "SI", "NO ")
 *   · motivoDe     ~70 tipos escritos a mano → 25 motivos del catálogo, cada
 *                  uno en la familia del tablero que le corresponde
 *   · sedeDe       DOS / VIVA / ALKARAWI / ALEGRA → las sedes del sistema
 *   · ALIAS        nombres del Excel mal escritos o cortos → el recurso del SGRC
 *   · NO_SON_PROFESIONALES  filas cuya "agenda" es un equipo, no una persona
 *   · claveDeFila  las hojas de febrero y marzo traen pegado el bloque de
 *                  enero; con la clave, la copia no entra dos veces
 */
import crypto from 'node:crypto'

/** Mayúsculas, sin tildes y con un solo espacio. null si queda vacío. */
export function normalizar(v) {
  if (v == null) return null
  const s = String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
  return s || null
}

/** Palabras de un nombre, sin títulos (Dr., Dra., Tec.). */
export function palabras(nombre) {
  return (normalizar(nombre) ?? '')
    .replace(/\b(DR|DRA|TEC|DOCTOR|DOCTORA)\b\.?/g, ' ')
    .match(/[A-Z]{2,}/g) ?? []
}

/** "PATRICIA POMBO" → "Patricia Pombo" (para quien cubre, que es texto libre). */
export function nombrePropio(v) {
  // Sin normalizar: es texto que se muestra, conserva tildes y eñes.
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim()
  return s ? s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : null
}

// ---------------------------------------------------------------------------
// Motivos. Los del sistema se reutilizan; los demás se crean INACTIVOS: sirven
// al tablero (que lee nombre y familia) sin aparecer en Registrar ausencia.
// ---------------------------------------------------------------------------
export const MOTIVOS_NUEVOS = [
  // Ausencia del profesional
  { code: 'hist_formato', name: 'Ausencia con formato', family: 'ausencia_profesional' },
  { code: 'hist_personal', name: 'Asunto personal', family: 'ausencia_profesional' },
  { code: 'hist_licencia', name: 'Licencia', family: 'ausencia_profesional' },
  { code: 'hist_fin_contrato', name: 'Fin de contrato', family: 'ausencia_profesional' },
  { code: 'hist_institucional', name: 'Actividad institucional (junta, administrativa)', family: 'ausencia_profesional' },
  { code: 'hist_ausencia', name: 'Ausencia sin detalle', family: 'ausencia_profesional' },
  // Reprogramación operativa
  { code: 'hist_cambio_horario', name: 'Cambio de horario', family: 'reprogramacion_operativa' },
  { code: 'hist_movimiento_agenda', name: 'Movimiento de agenda', family: 'reprogramacion_operativa' },
  { code: 'hist_cirugia', name: 'Apoyo en cirugía', family: 'reprogramacion_operativa' },
  { code: 'hist_mantenimiento', name: 'Mantenimiento de equipo', family: 'reprogramacion_operativa' },
  // Ajuste de cupos
  { code: 'hist_disminuir_pacientes', name: 'Disminución de pacientes', family: 'ajuste_cupos' },
  { code: 'hist_llenar_agenda', name: 'Llenar agenda', family: 'ajuste_cupos' },
  // Movilidad / regional
  { code: 'hist_regional', name: 'Atención en regional', family: 'movilidad_regional' },
  { code: 'hist_cambio_sede', name: 'Cambio de sede', family: 'movilidad_regional' },
  { code: 'hist_brigada', name: 'Brigada', family: 'movilidad_regional' },
  { code: 'hist_tercer_nivel', name: 'Tercer nivel', family: 'movilidad_regional' },
  // Calendario
  { code: 'hist_festivo', name: 'Día festivo', family: 'calendario_festivo' },
  // Sin tipo en el Excel
  { code: 'hist_otro', name: 'Otro (histórico)', family: 'otros' },
]

// Tipo del Excel (normalizado) → código del motivo. Lo que empieza por
// REGIONAL / REGINAL o por CUBRE + ciudad se resuelve abajo por prefijo.
const MOTIVO_POR_TIPO = {
  FORMATO: 'hist_formato',
  PERSONAL: 'hist_personal',
  MEDICA: 'enfermedad',
  'AUSENCIA MEDICA': 'enfermedad',
  LICENCIA: 'hist_licencia',
  AUSENCIA: 'hist_ausencia',
  CONGRESO: 'academico',
  CAPACITACION: 'academico',
  'VACACIONES FELLOW': 'vacaciones',
  'FIN CONTRATO': 'hist_fin_contrato',
  'FIN DE CONTRATO': 'hist_fin_contrato',
  'JUNTA MEDICA': 'hist_institucional',
  ADMINISTRATIVA: 'hist_institucional',
  'CAMBIO HORARIO': 'hist_cambio_horario',
  'CAMBIO DE HORARIO': 'hist_cambio_horario',
  'MODIFICA HORARIO': 'hist_cambio_horario',
  'MODIFICAR HORARIO': 'hist_cambio_horario',
  'MOVER AGENDA': 'hist_movimiento_agenda',
  'CAMBIO AGENDA': 'hist_movimiento_agenda',
  'CAMBIO DE AGENDA': 'hist_movimiento_agenda',
  'CAMBIA AGENDA': 'hist_movimiento_agenda',
  'MODIFICION AGENDA': 'hist_movimiento_agenda',
  'CONFIRMAR AGENDA': 'hist_movimiento_agenda',
  'CONFIRMACION AGENDA': 'hist_movimiento_agenda',
  CANCELAR: 'hist_movimiento_agenda',
  'ADELANTAR PACIENTES': 'hist_movimiento_agenda',
  ADELANTO: 'hist_movimiento_agenda',
  CIRUGIA: 'hist_cirugia',
  'CUBRE QX': 'hist_cirugia',
  'APOYA CX': 'hist_cirugia',
  'RETRASO QX': 'hist_cirugia',
  'EQUIPO MANTENIMIENTO': 'hist_mantenimiento',
  MANTENIMIENTO: 'hist_mantenimiento',
  MANTEMINIENTO: 'hist_mantenimiento',
  'DISMINUIR PACIENTES': 'hist_disminuir_pacientes',
  'DISMIUIR PACIENTES': 'hist_disminuir_pacientes',
  'DISMINUIR PAC': 'hist_disminuir_pacientes',
  'LLENAR AGENDA': 'hist_llenar_agenda',
  'CAMBIO DE SEDE': 'hist_cambio_sede',
  'CAMBIO SEDE': 'hist_cambio_sede',
  'CAMBIA SEDE': 'hist_cambio_sede',
  'PROGRAMACION MALL': 'hist_cambio_sede',
  'SEDE EXTERNA': 'hist_regional',
  BRIGADA: 'hist_brigada',
  'TERCER NIVEL': 'hist_tercer_nivel',
  'DIA FESTIVO': 'hist_festivo',
}

/** Código del motivo para el tipo escrito en el Excel. */
export function motivoDe(tipoExcel) {
  const t = normalizar(tipoExcel)
  if (!t) return 'hist_otro'
  if (MOTIVO_POR_TIPO[t]) return MOTIVO_POR_TIPO[t]
  if (/^REG(IO|I)NAL\b/.test(t)) return 'hist_regional'   // REGIONAL X, REGINAL X
  if (/^CUBRE\b/.test(t)) return 'hist_regional'
  return 'hist_otro'
}

/** El enum viejo `tipo` es obligatorio: se usa el del motivo si existe. */
const TIPOS_LEGADO = new Set(['enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion'])
export const tipoLegadoDe = (codigoMotivo) => (TIPOS_LEGADO.has(codigoMotivo) ? codigoMotivo : 'otra')

// ---------------------------------------------------------------------------
// Sedes. ALKARAWI se parte: otorrino y audiología atienden en la sede de
// otorrino; el resto en Sede 3 Alkarawi.
// ---------------------------------------------------------------------------
export function sedeDe(sedeExcel, tipoRecurso) {
  const s = normalizar(sedeExcel)
  if (!s) return null
  if (s === 'DOS') return 'Sede 2'
  if (s === 'VIVA' || s === 'SALA AZUL VIVA') return 'Sede Viva'
  if (s === 'ALEGRA') return 'Sede Alegra'
  if (s === 'CARTAGENA') return 'Sede Cartagena'
  if (s === 'ALKARAWI') return ['otorrino', 'fonoaudiologa'].includes(tipoRecurso) ? 'Sede Alkarawi Otorrino' : 'Sede 3 Alkarawi'
  return null   // "SEDE 1", "ASPIRACION DE OIDOS": no se sabe cuál es
}

// ---------------------------------------------------------------------------
// Tipo de profesional según la especialidad escrita en el Excel.
// ---------------------------------------------------------------------------
const TIPO_POR_ESPECIALIDAD = {
  OFTALMOLOGIA: 'oftalmologo', OFTAMLOLOGIA: 'oftalmologo',
  OTORRINOLARINGOLOGIA: 'otorrino', OTORRINO: 'otorrino',
  AUDIOLOGIA: 'fonoaudiologa', AUDIOLOGICO: 'fonoaudiologa', FONOAUDIOLOGIA: 'fonoaudiologa',
  OPTOMETRIA: 'optometra', ORTIOTICA: 'optometra',
}
export const tipoDeEspecialidad = (esp) => TIPO_POR_ESPECIALIDAD[normalizar(esp)] ?? null

/** Tipo de consulta de la tabla de costos para cada tipo de profesional. */
export const CONSULTA_DE_TIPO = {
  oftalmologo: 'oftalmologia', otorrino: 'otorrinolaringologia', fonoaudiologa: 'fonoaudiologia',
  optometra: 'optometria', anestesiologo: 'anestesiologia',
}

// ---------------------------------------------------------------------------
// Subespecialidad del Excel → catálogo. GENERAL depende del tipo. Las que son
// procedimientos (nasofaringolaringoscopia, ecografía…) no son subespecialidad.
// ---------------------------------------------------------------------------
const SUB_OFTALMO = {
  GENERAL: 'Oftalmología general', OFTALMOLOGIA: 'Oftalmología general',
  RETINA: 'Retina y vítreo', GLAUCOMA: 'Glaucoma', GLACUCOMA: 'Glaucoma',
  SEGMENTO: 'Segmento anterior', OCULOPLASTICA: 'Oculoplastia',
  PEDIATRIA: 'Oftalmopediatría', PEDIATRICA: 'Oftalmopediatría', OFTALMOPEDIATRIA: 'Oftalmopediatría',
  CORNEA: 'Córnea y refractiva', 'SUPERFICIE OCULAR': 'Córnea y refractiva',
}
const SUB_OTORRINO = { GENERAL: 'Otorrinolaringología general', OTORRINO: 'Otorrinolaringología general', LARINGOLOGIA: 'Laringología' }
export function subespecialidadDe(tipoRecurso, subExcel) {
  const s = normalizar(subExcel)
  if (!s) return null
  if (tipoRecurso === 'oftalmologo') return SUB_OFTALMO[s] ?? null
  if (tipoRecurso === 'otorrino') return SUB_OTORRINO[s] ?? null
  return null
}

// ---------------------------------------------------------------------------
// Nombres. El Excel usa nombre y apellido; el SGRC el nombre completo. Lo que
// no se resuelve solo (errores de escritura, duplicados del catálogo) va aquí,
// revisado a mano el 29-oct-2026 contra los profesionales de producción.
// ---------------------------------------------------------------------------
export const ALIAS = {
  'GINA CASALES': 'Gina Maria Casale Areyanes',
  'JOHANNA ROMERO': 'Johana Maria Romero Valencia',
  'LESVIA DE LA HOZ': 'Lesbia Maria de la Hoz Fernandez',
  'NOHORA GOMEZ': 'Nora Lucia Gomez Crespo',
  'MARISELA ESCOBAR': 'Maricela Escobar Orozco',
  'PREMATURO MARICELA ESCOBAR': 'Maricela Escobar Orozco',
  'LUPE VANHEYL': 'Lupe Jhoana Katherine Van Heyl Cleves',
  'JENIFER MONTERROZA': 'Jennifer Monterroza Aguas',
  'MARTA TORRES': 'Martha Cecilia Torres Diaz',
  'YLENA CHINCHILLA': 'Ylehana Chinchilla Rojas',
  'VANESA ISHIKANE': 'Vanessa de los Angeles Ishikane Flores',
  'JOSE ROGRIGUEZ': 'José Luis Rodríguez Locarno',
  'YAG JOSE LUIS RODRIGUEZ': 'José Luis Rodríguez Locarno',
  'ERICK ALVAREZ SUR-SANI': 'Erick Alvarez',
  'YAG VERONICA VARGAS': 'Veronica Vargas',
  'VERNONICA VARGAS': 'Veronica Vargas',
  'VERNONICA VARGAS PAC': 'Veronica Vargas',
  'JEANELE GUTIERREZ': 'Jeanelle Gutierrez - 2',
  // Duplicados en el catálogo: se usa la ficha con el nombre completo.
  'PABLO CHAMARTIN': 'Pablo Chamartin Escobar',
  'KIARA ALEMAN': 'Kiara Julizta Aleman Morillo',
  'ALEJANDRO GONZALEZ': 'Alejandro Gonzalez Unimetro 1',
}

/**
 * Profesionales del Excel que no están en el SGRC (fellows y médicos que ya no
 * trabajan). Se crean INACTIVOS para que su historia no se pierda; no
 * aparecen para programar.
 */
export const PROFESIONALES_NUEVOS = {
  'ADRIANA FELLOW': { name: 'Adriana (fellow)', type: 'oftalmologo' },
  'SHIRLEY GAONA': { name: 'Shirley Gaona', type: 'oftalmologo' },
  'MARIO ALBA': { name: 'Mario Alba', type: 'oftalmologo' },
  'DANIEL GARCIA': { name: 'Daniel Garcia', type: 'oftalmologo' },
  'VALENTIN MORALES': { name: 'Valentin Morales', type: 'oftalmologo' },
  'JENIFER RIOS FELLOW': { name: 'Jenifer Rios (fellow)', type: 'oftalmologo' },
  'FELLOW IGNACIO': { name: 'Ignacio (fellow)', type: 'oftalmologo' },
  'MARIA ELISA': { name: 'Maria Elisa', type: 'oftalmologo' },
  'MIGUEL PORTUGAL': { name: 'Miguel Portugal', type: 'oftalmologo' },
}

/** "Médicos" del Excel que en realidad son equipos o procedimientos. */
export const NO_SON_PROFESIONALES = new Set([
  'CAMPO VISUAL', 'OCT CONTIGENCIA', 'TOMOGRAFIA', 'PENTACAM', 'BIOMETRIA', 'CURVA DE PRESION', 'CAPSULOTOMIA FELLOW',
])

/**
 * Busca el recurso del SGRC para un médico del Excel.
 * `recursos`: [{ id, name, type }]. Devuelve { recurso } o { error }.
 */
export function emparejar(medicoExcel, tipoExcel, recursos) {
  const m = normalizar(medicoExcel)
  if (ALIAS[m]) {
    const r = recursos.find((x) => x.name === ALIAS[m])
    return r ? { recurso: r } : { error: `el alias apunta a "${ALIAS[m]}", que no existe` }
  }
  const buscadas = palabras(m)
  if (!buscadas.length) return { error: 'sin nombre' }
  let cands = recursos.filter((r) => {
    const suyas = palabras(r.name)
    return buscadas.every((t) => suyas.some((s) => s === t || (t.length >= 4 && s.startsWith(t))))
  })
  if (cands.length > 1 && tipoExcel) {
    const mismos = cands.filter((r) => r.type === tipoExcel)
    if (mismos.length) cands = mismos
  }
  if (cands.length === 1) return { recurso: cands[0] }
  if (!cands.length) return { error: 'no está en el SGRC' }
  return { error: `varios posibles: ${cands.map((c) => c.name).join(' / ')}` }
}

/**
 * Clave de una fila. Las copias pegadas entre hojas tienen el mismo médico,
 * agenda, fecha, tipo y fecha de reporte: dan la misma clave.
 */
export function claveDeFila({ medico, agenda, fecha, tipo, reportada }) {
  const base = [normalizar(medico), normalizar(agenda), fecha, normalizar(tipo), reportada].join('|')
  return 'hist:' + crypto.createHash('sha1').update(base).digest('hex').slice(0, 40)
}

/** Días de calendario entre dos fechas 'AAAA-MM-DD' (b − a). */
export function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** Fecha de una celda de Excel (Date o texto) → 'AAAA-MM-DD' o null. */
export function fechaDeCelda(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/) ?? v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!m) return null
    return m[0].includes('/') ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : `${m[1]}-${m[2]}-${m[3]}`
  }
  return null
}

/** Número de una celda (los pacientes vienen como 5.0 o "5"). */
export function numeroDeCelda(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n) : null
}

/** REPONE: "SI", "Sí", "NO " → true / false / null. */
export function siNo(v) {
  const s = normalizar(v)
  if (s === 'SI') return true
  if (s === 'NO') return false
  return null
}
