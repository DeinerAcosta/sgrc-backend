/**
 * ¿LA AUSENCIA ES REMUNERADA? (PROYECTOS-3739 punto 1)
 *
 * "Esta relación debe indicar si la ausencia es remunerada o no remunerada.
 * Agendas es responsable de asignar este dato, que aplica para todos los tipos
 * de ausencia excepto licencia remunerada."
 *
 *   - Al registrar, sale de lo que se eligió en el primer nivel del formulario
 *     ("¿La ausencia es remunerada?"); si no viene, del tipo.
 *   - Agendas lo puede cambiar después (es_remunerada en la base).
 *   - La licencia remunerada lo es siempre: no se cambia.
 *
 * Es el mismo reparto de GRUPOS_TIPO_AUSENCIA del frontend. Pura, para
 * probarla sin base de datos.
 */
export const TIPOS_REMUNERADOS = new Set(['enfermedad', 'calamidad', 'familiar', 'academico', 'vacaciones', 'licencia_remunerada'])
export const SIEMPRE_REMUNERADA = 'licencia_remunerada'

export const esRemunerada = (a) =>
  a?.type === SIEMPRE_REMUNERADA ? true : (a?.isPaid ?? TIPOS_REMUNERADOS.has(a?.type))

export const sePuedeCambiarRemuneracion = (a) => a?.type !== SIEMPRE_REMUNERADA
