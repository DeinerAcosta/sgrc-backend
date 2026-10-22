// QA · El registro de llamadas de quien recibe el encargo.
//
// Oct-2026 · Hector corrigio el perfil: "¿por que el reprogramador debe
// reprogramar? El reprogramador solamente mira a que profesional le asignaron
// y que el mismo ponga cuantos pacientes fueron los que llamo, cuales
// contestaron y cuales no, para asi ver en el indicador de su personal".
//
// Se comprueba que pueda anotar lo suyo, que el indicador cuadre, que no
// pueda anotar en lo ajeno y que no pueda meter numeros imposibles.
//
// Necesita el backend levantado y los datos de prueba.
// Deja los contadores como estaban al terminar.
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
const get = async (t, p) => {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const put = async (t, p, body) => {
  const r = await fetch(API + p, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

let mal = 0
const prueba = (n, ok, d = '') => {
  console.log((ok ? '  PASA  ' : '  FALLA ') + n + (d ? '\n          ' + d : ''))
  if (!ok) mal++
}

console.log('QA · REGISTRO DE LLAMADAS')
console.log('='.repeat(74))

const luisa = await login('repro1@prueba.local')
const maria = await login('duarte@cofca.co')
if (!luisa || !maria) {
  console.log('No se pudo entrar. ¿Corriste npm run datos:prueba -- --aplicar?')
  await prisma.$disconnect(); process.exit(1)
}

const antes = await get(luisa, '/reschedules/mine')
const casos = antes.body?.casos ?? []
prueba('tiene casos asignados', casos.length > 0, `${casos.length}`)
if (casos.length === 0) { await prisma.$disconnect(); process.exit(1) }

const caso = casos[0]
const tope = caso.cuenta.pacientes_impactados
console.log(`\n  Caso: ${caso.resource?.name} · ${tope} pacientes en la agenda`)
console.log(`  Le asigno: ${caso.asignada_por ?? '—'}`)

// Se guarda el estado para devolverlo tal cual al final.
const original = await prisma.absence.findUnique({
  where: { id: caso.id },
  select: { patientsReached: true, patientsNoAnswer: true, callLogAt: true, patientsConfirmed: true },
})

// ── Los pacientes REALES los pone la LÍDER ─────────────────────────────────
// Oct-2026 · Antes los corregía quien llama. Hector lo cambió: "en el momento
// del proceso de repro, en líder es donde pone los datos de los pacientes
// reales afectados", y quien llama solo los ve.
console.log('\nLOS PACIENTES REALES LOS PONE LA LÍDER')
const estimado = caso.cuenta.pacientes_estimados
const r0 = await put(luisa, `/absences/${caso.id}/call-log`, { reached: tope + 5, no_answer: 0 })
prueba('sin corregir, rebota llamar a mas de los pacientes del caso', r0.status >= 400, `HTTP ${r0.status}`)

const r0x = await put(luisa, `/absences/${caso.id}/call-log`,
  { reached: 1, no_answer: 0, patients_confirmed: tope + 10 })
prueba('quien llama ya no puede poner el numero real (y se le dice quien)',
  r0x.status === 400 && /líder/.test(r0x.body?.message ?? ''), `HTTP ${r0x.status} · ${r0x.body?.message ?? ''}`)
const r0y = await put(luisa, `/absences/${caso.id}/patients`, { patients_confirmed: tope + 10 })
prueba('ni por la puerta de la líder', r0y.status === 403, `HTTP ${r0y.status}`)

const r0b = await put(maria, `/absences/${caso.id}/patients`, { patients_confirmed: tope + 10 })
prueba('la líder pone el numero real', r0b.status === 200, `HTTP ${r0b.status} · ${r0b.body?.message ?? ''}`)

const trasReal = await get(luisa, '/reschedules/mine')
const cReal = (trasReal.body?.casos ?? []).find((c) => c.id === caso.id)
prueba('quien llama ve el real, y el estimado del sistema se conserva',
  cReal?.cuenta?.pacientes_oficiales === tope + 10 && cReal?.cuenta?.pacientes_estimados === estimado &&
  cReal?.cuenta?.pacientes_corregidos === true,
  `oficial ${cReal?.cuenta?.pacientes_oficiales} · estimado ${cReal?.cuenta?.pacientes_estimados}`)
prueba('el indicador se mide contra el real', (trasReal.body?.resumen?.pacientes_impactados ?? 0) >= tope + 10,
  `${trasReal.body?.resumen?.pacientes_impactados}`)
const r0d = await put(luisa, `/absences/${caso.id}/call-log`, { reached: tope + 5, no_answer: 0 })
prueba('con el real puesto, la misma cifra de antes ya pasa', r0d.status === 200, `HTTP ${r0d.status}`)

// El verde del cronograma: solo cuando de verdad estan todas.
const trasParcial = await get(luisa, '/reschedules/mine')
const cParcial = (trasParcial.body?.casos ?? []).find((c) => c.id === caso.id)
prueba('aun no esta completa', cParcial?.llamadas?.completa === false, JSON.stringify(cParcial?.llamadas))
const r0c = await put(luisa, `/absences/${caso.id}/call-log`, { reached: tope + 10, no_answer: 0 })
const trasFin = await get(luisa, '/reschedules/mine')
const cFin = (trasFin.body?.casos ?? []).find((c) => c.id === caso.id)
prueba('al llamarlos a todos, queda completa (el verde del cronograma)',
  r0c.status === 200 && cFin?.llamadas?.completa === true, JSON.stringify(cFin?.llamadas))

// Y la líder no puede bajarlo por debajo de lo ya llamado.
const r0e = await put(maria, `/absences/${caso.id}/patients`, { patients_confirmed: tope + 9 })
prueba('la líder no puede poner menos de los ya llamados', r0e.status === 400 && /llam/.test(r0e.body?.message ?? ''),
  `HTTP ${r0e.status} · ${r0e.body?.message ?? ''}`)

console.log('\nANOTAR LO SUYO')
const contestaron = Math.max(1, Math.floor(tope * 0.7))
const noContestaron = Math.max(0, Math.floor(tope * 0.1))
const r1 = await put(luisa, `/absences/${caso.id}/call-log`, { reached: contestaron, no_answer: noContestaron })
prueba('registra sus llamadas', r1.status === 200, `HTTP ${r1.status} · ${JSON.stringify(r1.body).slice(0, 120)}`)

const tras = await get(luisa, '/reschedules/mine')
const casoTras = (tras.body?.casos ?? []).find((c) => c.id === caso.id)
prueba('el caso devuelve lo anotado',
  casoTras?.llamadas?.contestaron === contestaron && casoTras?.llamadas?.no_contestaron === noContestaron,
  JSON.stringify(casoTras?.llamadas))
prueba('el total de llamados es la suma, no un tercer numero',
  casoTras?.llamadas?.llamados === contestaron + noContestaron,
  `${casoTras?.llamadas?.llamados} vs ${contestaron + noContestaron}`)

console.log('\nEL INDICADOR DE LA PERSONA')
const ll = tras.body?.resumen?.llamadas ?? {}
console.log(`   ${JSON.stringify(ll)}`)
prueba('cuenta los contestaron', (ll.contestaron ?? 0) >= contestaron)
prueba('la efectividad es contestaron sobre llamados',
  ll.llamados > 0 && ll.efectividad === Math.round((ll.contestaron / ll.llamados) * 100),
  `${ll.efectividad}% con ${ll.contestaron}/${ll.llamados}`)
prueba('los que faltan por llamar no son negativos', (ll.por_llamar ?? 0) >= 0, `${ll.por_llamar}`)

console.log('\nLO QUE NO DEBE PODER')
const r2 = await put(luisa, `/absences/${caso.id}/call-log`, { reached: tope + 50, no_answer: 0 })
prueba('rechaza mas llamadas que pacientes', r2.status >= 400,
  `HTTP ${r2.status} al anotar ${tope + 50} sobre ${tope}`)

const r3 = await put(luisa, `/absences/${caso.id}/call-log`, { reached: -3, no_answer: 0 })
prueba('rechaza un negativo', r3.status >= 400, `HTTP ${r3.status}`)

// Un caso que no es suyo.
const todas = await get(maria, '/absences')
const lista = Array.isArray(todas.body) ? todas.body : (todas.body?.data ?? [])
const mios = new Set(casos.map((c) => c.id))
const ajena = lista.find((a) => !mios.has(a.id))
if (ajena) {
  const r4 = await put(luisa, `/absences/${ajena.id}/call-log`, { reached: 1, no_answer: 0 })
  prueba('no puede anotar en un caso ajeno', r4.status >= 400, `HTTP ${r4.status}`)
}

// Y la pantalla de reemplazo ya no es asunto suyo.
const r5 = await get(luisa, `/absences/${caso.id}/replacement-context`)
prueba('no entra a la pantalla de reemplazo, ni la suya', r5.status === 403, `HTTP ${r5.status}`)

// ── Se deja como estaba ────────────────────────────────────────────────────
await prisma.absence.update({ where: { id: caso.id }, data: original })
const vuelta = await prisma.absence.findUnique({
  where: { id: caso.id }, select: { patientsReached: true, patientsNoAnswer: true },
})
prueba('se deja el contador como estaba',
  vuelta.patientsReached === original.patientsReached && vuelta.patientsNoAnswer === original.patientsNoAnswer,
  `quedo en ${vuelta.patientsReached}/${vuelta.patientsNoAnswer}`)

await prisma.$disconnect()
console.log('\n' + '='.repeat(74))
console.log(mal === 0 ? 'TODO BIEN.' : mal + ' FALLO(S).')
process.exit(mal === 0 ? 0 : 1)
