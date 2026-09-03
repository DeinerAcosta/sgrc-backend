import { PrismaClient } from '@prisma/client'
import { horasEfectivasFranja } from '../src/lib/horarios.js'

const p = new PrismaClient()

const semana = await p.week.findFirst({
  where: {
    startDate: { lte: new Date('2026-06-22T23:59:59Z') },
    endDate: { gte: new Date('2026-06-22T00:00:00Z') },
  },
})
const jornadaParam = await p.parametroSistema.findUnique({ where: { key: 'jornada_semanal_horas' } })
const jornada = Number(jornadaParam.value)

console.log(`\n══ Ocupación de asesores · ${semana.startDate.toISOString().slice(0,10)} → ${semana.endDate.toISOString().slice(0,10)} ══`)
console.log(`Jornada legal: ${jornada}h\n`)

const asigs = await p.assignment.findMany({
  where: { weekId: semana.id, status: { not: 'cancelada' }, resource: { type: 'asesor_servicios' } },
  include: { resource: { select: { id: true, type: true, maxHoursPerWeek: true } }, room: { include: { site: true } } },
})

// Paso 1: horas totales por asesor (suma de TODAS sus sedes para factor proporcional)
const horasPorAsesor = new Map()
for (const a of asigs) {
  if (!horasPorAsesor.has(a.resource.id)) {
    horasPorAsesor.set(a.resource.id, { tope: a.resource.maxHoursPerWeek ?? jornada, horasSemana: 0 })
  }
  horasPorAsesor.get(a.resource.id).horasSemana += horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
}

// Paso 2: agrupar por sede con distribución proporcional
const porSede = new Map()
for (const a of asigs) {
  const sid = a.room.siteId
  if (!porSede.has(sid)) porSede.set(sid, { site: a.room.site.name, h_asign: 0, h_base: 0, asesores: new Set() })
  const grp = porSede.get(sid)
  const hAsig = horasEfectivasFranja(a.startTime, a.endTime, a.resource.type)
  const stat = horasPorAsesor.get(a.resource.id)
  const factor = stat.horasSemana > 0 ? hAsig / stat.horasSemana : 0
  grp.h_asign += hAsig
  grp.h_base  += factor * stat.tope
  grp.asesores.add(a.resource.id)
}

console.log('Sede                         #Ases  Asignadas  Base   %Ocup   Estado')
console.log('-'.repeat(80))
const filas = [...porSede.values()].sort((a, b) => (b.h_asign/b.h_base) - (a.h_asign/a.h_base))
for (const f of filas) {
  const pct = Math.round((f.h_asign / f.h_base) * 100)
  const sem = pct >= 80 ? '🟢' : pct >= 70 ? '🟡' : '🔴'
  const flag = pct > 100 ? '⚠ extras' : pct === 100 ? 'lleno' : 'OK'
  console.log(`${f.site.padEnd(28)} ${String(f.asesores.size).padStart(3)}    ${f.h_asign.toFixed(1).padStart(6)}h  ${f.h_base.toFixed(1).padStart(5)}h  ${sem} ${String(pct).padStart(3)}%   ${flag}`)
}

await p.$disconnect()
