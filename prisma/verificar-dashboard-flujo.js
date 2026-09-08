import { PrismaClient } from '@prisma/client'
import { horasEfectivasFranja } from '../src/lib/horarios.js'

const p = new PrismaClient()

console.log('\n══════ AUDITORÍA DASHBOARD EJECUTIVO ══════\n')

// 1. Semana actual
const hoy = new Date()
const semanaActual = await p.week.findFirst({
  where: { startDate: { lte: hoy }, endDate: { gte: hoy } },
})
const semanaAnterior = semanaActual
  ? await p.week.findFirst({ where: { startDate: { lt: semanaActual.startDate } }, orderBy: { startDate: 'desc' } })
  : null

console.log('1. SEMANAS')
console.log(`   Actual:   ${semanaActual?.startDate.toISOString().slice(0,10)} → ${semanaActual?.endDate.toISOString().slice(0,10)} (${semanaActual?.status})`)
console.log(`   Anterior: ${semanaAnterior?.startDate.toISOString().slice(0,10)} → ${semanaAnterior?.endDate.toISOString().slice(0,10)} (${semanaAnterior?.status})`)

// 2. KPI: pacientes programados
const sumarProg = async (sid) => {
  if (!sid) return 0
  const a = await p.assignment.findMany({ where: { weekId: sid, status: { not: 'cancelada' } }, select: { patientCapacity: true } })
  return a.reduce((acc, x) => acc + (x.patientCapacity ?? 0), 0)
}
const sumarAtend = async (sid) => {
  if (!sid) return 0
  const a = await p.assignment.findMany({ where: { weekId: sid, status: { not: 'cancelada' }, execution: { isNot: null } }, select: { execution: { select: { patientsSeen: true } } } })
  return a.reduce((acc, x) => acc + (x.execution?.patientsSeen ?? 0), 0)
}

const progActual = await sumarProg(semanaActual?.id)
const progAnterior = await sumarProg(semanaAnterior?.id)
const atendActual = await sumarAtend(semanaActual?.id)
const atendAnterior = await sumarAtend(semanaAnterior?.id)

console.log('\n2. PACIENTES (KPIs)')
console.log(`   Programados actual:   ${progActual.toLocaleString('es-CO')}`)
console.log(`   Programados anterior: ${progAnterior.toLocaleString('es-CO')}`)
console.log(`   Atendidos actual:     ${atendActual.toLocaleString('es-CO')}`)
console.log(`   Atendidos anterior:   ${atendAnterior.toLocaleString('es-CO')}`)
console.log(`   Tasa ejecución actual: ${progActual > 0 ? Math.round((atendActual/progActual)*100) : 0}%`)

// 3. Filtros día (test con lunes)
const sumarProgDia = async (sid, dia) => {
  if (!sid) return 0
  const a = await p.assignment.findMany({ where: { weekId: sid, weekday: dia, status: { not: 'cancelada' } }, select: { patientCapacity: true } })
  return a.reduce((acc, x) => acc + (x.patientCapacity ?? 0), 0)
}
console.log('\n3. FILTRO DÍA (semana actual)')
for (const dia of ['domingo','lunes','martes','miercoles','jueves','viernes','sabado']) {
  const prog = await sumarProgDia(semanaActual?.id, dia)
  console.log(`   ${dia.padEnd(10)} programados: ${prog}`)
}

// 4. Ausencias activas
const ausenciasActivas = semanaActual ? await p.absence.count({
  where: { status: 'confirmada', startDate: { lte: semanaActual.endDate }, endDate: { gte: semanaActual.startDate } },
}) : 0
const impactados = semanaActual ? await p.absence.findMany({
  where: { status: 'confirmada', startDate: { lte: semanaActual.endDate }, endDate: { gte: semanaActual.startDate } },
  select: { patientsAffected: true, opportunityCost: true },
}) : []
const totalImpactados = impactados.reduce((acc, a) => acc + (a.patientsAffected ?? 0), 0)
const totalCosto = impactados.reduce((acc, a) => acc + Number(a.opportunityCost ?? 0), 0)
console.log('\n4. AUSENCIAS ACTIVAS (semana actual)')
console.log(`   Total ausencias:       ${ausenciasActivas}`)
console.log(`   Pacientes impactados:  ${totalImpactados}`)
console.log(`   Costo total estimado:  $${totalCosto.toLocaleString('es-CO')}`)

// 5. Ocupación por sede (sin filtros) — usando horasEfectivasFranja
const asigs = semanaActual ? await p.assignment.findMany({
  where: { weekId: semanaActual.id, status: { not: 'cancelada' } },
  include: { resource: { select: { type: true } }, room: { include: { site: true } } },
}) : []
const BASE_64H = 64
const porCons = new Map()
for (const a of asigs) {
  if (a.room.specialty === 'asesoria') continue
  const k = a.room.id
  if (!porCons.has(k)) porCons.set(k, { site: a.room.site.name, asign: 0, base: BASE_64H })
  porCons.get(k).asign += horasEfectivasFranja(a.startTime, a.endTime, a.resource?.type)
}
const porSede = new Map()
for (const c of porCons.values()) {
  if (!porSede.has(c.site)) porSede.set(c.site, { asign: 0, base: 0 })
  porSede.get(c.site).asign += c.asign
  porSede.get(c.site).base += c.base
}
console.log('\n5. OCUPACIÓN POR SEDE')
const filas = [...porSede.entries()].map(([nombre, v]) => ({
  name: nombre, pct: v.base > 0 ? Math.round((v.asign/v.base)*100) : 0,
})).sort((a, b) => b.pct - a.pct)
for (const f of filas) {
  const sem = f.pct >= 80 ? '🟢' : f.pct >= 70 ? '🟡' : '🔴'
  console.log(`   ${sem} ${f.name.padEnd(28)} ${f.pct}%`)
}
const promedio = filas.length > 0 ? Math.round(filas.reduce((acc, x) => acc + x.pct, 0) / filas.length) : 0
console.log(`\n   Ocupación global (promedio simple): ${promedio}% (meta 80%)`)

console.log('\n══════ DIAGNÓSTICO ══════')
const issues = []
if (!semanaActual) issues.push('❌ No hay semana actual')
if (atendActual > progActual) issues.push(`⚠️  Atendidos (${atendActual}) > programados (${progActual}) — revisar`)
if (progActual === 0) issues.push('⚠️  0 pacientes programados — semana sin actividad')
if (filas.length === 0) issues.push('⚠️  0 sedes con ocupación — no hay consultorios físicos con asignaciones')
if (issues.length === 0) console.log('✅ Todos los KPIs cuadran con la BD — flujo OK')
else issues.forEach(i => console.log(i))

await p.$disconnect()
