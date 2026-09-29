/**
 * FUSIONAR RECURSOS DUPLICADOS
 * ============================
 *
 * Una misma persona quedo cargada dos o tres veces. Este script mueve TODO el
 * historial de las copias al recurso que se conserva y despues borra las copias,
 * que ya quedan sin nada colgando.
 *
 * POR QUE FUSIONAR Y NO BORRAR (sep-2026). Medido en produccion, las copias que
 * parecian "las malas" —las que no tienen usuario— resultaron ser justo las que
 * estan en la programacion:
 *
 *     Jeiny copia SIN usuario ....... 1 asignacion    (semana 10-ago, cerrada)
 *     Jeiny CON usuario ............. 0
 *     Ruby copia 1 SIN usuario ...... 1 asignacion    (semana 29-jun, cerrada)
 *     Ruby copia 2 SIN usuario ...... 1 asignacion    (semana 10-ago, cerrada)
 *     Ruby CON usuario .............. 0
 *
 * Borrar las huerfanas habria perdido tres asignaciones de semanas ya cerradas y
 * cambiado los informes de junio y agosto. Borrar las que tienen usuario habria
 * dejado a la persona sin acceso. La operacion correcta es mover y luego borrar.
 *
 * QUE SE MUEVE. Las SEIS referencias que existen a un recurso en el schema
 * (revisadas una por una; no basta con asignaciones y ausencias):
 *
 *   · Assignment.resourceId      — titular de la franja
 *   · Assignment.assistantId     — auxiliar 1
 *   · Assignment.assistant2Id    — auxiliar 2
 *   · Absence.resourceId         — las reposiciones cuelgan de la ausencia, viajan solas
 *   · BackofficeAssignment.assistantId
 *   · ResourceRequest.resourceId
 *
 * `User.resourceId` NO se mueve: el usuario se queda donde esta, y por eso el
 * recurso que se conserva es, por defecto, el que ya tiene usuario.
 *
 * USO
 *   node scripts/fusionar-recursos.js --nombre "Ruby Celeste Guerrero"
 *   node scripts/fusionar-recursos.js --nombre "Ruby Celeste Guerrero" --aplicar
 *   node scripts/fusionar-recursos.js --nombre "..." --mantener <id> --aplicar
 *
 * Sin --aplicar hace corrida en seco y no escribe nada. Si varias copias tienen
 * usuario, o ninguna lo tiene, se niega a elegir y pide --mantener: ahi la
 * decision es de negocio, no del script.
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : null
}
const APLICAR = args.includes('--aplicar')
const NOMBRE = flag('nombre')
const MANTENER = flag('mantener')

if (!NOMBRE) {
  console.error('Falta --nombre.\n  node scripts/fusionar-recursos.js --nombre "Ruby Celeste Guerrero" [--mantener <id>] [--aplicar]')
  process.exit(1)
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ')

/** Cuenta todo lo que apunta a un recurso. Las seis referencias del schema. */
async function dependencias(id) {
  const [titular, aux1, aux2, ausencias, backoffice, solicitudes] = await Promise.all([
    prisma.assignment.count({ where: { resourceId: id } }),
    prisma.assignment.count({ where: { assistantId: id } }),
    prisma.assignment.count({ where: { assistant2Id: id } }),
    prisma.absence.count({ where: { resourceId: id } }),
    prisma.backofficeAssignment.count({ where: { assistantId: id } }),
    prisma.resourceRequest.count({ where: { resourceId: id } }),
  ])
  const total = titular + aux1 + aux2 + ausencias + backoffice + solicitudes
  return { titular, aux1, aux2, ausencias, backoffice, solicitudes, total }
}

async function main() {
  console.log('='.repeat(76))
  console.log('FUSION DE RECURSOS DUPLICADOS' + (APLICAR ? '  ·  MODO APLICAR' : '  ·  CORRIDA EN SECO'))
  console.log('='.repeat(76))

  const todos = await prisma.resource.findMany({
    select: { id: true, name: true, type: true, active: true, createdAt: true, user: { select: { id: true, email: true } } },
  })
  const copias = todos.filter((r) => norm(r.name) === norm(NOMBRE))

  if (copias.length === 0) {
    console.error(`\nNo hay ningun recurso llamado "${NOMBRE}".`)
    process.exitCode = 1
    return
  }
  if (copias.length === 1) {
    console.log(`\n"${copias[0].name}" existe una sola vez. Nada que fusionar.`)
    return
  }

  console.log(`\n"${copias[0].name}" — ${copias.length} copias (tipo ${copias[0].type})\n`)
  const deps = new Map()
  for (const c of copias) {
    const d = await dependencias(c.id)
    deps.set(c.id, d)
    console.log(`  id=${c.id}`)
    console.log(`     ${c.active ? 'activo  ' : 'inactivo'}  usuario=${c.user ? c.user.email : 'NINGUNO'}  creado ${c.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`)
    console.log(`     titular=${d.titular} aux1=${d.aux1} aux2=${d.aux2} ausencias=${d.ausencias} backoffice=${d.backoffice} solicitudes=${d.solicitudes}  (total ${d.total})`)
  }

  // A quien se conserva: el que tiene usuario, salvo que se indique otro.
  let destino
  if (MANTENER) {
    destino = copias.find((c) => c.id === MANTENER)
    if (!destino) {
      console.error(`\n--mantener ${MANTENER} no es ninguna de las copias de arriba.`)
      process.exitCode = 1
      return
    }
  } else {
    const conUsuario = copias.filter((c) => c.user)
    if (conUsuario.length !== 1) {
      console.error(`\nNo puedo elegir solo: ${conUsuario.length} copias tienen usuario.`)
      console.error('Decide cual se queda y vuelve a correr con --mantener <id>.')
      process.exitCode = 1
      return
    }
    destino = conUsuario[0]
  }

  const aFusionar = copias.filter((c) => c.id !== destino.id)
  console.log(`\nSE CONSERVA : ${destino.id}  (usuario: ${destino.user?.email ?? 'ninguno'})`)
  console.log(`SE FUSIONAN : ${aFusionar.map((c) => c.id).join(', ')}`)

  const mover = aFusionar.reduce((acc, c) => {
    const d = deps.get(c.id)
    for (const k of Object.keys(d)) acc[k] = (acc[k] ?? 0) + d[k]
    return acc
  }, {})
  console.log(`\nSE MOVERAN al recurso que se conserva:`)
  console.log(`   asignaciones como titular : ${mover.titular}`)
  console.log(`   asignaciones como aux 1   : ${mover.aux1}`)
  console.log(`   asignaciones como aux 2   : ${mover.aux2}`)
  console.log(`   ausencias (y sus reposiciones): ${mover.ausencias}`)
  console.log(`   tareas de backoffice      : ${mover.backoffice}`)
  console.log(`   solicitudes de recurso    : ${mover.solicitudes}`)
  console.log(`   ─────────────────────────────`)
  console.log(`   total                     : ${mover.total}`)
  console.log(`\nY despues se borraran ${aFusionar.length} recurso(s), que ya quedarian sin historial.`)

  const usuariosHuerfanos = aFusionar.filter((c) => c.user)
  if (usuariosHuerfanos.length) {
    console.log(`\nATENCION: ${usuariosHuerfanos.length} de las copias a fusionar TIENEN usuario:`)
    usuariosHuerfanos.forEach((c) => console.log(`   ${c.user.email}`))
    console.log('   Esos usuarios quedarian sin recurso vinculado. Revisa antes de aplicar.')
  }

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(76))
    console.log('CORRIDA EN SECO — no se escribio nada.')
    console.log('Para aplicar, repite el comando agregando  --aplicar')
    console.log('-'.repeat(76))
    return
  }

  const ids = aFusionar.map((c) => c.id)
  await prisma.$transaction(async (tx) => {
    await tx.assignment.updateMany({ where: { resourceId: { in: ids } }, data: { resourceId: destino.id } })
    await tx.assignment.updateMany({ where: { assistantId: { in: ids } }, data: { assistantId: destino.id } })
    await tx.assignment.updateMany({ where: { assistant2Id: { in: ids } }, data: { assistant2Id: destino.id } })
    await tx.absence.updateMany({ where: { resourceId: { in: ids } }, data: { resourceId: destino.id } })
    await tx.backofficeAssignment.updateMany({ where: { assistantId: { in: ids } }, data: { assistantId: destino.id } })
    await tx.resourceRequest.updateMany({ where: { resourceId: { in: ids } }, data: { resourceId: destino.id } })
    // Un usuario vinculado a una copia se queda sin recurso: se desvincula
    // explicitamente para que el borrado no choque contra la FK.
    await tx.user.updateMany({ where: { resourceId: { in: ids } }, data: { resourceId: null } })
    await tx.resource.deleteMany({ where: { id: { in: ids } } })
  })

  await registrarAuditoria({
    userId: destino.user?.id ?? null,
    action: 'fusionar_recursos',
    entity: 'recursos',
    entityId: destino.id,
    oldValue: { fusionados: ids, nombre: destino.name },
    newValue: { conservado: destino.id, movidos: mover },
    reason: `Fusion de ${copias.length} copias duplicadas de "${destino.name}"`,
  })

  // Verificacion: no debe quedar nada apuntando a los borrados ni el nombre repetido.
  const restantes = await prisma.resource.count({ where: { id: { in: ids } } })
  const quedan = (await prisma.resource.findMany({ select: { name: true } }))
    .filter((r) => norm(r.name) === norm(NOMBRE)).length
  const depsDestino = await dependencias(destino.id)

  console.log('\n' + '-'.repeat(76))
  console.log(`APLICADO — ${mover.total} registro(s) movidos, ${ids.length} recurso(s) borrados.`)
  console.log(`Verificacion: copias que sobreviven = ${restantes} (debe ser 0)`)
  console.log(`              recursos con ese nombre = ${quedan} (debe ser 1)`)
  console.log(`              historial ahora en el conservado = ${depsDestino.total}`)
  if (restantes !== 0 || quedan !== 1) {
    console.log('ATENCION: la verificacion no cuadro. Revisar antes de dar por cerrado.')
    process.exitCode = 1
  }
  console.log('-'.repeat(76))
}

main()
  .catch((e) => {
    console.error('\nFALLO — la escritura va en transaccion, no quedo a medias:')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
