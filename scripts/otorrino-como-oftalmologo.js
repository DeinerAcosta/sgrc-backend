/**
 * PASAR LOS OTORRINOS A "POR PACIENTE" Y DARLES SU INTERVALO
 * ==========================================================
 *
 * Decision de negocio (Hector, 6-oct-2026): el otorrino opera IGUAL que el
 * oftalmologo. Eso incluye el esquema de pago: cobra por paciente y por lo
 * tanto NO tiene tope semanal.
 *
 * El codigo ya quedo asi — 'otorrino' esta en TIPOS_POR_PACIENTE, asi que todo
 * otorrino NUEVO nace correcto. Este script es para los que YA estan cargados.
 *
 * POR QUE NO LO HACE `corregir:esquema`
 * -------------------------------------
 * Ese script repara el INVARIANTE: filas donde el esquema y el tope se
 * contradicen (fijo sin tope, o por_paciente con tope). Un otorrino con
 * `fijo` + tope 44 es perfectamente COHERENTE, asi que no lo toca — y hace
 * bien. Lo que cambio no es la coherencia del dato, es la POLITICA de negocio
 * sobre que esquema le corresponde al tipo. Son dos cosas distintas y conviene
 * que vivan en scripts distintos: mezclarlas convertiria al reparador del
 * invariante en un aplicador de politicas, y nadie podria volver a correrlo sin
 * miedo.
 *
 * QUE HACE, sobre recursos ACTIVOS de tipo `otorrino`:
 *
 *   1. esquema_pago        -> 'por_paciente'   (si no lo esta ya)
 *      horas_max_semana    -> NULL             (el par va junto, invariante)
 *
 *   2. intervalo_minutos: solo AVISA, no lo cambia.
 *      El formulario tenia el campo oculto para otorrino pero enviaba igual el
 *      valor por defecto, asi que lo mas probable es que todos tengan 10
 *      minutos que nadie eligio. Ese numero calcula la capacidad de pacientes
 *      de su agenda, asi que NO se puede adivinar: lo define Wendy o Duarte
 *      por profesional, ahora que el campo ya se ve en la pantalla.
 *      (PROYECTOS-3495, punto 3.)
 *
 * NO toca inactivos, ni ningun otro tipo de recurso, ni las asignaciones ya
 * creadas. La escritura va en una transaccion.
 *
 * USO
 *   node scripts/otorrino-como-oftalmologo.js            # simulacion, no escribe
 *   node scripts/otorrino-como-oftalmologo.js --aplicar  # escribe
 */
import { PrismaClient } from '@prisma/client'
import { TIPOS_POR_PACIENTE } from '../src/lib/resourceTypes.js'

const prisma = new PrismaClient()
const APLICAR = process.argv.includes('--aplicar')
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)

async function main() {
  console.log('='.repeat(78))
  console.log('OTORRINO = OFTALMOLOGO · esquema por paciente, sin tope semanal')
  console.log(APLICAR ? 'MODO: APLICAR (escribe en la base)' : 'MODO: SIMULACION (no escribe nada)')
  console.log('='.repeat(78))

  // Salvaguarda: si alguien revierte la decision en el codigo, el script no
  // debe seguir escribiendo datos que ya no corresponden.
  if (!TIPOS_POR_PACIENTE.has('otorrino')) {
    console.log('\nABORTADO: `otorrino` ya no esta en TIPOS_POR_PACIENTE.')
    console.log('La decision se revirtio en el codigo; este script quedo obsoleto.')
    process.exitCode = 1
    return
  }

  const otorrinos = await prisma.resource.findMany({
    where: { active: true, type: 'otorrino' },
    select: { id: true, name: true, payScheme: true, maxHoursPerWeek: true, slotMinutes: true, multiRoom: true },
    orderBy: { name: 'asc' },
  })

  if (otorrinos.length === 0) {
    console.log('\nNo hay otorrinos activos. Nada que hacer.')
    return
  }

  console.log(`\n${otorrinos.length} otorrino(s) activo(s):\n`)
  console.log(`  ${pad('NOMBRE', 34)} ${pad('ESQUEMA', 14)} ${pad('TOPE', 6)} ${pad('INTERVALO', 10)} MULTI`)
  console.log('  ' + '-'.repeat(74))
  for (const r of otorrinos) {
    console.log(`  ${pad(r.name, 34)} ${pad(r.payScheme, 14)} ${pad(r.maxHoursPerWeek ?? 'NULL', 6)} ${pad((r.slotMinutes ?? 'NULL') + ' min', 10)} ${r.multiRoom ? 'si' : 'no'}`)
  }

  const aCambiar = otorrinos.filter((r) => r.payScheme !== 'por_paciente' || r.maxHoursPerWeek !== null)
  console.log(`\n1) ESQUEMA DE PAGO — ${aCambiar.length} de ${otorrinos.length} hay que cambiar:`)
  if (aCambiar.length === 0) {
    console.log('   ninguno: todos ya estan en por_paciente sin tope.')
  } else {
    for (const r of aCambiar) {
      console.log(`   ${pad(r.name, 34)} ${r.payScheme}/${r.maxHoursPerWeek ?? 'NULL'} -> por_paciente/NULL`)
    }
  }

  // --- intervalo: solo informar
  const sospechosos = otorrinos.filter((r) => r.slotMinutes == null || r.slotMinutes === 10)
  console.log(`\n2) INTERVALO POR PACIENTE — ${sospechosos.length} de ${otorrinos.length} con el valor por defecto:`)
  if (sospechosos.length === 0) {
    console.log('   ninguno: todos tienen un intervalo propio.')
  } else {
    for (const r of sospechosos) {
      console.log(`   ${pad(r.name, 34)} ${r.slotMinutes ?? 'NULL'} min  <- revisar con Wendy/Duarte`)
    }
    console.log('\n   Este script NO los cambia. Ese numero calcula la capacidad de')
    console.log('   pacientes de la agenda y no se puede adivinar: se corrige desde la')
    console.log('   pantalla de Recursos, donde el campo ya se muestra para otorrino.')
  }

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(78))
    console.log('SIMULACION — no se escribio nada.')
    console.log('Para aplicar el punto 1:  node scripts/otorrino-como-oftalmologo.js --aplicar')
    console.log('-'.repeat(78))
    return
  }

  if (aCambiar.length === 0) {
    console.log('\nNada que escribir.')
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.resource.updateMany({
      where: { id: { in: aCambiar.map((r) => r.id) } },
      data: { payScheme: 'por_paciente', maxHoursPerWeek: null },
    })
  })

  // Verificacion posterior: que no quede ninguno fuera de la politica.
  const restantes = await prisma.resource.count({
    where: {
      active: true, type: 'otorrino',
      OR: [{ payScheme: { not: 'por_paciente' } }, { maxHoursPerWeek: { not: null } }],
    },
  })

  console.log('\n' + '-'.repeat(78))
  console.log(`APLICADO — ${aCambiar.length} otorrino(s) pasados a por_paciente sin tope.`)
  console.log(`Verificacion: otorrinos activos fuera de la politica = ${restantes}`)
  if (restantes !== 0) {
    console.log('ATENCION: quedaron casos sin corregir. Revisar antes de dar por cerrado.')
    process.exitCode = 1
  }
  if (sospechosos.length > 0) {
    console.log(`PENDIENTE A MANO: revisar el intervalo por paciente de ${sospechosos.length} otorrino(s).`)
  }
  console.log('Los informes cachean 5 min; para verlo ya: pm2 reload sgrc-backend')
  console.log('-'.repeat(78))
}

main()
  .catch((e) => {
    console.error('\nFALLO — no se aplico nada (la escritura va en transaccion):')
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
