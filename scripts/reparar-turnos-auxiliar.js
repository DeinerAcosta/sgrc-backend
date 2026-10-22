/**
 * REPARAR LOS TURNOS DE MÉDICO MARCADOS "NO EJECUTADO" POR LA AUSENCIA DE SU AUXILIAR
 *
 *   npm run reparar:turnos-auxiliar              solo muestra lo que encontró
 *   npm run reparar:turnos-auxiliar -- --aplicar  borra las ejecuciones falsas
 *
 * Desde el 8-sep-2026 (584c141) hasta el 20-oct-2026, confirmar la ausencia de
 * una auxiliar creaba en el turno del MÉDICO al que acompañaba una ejecución
 * "no_ejecutada" con 0 pacientes, aunque el médico atendiera. Eso bajaba su
 * productividad y bloqueaba el turno (RN-17).
 *
 * Qué hace:
 *   - Busca ejecuciones "Generado automáticamente — ausencia confirmada" en
 *     turnos cuyo médico NO estaba ausente ese día pero cuya auxiliar sí.
 *   - Con --aplicar las borra: el turno vuelve a "sin registrar", que es lo
 *     cierto, y el coordinador registra lo que pasó. Deja la auditoría antes de
 *     escribir y aborta si no quedó.
 *   - Las "Sobreescrito automáticamente…" NO se tocan: ahí había un registro
 *     real antes y se perdió. Solo se listan, para revisarlas a mano.
 *   - Las bloqueadas (locked) tampoco se tocan.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { fechaDeTurno, isoDia } from '../src/lib/bloqueosSede.js'

const aplicar = process.argv.includes('--aplicar')

const ausenteEse = (ausencias, recursoId, fecha) => ausencias.some((a) =>
  a.resourceId === recursoId && isoDia(a.startDate) <= fecha && fecha <= isoDia(a.endDate))

try {
  const ejecuciones = await prisma.execution.findMany({
    where: {
      shiftStatus: 'no_ejecutada',
      patientsSeen: 0,
      OR: [
        { notes: { startsWith: 'Generado automáticamente — ausencia confirmada' } },
        { notes: { startsWith: 'Sobreescrito automáticamente — ausencia confirmada' } },
      ],
      assignment: { is: { OR: [{ assistantId: { not: null } }, { assistant2Id: { not: null } }] } },
    },
    select: {
      id: true, notes: true, locked: true,
      assignment: {
        select: {
          id: true, weekday: true, startTime: true, endTime: true, resourceId: true, assistantId: true, assistant2Id: true,
          week: { select: { startDate: true } },
          resource: { select: { name: true } }, room: { select: { name: true, site: { select: { name: true } } } },
        },
      },
    },
  })
  const recursos = [...new Set(ejecuciones.flatMap((e) => [e.assignment.resourceId, e.assignment.assistantId, e.assignment.assistant2Id]).filter(Boolean))]
  const ausencias = await prisma.absence.findMany({
    where: { status: 'confirmada', resourceId: { in: recursos } },
    select: { resourceId: true, startDate: true, endDate: true },
  })

  const falsas = ejecuciones.filter((e) => {
    const a = e.assignment
    const fecha = fechaDeTurno(a.week.startDate, a.weekday)
    if (!fecha || ausenteEse(ausencias, a.resourceId, fecha)) return false   // el médico sí faltó: está bien
    return [a.assistantId, a.assistant2Id].some((aux) => aux && ausenteEse(ausencias, aux, fecha))
  })
  const generadas = falsas.filter((e) => e.notes.startsWith('Generado') && !e.locked)
  const sobreescritas = falsas.filter((e) => e.notes.startsWith('Sobreescrito'))
  const bloqueadas = falsas.filter((e) => e.notes.startsWith('Generado') && e.locked)
  const linea = (e) => {
    const a = e.assignment
    return `  ${isoDia(fechaDeTurno(a.week.startDate, a.weekday))} ${a.startTime}–${a.endTime} · ${a.resource?.name} · ${a.room?.name} (${a.room?.site?.name})`
  }

  console.log(`Turnos de médico marcados "no ejecutado" por la ausencia de su auxiliar: ${falsas.length}`)
  console.log(`  se pueden reparar (generados automáticamente): ${generadas.length}`)
  generadas.slice(0, 30).forEach((e) => console.log(linea(e)))
  if (generadas.length > 30) console.log(`  … y ${generadas.length - 30} más`)
  if (sobreescritas.length) {
    console.log(`  NO se tocan, revisar a mano (pisaron un registro real): ${sobreescritas.length}`)
    sobreescritas.forEach((e) => console.log(linea(e)))
  }
  if (bloqueadas.length) console.log(`  NO se tocan, están bloqueadas: ${bloqueadas.length}`)

  if (!aplicar) {
    console.log('\nNo se escribió nada. Para aplicar: npm run reparar:turnos-auxiliar -- --aplicar')
  } else if (generadas.length) {
    const auditoria = await registrarAuditoria({
      userId: null,
      action: 'reparar_turnos_auxiliar',
      entity: 'ejecuciones',
      entityId: 'lote',
      oldValue: { ejecuciones: generadas.map((e) => ({ id: e.id, asignacion: e.assignment.id })) },
      reason: 'Confirmar la ausencia de una auxiliar marcaba el turno del médico como no ejecutado',
    })
    if (!auditoria) throw new Error('No quedó la auditoría: no se escribe nada.')
    const r = await prisma.execution.deleteMany({ where: { id: { in: generadas.map((e) => e.id) } } })
    console.log(`\nAPLICADO · ${r.count} ejecuciones falsas borradas.`)
  }
} finally {
  await prisma.$disconnect()
}
