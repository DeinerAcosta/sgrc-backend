/**
 * Ausencias con la fecha final ANTES de la inicial.
 *
 * Oct-2026 · Crear una ausencia no validaba el rango y en producción quedó una
 * vacación del 27-nov al 11-nov: un duplicado mal digitado, registrado 4 minutos
 * después de la vacación real del mismo técnico. Desde el commit 5236852 el
 * servidor ya no deja crear otra así; este script quita las que quedaron.
 *
 * Solo borra las que no tienen nada colgado (reemplazos, reposiciones ni
 * backoffice): una ausencia al revés no cubre ningún día, así que no movió
 * turnos ni pacientes. Las que tengan algo colgado se listan para revisarlas a
 * mano. Cada borrado queda en la auditoría con la fila completa.
 *
 *   npm run limpiar:fechas-invertidas               solo muestra
 *   npm run limpiar:fechas-invertidas -- --aplicar  borra
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'

const aplicar = process.argv.includes('--aplicar')
const dia = (d) => d.toISOString().slice(0, 10)

const todas = await prisma.absence.findMany({
  include: {
    resource: { select: { name: true } },
    _count: { select: { replacementAssignments: true, sourceBackofficeAssignments: true, makeups: true } },
  },
})
const invertidas = todas.filter((a) => a.endDate < a.startDate)
const borrables = invertidas.filter((a) => Object.values(a._count).every((n) => n === 0))
const aMano = invertidas.filter((a) => !borrables.includes(a))

console.log(`Ausencias con la fecha final antes de la inicial: ${invertidas.length}`)
for (const a of borrables) console.log(`  · se borra   ${a.resource.name} · ${a.status} · ${dia(a.startDate)} → ${dia(a.endDate)}`)
for (const a of aMano) console.log(`  · REVISAR A MANO (tiene ${JSON.stringify(a._count)}) ${a.resource.name} · ${dia(a.startDate)} → ${dia(a.endDate)}`)

if (!aplicar) {
  console.log('\nNo se escribió nada. Para aplicar: npm run limpiar:fechas-invertidas -- --aplicar')
} else if (borrables.length === 0) {
  console.log('\nNada que borrar.')
} else {
  for (const a of borrables) {
    const { resource, _count, ...fila } = a
    // Auditar ANTES de borrar: si el borrado falla, queda la constancia del intento.
    await registrarAuditoria({
      userId: null,
      action: 'eliminar_ausencia_fechas_invertidas',
      entity: 'ausencia',
      entityId: a.id,
      oldValue: fila,
      reason: `Fecha final (${dia(a.endDate)}) anterior a la inicial (${dia(a.startDate)}); script limpiar:fechas-invertidas`,
    })
    await prisma.absence.delete({ where: { id: a.id } })
  }
  console.log(`\nBorradas: ${borrables.length}`)
}
await prisma.$disconnect()
