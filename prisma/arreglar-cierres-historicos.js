/**
 * Pasada one-shot para corregir los cierres históricos que se migraron
 * inicialmente con un solo coordinador (Wadys) por todos los registros.
 *
 * Regla:
 *   - Si la sede tenía asignaciones en esa semana → cerradaPor = coordinador
 *     responsable de la sede (Sede.responsableId; si no, primer coord vinculado
 *     vía UsuarioSede).
 *   - Si la sede NO tenía asignaciones → cerradaPor = null (Sistema).
 *
 * Solo aplica a cierres pre-existentes. Los nuevos cierres (desde el deploy de
 * "cierre por sede") ya guardan el coord correcto en el momento del cierre.
 */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const cierres = await p.cierreSemanaSede.findMany({
  include: { site: { select: { id: true, name: true, managerId: true } }, week: true },
})

console.log(`\n══ Arreglando ${cierres.length} cierres históricos ══\n`)

// Pre-cargar coordinadores por sede (caso responsableId vacío → primer coord de UsuarioSede)
const sedeCoordCache = new Map()
async function coordDeSede(sedeId) {
  if (sedeCoordCache.has(sedeId)) return sedeCoordCache.get(sedeId)
  const sede = await p.site.findUnique({ where: { id: sedeId }, select: { managerId: true } })
  let coordId = sede?.managerId ?? null
  if (!coordId) {
    const us = await p.usuarioSede.findFirst({
      where: { siteId: sedeId, user: { role: 'coordinador', active: true } },
      include: { user: { select: { id: true, name: true } } },
    })
    coordId = us?.userId ?? null
  }
  sedeCoordCache.set(sedeId, coordId)
  return coordId
}

let asignados = 0
let sistema = 0
let sinCoord = 0

for (const c of cierres) {
  const totalAsigs = await p.assignment.count({
    where: {
      weekId: c.weekId,
      status: { not: 'cancelada' },
      room: { siteId: c.siteId },
    },
  })

  if (totalAsigs === 0) {
    // Sin actividad: dejar como Sistema (cerradaPor = null)
    if (c.closedBy !== null) {
      await p.cierreSemanaSede.update({
        where: { id: c.id },
        data: { closedBy: null, reason: 'Sin actividad esa semana — cerrada por el sistema' },
      })
    }
    sistema++
    console.log(`  🤖 ${c.site.name.padEnd(28)} ${c.week.startDate.toISOString().slice(0,10)} → Sistema (0 asignaciones)`)
    continue
  }

  const coordId = await coordDeSede(c.siteId)
  if (!coordId) {
    sinCoord++
    console.log(`  ⚠️  ${c.site.name.padEnd(28)} ${c.week.startDate.toISOString().slice(0,10)} → sin coord asignado a la sede (dejo como está)`)
    continue
  }
  if (c.closedBy !== coordId) {
    await p.cierreSemanaSede.update({
      where: { id: c.id },
      data: { closedBy: coordId, reason: 'Histórico re-asignado al coord responsable de la sede' },
    })
  }
  const coordU = await p.user.findUnique({ where: { id: coordId }, select: { name: true } })
  asignados++
  console.log(`  ✅ ${c.site.name.padEnd(28)} ${c.week.startDate.toISOString().slice(0,10)} → ${coordU?.name} (${totalAsigs} asigns)`)
}

console.log(`\n──── Resumen ────`)
console.log(`  Asignados a coord:    ${asignados}`)
console.log(`  Dejados como Sistema: ${sistema}`)
console.log(`  Sin coord en la sede: ${sinCoord}`)

await p.$disconnect()
