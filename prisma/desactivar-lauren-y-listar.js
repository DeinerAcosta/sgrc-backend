import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

// ───── 1) Desactivar a Lauren ─────
console.log(`\n══ Desactivando a Lauren Yineth Ochpa Deluque ══\n`)
const lauren = await p.resource.findFirst({ where: { name: { contains: 'Lauren' } } })
if (lauren) {
  await p.resource.update({ where: { id: lauren.id }, data: { active: false } })
  console.log(`  ✅ Recurso "${lauren.name}" desactivado`)
  if (lauren.id) {
    const usuario = await p.user.findFirst({ where: { resourceId: lauren.id } })
    if (usuario) {
      await p.user.update({ where: { id: usuario.id }, data: { active: false } })
      console.log(`  ✅ Usuario asociado <${usuario.email}> también desactivado`)
    }
  }
} else {
  console.log(`  ⚠️  Lauren no encontrada`)
}

// ───── 2) Listar las 15 personas reales sin líder (no rotativas) ─────
console.log(`\n══ Personas REALES sin coord-líder (excluye oftalmólogos/anestesiólogos rotativos) ══\n`)
const huerfanos = await p.resource.findMany({
  where: {
    active: true,
    payScheme: { in: ['fijo', 'mixto'] },
    leadCoordinatorId: null,
    type: { in: ['optometra', 'asesor_servicios', 'auxiliar', 'tecnico'] },
  },
  include: {
    user: {
      select: {
        email: true,
        sites: { select: { site: { select: { name: true } } } },
      },
    },
  },
  orderBy: [{ type: 'asc' }, { name: 'asc' }],
})

const porTipo = {}
for (const r of huerfanos) (porTipo[r.type] ??= []).push(r)

console.log(`Total a asignar líder: ${huerfanos.length}\n`)
for (const tipo of ['optometra', 'asesor_servicios', 'auxiliar', 'tecnico']) {
  const arr = porTipo[tipo] ?? []
  if (!arr.length) continue
  console.log(`── ${tipo.toUpperCase()} (${arr.length}) ──`)
  for (const r of arr) {
    const sedes = (r.user?.sites ?? []).map((s) => s.site.name).join(', ') || '(sin sede)'
    console.log(`  • ${r.name.padEnd(45)} ${sedes}`)
  }
  console.log('')
}

await p.$disconnect()
