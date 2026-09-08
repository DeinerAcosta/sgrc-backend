/**
 * MODO DE PROGRAMACIÓN LIBRE  —  interruptor temporal
 * ===================================================
 *
 * Con PROGRAMACION_LIBRE=true los coordinadores pueden programar sin las
 * restricciones de calendario: semanas ya vencidas, y sedes cuyo cierre semanal
 * ya se procesó. Pensado para cuadres retroactivos (cargar el mes pasado).
 *
 * QUÉ LEVANTA (todo lo demás sigue igual):
 *   · Crear semanas con fecha pasada  ........... semanaController.create / copiar
 *   · Crear / editar asignaciones en sede cerrada  asignacionService
 *   · Copiar hacia o desde una semana cerrada  ... asignacionController, semanaController
 *   · Copiar en lote hacia una sede cerrada  .... validacionLote (vía copiaAsignaciones)
 *   · El auto-cierre nocturno se salta  ......... jobs/autoCierreSemana
 *     (si no, el job de las 2am volvería a cerrar cada noche lo que se abrió)
 *
 * QUÉ NO TOCA — sigue vigente y protegiendo:
 *   · Solapes de recurso y de auxiliar (RN-08)
 *   · Una sola ciudad por día (RN-09)
 *   · Tope diario de horas (RN-13)
 *   · Permisos por rol y aislamiento por sede
 *   · Registro de auditoría de todo lo que se toca
 *
 * PARA VOLVER A LA NORMALIDAD: quitar la variable del .env (o ponerla en false)
 * y reiniciar el backend. No hay que tocar código ni migrar nada. Las semanas
 * que quedaron sin cerrar las cerrará el job nocturno en su siguiente pasada.
 *
 * El arranque lo avisa por consola en grande, a propósito: es un modo temporal
 * y no debería quedarse puesto por olvido.
 */

export function programacionLibre(env = process.env) {
  return String(env.PROGRAMACION_LIBRE ?? 'false').toLowerCase() === 'true'
}

/** Mensaje de arranque. Devuelve null si el modo está apagado. */
export function avisoProgramacionLibre(env = process.env) {
  if (!programacionLibre(env)) return null
  return [
    '',
    '  ⚠️  PROGRAMACIÓN LIBRE ACTIVADA  (PROGRAMACION_LIBRE=true)',
    '     · Se pueden crear y editar semanas vencidas y sedes ya cerradas.',
    '     · El auto-cierre nocturno está en pausa.',
    '     · Los solapes, topes de horas y permisos por rol SIGUEN validándose.',
    '     Quitar la variable del .env y reiniciar para volver a la normalidad.',
    '',
  ].join('\n')
}
