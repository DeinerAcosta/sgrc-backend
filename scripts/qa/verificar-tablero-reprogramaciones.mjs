// Verifica, SOLO LEYENDO, de dónde salen las cifras del tablero de
// Reprogramaciones (Resumen ejecutivo) en la base donde se corra.
//
//   npm run verificar:tablero                      (diciembre 2025 a hoy)
//   npm run verificar:tablero -- 2026-08-01 2026-10-31
//
// No escribe nada. Sirve para responder "¿estos números son reales?" contra
// la base de producción sin abrir la base a mano.
import { PrismaClient } from '@prisma/client'
import { tiposProfesionalesPermitidos } from '../../src/lib/resourceTypes.js'
import { pacientesDelCaso } from '../../src/lib/pacientesDelCaso.js'
import { coberturaDeAusencia, bucketAntelacion, diasEntreFechas } from '../../src/lib/coberturaTablero.js'

const prisma = new PrismaClient()
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
const [desde = '2025-12-01', hasta = hoy] = process.argv.slice(2)

const aus = await prisma.absence.findMany({
  where: {
    status: { not: 'rechazada' },
    startDate: { lte: new Date(`${hasta}T00:00:00Z`) },
    endDate: { gte: new Date(`${desde}T00:00:00Z`) },
    resource: { is: { type: { in: tiposProfesionalesPermitidos(null) } } },
  },
  select: {
    id: true, startDate: true, reportedAt: true, noticeDays: true, isPlanned: true,
    patientsAffected: true, patientsConfirmed: true, recordedByCoordinator: true,
    makeups: { select: { status: true } },
  },
})
const ids = aus.map((a) => a.id)
const cubren = ids.length ? await prisma.assignment.groupBy({
  by: ['coveredAbsenceId'], where: { coveredAbsenceId: { in: ids }, status: { not: 'cancelada' } },
  _sum: { patientCapacity: true }, _count: true,
}) : []
const cub = new Map(cubren.map((c) => [c.coveredAbsenceId, c._sum.patientCapacity ?? 0]))

const n = (x) => x.toLocaleString('es-CO')
const buckets = {}
let registradasAntes = 0, porCoordinador = 0, conReales = 0, pacientes = 0, cubiertos = 0, repuestas = 0, conTurnos = 0
const reposiciones = {}
for (const a of aus) {
  const b = bucketAntelacion(a.noticeDays); buckets[b] = (buckets[b] ?? 0) + 1
  if (diasEntreFechas(a.reportedAt, a.startDate) > 0) registradasAntes++
  if (a.recordedByCoordinator) porCoordinador++
  if (a.patientsConfirmed != null) conReales++
  const total = pacientesDelCaso(a)
  const rep = a.makeups.some((m) => m.status === 'aprobada' || m.status === 'realizada')
  const c = coberturaDeAusencia({ total, cubiertos: cub.get(a.id) ?? 0, reposicion: rep })
  pacientes += total; cubiertos += c.pacientesCubiertos; if (c.repuesta) repuestas++
  if (cub.has(a.id)) conTurnos++
  for (const m of a.makeups) reposiciones[m.status] = (reposiciones[m.status] ?? 0) + 1
}

console.log(`\nTABLERO DE REPROGRAMACIONES · solo lectura · ${desde} a ${hasta}`)
console.log('='.repeat(72))
console.log(`Ausencias de profesionales (sin rechazadas): ${n(aus.length)}`)
console.log(`  registradas por el coordinador (no por el médico): ${n(porCoordinador)}`)
console.log(`  registradas ANTES del día de la ausencia: ${n(registradasAntes)} · el mismo día o después: ${n(aus.length - registradasAntes)}`)
console.log(`  anticipación guardada → retroactivas/mismo día: ${n(buckets.retroactivo ?? 0)} · 1-7 d: ${n(buckets.uno_a_siete ?? 0)} · 8-19 d: ${n(buckets.ocho_a_diecinueve ?? 0)} · 20+ d: ${n(buckets.veinte_o_mas ?? 0)}`)
console.log(`Pacientes impactados: ${n(pacientes)} (con número real de la líder: ${n(conReales)} ausencias)`)
console.log(`Ausencias con turnos que las cubren: ${n(conTurnos)} · pacientes con turno nuevo: ${n(cubiertos)}`)
console.log(`Reposiciones propuestas por el médico: ${Object.keys(reposiciones).length ? Object.entries(reposiciones).map(([k, v]) => `${k} ${v}`).join(' · ') : 'ninguna'}`)
console.log(`Repuestas (todos sus pacientes con turno nuevo, o reposición aprobada): ${n(repuestas)} de ${n(aus.length)} = ${aus.length ? Math.round((repuestas / aus.length) * 100) : 0}%`)
console.log('\nNo se escribió nada.')
await prisma.$disconnect()
