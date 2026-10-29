/**
 * Corrige las fechas de una ausencia ya registrada.
 *
 * Oct-2026 · Crear una ausencia no validaba el rango y en producción quedó una
 * vacación del 27-nov al 11-nov. Desde el commit 5236852 el servidor ya no deja
 * crear otra así; este script arregla las que quedaron, sin borrarlas.
 *
 * Si la ausencia está confirmada, se vuelve a aplicar lo mismo que al
 * confirmarla, ahora con las fechas buenas: pacientes impactados, costo de
 * oportunidad y los turnos de esos días marcados como no ejecutados. Se
 * conservan quién la confirmó, cuándo y su nota. Antes y después quedan en la
 * auditoría.
 *
 *   npm run corregir:fechas-ausencia                                   lista las que tienen el rango al revés
 *   npm run corregir:fechas-ausencia -- --id <id> --hasta 2026-12-11   muestra el cambio
 *   npm run corregir:fechas-ausencia -- --id <id> --hasta 2026-12-11 --aplicar
 *   (también --desde AAAA-MM-DD)
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { errorEnFechasDeAusencia, ausenciasSeCruzan } from '../src/lib/tramos.js'
import { diasDeAnticipacion, esProgramada } from '../src/lib/anticipacion.js'
import { procesarConfirmacionAusencia } from '../src/controllers/absenceController.js'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const aplicar = process.argv.includes('--aplicar')
const id = arg('--id')
const dia = (d) => d.toISOString().slice(0, 10)
const utc = (s) => new Date(`${s}T00:00:00Z`)

if (!id) {
  const invertidas = (await prisma.absence.findMany({ include: { resource: { select: { name: true } } } }))
    .filter((a) => a.endDate < a.startDate)
  console.log(`Ausencias con la fecha final antes de la inicial: ${invertidas.length}`)
  for (const a of invertidas) {
    console.log(`  ${a.id} · ${a.resource.name} · ${a.status} · ${dia(a.startDate)} → ${dia(a.endDate)} · reportada ${a.reportedAt?.toISOString().slice(0, 10)}`)
  }
  console.log('\nPara corregir una: npm run corregir:fechas-ausencia -- --id <id> --desde AAAA-MM-DD --hasta AAAA-MM-DD')
  await prisma.$disconnect()
  process.exit(0)
}

const a = await prisma.absence.findUnique({ where: { id }, include: { resource: { select: { name: true } } } })
if (!a) { console.error('No existe esa ausencia.'); process.exit(1) }
const desde = arg('--desde') ?? dia(a.startDate)
const hasta = arg('--hasta') ?? dia(a.endDate)

const error = errorEnFechasDeAusencia({ startDate: desde, endDate: hasta, isPartial: a.isPartial, absenceStartTime: a.absenceStartTime, absenceEndTime: a.absenceEndTime })
if (error) { console.error(error); process.exit(1) }

const nueva = { startDate: desde, endDate: hasta, isPartial: a.isPartial, absenceStartTime: a.absenceStartTime, absenceEndTime: a.absenceEndTime }
const otras = await prisma.absence.findMany({
  where: { resourceId: a.resourceId, id: { not: a.id }, status: { not: 'rechazada' } },
  select: { startDate: true, endDate: true, status: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
})
const choca = otras.find((o) => o.endDate >= o.startDate && ausenciasSeCruzan(o, nueva))
if (choca) {
  console.error(`Se cruza con otra ausencia ${choca.status} del mismo recurso (${dia(choca.startDate)} → ${dia(choca.endDate)}). No se cambió nada.`)
  process.exit(1)
}

// La anticipación se mide desde que se reportó, no desde hoy.
const anticipacion = Math.max(0, diasDeAnticipacion(desde, a.reportedAt ?? new Date()))
console.log(`${a.resource.name} · ${a.status}`)
console.log(`  fechas:       ${dia(a.startDate)} → ${dia(a.endDate)}   pasa a   ${desde} → ${hasta}`)
console.log(`  anticipación: ${a.noticeDays} d   pasa a   ${anticipacion} d (${esProgramada(anticipacion) ? 'programada' : 'imprevista'})`)

if (!aplicar) {
  console.log('\nNo se escribió nada. Agregue --aplicar para guardar el cambio.')
  await prisma.$disconnect()
  process.exit(0)
}

const antes = { startDate: a.startDate, endDate: a.endDate, noticeDays: a.noticeDays, isPlanned: a.isPlanned, patientsAffected: a.patientsAffected, opportunityCost: a.opportunityCost }
const resultado = await prisma.$transaction(async (tx) => {
  let fila = await tx.absence.update({
    where: { id: a.id },
    data: { startDate: utc(desde), endDate: utc(hasta), noticeDays: anticipacion, isPlanned: esProgramada(anticipacion) },
    include: { resource: true, reasonRef: true },
  })
  if (a.status === 'confirmada') {
    const r = await procesarConfirmacionAusencia(tx, fila, {
      confirmadorId: a.confirmedBy,
      notaCoordinador: a.actionTaken,
      accionAgenda: a.agendaAction,
      auditReason: 'Fechas corregidas con corregir:fechas-ausencia: se vuelve a aplicar la confirmación',
    })
    // Se conserva cuándo se confirmó de verdad.
    fila = await tx.absence.update({ where: { id: a.id }, data: { confirmedAt: a.confirmedAt } })
    return { fila, ejecuciones: r.ejecucionesAuto }
  }
  return { fila, ejecuciones: 0 }
}, { timeout: 60_000 })

await registrarAuditoria({
  userId: null,
  action: 'corregir_fechas_ausencia',
  entity: 'ausencia',
  entityId: a.id,
  oldValue: antes,
  newValue: {
    startDate: resultado.fila.startDate, endDate: resultado.fila.endDate, noticeDays: resultado.fila.noticeDays,
    isPlanned: resultado.fila.isPlanned, patientsAffected: resultado.fila.patientsAffected, opportunityCost: resultado.fila.opportunityCost,
  },
  reason: 'Fechas corregidas con el script corregir:fechas-ausencia',
})
console.log(`\nGuardado. Pacientes impactados: ${resultado.fila.patientsAffected} · turnos marcados no ejecutados: ${resultado.ejecuciones}`)
await prisma.$disconnect()
