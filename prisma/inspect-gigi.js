import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const gigi = await p.resource.findFirst({
  where: { name: { contains: 'Gigi' } },
})
if (!gigi) { console.log('No encontrada'); process.exit(0) }

console.log(`\n── Recurso: ${gigi.name} ──`)
console.log(`  ID:                ${gigi.id.slice(0,8)}`)
console.log(`  Tipo:              ${gigi.type}`)
console.log(`  Especialidad:      ${gigi.specialty}`)
console.log(`  Intervalo minutos: ${gigi.slotMinutes ?? '(no configurado, default 15)'}`)
console.log(`  Esquema pago:      ${gigi.payScheme}`)
console.log(`  Multi-consultorio: ${gigi.multiRoom}`)

// Sus asignaciones de la semana actual
const semanaActual = await p.week.findFirst({
  where: { status: 'abierta' },
  orderBy: { startDate: 'desc' },
})
console.log(`\n── Semana actual: ${semanaActual?.startDate?.toISOString().slice(0,10)} ──`)

const asigs = await p.assignment.findMany({
  where: { resourceId: gigi.id, weekId: semanaActual?.id, status: { not: 'cancelada' } },
  include: { room: { select: { name: true } } },
  orderBy: { weekday: 'asc' },
})

console.log(`\nAsignaciones de la semana: ${asigs.length}`)
let totalPac = 0
for (const a of asigs) {
  const hi = a.startTime, hf = a.endTime
  const [h1, m1] = hi.split(':').map(Number)
  const [h2, m2] = hf.split(':').map(Number)
  const minutos = (h2*60+m2) - (h1*60+m1)
  const almuerzo = minutos >= 360 ? 60 : 0
  const intervalo = gigi.slotMinutes ?? 15
  const calc = Math.floor((minutos - almuerzo) / intervalo)
  console.log(`  ${a.weekday.padEnd(10)} ${hi}-${hf}  ${a.room?.name ?? '?'}  → guardado=${a.patientCapacity}  (recalc: ${minutos}min - ${almuerzo}almuerzo = ${minutos-almuerzo}/${intervalo}min = ${calc})`)
  totalPac += a.patientCapacity ?? 0
}
console.log(`\nTotal pacientes capacidad semana: ${totalPac}`)

await p.$disconnect()
