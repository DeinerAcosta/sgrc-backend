import { PrismaClient } from '@prisma/client'
import { horasEfectivasFranja } from '../src/lib/horarios.js'

const p = new PrismaClient()

// Semana 22-28 jun 2026 (la que aparece en el screenshot)
const semana = await p.week.findFirst({
  where: {
    startDate: { lte: new Date('2026-06-22T23:59:59Z') },
    endDate: { gte: new Date('2026-06-22T00:00:00Z') },
  },
})
console.log(`\nSemana: ${semana.startDate.toISOString().slice(0,10)} → ${semana.endDate.toISOString().slice(0,10)}`)

const jornadaParam = await p.parametroSistema.findUnique({ where: { key: 'jornada_semanal_horas' } })
console.log(`Parámetro jornada_semanal_horas en BD: ${jornadaParam?.value}\n`)

const asigs = await p.assignment.findMany({
  where: {
    weekId: semana.id,
    status: { not: 'cancelada' },
    resource: { type: 'asesor_servicios' },
    room: { site: { name: { contains: 'Galapa' } } },
  },
  include: { resource: { select: { id: true, name: true, type: true, maxHoursPerWeek: true } }, room: { include: { site: true } } },
})

console.log(`Asignaciones de asesores en Galapa: ${asigs.length}\n`)
let hBrutas = 0, hEfectivas = 0
const asesores = new Map()
for (const a of asigs) {
  const [h1, m1] = a.startTime.split(':').map(Number)
  const [h2, m2] = a.endTime.split(':').map(Number)
  const bruta = ((h2*60+m2) - (h1*60+m1)) / 60
  const efectiva = horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
  hBrutas += bruta
  hEfectivas += efectiva
  console.log(`  ${a.resource.name} día ${a.weekday} ${a.startTime}-${a.endTime}: ${bruta}h brutas → ${efectiva}h efectivas`)
  if (!asesores.has(a.resource.id)) asesores.set(a.resource.id, a.resource)
}

const tope = [...asesores.values()][0]?.maxHoursPerWeek ?? Number(jornadaParam.value)
console.log(`\n══════════════════════════════════════`)
console.log(`Asesores: ${asesores.size}`)
console.log(`Tope individual: ${tope}h`)
console.log(`Horas BRUTAS (cálculo viejo): ${hBrutas}h / ${tope}h = ${Math.round(hBrutas/tope*100)}%`)
console.log(`Horas EFECTIVAS (cálculo nuevo): ${hEfectivas}h / ${tope}h = ${Math.round(hEfectivas/tope*100)}%`)
console.log(`══════════════════════════════════════`)

await p.$disconnect()
