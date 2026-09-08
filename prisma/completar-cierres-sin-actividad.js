/**
 * Para cada semana ya consolidada (Semana.estado='cerrada'), agregar un cierre
 * por SISTEMA para las sedes activas que NO tuvieron asignaciones esa semana
 * y aún no aparecen en CierreSemanaSede.
 *
 * Justificación: si una sede activa no programó nada en una semana, igual debe
 * figurar en el informe de cumplimiento — con responsable "Sistema" porque
 * técnicamente no había nada que cerrar manualmente.
 */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const semanas = await p.week.findMany({
  where: { status: 'cerrada' },
  orderBy: { startDate: 'desc' },
})
const sedesActivas = await p.site.findMany({ where: { active: true }, select: { id: true, name: true } })

console.log(`\n══ Completando cierres "Sistema" para sedes sin actividad ══\n`)

let creados = 0
for (const sem of semanas) {
  const fechaStr = sem.startDate.toISOString().slice(0, 10)
  const yaTienen = new Set(
    (await p.cierreSemanaSede.findMany({
      where: { weekId: sem.id }, select: { siteId: true },
    })).map((c) => c.siteId)
  )
  for (const s of sedesActivas) {
    if (yaTienen.has(s.id)) continue
    const tieneAsigs = await p.assignment.count({
      where: {
        weekId: sem.id,
        status: { not: 'cancelada' },
        room: { siteId: s.id },
      },
    })
    if (tieneAsigs > 0) {
      console.log(`  ⚠️  ${s.name.padEnd(40)} ${fechaStr} → tenía ${tieneAsigs} asigns pero falta cierre (raro, saltando)`)
      continue
    }
    await p.cierreSemanaSede.create({
      data: {
        weekId: sem.id,
        siteId: s.id,
        closedBy: null,
        closedAt: sem.closedAt ?? sem.updatedAt,
        reason: 'Sin actividad esa semana — cerrada por el sistema',
      },
    })
    creados++
    console.log(`  🤖 ${s.name.padEnd(40)} ${fechaStr} → Sistema (0 asignaciones)`)
  }
}

console.log(`\n──── Resumen ────`)
console.log(`  Cierres "Sistema" creados: ${creados}`)
await p.$disconnect()
