/**
 * CREAR EL USUARIO DE UN RECURSO QUE YA EXISTE
 * ============================================
 *
 * Vincula un usuario nuevo a un recurso que ya esta en el catalogo. No es lo
 * mismo que "Nuevo usuario" en la pantalla: ese crea un recurso NUEVO, y usarlo
 * aqui dejaria una segunda copia de la persona — justo el problema que venimos
 * limpiando.
 *
 * POR QUE HACE FALTA (sep-2026). En produccion hay recursos sin usuario
 * vinculado: no pueden entrar al sistema y no existe pantalla que los conecte.
 * Dos de ellos —Munir Escaf Vergara y Katiuscka Zarate Ariza— son personas
 * reales, no duplicados, asi que lo que corresponde no es borrarlos sino darles
 * acceso.
 *
 * SOBRE EL CORREO. Si no se pasa --email, se genera uno de relleno con dominio
 * `pendiente.sgrc`, que no existe: asi ningun correo se va a una direccion ajena
 * por accidente. Se cambia despues desde Gestion de usuarios. El alta NO envia
 * correo de bienvenida (create() del controlador tampoco lo hace), de modo que
 * una direccion falsa no genera rebotes.
 *
 * La contrasena queda en la provisional comun y con `debe_cambiar_password`, o
 * sea que la persona la cambia en su primer ingreso.
 *
 * USO
 *   node scripts/crear-usuario-de-recurso.js --recurso "Munir Escaf Vergara"
 *   node scripts/crear-usuario-de-recurso.js --recurso "Munir Escaf Vergara" --aplicar
 *   node scripts/crear-usuario-de-recurso.js --recurso "..." --email real@cofca.com --aplicar
 */
import bcrypt from 'bcrypt'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'

const PASSWORD_PROVISIONAL = 'SGRC2026!'
const DOMINIO_RELLENO = 'pendiente.sgrc'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : null
}
const APLICAR = args.includes('--aplicar')
const RECURSO = flag('recurso')
const EMAIL = flag('email')

if (!RECURSO) {
  console.error('Falta --recurso.\n  node scripts/crear-usuario-de-recurso.js --recurso "Munir Escaf Vergara" [--email x@y.com] [--aplicar]')
  process.exit(1)
}

/** "Munir Escaf Vergara" -> "munir.escaf@pendiente.sgrc" */
function correoDeRelleno(nombre) {
  const partes = nombre.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita tildes
    .replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
  const base = partes.slice(0, 2).join('.') || 'recurso'
  return `${base}@${DOMINIO_RELLENO}`
}

async function main() {
  console.log('='.repeat(72))
  console.log('CREAR USUARIO PARA UN RECURSO EXISTENTE' + (APLICAR ? '  ·  APLICAR' : '  ·  CORRIDA EN SECO'))
  console.log('='.repeat(72))

  const coincidencias = await prisma.resource.findMany({
    where: { name: { contains: RECURSO } },
    select: { id: true, name: true, type: true, active: true, user: { select: { email: true } } },
  })

  if (coincidencias.length === 0) {
    console.error(`\nNingun recurso contiene "${RECURSO}".`)
    process.exitCode = 1
    return
  }
  if (coincidencias.length > 1) {
    console.error(`\n"${RECURSO}" coincide con ${coincidencias.length} recursos. Concreta el nombre:`)
    coincidencias.forEach((r) => console.error(`   · ${r.name}  (usuario: ${r.user?.email ?? 'ninguno'})`))
    process.exitCode = 1
    return
  }

  const recurso = coincidencias[0]
  if (recurso.user) {
    console.log(`\n"${recurso.name}" YA tiene usuario: ${recurso.user.email}. Nada por hacer.`)
    return
  }

  const email = (EMAIL ?? correoDeRelleno(recurso.name)).trim().toLowerCase()
  const yaUsado = await prisma.user.findUnique({ where: { email }, select: { name: true } })
  if (yaUsado) {
    console.error(`\nEl correo ${email} ya esta registrado a nombre de ${yaUsado.name}. Pasa otro con --email.`)
    process.exitCode = 1
    return
  }

  console.log(`\nRecurso    : ${recurso.name}  (${recurso.type}, ${recurso.active ? 'activo' : 'inactivo'})`)
  console.log(`Correo     : ${email}${EMAIL ? '' : '   ← de relleno, cambiar despues en Gestion de usuarios'}`)
  console.log(`Rol        : recurso`)
  console.log(`Contrasena : ${PASSWORD_PROVISIONAL} (debe cambiarla al primer ingreso)`)
  console.log(`Sedes      : ninguna — asignarlas despues desde Gestion de usuarios`)

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(72))
    console.log('CORRIDA EN SECO — no se creo nada.')
    console.log('Para aplicar, repite el comando agregando  --aplicar')
    console.log('-'.repeat(72))
    return
  }

  const usuario = await prisma.user.create({
    data: {
      name: recurso.name,
      email,
      passwordHash: await bcrypt.hash(PASSWORD_PROVISIONAL, 12),
      role: 'recurso',
      resourceId: recurso.id,
      active: true,
      mustChangePassword: true,
    },
    select: { id: true, name: true, email: true },
  })

  await registrarAuditoria({
    userId: usuario.id,
    action: 'crear_usuario',
    entity: 'usuarios',
    entityId: usuario.id,
    newValue: { name: usuario.name, email: usuario.email, role: 'recurso', resourceId: recurso.id },
    reason: 'Recurso existente sin usuario vinculado — alta por script',
  })

  console.log('\n' + '-'.repeat(72))
  console.log(`CREADO — ${usuario.name} <${usuario.email}>`)
  console.log('Pendiente: ajustar el correo real y asignarle sedes desde Gestion de usuarios.')
  console.log('-'.repeat(72))
}

main()
  .catch((e) => {
    console.error('\nFALLO:')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
