import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const recursos = await prisma.resource.findMany({
  where: { name: { contains: 'Fellow' } },
  include: {
    user: { select: { id: true, name: true, email: true, active: true } },
    _count: { select: {
      assignmentsAsLead: true,
      assignmentsAsAssistant: true,
      assignmentsAsAssistant2: true,
    } },
  },
  orderBy: { name: 'asc' },
})

for (const r of recursos) {
  const u = r.user
  const total = r._count.assignmentsAsLead + r._count.assignmentsAsAssistant + r._count.assignmentsAsAssistant2
  console.log(`──────────────────────────────`)
  console.log(`  Recurso:    ${r.name}  (id=${r.id.slice(0,8)})`)
  console.log(`  Estado:     ${r.active ? '🟢 activo' : '🔴 inactivo'}`)
  console.log(`  Usuario:    ${u ? `${u.name} <${u.email}>  ${u.active ? '🟢 activo' : '🔴 inactivo'}` : '⚠️ HUÉRFANO (sin usuario vinculado)'}`)
  console.log(`  Asigns total: ${total}  (principal=${r._count.assignmentsAsLead}, aux1=${r._count.assignmentsAsAssistant}, aux2=${r._count.assignmentsAsAssistant2})`)
}
console.log(`──────────────────────────────`)
console.log(`Total: ${recursos.length} recursos`)

await prisma.$disconnect()
