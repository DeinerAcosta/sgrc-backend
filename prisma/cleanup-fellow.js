/**
 * Cleanup específico de los Fellow huérfanos/duplicados pedido por Hector.
 *
 * MANTIENE (renombra para consistencia con el usuario):
 *   - Recurso "Fellow"               → renombrar a "Fellow Mall Plaza"
 *   - Recurso "Fellow Retina Sede 2" → renombrar a "Fellow Sede 2"
 *
 * ELIMINA (recurso + usuario + asignaciones + ausencias):
 *   - Recurso "Fellow Catarata Sede 2" huérfano (sin usuario)
 *   - Recurso "Fellow Catarata Sede 2" inactivo + su usuario
 *   - Recurso "Fellow Oculoplastia Sede 2" inactivo + su usuario + 3 asignaciones
 *
 * Uso (desde backend/):
 *   node prisma/cleanup-fellow.js          → dry-run
 *   node prisma/cleanup-fellow.js --apply  → aplica
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

// Selección por ID-prefix para que el script sea idempotente: si ya se corrió,
// el findFirst de los eliminados retorna null y el bloque se salta.
const SELECTORES = {
  eliminar: [
    // Fellow Catarata Sede 2 — HUÉRFANO (sin usuario), activo
    { idStartsWith: '4cbda145', name: 'Fellow Catarata Sede 2 (huérfano)' },
    // Fellow Catarata Sede 2 — inactivo, con usuario inactivo
    { idStartsWith: 'ea533787', name: 'Fellow Catarata Sede 2 (inactivo)' },
    // Fellow Oculoplastia Sede 2 — inactivo, con usuario + 3 asignaciones
    { idStartsWith: 'f0a683ea', name: 'Fellow Oculoplastia Sede 2' },
  ],
  renombrar: [
    { idStartsWith: 'a16a4988', nombreActual: 'Fellow',               nombreNuevo: 'Fellow Mall Plaza' },
    { idStartsWith: '7aa53626', nombreActual: 'Fellow Retina Sede 2', nombreNuevo: 'Fellow Sede 2'      },
  ],
}

async function findByPrefix(prefix) {
  const recursos = await prisma.resource.findMany({
    where: { id: { startsWith: prefix } },
    include: { user: { select: { id: true, name: true } } },
  })
  return recursos[0] ?? null
}

async function eliminarRecursoCompleto(recurso) {
  const id = recurso.id
  // 1. Asignaciones donde es principal/aux/aux2 — DELETE cascadea a ejecuciones.
  const asigsBorradas = await prisma.assignment.deleteMany({
    where: {
      OR: [{ resourceId: id }, { assistantId: id }, { assistant2Id: id }],
    },
  })
  // 2. Ausencias del recurso.
  const ausBorradas = await prisma.absence.deleteMany({ where: { resourceId: id } })
  // 3. Si tiene usuario, lo desvinculamos (recursoId=null) antes de borrar el recurso
  //    para evitar el FK error, y luego borramos el usuario.
  let usuarioBorrado = false
  if (recurso.user) {
    await prisma.user.update({
      where: { id: recurso.user.id },
      data: { resourceId: null },
    })
    await prisma.user.delete({ where: { id: recurso.user.id } })
    usuarioBorrado = true
  }
  // 4. Recurso.
  await prisma.resource.delete({ where: { id } })
  return { assignments: asigsBorradas.count, absences: ausBorradas.count, usuarioBorrado }
}

async function main() {
  console.log(`\n=== Cleanup Fellow ===`)
  console.log(`Modo: ${APPLY ? 'APLICAR' : 'DRY-RUN'}\n`)

  console.log(`── ELIMINAR ──`)
  for (const sel of SELECTORES.eliminar) {
    const r = await findByPrefix(sel.idStartsWith)
    if (!r) {
      console.log(`  ⏭️  ${sel.name}: NO encontrado (¿ya se eliminó?)`)
      continue
    }
    // Contar primero
    const asigs = await prisma.assignment.count({
      where: { OR: [{ resourceId: r.id }, { assistantId: r.id }, { assistant2Id: r.id }] },
    })
    const ausencias = await prisma.absence.count({ where: { resourceId: r.id } })
    console.log(`  🗑️  ${r.name} (${r.id.slice(0,8)})`)
    console.log(`      Usuario: ${r.user ? r.user.name : 'HUÉRFANO'}`)
    console.log(`      Asignaciones a borrar: ${asigs}, Ausencias: ${ausencias}`)
    if (APPLY) {
      const res = await eliminarRecursoCompleto(r)
      console.log(`      ✅ Borrado: ${res.assignments} asigns, ${res.absences} ausencias, usuario=${res.usuarioBorrado ? 'sí' : 'n/a'}`)
    }
  }

  console.log(`\n── RENOMBRAR ──`)
  for (const sel of SELECTORES.renombrar) {
    const r = await findByPrefix(sel.idStartsWith)
    if (!r) {
      console.log(`  ⏭️  ${sel.nombreActual}: NO encontrado`)
      continue
    }
    if (r.name === sel.nombreNuevo) {
      console.log(`  ⏭️  Ya se llama "${sel.nombreNuevo}" — nada que hacer`)
      continue
    }
    console.log(`  ✏️  "${r.name}" → "${sel.nombreNuevo}"`)
    if (APPLY) {
      await prisma.resource.update({ where: { id: r.id }, data: { name: sel.nombreNuevo } })
      // Sincronizar el nombre del usuario vinculado también (si existe)
      if (r.user) {
        await prisma.user.update({ where: { id: r.user.id }, data: { name: sel.nombreNuevo } })
      }
    }
  }

  console.log(APPLY ? `\n✅ Aplicado.` : `\n⚠️ Dry-run. Corre con --apply.`)
}

main()
  .catch((e) => { console.error('Error:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
