/**
 * VERIFICADOR DEL IMPACTO DE AUSENCIAS — SOLO LECTURA
 * ==================================================
 *
 * Responde a "los pacientes afectados y el costo salen exagerados, quiero ver
 * como se calcula y comprobarlo contra la base".
 *
 * No escribe NADA. Se puede correr en produccion cuando sea:
 *
 *   cd /opt/sgrc/backend && node scripts/verificar-impacto-ausencias.js
 *
 * ---------------------------------------------------------------------------
 * COMO SE CALCULA HOY (services/absenceService.js > calcularImpacto)
 * ---------------------------------------------------------------------------
 * Al CONFIRMAR una ausencia, para cada dia del rango:
 *   1. Busca las asignaciones del recurso ese DIA DE LA SEMANA
 *   2. Suma `pacientes_capacidad` de cada una
 *   3. Multiplica por dos atenuadores:
 *        factor parcial (si la ausencia es por horas, prorratea sobre 10h)
 *        factor del motivo (del catalogo, 1.00 = impacto completo)
 *   4. El costo = pacientes x costo de la especialidad del consultorio
 * El resultado se GUARDA en ausencias.pacientes_impactados y .costo_oportunidad.
 * Los informes solo SUMAN esa columna: no recalculan nada.
 *
 * ---------------------------------------------------------------------------
 * EL PROBLEMA QUE ESTE SCRIPT MIDE
 * ---------------------------------------------------------------------------
 * El paso 1 filtra por `dia_semana` pero NO por semana. Si un profesional
 * atiende todos los lunes y en la base hay 30 semanas cargadas, una ausencia
 * de UN lunes suma los pacientes de LOS 30 lunes. El numero queda multiplicado
 * por la cantidad de semanas que existan, y crece cada vez que se crea una
 * semana nueva.
 *
 * El script recalcula cada ausencia acotando las asignaciones a la SEMANA que
 * realmente contiene cada fecha, y compara contra lo guardado.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Tipos que tienen agenda propia de pacientes. Un auxiliar o un tecnico
// ACOMPAÑAN la consulta de otro: si faltan, la agenda no necesariamente se
// pierde. Se separan para poder ver cuanto del total sale de cada grupo.
const CON_AGENDA_PROPIA = new Set(['oftalmologo', 'optometra', 'otorrino', 'fonoaudiologa'])

const money = (n) => '$ ' + Math.round(n).toLocaleString('es-CO')
const fmt = (d) => new Date(d).toISOString().slice(0, 10)
const linea = (c = '=') => console.log(c.repeat(92))

async function main() {
  linea()
  console.log('VERIFICADOR DE IMPACTO DE AUSENCIAS · solo lectura')
  linea()

  const semanas = await prisma.week.findMany({
    select: { id: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' },
  })
  console.log(`Semanas cargadas en la base: ${semanas.length}`)
  console.log('Ese numero es, aproximadamente, el factor por el que se multiplica')
  console.log('cada ausencia con el calculo actual.')
  console.log('')

  const ausencias = await prisma.absence.findMany({
    where: { status: 'confirmada' },
    include: {
      resource: { select: { name: true, type: true } },
      reasonRef: { select: { name: true, impactFactor: true } },
    },
    orderBy: { patientsAffected: 'desc' },
  })

  if (ausencias.length === 0) {
    console.log('No hay ausencias confirmadas.')
    return
  }

  const parametros = await prisma.costSetting.findMany({ orderBy: { effectiveFrom: 'desc' } })
  const costoDe = (especialidad, fechaRef) => {
    const ap = parametros.filter((p) => p.visitType === especialidad && p.effectiveFrom <= fechaRef)
    return Number(ap[0]?.visitCost ?? 0)
  }

  // DIAS[getDay()] — getDay() devuelve 0 para domingo.
  const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

  console.log('recurso'.padEnd(26) + 'tipo'.padEnd(14) + 'fechas'.padEnd(24) +
              'dias'.padStart(5) + 'GUARDADO'.padStart(10) + 'REAL'.padStart(8) + '  factor')
  console.log('-'.repeat(92))

  let totGuardado = 0
  let totReal = 0
  let totCostoGuardado = 0
  let totCostoReal = 0
  let totProf = 0
  let totApoyo = 0

  for (const a of ausencias) {
    // Factor parcial (RN-19) y factor del motivo: se replican tal cual.
    let factorParcial = 1
    if (a.isPartial && a.absenceStartTime && a.absenceEndTime) {
      const min = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
      const dur = min(a.absenceEndTime) - min(a.absenceStartTime)
      factorParcial = dur <= 0 ? 0 : Math.min(1, dur / 600)
    }
    const factorMotivo = a.reasonRef?.impactFactor != null ? Number(a.reasonRef.impactFactor) : 1
    const factor = factorParcial * factorMotivo

    // Recorrido dia a dia, igual que el calculo real.
    let pacReal = 0
    let costoReal = 0
    let dias = 0
    let diasSinSemana = 0
    const cursor = new Date(a.startDate)
    while (cursor <= a.endDate) {
      dias++
      const dia = DIAS[cursor.getUTCDay()]
      // LA DIFERENCIA: solo la semana que contiene ESTA fecha.
      const semana = semanas.find((s) => cursor >= s.startDate && cursor <= s.endDate)
      // Distinguir "no hay semana cargada para esa fecha" de "hay semana pero
      // esa persona no tenia turno": en el primer caso el 0 no significa que no
      // hubo impacto, significa que no hay con que compararlo.
      if (!semana) diasSinSemana++
      if (semana) {
        const asigs = await prisma.assignment.findMany({
          where: {
            weekId: semana.id,
            weekday: dia,
            status: { not: 'cancelada' },
            OR: [{ resourceId: a.resourceId }, { assistantId: a.resourceId }],
          },
          include: { room: { select: { specialty: true } } },
        })
        for (const asig of asigs) {
          const p = Math.round((asig.patientCapacity ?? 0) * factor)
          pacReal += p
          costoReal += Math.round(p * costoDe(asig.room.specialty, a.startDate))
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    const guardado = a.patientsAffected ?? 0
    const costoGuardado = Number(a.opportunityCost ?? 0)
    totGuardado += guardado
    totReal += pacReal
    totCostoGuardado += costoGuardado
    totCostoReal += costoReal
    if (CON_AGENDA_PROPIA.has(a.resource.type)) totProf += guardado
    else totApoyo += guardado

    // Marca por que el recalculo dio 0, para no confundir "no hubo impacto"
    // con "no hay datos para compararlo".
    let nota = ''
    if (pacReal === 0 && guardado > 0) {
      nota = diasSinSemana === dias ? 'sin semana cargada'
           : diasSinSemana > 0      ? `${diasSinSemana}/${dias} dias sin semana`
           : 'sin turnos esa semana'
    }
    const factorInflado = pacReal > 0 ? (guardado / pacReal).toFixed(1) + 'x' : (guardado > 0 ? '—' : '')
    console.log(
      a.resource.name.slice(0, 25).padEnd(26) +
      a.resource.type.slice(0, 13).padEnd(14) +
      `${fmt(a.startDate)} a ${fmt(a.endDate)}`.padEnd(24) +
      String(dias).padStart(5) +
      String(guardado).padStart(10) +
      String(pacReal).padStart(8) +
      '  ' + factorInflado.padEnd(8) + nota
    )
  }

  console.log('-'.repeat(92))
  console.log('')
  linea()
  console.log('RESUMEN')
  linea()
  console.log(`  Pacientes afectados · guardado en la base : ${totGuardado.toLocaleString('es-CO')}`)
  console.log(`  Pacientes afectados · recalculado por semana: ${totReal.toLocaleString('es-CO')}`)
  if (totReal > 0) {
    console.log(`  → el informe muestra ${(totGuardado / totReal).toFixed(1)} veces el valor real`)
  }
  console.log('')
  console.log(`  Costo de oportunidad · guardado    : ${money(totCostoGuardado)}`)
  console.log(`  Costo de oportunidad · recalculado : ${money(totCostoReal)}`)
  console.log('')
  console.log('  De los pacientes afectados que hay guardados hoy:')
  console.log(`    ${totProf.toLocaleString('es-CO')} vienen de profesionales con agenda propia`)
  console.log(`    ${totApoyo.toLocaleString('es-CO')} vienen de personal de apoyo (auxiliar / tecnico / asesor)`)
  console.log('')
  console.log('  Los del segundo grupo son discutibles: cuando falta una auxiliar,')
  console.log('  el sistema imputa TODOS los pacientes de la consulta del medico al')
  console.log('  que acompaña, como si se hubiera perdido la agenda entera. Si ese')
  console.log('  dia el medico igual atendio, ese numero no corresponde — y ademas')
  console.log('  se cuenta dos veces si el medico tambien estuvo ausente.')
  console.log('')

  // ---------------------------------------------------------------- dupes ----
  // Misma persona, mismas fechas exactas, mas de un registro. Cada copia suma
  // otra vez sus pacientes y sus dias en los informes.
  linea()
  console.log('AUSENCIAS DUPLICADAS')
  linea()
  const porClave = new Map()
  for (const a of ausencias) {
    const k = `${a.resourceId}|${fmt(a.startDate)}|${fmt(a.endDate)}`
    if (!porClave.has(k)) porClave.set(k, [])
    porClave.get(k).push(a)
  }
  const dupes = [...porClave.values()].filter((g) => g.length > 1)
  if (dupes.length === 0) {
    console.log('  OK · no hay ausencias repetidas.')
  } else {
    let pacDeMas = 0
    let diasDeMas = 0
    console.log(`  ${dupes.length} ausencia(s) registradas mas de una vez:`)
    console.log('')
    for (const g of dupes.sort((x, y) => (y[0].patientsAffected ?? 0) - (x[0].patientsAffected ?? 0))) {
      const a = g[0]
      const d = Math.round((a.endDate - a.startDate) / 86400000) + 1
      const copias = g.length - 1
      pacDeMas += (a.patientsAffected ?? 0) * copias
      diasDeMas += d * copias
      console.log(`    ${a.resource.name.slice(0, 28).padEnd(29)} ${fmt(a.startDate)} a ${fmt(a.endDate)}` +
                  `  x${g.length}  (${a.patientsAffected ?? 0} pac. c/u)`)
    }
    console.log('')
    console.log(`  Las copias suman de mas: ${pacDeMas.toLocaleString('es-CO')} pacientes y ${diasDeMas} dias`)
    console.log('  en los informes de ausentismo, encima del inflado por semana.')
  }
  console.log('')

  // ------------------------------------------------------------- corruptas ----
  linea()
  console.log('FECHAS IMPOSIBLES')
  linea()
  const malas = ausencias.filter((a) => {
    const ini = new Date(a.startDate)
    const fin = new Date(a.endDate)
    return fin < ini || ini.getUTCFullYear() < 2020 || ini.getUTCFullYear() > 2100
        || fin.getUTCFullYear() < 2020 || fin.getUTCFullYear() > 2100
  })
  if (malas.length === 0) {
    console.log('  OK · todas las fechas son coherentes.')
  } else {
    console.log(`  ${malas.length} ausencia(s) con fechas que no pueden ser. Hay que corregirlas a mano:`)
    console.log('')
    for (const a of malas) {
      const fin = new Date(a.endDate)
      const motivo = fin < new Date(a.startDate) ? 'termina antes de empezar' : 'año fuera de rango'
      console.log(`    ${a.resource.name.slice(0, 28).padEnd(29)} ${fmt(a.startDate)} a ${fmt(a.endDate)}   ${motivo}`)
      console.log(`      id: ${a.id}`)
    }
  }
  console.log('')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
