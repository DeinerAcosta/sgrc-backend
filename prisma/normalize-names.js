/**
 * Script one-shot: normaliza todos los nombres de Usuario y Recurso existentes
 * a Title Case. Idempotente — correr varias veces no hace daño.
 *
 * Uso (desde backend/):
 *   node prisma/normalize-names.js          → dry-run (solo reporta)
 *   node prisma/normalize-names.js --apply  → aplica los cambios en la BD
 */

import { PrismaClient } from '@prisma/client'
import { titleCase } from '../src/lib/strings.js'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n=== Normalización de nombres a Title Case ===`)
  console.log(`Modo: ${APPLY ? 'APLICAR cambios' : 'DRY-RUN (solo reporte)'}`)

  let cambiosUsuario = 0
  let cambiosRecurso = 0

  const usuarios = await prisma.user.findMany({ select: { id: true, name: true } })
  console.log(`\n— Usuarios: ${usuarios.length} registros leídos`)
  for (const u of usuarios) {
    const tc = titleCase(u.name)
    if (tc !== u.name) {
      cambiosUsuario++
      if (APPLY) {
        await prisma.user.update({ where: { id: u.id }, data: { name: tc } })
      } else {
        console.log(`  [USR] "${u.name}" → "${tc}"`)
      }
    }
  }

  const recursos = await prisma.resource.findMany({ select: { id: true, name: true } })
  console.log(`\n— Recursos: ${recursos.length} registros leídos`)
  for (const r of recursos) {
    const tc = titleCase(r.name)
    if (tc !== r.name) {
      cambiosRecurso++
      if (APPLY) {
        await prisma.resource.update({ where: { id: r.id }, data: { name: tc } })
      } else {
        console.log(`  [REC] "${r.name}" → "${tc}"`)
      }
    }
  }

  console.log(`\n=== Resumen ===`)
  console.log(`Usuarios a cambiar: ${cambiosUsuario}`)
  console.log(`Recursos a cambiar: ${cambiosRecurso}`)
  console.log(APPLY ? `\n✅ Cambios aplicados.` : `\n⚠️  Dry-run. Para aplicar, correr con --apply`)
}

main()
  .catch((e) => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
