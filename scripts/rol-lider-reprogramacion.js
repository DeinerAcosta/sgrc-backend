// Oct-2026 · Maria Duarte pasa de 'reprogramador' a 'supervisor'.
//
// El rol 'reprogramador' quedo para QUIEN RECIBE el encargo: ve sus casos,
// llama a los pacientes y los cierra. Hector: "este perfil es para las
// personas que Duarte asigna, no para Duarte".
//
// Maria lidera el proceso: mira la agenda caida, decide y reparte. Eso lo
// hace el perfil de supervisor, que ya tiene Gestion de ausencias completa y
// permiso para asignar un reprogramador. No hizo falta un rol nuevo.
//
// Efecto lateral util: 'listReprogramadores' solo devuelve usuarios con rol
// 'reprogramador', asi que Maria deja de salir en su propio desplegable de
// "asignar a".
//
//   node scripts/rol-lider-reprogramacion.js              (corrida en seco)
//   node scripts/rol-lider-reprogramacion.js --aplicar
import { PrismaClient } from '@prisma/client'
import { registrarAuditoria } from '../src/middleware/audit.js'

const prisma = new PrismaClient()
const aplicar = process.argv.includes('--aplicar')
const CORREO = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1] ?? 'duarte@cofca.co'
const NUEVO = 'supervisor'

const linea = () => console.log('-'.repeat(78))

async function main() {
  console.log('')
  linea()
  console.log('LA LIDER DE REPROGRAMACION PASA A SUPERVISOR')
  console.log('MODO: ' + (aplicar ? 'APLICAR' : 'CORRIDA EN SECO'))
  linea()

  const u = await prisma.user.findUnique({
    where: { email: CORREO },
    select: { id: true, name: true, email: true, role: true, active: true },
  })

  if (!u) {
    console.log(`\nNo existe ningun usuario con el correo ${CORREO}.`)
    console.log('Si el correo de Maria es otro, pasalo asi:')
    console.log('   node scripts/rol-lider-reprogramacion.js --email=otro@correo.co --aplicar')
    process.exitCode = 1
    return
  }

  console.log(`\n  ${u.name}  <${u.email}>`)
  console.log(`  rol actual : ${u.role}`)
  console.log(`  rol nuevo  : ${NUEVO}`)

  if (u.role === NUEVO) {
    console.log('\nYa esta en supervisor. No hay nada que hacer.')
    return
  }

  // Quien se queda con el rol de reprogramador, para que quede claro a quien
  // afecta el recorte del menu.
  const reprogramadores = await prisma.user.findMany({
    where: { role: 'reprogramador', active: true, NOT: { id: u.id } },
    select: { name: true, email: true },
    orderBy: { name: 'asc' },
  })
  console.log(`\n  Siguen con rol 'reprogramador' (reciben encargos): ${reprogramadores.length}`)
  for (const r of reprogramadores) console.log(`     · ${r.name}  <${r.email}>`)

  // Los casos que ya tenga asignados a su nombre: al dejar el rol dejaria de
  // verlos en "Mis reprogramaciones", asi que conviene saberlo antes.
  const suyos = await prisma.absence.count({
    where: { reschedulerId: u.id, rescheduleStatus: { not: 'resuelta' } },
  })
  if (suyos > 0) {
    console.log(`\n  OJO: tiene ${suyos} caso(s) abierto(s) asignados a su nombre.`)
    console.log('       Como supervisor los sigue viendo y cerrando, pero hay que')
    console.log('       repartirlos a un reprogramador para que alguien los trabaje.')
  }

  if (!aplicar) {
    linea()
    console.log('CORRIDA EN SECO. Para aplicarlo:')
    console.log('   node scripts/rol-lider-reprogramacion.js --aplicar')
    linea()
    return
  }

  // La auditoria va ANTES de tocar nada, y si no queda no se toca: un cambio
  // de rol sin rastro es exactamente lo que no se puede permitir.
  const entrada = await registrarAuditoria({
    userId: null,
    action: 'cambiar_rol',
    entity: 'usuarios',
    entityId: u.id,
    oldValue: { role: u.role },
    newValue: { role: NUEVO },
    reason: 'La lider de reprogramacion pasa a supervisor: el rol reprogramador queda para quien recibe los encargos',
  })
  if (!entrada) {
    console.log('\nNo se pudo registrar la auditoria. No se cambia nada.')
    process.exitCode = 1
    return
  }

  await prisma.user.update({ where: { id: u.id }, data: { role: NUEVO } })

  linea()
  console.log(`LISTO. ${u.name} entra ahora como ${NUEVO}.`)
  console.log('')
  console.log('  Su camino para repartir: Gestion de ausencias → el caso → Asignar')
  console.log('  Ya no sale en su propio desplegable de "asignar a".')
  console.log('')
  console.log('  Para devolverla: --email=' + u.email + ' y cambiar NUEVO en este archivo,')
  console.log('  o desde Catalogos → Usuarios en la propia aplicacion.')
  linea()
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
