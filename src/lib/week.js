import { prisma as defaultPrisma } from './prisma.js'

/**
 * La "semana actual" es la que contiene HOY — o sea, la semana más reciente
 * cuya fechaInicio ya pasó. Esto NO es lo mismo que "la semana abierta más
 * reciente" (esa podría ser una semana futura que se creó por anticipado).
 *
 * Acepta un cliente Prisma opcional (útil dentro de transacciones).
 */
export async function getSemanaActual(client = defaultPrisma) {
  return client.week.findFirst({
    where: { startDate: { lte: new Date() } },
    orderBy: { startDate: 'desc' },
  })
}

/** Semana inmediatamente anterior a la actual (para deltas). */
export async function getSemanaAnterior(client = defaultPrisma) {
  const actual = await getSemanaActual(client)
  if (!actual) return null
  return client.week.findFirst({
    where: { startDate: { lt: actual.startDate } },
    orderBy: { startDate: 'desc' },
  })
}
