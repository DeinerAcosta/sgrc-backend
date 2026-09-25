/**
 * TIPOS DE RECURSO — fuente unica
 * ===============================
 *
 * Debe coincidir EXACTAMENTE con el enum `TipoRecurso` de prisma/schema.prisma
 * y con TIPOS_RECURSO en el frontend (src/utils/helpers.js).
 *
 * Por que existe este archivo (sep-2026): la lista estaba copiada a mano en
 * cinco sitios del backend y se desincronizo. `otorrino` se agrego a la BD en
 * la migracion 20260707130000_add_otorrino y al desplegable del frontend, pero
 * NO a las listas de validacion, asi que crear un usuario de tipo Otorrino
 * rebotaba con "Datos invalidos" sin decir por que. Lo mismo le pasaba a
 * `fonoaudiologa` en el registro publico.
 *
 * Al agregar un tipo nuevo hay que tocar TRES lugares y ninguno mas:
 *   1. enum TipoRecurso en schema.prisma (+ migracion)
 *   2. esta constante
 *   3. TIPOS_RECURSO en el frontend
 */
export const TIPOS_RECURSO = [
  'oftalmologo',
  'optometra',
  'anestesiologo',
  'asesor_servicios',
  'auxiliar',
  'tecnico',
  'fonoaudiologa',
  'otorrino',
]

/** Version Set, para los chequeos de pertenencia (carga en lote). */
export const TIPOS_RECURSO_SET = new Set(TIPOS_RECURSO)

/**
 * Tipos cuyo esquema de pago es "por paciente": sin tope semanal contractual,
 * sin subespecialidad ni multi-consultorio. NO es la lista completa — es una
 * regla de negocio aparte, no derivable de la de arriba.
 */
export const TIPOS_POR_PACIENTE = new Set(['oftalmologo', 'fonoaudiologa'])

/** Esquemas de pago validos. Debe coincidir con el enum EsquemaPago del schema. */
export const ESQUEMAS_PAGO = ['por_paciente', 'fijo', 'mixto']
export const ESQUEMAS_PAGO_SET = new Set(ESQUEMAS_PAGO)

/** Jornada semanal por defecto — Ley 2101 vigente (44h hasta el 14-jul-2026). */
export const HORAS_SEMANA_POR_DEFECTO = 44

/**
 * INVARIANTE esquema de pago ↔ tope semanal
 * =========================================
 *
 * El esquema de pago no es un dato de nomina (el SGRC no paga a nadie): es el
 * interruptor que decide si a ese recurso se le mide tiempo ocioso. Solo lo
 * consumen cuatro sitios, y los dos primeros filtran por `payScheme`:
 *
 *   1. Informe "Tiempos ociosos"  → payScheme IN (fijo, mixto)
 *   2. Job de alertas RN-25       → payScheme IN (fijo, mixto)
 *   3. Incentivo acumulado        → solo 'mixto'
 *   4. Motivos de licencia        → solo 'fijo'
 *
 * De ahi la regla, que hasta ahora no estaba escrita en ninguna parte:
 *
 *   payScheme === 'por_paciente'  ⇔  maxHoursPerWeek === null
 *
 * Sin tope no hay denominador, y sin denominador no hay porcentaje de
 * utilizacion que comparar contra una meta.
 *
 * POR QUE HIZO FALTA (sep-2026). En produccion habia 94 oftalmologos con
 * `esquema_pago = 'fijo'` y `horas_max_semana = NULL` — el 100% de los que
 * estaban en 'fijo'. Entraban al informe de ociosos por el filtro, pero sin
 * tope el calculo devolvia 0%: aparecian en rojo con 32,5 h asignadas y
 * engordaban el KPI "Recursos con tiempo ocioso" (262 en vez de 166).
 *
 * El estado lo producia la carga en lote de usuarios, que decidia cada campo
 * por su cuenta: el tope mirando el TIPO (oftalmologo ⇒ null) y el esquema
 * tomando lo que viniera en el CSV (⇒ 'fijo'). Un CSV con esquemaPago=fijo
 * generaba la combinacion imposible sin un solo error. Y no se podia arreglar
 * a mano porque el formulario de administracion escondia la casilla de horas
 * mirando tambien el tipo: con tipo oftalmologo la casilla no existia en
 * pantalla.
 *
 * Ahora todas las escrituras pasan por aqui, asi que la combinacion ya no es
 * representable. El tipo solo aporta el DEFECTO del esquema cuando no se
 * declara uno; a partir de ahi manda el esquema, nunca el tipo.
 *
 * @param {object} p
 * @param {string} [p.type]              tipo de recurso (solo da el defecto)
 * @param {string} [p.payScheme]         esquema declarado, si viene
 * @param {number|null} [p.maxHoursPerWeek] tope declarado, si viene
 * @returns {{payScheme: string, maxHoursPerWeek: number|null}}
 */
export function normalizarEsquemaYTope({ type, payScheme, maxHoursPerWeek } = {}) {
  const esquema = ESQUEMAS_PAGO_SET.has(payScheme)
    ? payScheme
    : (TIPOS_POR_PACIENTE.has(type) ? 'por_paciente' : 'fijo')

  return esquema === 'por_paciente'
    ? { payScheme: esquema, maxHoursPerWeek: null }
    : { payScheme: esquema, maxHoursPerWeek: maxHoursPerWeek ?? HORAS_SEMANA_POR_DEFECTO }
}
