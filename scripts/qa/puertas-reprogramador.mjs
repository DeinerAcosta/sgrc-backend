// QA adversarial · Las puertas de quien SOLO RECIBE encargos.
//
// Oct-2026 · Al separar los perfiles, el rol 'reprogramador' quedo para quien
// recibe el caso y llama a los pacientes; la lider pasa a supervisor. Se le
// recorto el menu de 7 entradas a 3.
//
// Quitar una entrada del menu NO cierra nada: la direccion se escribe a mano.
// Este guion entra por donde ya no hay menu y comprueba que el servidor lo
// rechace. Cuando se escribio encontro tres puertas abiertas:
//
//   · las ausencias de la semana, con el motivo de salud de cada profesional
//   · la pantalla completa de un caso ajeno
//   · repartir casos, que es el trabajo de la lider
//
// Necesita el backend levantado y los datos de prueba.
// Si una regresion reabre el reparto, el guion deja el dato como estaba.
import { PrismaClient } from '@prisma/client'

const API = 'http://localhost:3001/api'
const prisma = new PrismaClient()

async function login(email) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin123' }),
  })
  return r.ok ? (await r.json()).token : null
}
const idDe = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).id
const get = async (t, p) => {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const put = async (t, p, body) => {
  const r = await fetch(API + p, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const MARCA = 'PRUEBA QA puertas'
let abiertas = 0
const puerta = (nombre, cerrada, detalle = '') => {
  console.log(`  ${cerrada ? 'CERRADA' : ' ABIERTA'}  ${nombre}` + (detalle ? `\n            ${detalle}` : ''))
  if (!cerrada) abiertas++
}

console.log('QA · PUERTAS DE QUIEN SOLO RECIBE ENCARGOS')
console.log('='.repeat(74))

const luisa = await login('repro1@prueba.local')
const maria = await login('duarte@cofca.co')
if (!luisa || !maria) {
  console.log('No se pudo entrar. ¿Corriste npm run datos:prueba -- --aplicar?')
  await prisma.$disconnect()
  process.exit(1)
}
const yo = idDe(luisa)

// Sus propios casos, que son la referencia de "lo suyo".
const mios = await get(luisa, '/reschedules/mine?incluir_cerradas=true')
const idsMios = new Set((mios.body?.casos ?? []).map((c) => c.id))
console.log(`\nLuisa tiene ${idsMios.size} caso(s) a su nombre.\n`)

// Referencias vistas por la lider.
const todasM = await get(maria, '/absences')
const listaM = Array.isArray(todasM.body) ? todasM.body : (todasM.body?.data ?? [])
const ajena = listaM.find((a) => !idsMios.has(a.id) && a.status === 'confirmada')
const semanas = await get(maria, '/weeks')
const lw = Array.isArray(semanas.body) ? semanas.body : (semanas.body?.data ?? [])
const hoy = new Date()
const semana = lw.find((w) => new Date(w.start_date) <= hoy && hoy <= new Date(w.end_date)) ?? lw[0]

// 1 · Las ausencias de la semana alimentan las casillas rojas del Programador,
//     que Luisa si tiene en su menu — pero solo deben ser las suyas. El cuerpo
//     trae el motivo de cada ausencia, que es dato de salud.
if (semana) {
  const r = await get(luisa, `/weeks/${semana.id}/absences`)
  const aus = r.body?.ausencias ?? []
  const ajenas = aus.filter((a) => !idsMios.has(a.id))
  puerta('las ausencias de la semana, con el motivo de cada uno', ajenas.length === 0,
    `recibe ${aus.length}, de las cuales ${ajenas.length} no son suyas` +
      (ajenas[0] ? ` · ej: ${ajenas[0].resource?.name} — "${ajenas[0].motivo_catalogo ?? ajenas[0].motivo_texto ?? '?'}"` : ''))
}

// 2 · La pantalla completa de un caso ajeno: horarios, sedes, pacientes, motivo.
if (ajena) {
  const r = await get(luisa, `/absences/${ajena.id}/replacement-context`)
  puerta('la pantalla de un caso que no le asignaron', r.status === 403 || r.status === 404,
    `HTTP ${r.status} con el caso de ${ajena.resource?.name}`)
}

// 3 · Ni el suyo: esa pantalla es para decidir el reemplazo —candidatos,
//     sedes, coordinadores— y el no decide nada de eso. Su caso lo trabaja
//     desde /reschedules/mine, que es donde anota las llamadas.
const propio = [...idsMios][0]
if (propio) {
  const r = await get(luisa, `/absences/${propio}/replacement-context`)
  puerta('la pantalla de reemplazo, incluso la de su propio caso', r.status === 403,
    `HTTP ${r.status}`)
}

// 4 · Pero su pantalla SI funciona: un recorte que lo deje sin trabajar es el
//     mismo error al reves.
{
  const r = await get(luisa, '/reschedules/mine')
  const n = r.body?.casos?.length ?? 0
  const ok = r.status === 200 && n > 0
  console.log(`  ${ok ? '   SI  ' : ' FALLA '}  su lista de trabajo responde   (HTTP ${r.status}, ${n} casos)`)
  if (!ok) abiertas++
}

// 4 · Repartir. Es el trabajo de la lider.
if (ajena) {
  const repros = await get(maria, '/users/reschedulers')
  const otro = (repros.body ?? []).find((r) => r.id !== yo)
  if (otro) {
    const r = await put(luisa, `/absences/${ajena.id}/rescheduler`,
      { rescheduler_id: otro.id, notes: MARCA })
    puerta('repartir un caso a un companero', r.status >= 400,
      `HTTP ${r.status} al intentar asignarselo a ${otro.name}`)
  }
}

// 5 · Cerrar lo que no es suyo.
if (ajena) {
  const r = await put(luisa, `/absences/${ajena.id}/rescheduler/done`)
  puerta('cerrar un caso ajeno', r.status >= 400, `HTTP ${r.status}`)
}

// 5b · Confirmar o rechazar una ausencia. Decidir si ocurrió es del
//      coordinador o de la líder, no de quien llama. Solo se mandan peticiones
//      que DEBEN rebotar; si alguna pasara, la limpieza de abajo no la cubre,
//      así que se prueba con un id inexistente: lo que importa es el 403 del
//      rol, que llega antes de buscar la ausencia.
{
  const fantasma = '00000000-0000-0000-0000-000000000000'
  const c = await put(luisa, `/absences/${fantasma}/confirm`, {})
  puerta('confirmar una ausencia', c.status === 403, `HTTP ${c.status}`)
  const r = await put(luisa, `/absences/${fantasma}/reject`, { reason: 'prueba' })
  puerta('rechazar una ausencia', r.status === 403, `HTTP ${r.status}`)
  // Oct-2026 · Los pacientes reales los pone la líder; quien llama solo los ve.
  const p = await put(luisa, `/absences/${fantasma}/patients`, { patients_confirmed: 10 })
  puerta('poner los pacientes reales del caso', p.status === 403, `HTTP ${p.status}`)
}

// 6 · El tablero de indicadores, que salio de su menu.
// Oct-2026 · Antes se probaba '/reprogramaciones-dashboard', que no existe:
// daba 404 y la prueba pasaba sin probar nada. La ruta real es esta, y se
// exige 403 (no basta con "algún error").
const tab = await get(luisa, '/reports/reschedules-dashboard')
puerta('el tablero de indicadores', tab.status === 403, `HTTP ${tab.status}`)

// Oct-2026 · Lo nuevo de la líder y de quien programa: tampoco es suyo.
for (const [que, ruta] of [
  ['la gestión de los reprogramadores', '/reports/reschedulers'],
  ['los indicadores de asesores', '/reports/advisor-indicators'],
  ['los cambios de la semana', `/weeks/${semana?.id}/changes`],
  ['los bloqueos de sede', '/site-blocks'],
]) {
  const r = await get(luisa, ruta)
  puerta(que, r.status === 403, `HTTP ${r.status}`)
}

// ── Se deja todo como estaba ───────────────────────────────────────────────
// Solo escribe si una regresion reabre el reparto; aun asi se limpia siempre.
const sucias = await prisma.absence.findMany({
  where: { rescheduleNotes: { contains: MARCA } },
  select: { id: true, resource: { select: { name: true } } },
})
if (sucias.length) {
  for (const a of sucias) {
    await prisma.absence.update({
      where: { id: a.id },
      data: { reschedulerId: null, assignedBy: null, assignedAt: null, rescheduleStatus: null, rescheduleNotes: null },
    })
  }
  console.log(`\n  (se revirtieron ${sucias.length} asignacion(es) que dejo la prueba)`)
}

await prisma.$disconnect()
console.log('\n' + '='.repeat(74))
console.log(abiertas === 0 ? 'TODAS LAS PUERTAS CERRADAS.' : `${abiertas} PUERTA(S) ABIERTA(S).`)
process.exit(abiertas === 0 ? 0 : 1)
