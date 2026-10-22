// QA · Pulsar "Asignar" en TODOS los casos abiertos, como la pantalla.
//
// Oct-2026 · Hector: "mira el error que sale, cada vez hay muchos más
// errores". Los QA de flujo prueban un caso elegido; este barre todos los
// casos abiertos de la base —semana en curso y semanas pasadas, sedes
// abiertas y cerradas— y en cada jornada caída hace exactamente lo que hace
// la ventana de Asignar de la pantalla del caso: el primer candidato, todos
// los pacientes que falten, y el motivo si la sede ya cerró.
//
// Entra como la líder (supervisor). Todo lo que crea lo borra.
import { prisma } from '../../src/lib/prisma.js'
import { horaDeCorte } from '../../src/lib/tramos.js'

const API = 'http://localhost:3001/api'
const login = async (email) => {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin123' }),
  })
  return r.ok ? (await r.json()).token : null
}
const llamar = async (t, metodo, p, body) => {
  const r = await fetch(API + p, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const lider = await login('duarte@cofca.co')
if (!lider) { console.log('No entra la líder. ¿Datos de prueba cargados?'); process.exit(1) }

console.log('QA · ASIGNAR EN TODOS LOS CASOS ABIERTOS (como la ventana)')
console.log('='.repeat(74))

const casos = await prisma.absence.findMany({
  where: { status: 'confirmada', OR: [{ rescheduleStatus: null }, { rescheduleStatus: { not: 'resuelta' } }] },
  select: { id: true, resource: { select: { name: true } }, startDate: true },
  orderBy: { startDate: 'asc' },
})

let probadas = 0, bien = 0, sinCandidato = 0, sinPacientes = 0
const fallos = []
for (const c of casos) {
  const ctx = (await llamar(lider, 'GET', `/absences/${c.id}/replacement-context`)).body
  if (!ctx?.franjas?.length) continue
  const faltanCaso = (ctx.cuenta?.pacientes_impactados ?? 0) > 0 ? ctx.cuenta.pacientes_pendientes : null

  for (const fr of ctx.franjas.filter((f) => !f.cubierta && f.huecos?.length)) {
    const hueco = fr.huecos[0]
    const tope = faltanCaso != null ? Math.min(hueco.pacientes ?? 0, faltanCaso) : (hueco.pacientes ?? 0)
    if (tope < 1) { sinPacientes++; continue }   // la ventana no deja asignar 0

    const cands = (await llamar(lider, 'GET', '/resources/suggested?' + new URLSearchParams({
      type: ctx.ausencia.resource.type, day: fr.weekday, start_time: hueco.start_time, end_time: hueco.end_time,
      city: fr.site?.city ?? '', week_id: fr.week_id, room_id: fr.room_id,
    }))).body ?? []
    if (!Array.isArray(cands) || cands.length === 0) { sinCandidato++; continue }

    probadas++
    const hasta = tope >= (hueco.pacientes ?? 0)
      ? hueco.end_time
      : horaDeCorte(fr.patient_capacity ?? 0, { desde: fr.start_time, hasta: fr.end_time }, hueco.start_time, tope)
    const r = await llamar(lider, 'POST', '/assignments', {
      week_id: fr.week_id, room_id: fr.room_id, resource_id: cands[0].id, assistant_id: fr.assistant_id,
      weekday: fr.weekday, start_time: hueco.start_time, end_time: hasta, expected_patients: tope,
      is_replacement: true, covered_absence_id: c.id,
      ...(fr.sede_cerrada ? { supervisor_reason: 'QA: prueba de asignación en sede cerrada' } : {}),
    })
    if (r.status === 201) {
      bien++
      await llamar(lider, 'DELETE', `/assignments/${r.body.id}`)
    } else {
      fallos.push(`${c.resource.name} · ${c.startDate.toISOString().slice(0, 10)} · ${fr.weekday} ${hueco.start_time}-${hueco.end_time}` +
        `${fr.sede_cerrada ? ' (sede cerrada)' : ''} · con ${cands[0].name}\n      HTTP ${r.status} · ${r.body?.message ?? JSON.stringify(r.body).slice(0, 160)}`)
    }
  }
}

console.log(`Casos abiertos: ${casos.length} · jornadas probadas: ${probadas} · asignan bien: ${bien}`)
console.log(`Sin candidato libre: ${sinCandidato} · sin pacientes por reprogramar: ${sinPacientes}`)
if (fallos.length) {
  console.log(`\n${fallos.length} FALLO(S):`)
  for (const f of fallos) console.log('  · ' + f)
}
console.log('\n' + '='.repeat(74))
console.log(fallos.length === 0 ? 'TODO BIEN.' : `${fallos.length} FALLO(S).`)
await prisma.$disconnect()
process.exit(fallos.length === 0 ? 0 : 1)
