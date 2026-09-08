import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

// Semana actual
const sem = await p.week.findFirst({
  where: { startDate: new Date('2026-06-14T00:00:00.000Z') },
})

const asigs = await p.assignment.findMany({
  where: {
    weekId: sem.id,
    status: { not: 'cancelada' },
    resource: { type: 'asesor_servicios' },
  },
  include: {
    room: { include: { site: { select: { name: true } } } },
    resource: { select: { id: true, name: true, maxHoursPerWeek: true } },
  },
})

const horasFranja = (hi, hf) => {
  const [h1, m1] = hi.split(':').map(Number)
  const [h2, m2] = hf.split(':').map(Number)
  return ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60
}

const porSede = new Map()
for (const a of asigs) {
  const sn = a.room.site.name
  if (!porSede.has(sn)) porSede.set(sn, { asesores: new Map(), h_asignadas: 0 })
  const g = porSede.get(sn)
  g.asesores.set(a.resource.id, { name: a.resource.name, tope: a.resource.maxHoursPerWeek ?? 42 })
  g.h_asignadas += horasFranja(a.startTime, a.endTime)
}

console.log(`\n══ Asesores activos por sede — semana 14-20 jun ══\n`)
const orden = [...porSede.entries()].sort((a, b) => b[1].h_asignadas - a[1].h_asignadas)
for (const [sn, g] of orden) {
  const arr = [...g.asesores.values()]
  const h_base = arr.reduce((acc, a) => acc + a.tope, 0)
  const pct = h_base > 0 ? Math.round((g.h_asignadas / h_base) * 100) : 0
  const semaforo = pct >= 80 ? '🟢' : pct >= 70 ? '🟡' : '🔴'
  console.log(`${semaforo} ${sn.padEnd(28)} ${arr.length} asesores × ${arr[0]?.tope ?? '?'}h = ${h_base}h base · ${g.h_asignadas.toFixed(1)}h asign · ${pct}%`)
  for (const a of arr) console.log(`   - ${a.name} (tope ${a.tope}h)`)
  console.log()
}

await p.$disconnect()
