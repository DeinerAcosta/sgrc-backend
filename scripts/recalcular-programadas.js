/**
 * RECALCULAR "PROGRAMADA / IMPREVISTA" CON LA REGLA DE 20 DÍAS (PROYECTOS-3654)
 *
 *   npm run recalcular:programadas              solo muestra qué cambiaría
 *   npm run recalcular:programadas -- --aplicar  escribe
 *
 * Desde el 20-oct-2026 una ausencia es programada con 20 días o más de
 * anticipación (lib/anticipacion.js). Las ya guardadas conservan la regla
 * vieja (más de 15 días), así que los informes del pasado mezclan las dos. Esto
 * recalcula `es_programada` desde `anticipacion_dias`, que está guardado. No
 * toca nada más. Deja una entrada de auditoría ANTES de escribir y aborta si no
 * quedó, como el resto de guiones que cambian datos.
 *
 * Ojo: `anticipacion_dias` de lo anterior al 20-oct se contó restando la hora
 * del registro (un día menos en la mayoría de los casos); no se corrige aquí,
 * porque la hora exacta del registro original es la que se guardó.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { esProgramada, DIAS_PROGRAMADA } from '../src/lib/anticipacion.js'

const aplicar = process.argv.includes('--aplicar')

try {
  const ausencias = await prisma.absence.findMany({ select: { id: true, noticeDays: true, isPlanned: true } })
  const cambian = ausencias.filter((a) => esProgramada(a.noticeDays) !== a.isPlanned)
  const aImprevista = cambian.filter((a) => a.isPlanned)
  const aProgramada = cambian.filter((a) => !a.isPlanned)

  console.log(`Regla: programada con ${DIAS_PROGRAMADA} días o más de anticipación.`)
  console.log(`${ausencias.length} ausencias revisadas · ${cambian.length} cambian de clasificación:`)
  console.log(`  programada → imprevista: ${aImprevista.length} (avisadas con 16 a 19 días)`)
  console.log(`  imprevista → programada: ${aProgramada.length}`)

  if (!aplicar) {
    console.log('\nNo se escribió nada. Para aplicar: npm run recalcular:programadas -- --aplicar')
  } else if (cambian.length) {
    const auditoria = await registrarAuditoria({
      userId: null,
      action: 'recalcular_programadas',
      entity: 'ausencias',
      entityId: 'lote',
      newValue: { regla: `>= ${DIAS_PROGRAMADA} dias`, a_imprevista: aImprevista.map((a) => a.id), a_programada: aProgramada.map((a) => a.id) },
      reason: 'PROYECTOS-3654 · regla de 20 días',
    })
    if (!auditoria) throw new Error('No quedó la auditoría: no se escribe nada.')
    await prisma.$transaction([
      prisma.absence.updateMany({ where: { id: { in: aImprevista.map((a) => a.id) } }, data: { isPlanned: false } }),
      prisma.absence.updateMany({ where: { id: { in: aProgramada.map((a) => a.id) } }, data: { isPlanned: true } }),
    ])
    console.log(`\nAPLICADO · ${cambian.length} ausencias recalculadas.`)
  }
} finally {
  await prisma.$disconnect()
}
