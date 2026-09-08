/**
 * Script one-shot: sincroniza el flag `activo` del Recurso con el de su
 * Usuario vinculado. Si un usuario fue desactivado pero su recurso quedó
 * activo (bug histórico), apaga también el recurso para que no aparezca
 * en el programador / catálogo.
 *
 * Uso (desde backend/):
 *   node prisma/sync-recurso-activo.js          → dry-run
 *   node prisma/sync-recurso-activo.js --apply  → aplica
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n=== Sincronización Recurso.activo ← Usuario.activo ===`)
  console.log(`Modo: ${APPLY ? 'APLICAR' : 'DRY-RUN'}\n`)

  // Buscamos usuarios con recurso vinculado donde haya desalineación.
  const usuarios = await prisma.user.findMany({
    where: { resourceId: { not: null } },
    select: {
      id: true,
      name: true,
      active: true,
      resourceId: true,
      resource: { select: { id: true, name: true, active: true } },
    },
  })

  const desalineados = usuarios.filter(
    (u) => u.resource && u.active !== u.resource.active,
  )

  console.log(`Usuarios con recurso vinculado: ${usuarios.length}`)
  console.log(`Desalineados (usuario.activo ≠ recurso.activo): ${desalineados.length}\n`)

  for (const u of desalineados) {
    const flecha = u.active ? '🟢 activar' : '🔴 desactivar'
    console.log(`  [${flecha}] ${u.name}  (usuario=${u.active}, recurso=${u.resource.active})`)
    if (APPLY) {
      await prisma.resource.update({
        where: { id: u.resourceId },
        data: { active: u.active },
      })
    }
  }

  console.log(APPLY ? `\n✅ Aplicados ${desalineados.length} cambios.` : `\n⚠️ Dry-run. Corre con --apply.`)
}

main()
  .catch((e) => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
