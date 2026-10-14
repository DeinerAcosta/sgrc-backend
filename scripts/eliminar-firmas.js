/**
 * BORRAR LAS FIRMAS ESCANEADAS DE LOS RECURSOS
 * ============================================
 *
 * Decision de Hector, 14-oct-2026: el formato F-AA-126 sale del sistema por
 * completo y con el las firmas. El codigo ya no las lee ni las escribe en
 * ningun lado — no hay pantalla, ni endpoint, ni texto que las nombre — pero
 * los datos siguen en la base: ~137 escaneos en base64 dentro de la columna
 * `recursos.firma_url` (MEDIUMTEXT), entre 30 y 800 KB cada uno.
 *
 * Esto las pone a NULL. La columna se queda: quitarla es una migracion aparte
 * y conviene hacerla cuando ya se compruebe que nada la extraña.
 *
 * NO HAY VUELTA ATRAS. Un escaneo de la firma de un medico no se regenera: si
 * manana se vuelve a necesitar, hay que pedirsela otra vez a cada uno. El
 * respaldo de la base es la unica red:
 *
 *     bash scripts/backup-db.sh
 *
 * Por eso el modo por defecto es SECO: cuenta y lista a quien le va a borrar,
 * sin tocar nada. Solo escribe con --aplicar.
 *
 * USO
 *   node scripts/eliminar-firmas.js              # seco — solo informa
 *   node scripts/eliminar-firmas.js --aplicar    # borra de verdad
 */
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB'

async function main() {
  console.log('-'.repeat(78))
  console.log(APLICAR ? 'BORRADO DE FIRMAS — APLICANDO' : 'BORRADO DE FIRMAS — CORRIDA EN SECO')
  console.log('-'.repeat(78))

  // Se piden los escaneos completos a proposito: el tamaño de cada uno es la
  // unica forma de que quien corra esto vea de verdad lo que va a perder.
  const conFirma = await prisma.resource.findMany({
    where: { signatureUrl: { not: null } },
    select: { id: true, name: true, type: true, active: true, signatureUrl: true },
    orderBy: { name: 'asc' },
  })

  if (conFirma.length === 0) {
    console.log('\nNo hay ninguna firma cargada. Nada que hacer.')
    console.log('-'.repeat(78))
    return
  }

  let bytes = 0
  console.log(`\n${conFirma.length} recurso(s) con firma cargada:\n`)
  for (const r of conFirma) {
    const n = Buffer.byteLength(r.signatureUrl, 'utf8')
    bytes += n
    console.log(`  ${kb(n)}  ${r.active ? ' ' : '·'} ${r.name}  (${r.type})`)
  }
  console.log(`\n  Total: ${(bytes / 1024 / 1024).toFixed(2)} MB en la columna firma_url`)
  console.log('  (· = recurso inactivo)')

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(78))
    console.log('CORRIDA EN SECO — no se borro nada.')
    console.log('Esto no se puede deshacer. Antes de aplicar: bash scripts/backup-db.sh')
    console.log('Para borrar:  npm run limpiar:firmas -- --aplicar')
    console.log('-'.repeat(78))
    return
  }

  // Se guarda en auditoria QUIEN tenia firma, no la firma: el registro sirve
  // para saber a quien habria que volver a pedirsela, y meter 4 MB de base64
  // en la tabla de auditoria solo mueve el problema de sitio.
  const auditoria = await registrarAuditoria({
    userId: null,
    action: 'eliminar_firmas_escaneadas',
    entity: 'recursos',
    entityId: conFirma[0].id,
    oldValue: conFirma.map((r) => ({
      id: r.id,
      recurso: r.name,
      tipo: r.type,
      bytes: Buffer.byteLength(r.signatureUrl, 'utf8'),
    })),
    reason: 'El formato F-AA-126 salio del sistema (decision 14-oct-2026); las firmas ya no se usan en ninguna pantalla',
  })

  if (!auditoria) {
    console.error('\n' + '-'.repeat(78))
    console.error('ABORTADO — no se pudo escribir la auditoria (el error va arriba).')
    console.error('NO se borro ninguna firma. Sin registro no se sabria a quien pedirsela.')
    console.error('-'.repeat(78))
    process.exitCode = 1
    return
  }

  const { count } = await prisma.resource.updateMany({
    where: { signatureUrl: { not: null } },
    data: { signatureUrl: null },
  })

  const quedan = await prisma.resource.count({ where: { signatureUrl: { not: null } } })

  console.log('\n' + '-'.repeat(78))
  console.log(`APLICADO — ${count} firma(s) borradas.`)
  console.log(`Verificacion: recursos con firma que quedan = ${quedan}`)
  if (quedan !== 0) console.log('   OJO: deberia ser 0. Revisar a mano.')
  console.log(`Auditoria escrita antes de tocar nada (${auditoria.id}): tiene la lista`)
  console.log('de a quien habria que volver a pedirsela.')
  console.log('-'.repeat(78))
}

main()
  .catch((e) => {
    console.error('\nFALLO:')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
