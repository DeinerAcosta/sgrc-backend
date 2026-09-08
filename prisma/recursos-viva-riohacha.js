import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const sede = await p.site.findFirst({
  where: { name: { contains: 'Viva' } },
})
if (!sede) { console.log('No se encontró sede Viva'); process.exit(0) }

console.log(`\n══ ${sede.name} (${sede.city}) ══`)
console.log(`   id: ${sede.id.slice(0,8)}\n`)

// 1) Recursos FIJOS: aquellos cuyo usuario está vinculado a esta sede.
const vinculos = await p.usuarioSede.findMany({
  where: { siteId: sede.id },
  include: {
    user: {
      include: {
        resource: { select: { id: true, name: true, type: true, specialty: true, active: true, leadCoordinatorId: true } },
      },
    },
  },
})

const conRecurso = vinculos.filter((v) => v.user.resource && v.user.active)
const porTipo = new Map()
for (const v of conRecurso) {
  const r = v.user.resource
  if (!porTipo.has(r.type)) porTipo.set(r.type, [])
  porTipo.get(r.type).push({ ...r, usuarioActivo: v.user.active, email: v.user.email })
}

const ORDEN_TIPO = ['oftalmologo', 'anestesiologo', 'optometra', 'tecnico', 'auxiliar', 'asesor_servicios']
console.log(`── Recursos FIJOS vinculados directamente a ${sede.name} ──`)
let total = 0
for (const tipo of ORDEN_TIPO) {
  const arr = porTipo.get(tipo) ?? []
  if (!arr.length) continue
  console.log(`\n  ${tipo.toUpperCase()} (${arr.length}):`)
  for (const r of arr.sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = r.active ? '🟢' : '🔴'
    console.log(`    ${flag} ${r.name}${r.specialty ? ` · ${r.specialty}` : ''}`)
    total++
  }
}
console.log(`\n  Total fijos: ${total}`)

// 2) Rotativos que TIENEN asignaciones en consultorios de esta sede (cualquier semana)
const consultorios = await p.room.findMany({ where: { siteId: sede.id }, select: { id: true, name: true } })
const idsConsultorios = consultorios.map((c) => c.id)

const asigsRotativas = await p.assignment.findMany({
  where: {
    roomId: { in: idsConsultorios },
    resource: { type: { in: ['oftalmologo', 'anestesiologo'] } },
    status: { not: 'cancelada' },
  },
  select: { resourceId: true, resource: { select: { name: true, type: true } } },
})

const rotativosMap = new Map()
for (const a of asigsRotativas) {
  if (!a.resource) continue
  if (!rotativosMap.has(a.resourceId)) {
    rotativosMap.set(a.resourceId, { name: a.resource.name, type: a.resource.type, n: 0 })
  }
  rotativosMap.get(a.resourceId).n++
}

if (rotativosMap.size > 0) {
  console.log(`\n── Rotativos (oft/anest) que también atienden en ${sede.name} ──`)
  const lista = [...rotativosMap.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  for (const r of lista) {
    console.log(`    🔄 ${r.name} · ${r.type} · ${r.n} asignación(es) históricas`)
  }
  console.log(`\n  Total rotativos: ${rotativosMap.size}`)
}

await p.$disconnect()
