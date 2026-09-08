import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const sedes = await p.site.findMany({
  where: { active: true },
  include: {
    manager: { select: { id: true, name: true, email: true, role: true } },
    users: {
      include: { user: { select: { id: true, name: true, role: true, active: true } } },
    },
  },
  orderBy: [{ city: 'asc' }, { name: 'asc' }],
})

console.log(`\n══ ${sedes.length} sedes activas — Coordinador por sede ══\n`)

for (const s of sedes) {
  const coordsVinculados = (s.users ?? [])
    .map((u) => u.user)
    .filter((u) => u && u.active && u.role === 'coordinador')
  const responsable = s.manager
  const responsableEsCoord = responsable?.role === 'coordinador'

  console.log(`\n📍 ${s.name.padEnd(38)} ${s.city}`)

  // Línea principal: el responsable oficial
  if (responsable) {
    const marca = responsableEsCoord ? '👑' : '⚠️ '
    console.log(`  ${marca} Responsable: ${responsable.name} (${responsable.role})`)
  } else {
    console.log(`  ❌ Responsable: SIN ASIGNAR`)
  }

  // Otros coordinadores vinculados (los que no son el responsable)
  const otros = coordsVinculados.filter((c) => c.id !== responsable?.id)
  if (otros.length > 0) {
    console.log(`  + Otros coords vinculados (${otros.length}):`)
    for (const c of otros) {
      console.log(`      - ${c.name}`)
    }
  }

  // Si no hay responsable Y no hay coords vinculados, alerta
  if (!responsable && coordsVinculados.length === 0) {
    console.log(`  ⚠️ NINGÚN COORDINADOR — sede huérfana`)
  }
}

console.log(`\n──── Resumen ────`)
const sinResp = sedes.filter((s) => !s.manager).length
const respNoCoord = sedes.filter((s) => s.manager && s.manager.role !== 'coordinador').length
console.log(`  Sedes sin responsable asignado: ${sinResp}`)
console.log(`  Sedes con responsable que NO es coordinador: ${respNoCoord}`)

await p.$disconnect()
