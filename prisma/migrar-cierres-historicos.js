/**
 * Migración one-shot: las semanas YA cerradas en `Semana` (estado='cerrada')
 * se migran a la tabla `CierreSemanaSede` creando una fila por cada sede activa
 * con asignaciones en esa semana. Mantiene el mismo cerradaPor + cerradaEn del
 * registro original — el histórico queda íntegro.
 *
 * Idempotente: si ya existe la fila (semanaId, sedeId), no la duplica.
 */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const semanasCerradas = await p.week.findMany({ where: { status: 'cerrada' } })
console.log(`\n══ Migrando ${semanasCerradas.length} semanas cerradas a CierreSemanaSede ══\n`)

let creados = 0
let saltados = 0
for (const sem of semanasCerradas) {
  // Sedes que tenían asignaciones en esa semana
  const asigs = await p.assignment.findMany({
    where: { weekId: sem.id, status: { not: 'cancelada' } },
    include: { room: { select: { siteId: true } } },
  })
  const sedeIds = [...new Set(asigs.map((a) => a.room.siteId))]
  if (sedeIds.length === 0) {
    // Semana cerrada sin asignaciones — crear cierre para TODAS las sedes activas
    // (es la interpretación más conservadora: "todas estaban cerradas").
    const todas = await p.site.findMany({ where: { active: true }, select: { id: true } })
    sedeIds.push(...todas.map((s) => s.id))
  }
  for (const sedeId of sedeIds) {
    const yaExiste = await p.cierreSemanaSede.findFirst({ where: { weekId: sem.id, siteId: sedeId } })
    if (yaExiste) { saltados++; continue }
    await p.cierreSemanaSede.create({
      data: {
        weekId: sem.id,
        siteId: sedeId,
        closedBy: sem.closedBy,
        closedAt: sem.closedAt ?? sem.updatedAt,
        reason: 'Migración histórica desde Semana.estado=cerrada',
      },
    })
    creados++
  }
}

console.log(`✅ Creados: ${creados}`)
console.log(`⏭️  Saltados (ya existían): ${saltados}`)
await p.$disconnect()
