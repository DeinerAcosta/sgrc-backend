import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const gigi = await p.resource.findFirst({ where: { name: { contains: 'Gigi' } } })

// TODAS sus asignaciones, agrupadas por semana
const asigs = await p.assignment.findMany({
  where: { resourceId: gigi.id, status: { not: 'cancelada' } },
  include: { room: { select: { name: true } }, week: { select: { startDate: true } } },
  orderBy: [{ week: { startDate: 'asc' } }, { weekday: 'asc' }],
})

console.log(`Total asignaciones históricas de Gigi: ${asigs.length}\n`)
let semanaActual = null
for (const a of asigs) {
  const sem = a.week?.startDate?.toISOString().slice(0,10) ?? '?'
  if (sem !== semanaActual) {
    console.log(`\n── Semana ${sem} ──`)
    semanaActual = sem
  }
  console.log(`  ${a.weekday.padEnd(10)} ${a.startTime}-${a.endTime}  ${a.room?.name ?? '?'}  → ${a.patientCapacity} pacientes`)
}

await p.$disconnect()
