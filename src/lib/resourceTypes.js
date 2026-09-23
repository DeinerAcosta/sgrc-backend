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
