/**
 * One-shot: la semana 2026-06-07 → 2026-06-13 nadie la cerró realmente
 * (el flujo viejo era global y los nombres que quedaron son artefactos de
 * la migración). Marcar TODOS sus cierres como Sistema (cerradaPor=null).
 *
 * La semana 14-20 jun y las que vienen quedan tal cual (los registros reales).
 */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const sem = await p.week.findFirst({
  where: { startDate: new Date('2026-06-07T00:00:00.000Z') },
})
if (!sem) { console.log('No se encontró la semana 7-13 jun'); process.exit(0) }

const r = await p.cierreSemanaSede.updateMany({
  where: { weekId: sem.id },
  data: { closedBy: null, reason: 'Semana cerrada antes del refactor por-sede — atribuido al Sistema' },
})

// Marcar también la propia semana como cerrada por Sistema (coherencia)
await p.week.update({
  where: { id: sem.id },
  data: { closedBy: null },
})

console.log(`\n✅ ${r.count} cierres de la semana 2026-06-07 → 2026-06-13 marcados como Sistema.`)
await p.$disconnect()
