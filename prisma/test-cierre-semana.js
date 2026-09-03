import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

async function cierreEjecucionDe(semana) {
  const d = new Date(semana.startDate)
  const dowUtc = d.getUTCDay()
  const distAlSabado = (6 - dowUtc + 7) % 7
  let yyyy = d.getUTCFullYear()
  let mm = d.getUTCMonth()
  let dd = d.getUTCDate() + distAlSabado + 2
  let corrimientos = 0
  for (let i = 0; i < 7; i++) {
    const candidato = new Date(Date.UTC(yyyy, mm, dd))
    const esFestivo = await p.festivo.findUnique({ where: { date: candidato } })
    if (!esFestivo) break
    dd += 1
    corrimientos++
  }
  return { date: new Date(yyyy, mm, dd, 23, 59, 59, 999), corrimientos }
}

const DIA_NOMBRE = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']

// Probar con las próximas 8 semanas
const semanas = await p.week.findMany({ orderBy: { startDate: 'desc' }, take: 8 })
console.log('\n══ Test fecha de cierre del registro de ejecución (semana actual + alrededores) ══\n')
for (const s of semanas.reverse()) {
  const ini = s.startDate.toISOString().slice(0,10)
  const fin = s.endDate.toISOString().slice(0,10)
  const { date: fecha, corrimientos } = await cierreEjecucionDe(s)
  const diaNom = DIA_NOMBRE[fecha.getDay()]
  const cierreStr = `${diaNom} ${fecha.toISOString().slice(0,10)} 23:59`
  console.log(`Semana ${ini} → ${fin}  →  Cierre registro: ${cierreStr}${corrimientos ? ` (corrido ${corrimientos} día/s por festivo)` : ''}`)
}

console.log('\n══ Festivos cercanos en BD ══')
const hoy = new Date()
const en2meses = new Date(hoy); en2meses.setUTCMonth(en2meses.getUTCMonth()+2)
const festivos = await p.festivo.findMany({ where: { date: { gte: hoy, lte: en2meses } }, orderBy: { date: 'asc' } })
for (const f of festivos) {
  const dia = DIA_NOMBRE[new Date(f.date).getUTCDay()]
  console.log(`  ${f.date.toISOString().slice(0,10)} (${dia}): ${f.name}`)
}

await p.$disconnect()
