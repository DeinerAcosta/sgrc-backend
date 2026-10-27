/**
 * SUBESPECIALIDADES — catálogo obligatorio (Oct-2026 · PROYECTOS-3800)
 * ====================================================================
 *
 * Nelson, revisando el tablero de Reprogramaciones: "las subespecialidades son
 * opcionales y, como resultado, las especialidades no se están tomando de
 * manera correcta". En producción (27-oct) 32 de 99 oftalmólogos no tenían, y
 * la misma estaba escrita de varias formas ("SEGMENTO ANTERIOR", "Segmento",
 * "Segamento"), así que cada variante salía como una barra distinta.
 *
 * Ahora sale de la tabla `subespecialidades` y es obligatoria para los tipos de
 * TIPOS_CON_SUBESPECIALIDAD. El recurso guarda el NOMBRE del catálogo, así los
 * informes que ya agrupaban por ese texto no cambian.
 *
 * Las funciones de comparación son puras (sin BD) para probarlas aparte.
 */
import { TIPOS_CON_SUBESPECIALIDAD } from './resourceTypes.js'
import { errors } from './errors.js'

/** Clave de comparación: sin tildes, sin mayúsculas y sin espacios de más. */
export function claveSubespecialidad(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Cómo venían escritas antes de existir el catálogo (valores reales de
 * producción) → nombre del catálogo. Lo usa el script de normalización; al
 * validar un dato nuevo solo se acepta el nombre del catálogo.
 */
export const VARIANTES_ANTIGUAS = {
  oftalmologo: {
    'general': 'Oftalmología general',
    'oftalmologia general': 'Oftalmología general',
    'segmento anterior': 'Segmento anterior',
    'segmento': 'Segmento anterior',
    'segamento': 'Segmento anterior',
    'segmento anterior y cornea': 'Segmento anterior',
    'cornea': 'Córnea y refractiva',
    'cornea y refractiva': 'Córnea y refractiva',
    'glaucoma': 'Glaucoma',
    'retina': 'Retina y vítreo',
    'retina y vitreo': 'Retina y vítreo',
    'oculoplastia': 'Oculoplastia',
    'oculopastia': 'Oculoplastia',
    'plastia ocular': 'Oculoplastia',
    'pediatria': 'Oftalmopediatría',
    'pediatra': 'Oftalmopediatría',
    'oftalmopediatria': 'Oftalmopediatría',
    'neurooftalmologia': 'Neuro-oftalmología',
    'neuro oftalmologia': 'Neuro-oftalmología',
  },
  otorrino: {
    'otorrinolaringologia': 'Otorrinolaringología general',
    'otorrinolaringologia general': 'Otorrinolaringología general',
    'otologia': 'Otología',
    'rinologia': 'Rinología',
    'laringologia': 'Laringología',
  },
}

/**
 * Subespecialidades que delatan otro tipo de recurso: un oftalmólogo con
 * "Otorrinolaringología" casi seguro es un otorrino registrado con el tipo
 * equivocado. No se corrigen solas: el script las lista para revisión.
 */
export const DE_OTRO_TIPO = {
  oftalmologo: ['otorrinolaringologia', 'otologia', 'rinologia', 'laringologia'],
}

export const exigeSubespecialidad = (tipo) => TIPOS_CON_SUBESPECIALIDAD.has(tipo)

/**
 * Busca `valor` en el catálogo de ese tipo (lista de nombres). Devuelve el
 * nombre tal como está en el catálogo, o null si no está.
 */
export function enCatalogo(nombres, valor) {
  const k = claveSubespecialidad(valor)
  if (!k) return null
  return nombres.find((n) => claveSubespecialidad(n) === k) ?? null
}

/** Para el script: el nombre del catálogo que corresponde a un valor viejo. */
export function normalizarAntigua(tipo, valor, nombres) {
  return enCatalogo(nombres, valor) ?? (() => {
    const destino = VARIANTES_ANTIGUAS[tipo]?.[claveSubespecialidad(valor)]
    return destino && nombres.includes(destino) ? destino : null
  })()
}

/** Nombres activos del catálogo para un tipo, en su orden. */
export async function nombresDelCatalogo(db, tipo) {
  const filas = await db.subspecialty.findMany({
    where: { resourceType: tipo, active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { name: true },
  })
  return filas.map((f) => f.name)
}

/**
 * Valida la subespecialidad de un recurso y devuelve lo que se debe guardar:
 *   - tipo que la exige → el nombre del catálogo; si falta o no está, 400.
 *   - otro tipo         → el texto tal cual (o null), como antes.
 * `obligatoria: false` deja pasar el vacío (lo usa la edición que no la toca).
 */
export async function resolverSubespecialidad(db, tipo, valor, { obligatoria = true } = {}) {
  if (!exigeSubespecialidad(tipo)) return valor?.trim() ? valor.trim() : null
  if (!claveSubespecialidad(valor)) {
    if (!obligatoria) return null
    throw errors.badRequest('La subespecialidad es obligatoria.', { field: 'specialty' })
  }
  const nombres = await nombresDelCatalogo(db, tipo)
  const nombre = enCatalogo(nombres, valor)
  if (!nombre) {
    throw errors.badRequest(
      `"${valor}" no está en el catálogo de subespecialidades. Elige una de la lista.`,
      { field: 'specialty', opciones: nombres },
    )
  }
  return nombre
}
