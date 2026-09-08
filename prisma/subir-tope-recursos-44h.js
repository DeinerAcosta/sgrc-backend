import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

// Recursos cuyo horasMaxSemana sigue en 42 → subir a 44 (jornada legal vigente
// Ley 2101, fase 15-jul-2025 → 14-jul-2026). Los oftalmólogos tienen null
// (por paciente, sin tope) y NO los tocamos. Recursos con tope custom (43, 45,
// 48, etc. — horas extras habituales) tampoco se tocan.
const desactualizados = await p.resource.findMany({
  where: { maxHoursPerWeek: 42, active: true },
  select: { id: true, name: true, type: true, maxHoursPerWeek: true },
})
console.log(`\n${desactualizados.length} recursos activos con horasMaxSemana=42 (a actualizar a 44)\n`)

// Conteo por tipo para auditoría
const porTipo = {}
for (const r of desactualizados) porTipo[r.type] = (porTipo[r.type] ?? 0) + 1
for (const [t, n] of Object.entries(porTipo)) console.log(`  ${t}: ${n}`)

const res = await p.resource.updateMany({
  where: { maxHoursPerWeek: 42, active: true },
  data: { maxHoursPerWeek: 44 },
})
console.log(`\nActualizados: ${res.count}`)

// Verificar que quedaron en 44
const verif = await p.resource.groupBy({
  by: ['horasMaxSemana'],
  _count: true,
  where: { active: true },
})
console.log('\nDistribución final horasMaxSemana en recursos activos:')
for (const v of verif) console.log(`  ${v.maxHoursPerWeek ?? 'null (oftalmo/etc)'}: ${v._count}`)

await p.$disconnect()
