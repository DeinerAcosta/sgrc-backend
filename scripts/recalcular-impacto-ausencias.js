/**
 * RECALCULA EL IMPACTO DE LAS AUSENCIAS YA CONFIRMADAS
 * ====================================================
 *
 * `pacientes_impactados` y `costo_oportunidad` se calculan UNA SOLA VEZ, al
 * confirmar la ausencia, y quedan congelados en la fila. Arreglar el calculo
 * no toca lo ya guardado: hay que reprocesarlo.
 *
 * Este script aplica las reglas nuevas a todas las ausencias confirmadas:
 *
 *   1. Cada dia cuenta contra SU semana (antes sumaba todas las semanas)
 *   2. Domingos y festivos no cuentan (la sede no atiende)
 *   3. Solo impactan pacientes los tipos con agenda propia:
 *      oftalmologo, anestesiologo, otorrino, tecnico, fonoaudiologa, optometra
 *
 * MODO DE USO
 * -----------
 *   node scripts/recalcular-impacto-ausencias.js            # simulacion, no escribe
 *   node scripts/recalcular-impacto-ausencias.js --aplicar  # escribe de verdad
 *
 * Por defecto NO escribe nada: muestra que cambiaria. Revisa la simulacion
 * antes de aplicar, y saca un respaldo:
 *
 *   mysqldump -u root -p sgrc ausencias > ~/respaldo-ausencias-$(date +%F).sql
 */
import { PrismaClient } from '@prisma/client'
import { calcularImpacto } from '../src/services/absenceService.js'

const prisma = new PrismaClient()
const APLICAR = process.argv.includes('--aplicar')

const money = (n) => '$ ' + Math.round(n).toLocaleString('es-CO')
const linea = (c = '=') => console.log(c.repeat(88))

async function main() {
  linea()
  console.log(APLICAR
    ? 'RECALCULO DE IMPACTO · MODO APLICAR (escribe en la base)'
    : 'RECALCULO DE IMPACTO · SIMULACION (no escribe nada)')
  linea()
  if (!APLICAR) {
    console.log('Para aplicar de verdad: node scripts/recalcular-impacto-ausencias.js --aplicar')
    console.log('')
  }

  const ausencias = await prisma.absence.findMany({
    where: { status: 'confirmada' },
    // `select` explicito en el recurso, no `resource: true`: la ficha trae la
    // firma escaneada en un MEDIUMTEXT de 30-100 KB, y cargarla para cada
    // ausencia no aporta nada al calculo.
    include: {
      resource: { select: { id: true, name: true, type: true } },
      reasonRef: { select: { id: true, impactFactor: true } },
    },
    orderBy: { startDate: 'asc' },
  })
  console.log(`Ausencias confirmadas: ${ausencias.length}`)
  console.log('')

  let antesPac = 0
  let despuesPac = 0
  let antesCosto = 0
  let despuesCosto = 0
  let cambiadas = 0
  const cambios = []

  for (const a of ausencias) {
    // Se usa la MISMA funcion que corre al confirmar, para que no haya dos
    // implementaciones que puedan divergir.
    const r = await calcularImpacto(prisma, a)

    const pacAntes = a.patientsAffected ?? 0
    const costoAntes = Number(a.opportunityCost ?? 0)
    antesPac += pacAntes
    despuesPac += r.pacImpactados
    antesCosto += costoAntes
    despuesCosto += r.opportunityCost

    if (pacAntes !== r.pacImpactados || Math.round(costoAntes) !== Math.round(r.opportunityCost)) {
      cambiadas++
      cambios.push({ a, pacAntes, pacDespues: r.pacImpactados, r })
    }

    if (APLICAR) {
      await prisma.absence.update({
        where: { id: a.id },
        data: {
          patientsAffected: r.pacImpactados,
          opportunityCost: r.opportunityCost,
          complaintsLogged: r.quejasEstimadas,
          dailyImpact: r.dailyImpact,
        },
      })
    }
  }

  // Las 25 de mayor diferencia, que es donde esta el grueso de la distorsion.
  console.log('recurso'.padEnd(30) + 'tipo'.padEnd(15) + 'antes'.padStart(9) + 'despues'.padStart(9))
  console.log('-'.repeat(88))
  for (const c of cambios.sort((x, y) => (y.pacAntes - y.pacDespues) - (x.pacAntes - x.pacDespues)).slice(0, 25)) {
    console.log(
      c.a.resource.name.slice(0, 29).padEnd(30) +
      c.a.resource.type.slice(0, 14).padEnd(15) +
      String(c.pacAntes).padStart(9) +
      String(c.pacDespues).padStart(9)
    )
  }
  if (cambios.length > 25) console.log(`  … y ${cambios.length - 25} mas`)
  console.log('-'.repeat(88))
  console.log('')

  linea()
  console.log('RESUMEN')
  linea()
  console.log(`  Ausencias que cambian : ${cambiadas} de ${ausencias.length}`)
  console.log('')
  console.log(`  Pacientes afectados   : ${antesPac.toLocaleString('es-CO')}  →  ${despuesPac.toLocaleString('es-CO')}`)
  console.log(`  Costo de oportunidad  : ${money(antesCosto)}  →  ${money(despuesCosto)}`)
  console.log('')
  if (APLICAR) {
    console.log('  ✔ Cambios aplicados. Los informes ya muestran las cifras corregidas.')
  } else {
    console.log('  Nada se escribio. Si los numeros de arriba te cuadran, vuelve a correrlo')
    console.log('  con --aplicar (y saca el respaldo de la tabla `ausencias` antes).')
  }
  console.log('')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
