// QA · El reparto del trabajo de reprogramacion.
//
// Hector lo fijo asi: "la reprogramacion de los profesionales la hace Maria
// Duarte. La de los demas como tec, asesores, aux los hace los coordinadores
// de sede".
//
// Este guion comprueba que el servidor reparta justo eso, que el reparto no
// deje huecos ni solapes, y que el coordinador pueda cerrar lo suyo — que era
// el hueco de verdad: la reprogramacion de un tecnico no pasa por "asignar un
// reprogramador", asi que exigirle uno lo dejaba sin poder cerrar nunca.
//
// Necesita el backend levantado y los datos de prueba (npm run datos:prueba).
// La unica escritura es cerrar un caso del coordinador, y se deshace al final
// contra la BD. Queda la fila de auditoria, que es correcto: el cierre ocurrio.
import { PrismaClient } from '@prisma/client'

const API = 'http://localhost:3001/api'
const PROFESIONALES = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'otorrino', 'fonoaudiologa'])
const prisma = new PrismaClient()

async function login(email) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin123' }),
  })
  return r.ok ? (await r.json()).token : null
}
const get = async (t, p) => {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const put = async (t, p) => {
  const r = await fetch(API + p, { method: 'PUT', headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const CUENTAS = {
  // Quien RECIBE los encargos. Es el perfil que estamos probando: "este
  // perfil es para las personas que Duarte asigna, no para Duarte".
  reprogramador: 'repro1@prueba.local',
  coordinador: 'maria.lopez@cofca.co',
  gerencia: 'gerencia@cofca.co',
  recurso: 'angela.sarmiento@cofca.co',
}

/** El id del usuario, sacado del payload del token. No hace falta el secreto. */
function idDelToken(t) {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).id
  } catch { return null }
}

let mal = 0
const prueba = (n, ok, det = '') => {
  console.log((ok ? '  PASA  ' : '  FALLA ') + n + (det ? '\n          ' + det : ''))
  if (!ok) mal++
}

const tok = {}
const vistos = {}

console.log('QA · REPARTO DE LA REPROGRAMACION')
console.log('='.repeat(72))

for (const [rol, mail] of Object.entries(CUENTAS)) {
  tok[rol] = await login(mail)
  if (!tok[rol]) { console.log(`\n${rol}: NO ENTRA (${mail})`); mal++; continue }

  const r = await get(tok[rol], '/reschedules/mine')
  console.log(`\n${rol.toUpperCase()}  ->  HTTP ${r.status}`)

  if (rol === 'recurso') {
    prueba('el rol recurso no entra a la lista', r.status === 403 || r.status === 401, `devolvio ${r.status}`)
    continue
  }

  prueba('responde 200', r.status === 200)
  if (r.status !== 200) { console.log('   ', JSON.stringify(r.body).slice(0, 300)); continue }

  const casos = r.body.casos ?? []
  vistos[rol] = casos
  const tipos = [...new Set(casos.map((c) => c.resource?.type))]
  console.log(`   casos: ${casos.length} · tipos: ${tipos.join(', ') || '(ninguno)'}`)
  console.log(`   resumen: ${JSON.stringify(r.body.resumen)}`)

  if (rol === 'reprogramador') {
    // Lo suyo y nada mas. Antes le salia el reparto entero de profesionales,
    // que es el trabajo de la lider, no el de quien recibe el encargo.
    const yo = idDelToken(tok[rol])
    const ajenos = casos.filter((c) => c.rescheduler_id !== yo)
    prueba('solo lo que le asignaron a el', ajenos.length === 0,
      `${ajenos.length} casos que no son suyos`)
    prueba('cada caso dice quien se lo asigno', casos.every((c) => !!c.asignada_por),
      'sin asignador: ' + casos.filter((c) => !c.asignada_por).length)
    const conNotas = casos.filter((c) => c.reschedule_notes)
    console.log(`   con indicaciones de la lider: ${conNotas.length} de ${casos.length}`)
    if (conNotas[0]) console.log(`   «${conNotas[0].reschedule_notes}»`)
  }
  if (rol === 'coordinador') {
    prueba('ningun profesional', tipos.every((t) => !PROFESIONALES.has(t)),
      'colados: ' + tipos.filter((t) => PROFESIONALES.has(t)).join(', '))
  }

  const c = casos[0]
  if (c) {
    prueba('el caso trae la cuenta de pacientes', !!c.cuenta && typeof c.cuenta.pacientes_pendientes === 'number')
    prueba('el caso trae los dias', Array.isArray(c.dias))
    prueba('el caso trae las franjas con sede', Array.isArray(c.franjas))
    console.log(`   primero: ${c.resource?.name} (${c.resource?.type}) · ${c.dias?.join(',')} · ` +
      `${c.cuenta.pacientes_cubiertos}/${c.cuenta.pacientes_impactados} pac · sedes: ${(c.sedes ?? []).map((s) => s.name).join('/') || '-'}`)
  }

  const cerradas = await get(tok[rol], '/reschedules/mine?incluir_cerradas=true')
  prueba('incluir_cerradas devuelve al menos lo mismo',
    (cerradas.body?.casos?.length ?? -1) >= casos.length,
    `abiertas ${casos.length} vs con cerradas ${cerradas.body?.casos?.length}`)
}

// ── Nada se trabaja dos veces, nada se queda sin dueño ──────────────────────
if (vistos.reprogramador && vistos.coordinador && vistos.gerencia) {
  console.log('\nEL REPARTO COMPLETO')
  const delRepro = new Set(vistos.reprogramador.map((c) => c.id))
  const deCoord = new Set(vistos.coordinador.map((c) => c.id))
  const solapan = [...delRepro].filter((id) => deCoord.has(id))
  prueba('ningun caso le toca a los dos', solapan.length === 0, `${solapan.length} repetidos`)

  // Gerencia supervisa: nada de lo que ellos ven se le puede escapar. No se
  // exige igualdad al reves, porque gerencia ve ademas lo que aun no se
  // reparte y las sedes que el coordinador no lleva.
  const suyos = new Set([...delRepro, ...deCoord])
  const deGerencia = new Set(vistos.gerencia.map((c) => c.id))
  const huerfanos = [...suyos].filter((id) => !deGerencia.has(id))
  prueba('lo de ellos dos aparece en la vista de gerencia', huerfanos.length === 0,
    `${huerfanos.length} casos que ellos ven y gerencia no`)
  console.log(`   reprogramador ${delRepro.size} + coordinador ${deCoord.size} · gerencia ve ${deGerencia.size}`)
}

// ── La lider reparte, no recibe ─────────────────────────────────────────────
// Maria entra como supervisor desde oct-2026: el rol 'reprogramador' quedo
// para quien recibe el encargo. Lo que se comprueba aqui es que siga pudiendo
// repartir y que no se liste a si misma como destinataria.
{
  const t = await login('duarte@cofca.co')
  if (!t) {
    console.log('\nDUARTE: no entra')
    mal++
  } else {
    const rol = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).role
    console.log(`\nLA LIDER  (rol: ${rol})`)
    prueba('la lider no tiene el rol de quien recibe encargos', rol !== 'reprogramador',
      'sigue en reprogramador: compartiria menu con sus asignados')

    const repros = await get(t, '/users/reschedulers')
    const nombres = (repros.body ?? []).map((r) => r.name)
    prueba('tiene a quien asignarle', nombres.length > 0, nombres.join(', '))
    prueba('no sale en su propio desplegable', !nombres.some((n) => n.includes('Duarte')),
      'sale: ' + nombres.join(', '))

    const suyas = await get(t, '/absences')
    const lista = Array.isArray(suyas.body) ? suyas.body : (suyas.body?.data ?? [])
    prueba('sigue viendo las ausencias para repartir', lista.length > 0, `${lista.length}`)
  }
}

// ── El coordinador cierra lo suyo ───────────────────────────────────────────
console.log('\nCERRAR UN CASO')
const mio = (vistos.coordinador ?? []).find((c) => c.reschedule_status !== 'resuelta')
if (!mio) {
  console.log('  ojo   el coordinador no tiene ningun caso abierto para probar el cierre')
} else {
  const antes = await prisma.absence.findUnique({
    where: { id: mio.id },
    select: { rescheduleStatus: true, rescheduleDoneAt: true },
  })

  const cierre = await put(tok.coordinador, `/absences/${mio.id}/rescheduler/done`)
  prueba('el coordinador cierra un caso de su reparto', cierre.status < 400,
    `devolvio ${cierre.status} · ${JSON.stringify(cierre.body).slice(0, 160)}`)

  const despues = await prisma.absence.findUnique({
    where: { id: mio.id }, select: { rescheduleStatus: true },
  })
  prueba('queda marcado como resuelto', despues?.rescheduleStatus === 'resuelta',
    `quedo en ${despues?.rescheduleStatus}`)

  // Se deshace: este guion no decide el estado de los datos de nadie.
  await prisma.absence.update({ where: { id: mio.id }, data: antes })
  const restaurado = await prisma.absence.findUnique({
    where: { id: mio.id }, select: { rescheduleStatus: true },
  })
  prueba('se deja como estaba', restaurado?.rescheduleStatus === antes.rescheduleStatus,
    `esperado ${antes.rescheduleStatus}, quedo ${restaurado?.rescheduleStatus}`)
}

// Y no puede cerrar el de un profesional: ese es de la lider.
const ajeno = (vistos.reprogramador ?? [])[0]
if (ajeno) {
  const r = await put(tok.coordinador, `/absences/${ajeno.id}/rescheduler/done`)
  prueba('el coordinador no puede cerrar el caso de un profesional', r.status >= 400,
    `devolvio ${r.status}`)
}

await prisma.$disconnect()
console.log('\n' + '='.repeat(72))
console.log(mal === 0 ? 'TODO BIEN.' : mal + ' FALLO(S).')
process.exit(mal === 0 ? 0 : 1)
