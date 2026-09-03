import { prisma } from '../lib/prisma.js'

/**
 * Retención del log de auditoría.
 *
 * La tabla `auditoria` guarda una fila con dos columnas JSON por cada mutación
 * crítica y por cada exportación de informe, y nadie la purgaba nunca: crecía
 * de forma indefinida. Las consultas siguen siendo rápidas (hay índice por
 * fecha) pero el tamaño en disco y los backups no paran de subir.
 *
 * RETENCIÓN POR DEFECTO: 24 meses. Es un valor conservador pensado para que
 * cubra cualquier requisito de trazabilidad razonable de la clínica; ajústalo
 * con AUDITORIA_RETENCION_MESES cuando esté confirmado el plazo legal que
 * aplica. Con 0 el job no borra nada (retención indefinida, como hasta ahora).
 *
 * Se borra por lotes para no bloquear la tabla con un DELETE gigante la primera
 * vez que se ejecute sobre un histórico grande.
 */

export const RETENCION_MESES_POR_DEFECTO = 24
const TAMANO_LOTE = 1000
const MAX_LOTES = 100   // tope de seguridad: 100.000 filas por ejecución

export function mesesDeRetencion(env = process.env) {
  const bruto = env.AUDITORIA_RETENCION_MESES
  if (bruto === undefined || bruto === '') return RETENCION_MESES_POR_DEFECTO
  const n = Number(bruto)
  if (!Number.isFinite(n) || n < 0) return RETENCION_MESES_POR_DEFECTO
  return n
}

/** Fecha límite: todo lo anterior es purgable. */
export function fechaCorte(meses, ahora = new Date()) {
  const d = new Date(ahora)
  d.setUTCMonth(d.getUTCMonth() - meses)
  return d
}

export async function jobPurgarAuditoria(client = prisma) {
  const meses = mesesDeRetencion()
  if (meses === 0) {
    return { purgadas: 0, meses, reason: 'retención indefinida (AUDITORIA_RETENCION_MESES=0)' }
  }

  const corte = fechaCorte(meses)
  let purgadas = 0

  for (let lote = 0; lote < MAX_LOTES; lote++) {
    // Se seleccionan ids primero y se borran por id: así el DELETE es acotado y
    // no recorre la tabla entera en cada vuelta.
    const viejas = await client.auditEntry.findMany({
      where: { createdAt: { lt: corte } },
      select: { id: true },
      take: TAMANO_LOTE,
    })
    if (viejas.length === 0) break

    const { count } = await client.auditEntry.deleteMany({
      where: { id: { in: viejas.map((a) => a.id) } },
    })
    purgadas += count
    if (viejas.length < TAMANO_LOTE) break
  }

  return { purgadas, meses, corte: corte.toISOString().slice(0, 10) }
}
