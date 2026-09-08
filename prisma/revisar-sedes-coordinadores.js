import { prisma } from '../src/lib/prisma.js'

/**
 * COMPROBACIÓN PREVIA AL AISLAMIENTO POR SEDE (S-1 / S-2)
 * ======================================================
 *
 * Desde el arreglo S-1, un coordinador solo puede programar en las sedes a las
 * que está vinculado en `usuarios_sedes`. Si esos vínculos están incompletos,
 * el coordinador se queda sin poder trabajar — y el síntoma es un 403 al
 * guardar, que es fácil confundir con un fallo del sistema.
 *
 * Este script NO modifica nada. Solo lista:
 *   1. Coordinadores SIN ninguna sede vinculada  → quedarían bloqueados del todo
 *   2. Coordinadores que han programado en sedes a las que NO están vinculados
 *      → esas sedes dejarán de estar disponibles para ellos
 *
 * Ejecutar:  node prisma/revisar-sedes-coordinadores.js
 */

const linea = (n = 74) => '─'.repeat(n)

async function main() {
  console.log('\n' + linea())
  console.log('  REVISIÓN DE VÍNCULOS usuarios_sedes  ·  coordinadores')
  console.log(linea() + '\n')

  const coords = await prisma.user.findMany({
    where: { role: 'coordinador', active: true },
    select: {
      id: true,
      name: true,
      email: true,
      sites: { select: { site: { select: { id: true, name: true } } } },
    },
    orderBy: { name: 'asc' },
  })

  if (coords.length === 0) {
    console.log('  No hay coordinadores activos.\n')
    return
  }

  // ---- 1. Sin sedes vinculadas ----
  const sinSedes = coords.filter((c) => c.sites.length === 0)
  if (sinSedes.length > 0) {
    console.log('  ⛔  COORDINADORES SIN NINGUNA SEDE VINCULADA')
    console.log('      Con el aislamiento activo NO podrán programar nada.\n')
    for (const c of sinSedes) console.log(`      · ${c.name}  <${c.email}>`)
    console.log()
  } else {
    console.log('  ✅  Todos los coordinadores activos tienen al menos una sede.\n')
  }

  // ---- 2. Han programado fuera de sus sedes ----
  // Se mira quién CREÓ qué a través de la auditoría no es posible hacia atrás
  // (la programación no se auditaba hasta ahora), así que se usa una señal
  // indirecta: asignaciones donde el coordinador aparece como recurso o aux no
  // sirve. Lo que sí sirve: las sedes que ese coordinador cerró alguna vez.
  const cierres = await prisma.weekSiteClosure.findMany({
    where: { closedBy: { in: coords.map((c) => c.id) } },
    select: { closedBy: true, site: { select: { id: true, name: true } } },
  })

  const fuera = []
  for (const c of coords) {
    const suyas = new Set(c.sites.map((s) => s.site.id))
    const cerradasPorEl = cierres.filter((x) => x.closedBy === c.id)
    const ajenas = [...new Map(
      cerradasPorEl.filter((x) => !suyas.has(x.site.id)).map((x) => [x.site.id, x.site.name])
    )]
    if (ajenas.length > 0) fuera.push({ coord: c, ajenas })
  }

  if (fuera.length > 0) {
    console.log('  ⚠️   HAN CERRADO SEDES A LAS QUE HOY NO ESTÁN VINCULADOS')
    console.log('      Señal de que trabajaban en ellas. Revisar si les falta el vínculo.\n')
    for (const f of fuera) {
      console.log(`      · ${f.coord.name}: ${f.ajenas.map(([, n]) => n).join(', ')}`)
    }
    console.log()
  }

  // ---- Resumen ----
  console.log(linea())
  console.log('  RESUMEN\n')
  for (const c of coords) {
    const nombres = c.sites.map((s) => s.site.name)
    const marca = nombres.length === 0 ? '⛔' : '  '
    console.log(`  ${marca} ${c.name.padEnd(30)} ${nombres.length ? nombres.join(', ') : '(ninguna)'}`)
  }
  console.log()
  console.log(`  ${coords.length} coordinadores activos · ${sinSedes.length} sin sedes · ${fuera.length} con indicios de trabajar fuera`)
  console.log(linea() + '\n')

  if (sinSedes.length > 0 || fuera.length > 0) {
    console.log('  Corregir desde  Admin → Usuarios → (editar) → Sedes  antes de dar por')
    console.log('  bueno el aislamiento por sede.\n')
  }
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
