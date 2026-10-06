/**
 * RESOLVER LAS AUSENCIAS PENDIENTES ANTIGUAS
 * ==========================================
 *
 * En produccion habia 6 ausencias en estado `pendiente` cuya fecha ya paso hace
 * meses — la mas vieja, 105 dias. Nadie las confirmo ni las rechazo, asi que el
 * sistema las sigue mostrando como "por revisar" y no entran en ningun informe:
 * una ausencia pendiente no cuenta como ocurrida ni como descartada.
 *
 * Pasa porque hoy nada obliga a cerrar el caso. Es justo lo que la §6.1 de
 * PROYECTOS-3398 quiere resolver con el boton GESTIONAR.
 *
 * DOS MODOS, y la diferencia importa:
 *
 *   --rechazar  (por defecto)  Las marca `rechazada` con un motivo. Siguen en la
 *                              base, quedan fuera de los informes —el backend ya
 *                              excluye las rechazadas— y se puede ver que paso.
 *                              Es reversible.
 *
 *   --eliminar                 Las borra. No hay vuelta atras: si esa ausencia
 *                              ocurrio de verdad, se pierde el registro.
 *
 * Antes de borrar comprueba que nada cuelgue de la ausencia. Son tres
 * referencias, revisadas una por una en el schema:
 *   · AbsenceMakeup.absenceId          (reposiciones — borrado en cascada)
 *   · Assignment.coveredAbsenceId      (asignaciones de reemplazo)
 *   · BackofficeAssignment.sourceAbsenceId
 * Si algo apunta a ella, se salta y lo dice: borrarla dejaria huerfanos esos
 * registros o se los llevaria por delante.
 *
 * USO
 *   node scripts/limpiar-ausencias-pendientes.js                      # seco
 *   node scripts/limpiar-ausencias-pendientes.js --aplicar            # rechaza
 *   node scripts/limpiar-ausencias-pendientes.js --eliminar --aplicar # borra
 *   node scripts/limpiar-ausencias-pendientes.js --dias 60 --aplicar  # otro umbral
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { fechaSolo } from '../src/lib/fechas.js'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null }
const APLICAR = args.includes('--aplicar')
const ELIMINAR = args.includes('--eliminar')
const DIAS = Number(flag('dias') ?? 30)
const MOTIVO = flag('motivo')
  || 'Cerrada en limpieza: la fecha pasó hace meses sin que nadie la revisara'

if (!Number.isInteger(DIAS) || DIAS < 1) {
  console.error(`--dias debe ser un entero positivo (recibido: ${flag('dias')})`)
  process.exit(1)
}

async function dependencias(id) {
  const [reposiciones, reemplazos, backoffice] = await Promise.all([
    prisma.absenceMakeup.count({ where: { absenceId: id } }),
    prisma.assignment.count({ where: { coveredAbsenceId: id } }),
    prisma.backofficeAssignment.count({ where: { sourceAbsenceId: id } }),
  ])
  return { reposiciones, reemplazos, backoffice, total: reposiciones + reemplazos + backoffice }
}

async function main() {
  const modo = ELIMINAR ? 'ELIMINAR (irreversible)' : 'RECHAZAR (reversible)'
  console.log('='.repeat(78))
  console.log(`AUSENCIAS PENDIENTES CON MÁS DE ${DIAS} DÍAS  ·  ${modo}`)
  console.log(APLICAR ? 'MODO: APLICAR' : 'MODO: CORRIDA EN SECO (no escribe nada)')
  console.log('='.repeat(78))

  const corte = new Date(Date.now() - DIAS * 86400000)
  const pendientes = await prisma.absence.findMany({
    where: { status: 'pendiente', startDate: { lt: corte } },
    select: {
      id: true, startDate: true, endDate: true, type: true, reason: true,
      resource: { select: { name: true, type: true } },
    },
    orderBy: { startDate: 'asc' },
  })

  if (pendientes.length === 0) {
    console.log(`\nNo hay pendientes anteriores a ${fechaSolo(corte)}. Nada por hacer.`)
    return
  }

  const dias = (d) => Math.round((Date.now() - new Date(d).getTime()) / 86400000)
  const limpias = []
  const conDependencias = []

  console.log(`\nEncontradas: ${pendientes.length}\n`)
  for (const a of pendientes) {
    const dep = await dependencias(a.id)
    const linea = `  ${a.resource.name.padEnd(34)} ${String(a.type).padEnd(22)} ${fechaSolo(a.startDate)}  (${dias(a.startDate)}d)`
    if (dep.total === 0) {
      limpias.push(a)
      console.log(linea)
    } else {
      conDependencias.push({ a, dep })
      console.log(`${linea}   ← TIENE ${dep.reposiciones} reposición(es), ${dep.reemplazos} reemplazo(s), ${dep.backoffice} backoffice`)
    }
    if (a.reason) console.log(`${' '.repeat(4)}observación: "${a.reason}"`)
  }

  if (conDependencias.length) {
    console.log(`\n${conDependencias.length} tienen registros asociados.`)
    console.log(ELIMINAR
      ? '   NO se van a borrar: dejarían huérfanos esos registros. Revísalas a mano.'
      : '   Sí se pueden rechazar: rechazar no borra nada.')
  }

  const objetivo = ELIMINAR ? limpias : pendientes
  console.log(`\nSe van a ${ELIMINAR ? 'ELIMINAR' : 'RECHAZAR'}: ${objetivo.length}`)
  if (!ELIMINAR) console.log(`Motivo: "${MOTIVO}"`)

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(78))
    console.log('CORRIDA EN SECO — no se escribió nada.')
    console.log(`Para aplicar:  --aplicar${ELIMINAR ? ' --eliminar' : ''}`)
    if (ELIMINAR) console.log('Alternativa reversible: quitar --eliminar y quedan rechazadas, fuera de los informes.')
    console.log('-'.repeat(78))
    return
  }

  const ids = objetivo.map((a) => a.id)
  if (ids.length === 0) {
    console.log('\nNada que aplicar.')
    return
  }

  if (ELIMINAR) {
    await prisma.$transaction(async (tx) => {
      await tx.absence.deleteMany({ where: { id: { in: ids } } })
    })
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.absence.updateMany({
        where: { id: { in: ids } },
        data: { status: 'rechazada', rejectionReason: MOTIVO },
      })
    })
  }

  await registrarAuditoria({
    userId: null,
    action: ELIMINAR ? 'eliminar_ausencias_antiguas' : 'rechazar_ausencias_antiguas',
    entity: 'ausencias',
    entityId: ids[0],
    oldValue: objetivo.map((a) => ({
      id: a.id, recurso: a.resource.name, tipo: a.type,
      inicio: a.startDate, observacion: a.reason,
    })),
    reason: MOTIVO,
  })

  const quedan = await prisma.absence.count({ where: { status: 'pendiente', startDate: { lt: corte } } })
  console.log('\n' + '-'.repeat(78))
  console.log(`APLICADO — ${ids.length} ausencia(s) ${ELIMINAR ? 'eliminadas' : 'rechazadas'}.`)
  console.log(`Verificación: pendientes con más de ${DIAS} días que quedan = ${quedan}`)
  if (quedan !== 0) console.log('   (son las que tienen registros asociados, revísalas a mano)')
  console.log('Queda en auditoría con el detalle de cada una.')
  console.log('-'.repeat(78))
}

main()
  .catch((e) => {
    console.error('\nFALLO — la escritura va en transacción, no quedó a medias:')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
