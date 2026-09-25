/**
 * CORREGIR EL INVARIANTE esquema de pago ↔ tope semanal
 * =====================================================
 *
 * Problema (detectado sep-2026). En produccion habia 94 oftalmologos con
 * `esquema_pago = 'fijo'` y `horas_max_semana = NULL` — el 100% de los
 * oftalmologos marcados 'fijo'. Esa combinacion es imposible por definicion:
 *
 *   · 'fijo' / 'mixto'   → se paga por tiempo  → HACE FALTA un tope semanal,
 *                          porque es el denominador del % de utilizacion.
 *   · 'por_paciente'     → se paga por atencion → NO lleva tope.
 *
 * Consecuencia: entraban al informe "Tiempos ociosos" (que filtra por
 * esquema IN fijo/mixto) pero sin denominador, asi que salian al 0% con horas
 * asignadas de verdad, en rojo, y engordaban el KPI "Recursos con tiempo
 * ocioso" (262 en vez de 166).
 *
 * De donde salio: la carga en lote de usuarios y la aprobacion de solicitudes
 * decidian los dos campos por separado — el tope mirando el TIPO (oftalmologo
 * ⇒ null) y el esquema tomando lo que trajera el CSV (⇒ 'fijo'). Las dos fugas
 * quedaron cerradas: ahora toda escritura pasa por `normalizarEsquemaYTope`
 * (src/lib/resourceTypes.js). Este script arregla lo ya escrito.
 *
 * QUE HACE. Para cada recurso ACTIVO con la combinacion incoherente decide por
 * el TIPO, que es el dato de negocio fiable:
 *
 *   · tipo en TIPOS_POR_PACIENTE (oftalmologo, fonoaudiologa)
 *       → esquema_pago = 'por_paciente'   (el tope se queda en NULL)
 *       Es lo que el sistema entero ya asume de ellos: el seed los crea asi,
 *       el alta individual los crea asi, y los 4 oftalmologos + 5
 *       fonoaudiologas que SI estaban en 'por_paciente' son los correctos.
 *
 *   · cualquier otro tipo en fijo/mixto sin tope
 *       → horas_max_semana = 44   (Ley 2101 vigente; --horas lo cambia)
 *       Aqui el esquema si es creible (auxiliares, tecnicos, asesores y
 *       optometras son de salario), lo que falta es el tope.
 *
 * NO toca a nadie mas: ni inactivos, ni recursos coherentes, ni los topes que
 * ya tengan un valor. Los 8.321 overrides de capacidad manual no se tocan.
 *
 * USO
 *   node scripts/corregir-esquema-tope.js              # corrida en seco (no escribe)
 *   node scripts/corregir-esquema-tope.js --aplicar    # escribe
 *   node scripts/corregir-esquema-tope.js --aplicar --horas 42
 *
 * Hacer respaldo antes de --aplicar. La corrida en seco imprime exactamente
 * las mismas filas que se van a escribir.
 */
import { prisma } from '../src/lib/prisma.js'
import { TIPOS_POR_PACIENTE, HORAS_SEMANA_POR_DEFECTO } from '../src/lib/resourceTypes.js'

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const idxHoras = args.indexOf('--horas')
const HORAS = idxHoras >= 0 ? Number(args[idxHoras + 1]) : HORAS_SEMANA_POR_DEFECTO

if (!Number.isInteger(HORAS) || HORAS < 1 || HORAS > 60) {
  console.error(`--horas debe ser un entero entre 1 y 60 (recibido: ${args[idxHoras + 1]})`)
  process.exit(1)
}

const pad = (s, n) => String(s ?? '').padEnd(n)

async function main() {
  console.log('='.repeat(78))
  console.log('CORRECCION DEL INVARIANTE esquema de pago <-> tope semanal')
  console.log(APLICAR ? 'MODO: APLICAR (escribe en la BD)' : 'MODO: CORRIDA EN SECO (no escribe nada)')
  console.log(`Tope a asignar a los de salario sin tope: ${HORAS} h/semana`)
  console.log('='.repeat(78))

  // Los incoherentes: se paga por tiempo pero no hay tope contra el que medir.
  const incoherentes = await prisma.resource.findMany({
    where: { active: true, payScheme: { in: ['fijo', 'mixto'] }, maxHoursPerWeek: null },
    select: { id: true, name: true, type: true, payScheme: true, maxHoursPerWeek: true },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  })

  if (incoherentes.length === 0) {
    console.log('\nNo hay recursos activos con la combinacion incoherente. Nada por hacer.')
    return
  }

  // Y el caso espejo, por si existiera: por_paciente CON tope (el tope sobra).
  const conTopeDeMas = await prisma.resource.findMany({
    where: { active: true, payScheme: 'por_paciente', maxHoursPerWeek: { not: null } },
    select: { id: true, name: true, type: true, maxHoursPerWeek: true },
    orderBy: { name: 'asc' },
  })

  const aPorPaciente = []
  const aConTope = []
  for (const r of incoherentes) {
    if (TIPOS_POR_PACIENTE.has(r.type)) aPorPaciente.push(r)
    else aConTope.push(r)
  }

  console.log(`\nRecursos activos con esquema de salario y SIN tope: ${incoherentes.length}`)

  if (aPorPaciente.length > 0) {
    console.log(`\n[A] ${aPorPaciente.length} pasan a esquema 'por_paciente' (el tipo cobra por atencion)`)
    console.log(`    ${pad('Recurso', 38)} ${pad('Tipo', 16)} esquema: antes -> despues`)
    for (const r of aPorPaciente) {
      console.log(`    ${pad(r.name, 38)} ${pad(r.type, 16)} ${pad(r.payScheme, 7)} -> por_paciente`)
    }
    const porTipo = aPorPaciente.reduce((m, r) => m.set(r.type, (m.get(r.type) ?? 0) + 1), new Map())
    console.log(`    Resumen: ${[...porTipo].map(([t, n]) => `${t}=${n}`).join('  ')}`)
  }

  if (aConTope.length > 0) {
    console.log(`\n[B] ${aConTope.length} reciben tope de ${HORAS} h/semana (el esquema de salario si aplica al tipo)`)
    console.log(`    ${pad('Recurso', 38)} ${pad('Tipo', 16)} ${pad('Esquema', 8)} tope: NULL -> ${HORAS}`)
    for (const r of aConTope) {
      console.log(`    ${pad(r.name, 38)} ${pad(r.type, 16)} ${pad(r.payScheme, 8)} NULL -> ${HORAS}`)
    }
  }

  if (conTopeDeMas.length > 0) {
    console.log(`\n[C] ${conTopeDeMas.length} con esquema 'por_paciente' pero CON tope — se les quita el tope`)
    for (const r of conTopeDeMas) {
      console.log(`    ${pad(r.name, 38)} ${pad(r.type, 16)} tope ${r.maxHoursPerWeek} -> NULL`)
    }
  }

  const total = aPorPaciente.length + aConTope.length + conTopeDeMas.length

  if (!APLICAR) {
    console.log('\n' + '-'.repeat(78))
    console.log(`CORRIDA EN SECO — no se escribio nada. Se cambiarian ${total} recursos.`)
    console.log('Para aplicar: node scripts/corregir-esquema-tope.js --aplicar')
    console.log('-'.repeat(78))
    return
  }

  // Una sola transaccion: o quedan todos coherentes o no se toca nada.
  await prisma.$transaction(async (tx) => {
    if (aPorPaciente.length > 0) {
      await tx.resource.updateMany({
        where: { id: { in: aPorPaciente.map((r) => r.id) } },
        data: { payScheme: 'por_paciente', maxHoursPerWeek: null },
      })
    }
    if (aConTope.length > 0) {
      await tx.resource.updateMany({
        where: { id: { in: aConTope.map((r) => r.id) } },
        data: { maxHoursPerWeek: HORAS },
      })
    }
    if (conTopeDeMas.length > 0) {
      await tx.resource.updateMany({
        where: { id: { in: conTopeDeMas.map((r) => r.id) } },
        data: { maxHoursPerWeek: null },
      })
    }
  })

  // Verificacion posterior: el invariante tiene que quedar sin excepciones.
  const restantes = await prisma.resource.count({
    where: {
      active: true,
      OR: [
        { payScheme: { in: ['fijo', 'mixto'] }, maxHoursPerWeek: null },
        { payScheme: 'por_paciente', maxHoursPerWeek: { not: null } },
      ],
    },
  })

  console.log('\n' + '-'.repeat(78))
  console.log(`APLICADO — ${total} recursos corregidos.`)
  console.log(`Verificacion: recursos activos que siguen incoherentes = ${restantes}`)
  if (restantes !== 0) {
    console.log('ATENCION: quedaron incoherencias. Revisar antes de dar por cerrado.')
    process.exitCode = 1
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
