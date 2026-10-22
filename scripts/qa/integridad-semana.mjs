// QA · ¿Hay alguien en dos sitios a la vez esta semana?
//
// Oct-2026 · Existe porque un dato imposible se hizo pasar por un fallo de la
// aplicacion. El generador de datos dejo a Lina Torres el lunes de 07:00 a
// 13:00 en Santa Marta Y en Barranquilla; el sistema rechazo —con razon— todo
// reemplazo que la tocara, y en pantalla parecia que el boton Asignar estaba
// roto. Hector perdio la tarde en eso.
//
// Recorre la semana en curso y busca, para cada persona (como profesional o
// como auxiliar):
//   · dos turnos que se pisan el mismo dia        (RN-08)
//   · turnos en dos ciudades distintas el mismo dia (RN-09)
// y, por ausencia:
//   · mas pacientes reprogramados que afectados. Oct-2026: el generador ponia
//     al que cubre su capacidad entera (33 de una agenda de 16), y el servidor
//     ya no lo deja. Contra el numero REAL si la lider lo puso.
//   · reemplazos de una ausencia sin confirmar: el servidor exige confirmar
//     antes de cubrir (oct-2026).
//   · impacto calculado sobre días que no son los de la ausencia. Oct-2026: en
//     Colombia el martes salía lunes (npm run reparar:dias lo arregla).
//
// Se perdona UN solo par: un reemplazo y el turno caído que ese reemplazo
// cubre. Es el caso de la misma auxiliar —asistía al ausente y ahora asiste a
// quien lo cubre—, que es legítimo. Es la misma regla que aplica el sistema
// (turnosQueLiberaElReemplazo en assignmentService).
//
// Ojo: NO se descartan "todos los turnos de quien falta". La primera versión
// lo hacía y no vio el doble turno de Lina: ese lunes faltaban los dos médicos
// a los que asistía, así que sus dos turnos desaparecían de la revisión. Pero
// el sistema no razona así —solo libera lo que el reemplazo cubre—, y una
// revisión más permisiva que el sistema da verde donde la pantalla falla.
//
// Solo lee. Sirve igual para datos de prueba que para datos reales.
import { prisma } from '../../src/lib/prisma.js'
import { inicioDeSemana } from '../lib/datos-comunes.js'
import { pacientesDelCaso } from '../../src/lib/pacientesDelCaso.js'
import { diasDeAusencia } from '../../src/services/absenceService.js'

const solapan = (a1, a2, b1, b2) => !(a2 <= b1 || a1 >= b2)

const semana = await prisma.week.findFirst({ where: { startDate: inicioDeSemana() } })
console.log('QA · INTEGRIDAD DE LA SEMANA')
console.log('='.repeat(74))
if (!semana) {
  console.log('No hay semana en curso (lunes a domingo). Nada que revisar.')
  await prisma.$disconnect()
  process.exit(0)
}
console.log(`Semana ${semana.startDate.toISOString().slice(0, 10)} → ${semana.endDate.toISOString().slice(0, 10)}\n`)

const turnos = await prisma.assignment.findMany({
  where: { weekId: semana.id, status: { not: 'cancelada' }, room: { active: true } },
  select: {
    id: true, weekday: true, startTime: true, endTime: true,
    resourceId: true, assistantId: true, assistant2Id: true, coveredAbsenceId: true,
    resource: { select: { name: true, multiRoom: true } },
    room: { select: { name: true, site: { select: { name: true, city: true } } } },
  },
})

// Las ausencias que algún reemplazo cubre: son las únicas que liberan turnos.
const idsCubiertas = [...new Set(turnos.map((t) => t.coveredAbsenceId).filter(Boolean))]
const cubiertas = new Map(
  (await prisma.absence.findMany({
    where: { id: { in: idsCubiertas } },
    select: {
      id: true, resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true,
      patientsAffected: true, patientsConfirmed: true, status: true, resource: { select: { name: true } },
    },
  })).map((a) => [a.id, a])
)
/** ¿`reemp` es el reemplazo que cubre justo el turno caído `caido`? */
const cubreA = (reemp, caido) => {
  const aus = reemp.coveredAbsenceId && cubiertas.get(reemp.coveredAbsenceId)
  if (!aus || aus.resourceId !== caido.resourceId || reemp.weekday !== caido.weekday) return false
  if (!aus.isPartial || !aus.absenceStartTime || !aus.absenceEndTime) return true
  return solapan(aus.absenceStartTime, aus.absenceEndTime, caido.startTime, caido.endTime)
}

const nombres = new Map(
  (await prisma.resource.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name])
)

// Oct-2026 · RN-24 / 3583: el turno de un oftalmólogo, anestesiólogo u otorrino
// ausente no se atiende, así que su auxiliar está libre en esa franja. Como
// auxiliar, ese turno caído no cuenta para "dos sitios" ni "dos ciudades".
const LIBERAN = ['oftalmologo', 'anestesiologo', 'otorrino']
const fechaDe = (weekday) => {
  const d = new Date(semana.startDate)
  for (let i = 0; i < 7; i++) {
    if (['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'][d.getUTCDay()] === weekday) return d.toISOString().slice(0, 10)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return null
}
const ausentesRN24 = await prisma.absence.findMany({
  where: { status: 'confirmada', startDate: { lte: semana.endDate }, endDate: { gte: semana.startDate }, resource: { is: { type: { in: LIBERAN } } } },
  select: { resourceId: true, startDate: true, endDate: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
})
const caidoRN24 = new Set(turnos.filter((t) => {
  const f = fechaDe(t.weekday)
  return ausentesRN24.some((a) => a.resourceId === t.resourceId &&
    a.startDate.toISOString().slice(0, 10) <= f && f <= a.endDate.toISOString().slice(0, 10) &&
    (!a.isPartial || !a.absenceStartTime || !a.absenceEndTime || solapan(a.absenceStartTime, a.absenceEndTime, t.startTime, t.endTime)))
}).map((t) => t.id))
const libreComoAux = (t) => t.rol === 'auxiliar' && caidoRN24.has(t.id)

// Cada persona, con todos sus turnos del día (como profesional o como auxiliar).
const porPersonaDia = new Map()
const agregar = (persona, t, rol) => {
  if (!persona) return
  const k = persona + '|' + t.weekday
  if (!porPersonaDia.has(k)) porPersonaDia.set(k, [])
  porPersonaDia.get(k).push({ ...t, rol })
}
for (const t of turnos) {
  agregar(t.resourceId, t, 'profesional')
  agregar(t.assistantId, t, 'auxiliar')
  agregar(t.assistant2Id, t, 'auxiliar')
}

const problemas = []
for (const [k, lista] of porPersonaDia) {
  const [persona, dia] = k.split('|')
  const nombre = nombres.get(persona) ?? persona
  const donde = (t) => `${t.startTime}-${t.endTime} ${t.room.site.name}/${t.room.name}`

  const ciudades = [...new Set(lista.filter((t) => !libreComoAux(t)).map((t) => t.room.site.city))]
  if (ciudades.length > 1) {
    problemas.push(`${nombre} · ${dia} · en ${ciudades.join(' y ')}: ${lista.map(donde).join(' | ')}`)
  }
  for (let i = 0; i < lista.length; i++) {
    for (let j = i + 1; j < lista.length; j++) {
      const a = lista[i]; const b = lista[j]
      if (!solapan(a.startTime, a.endTime, b.startTime, b.endTime)) continue
      // Un profesional multi-consultorio cubre varias salas a la vez, y su
      // auxiliar rota con él: eso es su trabajo, no un choque.
      const mismoMulti = a.resourceId === b.resourceId && a.resource.multiRoom
      if (mismoMulti) continue
      // El reemplazo y el turno caído que cubre: la franja quedó libre.
      if (cubreA(a, b) || cubreA(b, a)) continue
      // La auxiliar de un médico ausente (RN-24) está libre en su turno caído.
      if (libreComoAux(a) || libreComoAux(b)) continue
      problemas.push(`${nombre} · ${dia} · dos turnos a la vez: ${donde(a)} | ${donde(b)}`)
    }
  }
}

// Más reprogramados que afectados. Se suman TODOS los reemplazos de la
// ausencia, también los de otra semana: el tope del servidor tampoco mira la
// semana.
const reprogramados = idsCubiertas.length
  ? await prisma.assignment.groupBy({
      by: ['coveredAbsenceId'],
      where: { coveredAbsenceId: { in: idsCubiertas }, status: { not: 'cancelada' } },
      _sum: { patientCapacity: true },
    })
  : []
for (const r of reprogramados) {
  const aus = cubiertas.get(r.coveredAbsenceId)
  const total = pacientesDelCaso(aus)
  const puestos = r._sum.patientCapacity ?? 0
  if (aus && aus.status !== 'confirmada') {
    problemas.push(`${aus.resource.name} · tiene reemplazo y la ausencia está ${aus.status}`)
  }
  if (total > 0 && puestos > total) {
    problemas.push(`${aus.resource.name} · ${puestos} pacientes reprogramados de una agenda de ${total}`)
  }
}

// Impacto sobre días corridos: algún día guardado cae fuera de la ausencia.
const ausSemana = await prisma.absence.findMany({
  where: { status: 'confirmada', startDate: { lte: semana.endDate }, endDate: { gte: semana.startDate } },
  select: { startDate: true, endDate: true, dailyImpact: true, resource: { select: { name: true } } },
})
for (const a of ausSemana) {
  const bien = new Set(diasDeAusencia(a).map((d) => d.date))
  const fuera = (Array.isArray(a.dailyImpact) ? a.dailyImpact : []).filter((d) => !bien.has(d.date))
  if (fuera.length) {
    problemas.push(`${a.resource.name} · impacto calculado el ${fuera.map((d) => d.date).join(', ')}, fuera de su ausencia`)
  }
}

console.log(`Turnos revisados: ${turnos.length}  ·  personas-día: ${porPersonaDia.size}`)
console.log('')
if (problemas.length === 0) {
  console.log('Nadie está en dos sitios ni en dos ciudades a la vez, y ningún caso tiene más reprogramados que afectados.')
} else {
  console.log(`${problemas.length} IMPOSIBLE(S):`)
  for (const p of problemas) console.log('  · ' + p)
}
await prisma.$disconnect()
process.exit(problemas.length === 0 ? 0 : 1)
