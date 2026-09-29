import crypto from 'crypto'

/**
 * HUELLA DEL RESUMEN DIARIO DEL COORDINADOR
 * =========================================
 *
 * Es lo que evita que el coordinador reciba siete veces la misma lista en una
 * semana: la programacion es semanal y casi no se mueve entre lunes y domingo,
 * pero el job corre todos los dias. La huella se guarda en `referenceId` de la
 * notificacion enviada, y la corrida del dia siguiente la compara antes de
 * mandar nada (ver jobs/alerts.js).
 *
 * Vive aparte de alerts.js a proposito: ahi dentro arrastraria Prisma y no se
 * podria probar sin base de datos. Es una funcion pura — mismo patron que
 * lib/resourceTypes.js y lib/fechas.js.
 *
 * Que entra en la huella y por que:
 *   · el id de la SEMANA — al abrir una semana nueva todo el mundo arranca sin
 *     programar; sin esto el primer resumen de la semana no saldria nunca.
 *   · los ids del bloque "sin programacion".
 *   · los ids del bloque "por completar" JUNTO CON SUS HORAS — si alguien pasa
 *     de 10 h a 30 h la situacion mejoro de verdad y el coordinador quiere
 *     verlo, aunque siga apareciendo en la lista.
 *   · un separador entre los dos bloques, para que el mismo recurso en uno o en
 *     otro no produzca la misma huella.
 *
 * @param {string} semanaId
 * @param {Array<{id: string}>} sinProgramar
 * @param {Array<{id: string, horas: number}>} porCompletar
 * @returns {string} 40 caracteres hexadecimales
 */
export function huellaResumen(semanaId, sinProgramar = [], porCompletar = []) {
  const partes = [
    semanaId,
    ...sinProgramar.map((r) => r.id).sort(),
    '|',
    ...porCompletar.map((r) => `${r.id}:${r.horas}`).sort(),
  ]
  return crypto.createHash('sha1').update(partes.join(',')).digest('hex').slice(0, 40)
}
