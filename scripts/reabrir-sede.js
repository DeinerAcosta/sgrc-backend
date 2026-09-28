/**
 * REABRIR UNA SEDE CERRADA POR ERROR
 * ==================================
 *
 * Borra el cierre semanal de UNA sede para que su coordinador pueda volver a
 * programar. No toca asignaciones, ejecuciones ni ausencias: solo el registro
 * de `cierre_semana_sede` y, si hacia falta, el estado consolidado de la semana.
 *
 * POR QUE EXISTE (28-sep-2026). El correo de cierre automatico le promete al
 * coordinador que "el supervisor tiene la facultad de reabrir la semana", pero
 * esa facultad no estaba implementada en ninguna parte: ni endpoint, ni pantalla,
 * ni script. Un cierre equivocado no tenia vuelta atras.
 *
 * El caso que lo motivo: una coordinadora con 5 sedes tenia "Sede Galapa"
 * seleccionada en el Programador y el sistema le cerro "Sede Malambo" — su
 * sites[0]. Su navegador tenia el bundle viejo, el cierre salio sin sede y el
 * backend adivinaba la primera. El fallback ya se quito; esto repara lo escrito.
 *
 * USO
 *   node scripts/reabrir-sede.js --sede "Malambo" --semana 2026-09-21
 *   node scripts/reabrir-sede.js --sede "Malambo" --semana 2026-09-21 --aplicar
 *
 * Sin --aplicar hace corrida en seco. `--sede` admite parte del nombre, y si
 * coincide con varias las lista y no toca nada. `--semana` es la fecha de inicio
 * (lunes) en formato YYYY-MM-DD.
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : null
}
const APLICAR = args.includes('--aplicar')
const SEDE = flag('sede')
const SEMANA = flag('semana')
const MOTIVO = flag('motivo') || 'Cierre registrado por error — reapertura solicitada'

if (!SEDE || !SEMANA) {
  console.error('Faltan argumentos.\n  node scripts/reabrir-sede.js --sede "Malambo" --semana 2026-09-21 [--aplicar]')
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(SEMANA)) {
  console.error(`--semana debe ser YYYY-MM-DD (recibido: ${SEMANA})`)
  process.exit(1)
}

async function main() {
  console.log('='.repeat(72))
  console.log('REABRIR SEDE' + (APLICAR ? '  ·  MODO APLICAR' : '  ·  CORRIDA EN SECO'))
  console.log('='.repeat(72))

  const desde = new Date(`${SEMANA}T00:00:00.000Z`)
  const hasta = new Date(desde.getTime() + 24 * 60 * 60 * 1000)
  const semana = await prisma.week.findFirst({
    where: { startDate: { gte: desde, lt: hasta } },
    select: { id: true, startDate: true, endDate: true, status: true },
  })
  if (!semana) {
    console.error(`No hay ninguna semana que empiece el ${SEMANA}.`)
    process.exitCode = 1
    return
  }

  const sedes = await prisma.site.findMany({
    where: { name: { contains: SEDE } },
    select: { id: true, name: true },
  })
  if (sedes.length === 0) {
    console.error(`Ninguna sede contiene "${SEDE}".`)
    process.exitCode = 1
    return
  }
  if (sedes.length > 1) {
    console.error(`"${SEDE}" coincide con ${sedes.length} sedes. Concreta el nombre:`)
    sedes.forEach((s) => console.error(`   · ${s.name}`))
    process.exitCode = 1
    return
  }
  const sede = sedes[0]

  const cierre = await prisma.weekSiteClosure.findUnique({
    where: { weekId_siteId: { weekId: semana.id, siteId: sede.id } },
  })
  if (!cierre) {
    console.log(`\n"${sede.name}" NO esta cerrada en la semana del ${SEMANA}. Nada por hacer.`)
    return
  }

  const quien = await prisma.user.findUnique({
    where: { id: cierre.closedBy },
    select: { name: true },
  })

  console.log(`\nSemana : ${SEMANA} — ${semana.endDate.toISOString().slice(0, 10)}  (estado: ${semana.status})`)
  console.log(`Sede   : ${sede.name}`)
  console.log(`Cerrada: ${cierre.closedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC por ${quien?.name ?? cierre.closedBy}`)
  console.log(`Motivo de la reapertura: ${MOTIVO}`)

  // Si la semana quedo consolidada por este cierre, vuelve a 'abierta': ya no
  // estan todas las sedes cerradas.
  const vuelveAAbrir = semana.status === 'cerrada'
  if (vuelveAAbrir) {
    console.log('\nLa semana estaba CONSOLIDADA — al reabrir esta sede vuelve a "abierta".')
  }

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(72))
    console.log('CORRIDA EN SECO — no se borro nada.')
    console.log('Para aplicar, repite el comando agregando  --aplicar')
    console.log('-'.repeat(72))
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.weekSiteClosure.delete({
      where: { weekId_siteId: { weekId: semana.id, siteId: sede.id } },
    })
    if (vuelveAAbrir) {
      await tx.week.update({ where: { id: semana.id }, data: { status: 'abierta' } })
    }
  })

  // La reapertura queda auditada igual que el cierre: es una accion que cambia
  // lo que un coordinador puede hacer con datos ya dados por definitivos.
  await registrarAuditoria({
    userId: cierre.closedBy,
    action: 'reabrir_semana_sede',
    entity: 'cierre_semana_sede',
    entityId: cierre.id,
    oldValue: { weekId: semana.id, siteId: sede.id, closedAt: cierre.closedAt, closedBy: cierre.closedBy },
    newValue: null,
    reason: MOTIVO,
  })

  const sigueCerrada = await prisma.weekSiteClosure.findUnique({
    where: { weekId_siteId: { weekId: semana.id, siteId: sede.id } },
  })

  console.log('\n' + '-'.repeat(72))
  console.log(`APLICADO — "${sede.name}" reabierta en la semana del ${SEMANA}.`)
  console.log(`Verificacion: cierre restante = ${sigueCerrada ? 'TODAVIA EXISTE (revisar)' : 'ninguno'}`)
  if (sigueCerrada) process.exitCode = 1
  console.log('Queda en auditoria como "reabrir_semana_sede".')
  console.log('-'.repeat(72))
}

main()
  .catch((e) => {
    console.error('\nFALLO — la escritura va en transaccion, no quedo a medias:')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
