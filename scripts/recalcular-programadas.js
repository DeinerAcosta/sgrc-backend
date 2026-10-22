/**
 * RECALCULAR LA ANTICIPACIÓN Y "PROGRAMADA / IMPREVISTA" (PROYECTOS-3654)
 *
 *   npm run recalcular:programadas              solo muestra qué cambiaría
 *   npm run recalcular:programadas -- --aplicar  escribe
 *
 * Desde el 20-oct-2026 una ausencia es programada con 20 días o más de
 * anticipación, contados en DÍAS DE CALENDARIO desde el registro, en hora de
 * Colombia (lib/anticipacion.js).
 *
 * 22-oct · Ahora también recalcula `anticipacion_dias` desde `reportado_en`.
 * Antes de la corrección se restaba la hora del registro: quien avisaba "para
 * mañana" a las 3 p. m. quedaba con 0 días. En producción había 5 ausencias de
 * médicos avisadas con antelación y guardadas con 0, y el tablero de
 * Reprogramaciones las contaba como avisadas el mismo día. Después recalcula
 * `es_programada` con el número corregido.
 *
 * Deja una entrada de auditoría ANTES de escribir y aborta si no quedó.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { esProgramada, diasDeAnticipacion, DIAS_PROGRAMADA } from '../src/lib/anticipacion.js'

const aplicar = process.argv.includes('--aplicar')
const iso = (d) => d.toISOString().slice(0, 10)

try {
  const ausencias = await prisma.absence.findMany({
    select: { id: true, startDate: true, reportedAt: true, noticeDays: true, isPlanned: true },
  })
  const cambios = ausencias.map((a) => {
    const dias = Math.max(0, diasDeAnticipacion(iso(a.startDate), a.reportedAt))
    return { ...a, dias, programada: esProgramada(dias) }
  }).filter((a) => a.dias !== a.noticeDays || a.programada !== a.isPlanned)

  const conDias = cambios.filter((a) => a.dias !== a.noticeDays)
  const aImprevista = cambios.filter((a) => a.isPlanned && !a.programada)
  const aProgramada = cambios.filter((a) => !a.isPlanned && a.programada)

  console.log(`Regla: programada con ${DIAS_PROGRAMADA} días o más de anticipación (días de calendario, hora de Colombia).`)
  console.log(`${ausencias.length} ausencias revisadas:`)
  console.log(`  días de anticipación corregidos: ${conDias.length}`)
  for (const a of conDias.slice(0, 40)) console.log(`    · ausencia del ${iso(a.startDate)} · registrada ${iso(a.reportedAt)} · ${a.noticeDays} → ${a.dias} días`)
  console.log(`  programada → imprevista: ${aImprevista.length}`)
  console.log(`  imprevista → programada: ${aProgramada.length}`)

  if (!aplicar) {
    console.log('\nNo se escribió nada. Para aplicar: npm run recalcular:programadas -- --aplicar')
  } else if (cambios.length) {
    const auditoria = await registrarAuditoria({
      userId: null,
      action: 'recalcular_programadas',
      entity: 'ausencias',
      entityId: 'lote',
      newValue: {
        regla: `>= ${DIAS_PROGRAMADA} dias calendario desde reportado_en`,
        cambios: cambios.map((a) => ({ id: a.id, dias: [a.noticeDays, a.dias], programada: [a.isPlanned, a.programada] })),
      },
      reason: 'PROYECTOS-3654 · regla de 20 días y anticipación en días de calendario',
    })
    if (!auditoria) throw new Error('No quedó la auditoría: no se escribe nada.')
    await prisma.$transaction(cambios.map((a) => prisma.absence.update({
      where: { id: a.id },
      data: { noticeDays: a.dias, isPlanned: a.programada },
    })))
    console.log(`\nAPLICADO · ${cambios.length} ausencias recalculadas.`)
  }
} finally {
  await prisma.$disconnect()
}
