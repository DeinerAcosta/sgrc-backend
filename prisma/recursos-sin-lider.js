import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

console.log(`\n══ Recursos activos esquema fijo/mixto SIN coord-líder ══\n`)
console.log(`(Estos son los que generaban spam diario a todos los coordinadores)\n`)

const huerfanos = await p.resource.findMany({
  where: {
    active: true,
    payScheme: { in: ['fijo', 'mixto'] },
    leadCoordinatorId: null,
  },
  select: {
    id: true,
    name: true,
    type: true,
    user: {
      select: {
        email: true,
        sites: { select: { site: { select: { name: true } } } },
      },
    },
  },
  orderBy: { name: 'asc' },
})

if (huerfanos.length === 0) {
  console.log('✅ Ninguno. Todos los recursos fijos/mixtos activos tienen coord-líder asignado.\n')
} else {
  console.log(`Total: ${huerfanos.length} recursos sin líder\n`)
  console.log('Por tipo:')
  const porTipo = {}
  for (const r of huerfanos) porTipo[r.type] = (porTipo[r.type] ?? 0) + 1
  for (const [tipo, n] of Object.entries(porTipo)) console.log(`  ${tipo}: ${n}`)
  console.log('\nDetalle (mostrando sedes vinculadas del usuario):\n')
  for (const r of huerfanos) {
    const sedes = (r.user?.sites ?? []).map((s) => s.site.name).join(', ') || '(sin sede)'
    console.log(`  • ${r.name.padEnd(45)} ${r.type.padEnd(20)} ${sedes}`)
  }
}

console.log(`\n══ Las 4 personas reportadas en el correo ══\n`)
const reportadas = ['Lauren', 'Dayanna', 'Ginna', 'Roxana']
for (const nombreParte of reportadas) {
  const r = await p.resource.findFirst({
    where: { name: { contains: nombreParte } },
    include: { user: { include: { sites: { include: { site: true } } } } },
  })
  if (!r) { console.log(`  ❌ ${nombreParte}: no encontrada en BD`); continue }
  let lider = null
  if (r.leadCoordinatorId) {
    lider = await p.user.findUnique({ where: { id: r.leadCoordinatorId }, select: { name: true } })
  }
  const sedes = (r.user?.sites ?? []).map((s) => s.site.name).join(', ') || '(sin sede)'
  console.log(`  • ${r.name}`)
  console.log(`      tipo:        ${r.type}`)
  console.log(`      activo:      ${r.active}`)
  console.log(`      esquema:     ${r.payScheme}`)
  console.log(`      líder:       ${lider?.name ?? '⚠️ SIN LÍDER'}`)
  console.log(`      sedes:       ${sedes}`)
  console.log('')
}

await p.$disconnect()
