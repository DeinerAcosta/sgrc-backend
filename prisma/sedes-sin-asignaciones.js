import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

// Buscar la semana del 14-20 jun (la del lunes 15 al domingo 21 cae acá)
const semana = await p.week.findFirst({
  where: { startDate: new Date('2026-06-14T00:00:00.000Z') },
})
if (!semana) { console.log('No se encontró la semana 14-20 jun'); process.exit(0) }

console.log(`\n══ Semana 2026-06-14 → 2026-06-20 ══\n`)

const sedesActivas = await p.site.findMany({
  where: { active: true },
  orderBy: { name: 'asc' },
})

const asigsPorSede = await p.assignment.groupBy({
  by: ['consultorioId'],
  where: { weekId: semana.id, status: { not: 'cancelada' } },
  _count: { _all: true },
})

// Mapear consultorioId → sedeId
const cons = await p.room.findMany({
  where: { id: { in: asigsPorSede.map((a) => a.roomId) } },
  select: { id: true, siteId: true },
})
const consSede = new Map(cons.map((c) => [c.id, c.siteId]))
const sedesConAsigs = new Map()
for (const a of asigsPorSede) {
  const sid = consSede.get(a.roomId)
  if (!sid) continue
  sedesConAsigs.set(sid, (sedesConAsigs.get(sid) ?? 0) + a._count._all)
}

const sinAsigs = sedesActivas.filter((s) => !sedesConAsigs.has(s.id))
const conAsigs = sedesActivas.filter((s) => sedesConAsigs.has(s.id))

console.log(`── ${sinAsigs.length} SEDES SIN ASIGNACIONES esa semana ──\n`)
for (const s of sinAsigs) {
  console.log(`  • ${s.name} (${s.city})`)
}

console.log(`\n── ${conAsigs.length} sedes con asignaciones (para referencia) ──\n`)
for (const s of conAsigs) {
  console.log(`  ✓ ${s.name.padEnd(28)} ${sedesConAsigs.get(s.id)} asignaciones`)
}

await p.$disconnect()
