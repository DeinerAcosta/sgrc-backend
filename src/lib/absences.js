// PROYECTOS-3255 #1.3: tipos de ausencia (enum TipoAusencia) que se consideran
// incapacidad medica y NO deben penalizar al recurso en los indicadores.
// 'licencia_remunerada' esta etiquetado como "Equivale a Incapacidad" en la
// migracion 20260826170000_motivo_familia_y_regional (UPDATE final).
// NOTA: 'medico' NO existe como family en motivos_ausencia (las familias son
// ausencia_profesional | reprogramacion_operativa | ajuste_cupos |
// movilidad_regional | calendario_festivo | otros). Por eso filtramos por
// TYPE del enum legacy, que si es reliable.
export const TIPOS_INCAPACIDAD_QUE_NO_PENALIZAN = ['enfermedad', 'licencia_remunerada']

// Clausula WHERE reutilizable para prisma.absence.findMany. Devuelve las
// ausencias CONFIRMADAS de incapacidad que solapan [desde, hasta] (acepta
// Date | string ISO en cualquiera de los dos extremos).
export function whereAusenciasIncapacidadEnRango(desde, hasta) {
  return {
    status: 'confirmada',
    type: { in: TIPOS_INCAPACIDAD_QUE_NO_PENALIZAN },
    startDate: { lte: new Date(hasta) },
    endDate: { gte: new Date(desde) },
  }
}
