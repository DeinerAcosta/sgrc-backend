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
 * Tipos cuyo esquema de pago es "por paciente": SIN TOPE SEMANAL contractual.
 * Es una regla de negocio aparte, no derivable de la lista de tipos.
 *
 * Es solo el DEFECTO que propone el formulario al elegir el tipo. La regla real
 * la marca el esquema de pago (ver normalizarEsquemaYTope).
 *
 * Oct-2026 · se agrega 'otorrino' por decision de Hector: el otorrino opera
 * igual que el oftalmologo y tampoco tiene tope semanal. El comentario anterior
 * decia "sin subespecialidad ni multi-consultorio", lo cual era falso incluso
 * para el oftalmologo — es el tipo multi-consultorio por excelencia y el unico
 * con subespecialidad. Esas dos cosas no tienen que ver con el esquema de pago.
 */
export const TIPOS_POR_PACIENTE = new Set(['oftalmologo', 'fonoaudiologa', 'otorrino'])

/**
 * TIPOS CON AGENDA PROPIA DE PACIENTES
 * ====================================
 *
 * Son los que tienen agenda propia, y coinciden uno a uno con las
 * especialidades que tienen costo de reprogramacion cargado.
 *
 * Auxiliares y asesores de servicios quedan FUERA: no tienen agenda propia,
 * acompanan la consulta de otro.
 *
 * Oct-2026 · vivia en services/absenceService.js. Se mueve aqui porque dejo de
 * ser un detalle del calculo de impacto: ahora tambien decide quien necesita
 * intervalo por paciente. absenceService la re-exporta, asi que todo lo que la
 * importaba de alli sigue funcionando. Aqui ademas se puede probar sin BD,
 * porque este archivo no tiene dependencias.
 */
export const TIPOS_QUE_IMPACTAN_PACIENTES = new Set([
  'oftalmologo',
  'anestesiologo',
  'otorrino',
  'tecnico',
  'fonoaudiologa',
  'optometra',
])

/**
 * MULTI-CONSULTORIO — quien puede cubrir varias salas en paralelo
 * ===============================================================
 *
 * El medico rota entre 2-3 consultorios y en cada uno hay una auxiliar
 * manejando la sala. Activarlo cambia DOS cosas en el programador, y las dos
 * van juntas o el modelo no cierra:
 *
 *   1. Se salta la validacion RN-08 de "el recurso ya esta ocupado en esa
 *      franja": puede quedar asignado a dos consultorios a la misma hora.
 *   2. Las horas del dia se cuentan por UNION DE INTERVALOS, no por suma.
 *      Estar en dos salas de 8 a 12 cuenta 4 horas, no 8. Sin esto el tope
 *      diario se reventaria en el segundo consultorio.
 *
 * Oct-2026 · se agrega 'otorrino'. Hasta ahora la regla estaba escrita a mano
 * como `type === 'oftalmologo'` en tres lugares de userController y dos del
 * frontend, asi que no habia forma de activarla para un otorrino desde la
 * aplicacion — ni siquiera marcando la casilla, porque no se renderizaba.
 *
 * El otorrino opera igual: tiene agenda propia, la auxiliar le es OBLIGATORIA
 * en consultorio (ESPECIALIDADES_EXIGEN_APOYO en lib/timeSlots.js) y hay 7
 * consultorios de otorrino en produccion. El motor de asignaciones ya era
 * agnostico al tipo: lee la bandera del recurso.
 *
 * OJO al agregar un tipo aqui: solo vale si de verdad rota entre salas. Si
 * atiende una sala a la vez, la union de intervalos le dejaria registrar horas
 * que no trabajo.
 */
export const TIPOS_MULTI_CONSULTORIO = new Set(['oftalmologo', 'otorrino'])

/** @param {string} type @returns {boolean} */
export function puedeMultiConsultorio(type) {
  return TIPOS_MULTI_CONSULTORIO.has(type)
}

/**
 * INTERVALO POR PACIENTE — quien necesita minutos por cita
 * ========================================================
 *
 * `intervalo_minutos` es lo que divide la franja para calcular la capacidad de
 * pacientes de una asignacion. Lo necesita exactamente quien tiene agenda
 * propia, asi que es el MISMO conjunto que TIPOS_QUE_IMPACTAN_PACIENTES y no
 * una lista aparte.
 *
 * Oct-2026 · existian como dos listas separadas y se desincronizaron:
 * 'otorrino' estaba en la de impacto pero faltaba en la del formulario. El
 * campo no se renderizaba para otorrino, pero el formulario seguia enviando el
 * valor por defecto, asi que cada otorrino quedaba con 10 minutos por paciente
 * que nadie eligio, nadie veia y nadie podia cambiar — y ese numero calculaba
 * la capacidad de su agenda.
 */
export function requiereIntervaloPorPaciente(type) {
  return TIPOS_QUE_IMPACTAN_PACIENTES.has(type)
}

/**
 * RN-24 · QUIEN LIBERA A SU AUXILIAR AL FALTAR
 * ============================================
 *
 * Si el medico falta, la auxiliar que lo acompana queda sin nada que hacer en
 * ese consultorio: el sistema la libera para que se le pueda asignar apoyo en
 * otra sala o una tarea de backoffice.
 *
 * Oct-2026 · se agrega 'otorrino', y es el caso mas claro de los tres: a los
 * consultorios de otorrino la auxiliar les es OBLIGATORIA, asi que si el
 * otorrino falta, la auxiliar quedaba en una sala sin medico y el sistema no la
 * liberaba. Vivia como constante local en services/absenceService.js.
 */
export const TIPOS_QUE_LIBERAN_AUXILIAR = new Set(['oftalmologo', 'anestesiologo', 'otorrino'])

/**
 * QUIEN ROTA ENTRE SEDES Y NO TIENE COORDINADOR LIDER FIJO
 * ========================================================
 *
 * Al crear el recurso no se le asigna coordinador lider: no pertenece a una
 * sede, pasa por varias. El resto (auxiliares, tecnicos, fonoaudiologas,
 * asesores) si queda con lider porque trabaja estable en su sede.
 *
 * Oct-2026 · se agrega 'otorrino': hay 7 consultorios repartidos y rota igual
 * que el oftalmologo.
 */
export const TIPOS_SIN_COORDINADOR_LIDER = new Set(['oftalmologo', 'anestesiologo', 'otorrino'])

/**
 * QUIEN TIENE SUBESPECIALIDAD
 * ===========================
 *
 * `specialty` es TEXTO LIBRE (VarChar 100), no una lista cerrada: el
 * oftalmologo pone Retina / Cornea / Glaucoma, el otorrino pondria Otologia /
 * Rinologia / Laringologia. Lo unico que cambia por tipo es el ejemplo que
 * sugiere el formulario.
 *
 * Oct-2026 · se agrega 'otorrino'.
 */
export const TIPOS_CON_SUBESPECIALIDAD = new Set(['oftalmologo', 'otorrino'])

/**
 * ETIQUETAS LEGIBLES — fuente unica
 * =================================
 *
 * Oct-2026 · habia dos copias de este mapa: una completa en jobs/alerts.js y
 * una incompleta en controllers/authController.js, a la que le faltaban
 * 'otorrino' y 'fonoaudiologa' Y ADEMAS tenia la clave 'assistant' en vez de
 * 'auxiliar' — otra fuga del renombrado a ingles. El correo al supervisor decia
 * "auxiliar" y "otorrino" en crudo en vez del nombre legible.
 */
export const TIPO_RECURSO_LABEL = {
  oftalmologo:      'Oftalmólogo',
  optometra:        'Optómetra',
  anestesiologo:    'Anestesiólogo',
  asesor_servicios: 'Asesor de servicios',
  auxiliar:         'Auxiliar de enfermería',
  tecnico:          'Técnico de diagnóstico',
  fonoaudiologa:    'Fonoaudióloga',
  otorrino:         'Otorrino',
}

/** Etiqueta legible de un tipo; cae al codigo si el tipo es desconocido. */
export const etiquetaTipoRecurso = (type) => TIPO_RECURSO_LABEL[type] ?? type

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
