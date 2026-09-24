/**
 * RECALCULA pacientes_capacidad CON EL INTERVALO DE 10 MINUTOS
 * ===========================================================
 *
 *   node scripts/recalcular-capacidad-pacientes.js            # simulacion
 *   node scripts/recalcular-capacidad-pacientes.js --aplicar  # escribe
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO ES UN UPDATE MASIVO
 * ---------------------------------------------------------------------------
 * `asignaciones.pacientes_capacidad` guarda DOS cosas distintas en la misma
 * columna:
 *
 *   a) el calculo automatico (minutos del turno − almuerzo) / intervalo
 *   b) el numero que el coordinador escribio a mano cuando conoce la agenda
 *      real del call center
 *
 * Un UPDATE masivo borraria (b), que es justamente el dato mas fiable. El
 * coordinador lo pone en pocos casos, pero cuando lo pone es porque sabe.
 *
 * ---------------------------------------------------------------------------
 * COMO LOS DISTINGUE
 * ---------------------------------------------------------------------------
 * Si el valor guardado COINCIDE EXACTO con lo que daba la formula vieja (15
 * min), nadie lo toco: se recalcula con 10. Si NO coincide, alguien lo
 * escribio a mano: se respeta y se reporta aparte.
 *
 * No es infalible —un override que por casualidad diera el mismo numero que la
 * formula se recalcularia— pero en ese caso el valor nuevo sigue siendo el
 * correcto segun la regla de 10 minutos, asi que no se pierde informacion.
 */
import { PrismaClient } from '@prisma/client'
import { calcularCapacidad } from '../src/services/assignmentService.js'

const prisma = new PrismaClient()
const APLICAR = process.argv.includes('--aplicar')
const INTERVALO_VIEJO = 15
const INTERVALO_NUEVO = 10

const linea = (c = '=') => console.log(c.repeat(88))

async function main() {
  linea()
  console.log(APLICAR
    ? 'RECALCULO DE CAPACIDAD · MODO APLICAR (escribe en la base)'
    : 'RECALCULO DE CAPACIDAD · SIMULACION (no escribe nada)')
  linea()
  if (!APLICAR) console.log('Para aplicar: node scripts/recalcular-capacidad-pacientes.js --aplicar\n')

  const asigs = await prisma.assignment.findMany({
    where: { status: { not: 'cancelada' } },
    select: {
      id: true, startTime: true, endTime: true, patientCapacity: true,
      resource: { select: { name: true, type: true, slotMinutes: true } },
      week: { select: { startDate: true } },
    },
  })
  console.log(`Asignaciones activas: ${asigs.length}\n`)

  const aCambiar = []
  let manuales = 0
  let sinCambio = 0

  for (const a of asigs) {
    const tipo = a.resource?.type ?? null
    const viejo = calcularCapacidad(a.startTime, a.endTime, INTERVALO_VIEJO, tipo)
    const nuevo = calcularCapacidad(a.startTime, a.endTime, a.resource?.slotMinutes ?? INTERVALO_NUEVO, tipo)
    const guardado = a.patientCapacity ?? 0

    if (guardado !== viejo) { manuales++; continue }   // override manual → intacto
    if (guardado === nuevo) { sinCambio++; continue }
    aCambiar.push({ a, guardado, nuevo })
  }

  console.log('turno'.padEnd(18) + 'tipo'.padEnd(16) + 'antes'.padStart(7) + 'despues'.padStart(9) + '   veces')
  console.log('-'.repeat(88))
  // Agrupado por turno+tipo: son cientos de filas con el mismo patron.
  const resumen = new Map()
  for (const c of aCambiar) {
    const k = `${c.a.startTime}-${c.a.endTime}|${c.a.resource?.type}|${c.guardado}|${c.nuevo}`
    resumen.set(k, (resumen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...resumen.entries()].sort((x, y) => y[1] - x[1]).slice(0, 18)) {
    const [turno, tipo, antes, despues] = k.split('|')
    console.log(turno.padEnd(18) + String(tipo).slice(0, 15).padEnd(16) +
                antes.padStart(7) + despues.padStart(9) + String(n).padStart(8))
  }
  if (resumen.size > 18) console.log(`  … y ${resumen.size - 18} combinaciones mas`)
  console.log('-'.repeat(88))

  const totalAntes = aCambiar.reduce((s, c) => s + c.guardado, 0)
  const totalDespues = aCambiar.reduce((s, c) => s + c.nuevo, 0)

  console.log('')
  linea()
  console.log('RESUMEN')
  linea()
  console.log(`  Se recalculan (venian del calculo automatico) : ${aCambiar.length}`)
  console.log(`  Se respetan  (override manual del coordinador): ${manuales}`)
  console.log(`  Ya estaban bien                               : ${sinCambio}`)
  console.log('')
  console.log(`  Pacientes en las filas que cambian: ${totalAntes.toLocaleString('es-CO')}  →  ${totalDespues.toLocaleString('es-CO')}`)
  console.log('')

  if (!APLICAR) {
    console.log('  Nada se escribio. Revisa y vuelve a correrlo con --aplicar.')
    console.log('')
    return
  }

  let n = 0
  for (const c of aCambiar) {
    await prisma.assignment.update({ where: { id: c.a.id }, data: { patientCapacity: c.nuevo } })
    n++
  }
  console.log(`  ✔ ${n} asignaciones actualizadas. Los ${manuales} valores manuales quedaron intactos.`)
  console.log('')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
