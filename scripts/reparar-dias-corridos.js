// Repara lo que dejaron dos fallos al confirmar ausencias (oct-2026).
//
//   1 · DÍAS CORRIDOS. `diasDeAusencia` leía las fechas con la hora local; en
//       Colombia la medianoche UTC del martes es el lunes a las 19:00, así que
//       el impacto, las ejecuciones "no ejecutada" y la auxiliar liberada se
//       calculaban sobre el día ANTERIOR. Lo vio Hector: una ausencia del
//       martes del Dr. Camargo decía 9 pacientes impactados —los de su turno
//       del lunes— y la pantalla del caso "no hay nada que reemplazar".
//       Solo pasa si el proceso corre con zona horaria de Colombia.
//
//   2 · AUXILIAR LIBERADA EN TODAS LAS SEMANAS. `liberarAuxiliaresSiAplica`
//       buscaba solo por día de la semana: una ausencia de un martes dejaba
//       "sin_cobertura" los turnos con auxiliar de TODOS los martes cargados.
//       Pasa con cualquier zona horaria.
//
// Qué hace, con el código ya corregido:
//   · recalcula el impacto de las ausencias confirmadas con los días corridos;
//   · borra las ejecuciones "no ejecutada" que se generaron en el día
//     equivocado y las crea en el correcto (si una se había SOBREESCRITO, no
//     hay forma de saber qué tenía antes: se informa y se deja);
//   · devuelve a 'activa' los turnos 'sin_cobertura' que ninguna ausencia
//     confirmada justifica, y marca los que sí correspondían.
//
// Por defecto SOLO MUESTRA. Para escribir:  node scripts/reparar-dias-corridos.js --aplicar
import { prisma } from '../src/lib/prisma.js'
import { calcularImpacto, diasDeAusencia, liberarAuxiliaresSiAplica } from '../src/services/absenceService.js'
import { TIPOS_QUE_LIBERAN_AUXILIAR } from '../src/lib/resourceTypes.js'

const APLICAR = process.argv.includes('--aplicar')
const log = (...x) => console.log(...x)
const enUtc = (fecha) => new Date(`${fecha}T00:00:00.000Z`)
const iso = (d) => new Date(d).toISOString().slice(0, 10)
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

async function semanaDe(fecha) {
  const d = enUtc(fecha)
  return prisma.week.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } }, select: { id: true } })
}
async function turnosDelDia(resourceId, fecha) {
  const semana = await semanaDe(fecha)
  if (!semana) return []
  return prisma.assignment.findMany({
    where: {
      weekId: semana.id, weekday: DIAS[enUtc(fecha).getUTCDay()], status: { not: 'cancelada' },
      OR: [{ resourceId }, { assistantId: resourceId }],
    },
    select: { id: true },
  })
}

log(`REPARAR DÍAS CORRIDOS · ${APLICAR ? 'APLICANDO' : 'solo muestra (usa --aplicar para escribir)'}`)
log('='.repeat(74))

// ── 1 · Ausencias confirmadas con el impacto sobre días corridos ──────────
const confirmadas = await prisma.absence.findMany({
  where: { status: 'confirmada' },
  include: { resource: true, reasonRef: true },
})
const corridas = confirmadas.filter((a) => {
  const guardado = (Array.isArray(a.dailyImpact) ? a.dailyImpact : []).map((d) => d.date)
  if (guardado.length === 0) return false
  // Corrida = algún día guardado cae fuera de la ausencia. No se compara la
  // lista entera: el impacto se salta domingos y festivos a propósito.
  const bien = new Set(diasDeAusencia(a).map((d) => d.date))
  return guardado.some((f) => !bien.has(f))
})
log(`\n1 · Ausencias confirmadas con los días corridos: ${corridas.length} de ${confirmadas.length}`)

let ejecBorradas = 0, ejecCreadas = 0, ejecSinDeshacer = 0
for (const a of corridas) {
  const bien = diasDeAusencia(a)
  const imp = await calcularImpacto(prisma, a)
  const malos = a.dailyImpact.map((d) => d.date).filter((f) => !bien.some((b) => b.date === f))
  log(`  · ${a.resource.name} · ${iso(a.startDate)}${iso(a.endDate) !== iso(a.startDate) ? ' a ' + iso(a.endDate) : ''}` +
    ` · pacientes ${a.patientsAffected} → ${imp.pacImpactados} · días guardados ${a.dailyImpact.map((d) => d.date).join(',')} → ${bien.map((d) => d.date).join(',')}`)

  // Ejecuciones automáticas generadas en el día equivocado.
  const marca = `ausencia confirmada (${a.type})`
  for (const f of malos) {
    const turnos = await turnosDelDia(a.resourceId, f)
    const ejec = await prisma.execution.findMany({
      where: { assignmentId: { in: turnos.map((t) => t.id) }, notes: { contains: marca }, locked: false },
      select: { id: true, notes: true },
    })
    for (const e of ejec) {
      if (e.notes.startsWith('Generado')) {
        ejecBorradas++
        if (APLICAR) await prisma.execution.delete({ where: { id: e.id } })
      } else {
        ejecSinDeshacer++
        log(`      ojo: ejecución del ${f} sobreescrita al confirmar; no se sabe qué tenía antes, se deja`)
      }
    }
  }

  if (APLICAR) {
    await prisma.absence.update({
      where: { id: a.id },
      data: {
        patientsAffected: imp.pacImpactados,
        opportunityCost: imp.opportunityCost,
        dailyImpact: imp.dailyImpact,
        complaintsLogged: imp.quejasEstimadas,
      },
    })
  }

  // Las del día correcto, igual que al confirmar.
  for (const { date: f } of bien) {
    for (const t of await turnosDelDia(a.resourceId, f)) {
      const ya = await prisma.execution.findUnique({ where: { assignmentId: t.id }, select: { locked: true } })
      if (ya) continue   // si ya tiene una (o está bloqueada), no se toca
      ejecCreadas++
      if (APLICAR) {
        await prisma.execution.create({
          data: {
            assignmentId: t.id, patientsSeen: 0, shiftStatus: 'no_ejecutada',
            notes: `Generado automáticamente — ${marca}`, recordedBy: a.confirmedBy ?? a.reportedBy,
          },
        })
      }
    }
  }
}
log(`  Ejecuciones en el día equivocado que se borran: ${ejecBorradas} · en el día correcto que se crean: ${ejecCreadas}` +
  (ejecSinDeshacer ? ` · sobreescritas que no se pueden deshacer: ${ejecSinDeshacer}` : ''))

// ── 2 · Turnos 'sin_cobertura' que ninguna ausencia justifica ─────────────
const liberadoras = confirmadas.filter((a) => TIPOS_QUE_LIBERAN_AUXILIAR.has(a.resource.type))
const justificado = async (t) => liberadoras.some((a) => {
  if (a.resourceId !== t.resourceId) return false
  if (a.isPartial && a.absenceStartTime && a.absenceEndTime &&
    (a.absenceEndTime <= t.startTime || a.absenceStartTime >= t.endTime)) return false
  return diasDeAusencia(a).some((d) => {
    const fd = enUtc(d.date)
    return d.day === t.weekday && fd >= t.week.startDate && fd <= t.week.endDate
  })
})
const sinCobertura = await prisma.assignment.findMany({
  where: { status: 'sin_cobertura' },
  select: {
    id: true, resourceId: true, weekday: true, startTime: true, endTime: true,
    resource: { select: { name: true } }, week: { select: { startDate: true, endDate: true } },
  },
})
const devolver = []
for (const t of sinCobertura) if (!(await justificado(t))) devolver.push(t)
log(`\n2 · Turnos 'sin_cobertura': ${sinCobertura.length} · sin ausencia que los justifique (vuelven a 'activa'): ${devolver.length}`)
for (const t of devolver) log(`  · ${t.resource.name} · semana ${iso(t.week.startDate)} · ${t.weekday} ${t.startTime}-${t.endTime}`)
if (APLICAR && devolver.length) {
  await prisma.assignment.updateMany({ where: { id: { in: devolver.map((t) => t.id) } }, data: { status: 'activa' } })
}

// Y los que SÍ correspondían a las ausencias corridas, en su día correcto.
let marcadas = 0
for (const a of corridas.filter((x) => TIPOS_QUE_LIBERAN_AUXILIAR.has(x.resource.type))) {
  if (APLICAR) {
    marcadas += (await liberarAuxiliaresSiAplica(prisma, a, diasDeAusencia(a))).liberadas
  }
}
if (APLICAR) log(`  Turnos marcados 'sin_cobertura' en su día correcto: ${marcadas}`)

log('\n' + '='.repeat(74))
log(APLICAR ? 'HECHO.' : 'Nada se escribió. Revisa la lista y corre con --aplicar.')
await prisma.$disconnect()
