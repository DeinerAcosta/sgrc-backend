/**
 * DATOS DE PRUEBA PARA LOS INDICADORES DE ASESORES (3667/3668) · solo local
 *
 *   npm run datos:asesores              crea el escenario
 *   npm run datos:asesores -- --limpiar lo deshace
 *
 * La base local trae 2 asesores y ninguno tiene turnos, así que el informe
 * "Indicadores de asesores" salía en ceros y no había nada que revisar. Esto
 * arma, en la semana de hoy:
 *   - una sala "ÁREA ASESORES (prueba)" en la primera sede activa;
 *   - Liliana de lunes a viernes 07:00–13:00 y dos tardes de backoffice;
 *   - Jhon Fredy lunes a miércoles 07:00–15:00 y una ausencia imprevista
 *     de hace 20 días.
 * Todo lo que crea lleva la marca MARCA para poder borrarlo sin tocar nada más.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { soloEnLocal, asegurarSemanaDeHoy, fechaDelDia } from './lib/datos-comunes.js'

soloEnLocal()

const MARCA = 'datos-asesores'
const SALA = 'ÁREA ASESORES (prueba)'
const log = (...x) => console.log(...x)

async function limpiar() {
  const salas = await prisma.room.findMany({ where: { name: SALA }, select: { id: true } })
  const idsSalas = salas.map((s) => s.id)
  const turnos = await prisma.assignment.deleteMany({ where: { roomId: { in: idsSalas } } })
  const bo = await prisma.backofficeAssignment.findMany({ where: { groupId: MARCA }, select: { id: true } })
  await prisma.backofficeExecution.deleteMany({ where: { backofficeAssignmentId: { in: bo.map((b) => b.id) } } })
  await prisma.backofficeAssignment.deleteMany({ where: { groupId: MARCA } })
  const aus = await prisma.absence.deleteMany({ where: { reason: MARCA } })
  await prisma.room.deleteMany({ where: { id: { in: idsSalas } } })
  log(`Borrados: ${turnos.count} turnos, ${bo.length} backoffice, ${aus.count} ausencias, ${idsSalas.length} sala(s).`)
}

async function crear() {
  await limpiar()
  const [liliana, jhon] = await Promise.all(
    ['Liliana Charris Mejía', 'Jhon Fredy Cantillo'].map((name) =>
      prisma.resource.findFirst({ where: { name, type: 'asesor_servicios' }, select: { id: true, name: true } })),
  )
  if (!liliana || !jhon) throw new Error('Faltan los asesores de los datos base: corre antes npm run datos:prueba')
  const sede = await prisma.site.findFirst({ where: { active: true }, orderBy: { name: 'asc' } })
  const { semana } = await asegurarSemanaDeHoy()
  const tarea = await prisma.backofficeTask.findFirst({ where: { active: true, status: 'aprobada' } })
  const autor = await prisma.user.findFirst({ where: { role: 'gerencia' }, select: { id: true } })

  const sala = await prisma.room.create({
    data: { siteId: sede.id, name: SALA, specialty: 'asesoria', requiresAssistant: false },
  })
  const turno = (r, weekday, startTime, endTime) => ({
    weekId: semana.id, resourceId: r.id, roomId: sala.id, weekday, startTime, endTime, patientCapacity: 0,
  })
  await prisma.assignment.createMany({
    data: [
      ...['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].map((d) => turno(liliana, d, '07:00', '13:00')),
      ...['lunes', 'martes', 'miercoles'].map((d) => turno(jhon, d, '07:00', '15:00')),
    ],
  })

  // Dos tardes de backoffice de Liliana: lunes y martes de esta semana.
  const lunes = fechaDelDia(semana, 'lunes')
  const martes = fechaDelDia(semana, 'martes')
  if (tarea) {
    await prisma.backofficeAssignment.createMany({
      data: [lunes, martes].map((day) => ({
        assistantId: liliana.id, siteId: sede.id, backofficeTaskId: tarea.id,
        day, startTime: '14:00', endTime: '17:00', assignedBy: autor.id, groupId: MARCA,
      })),
    })
  }

  // Una ausencia imprevista de Jhon hace 20 días.
  const hace20 = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 20))
  await prisma.absence.create({
    data: {
      resourceId: jhon.id, startDate: hace20, endDate: hace20, type: 'calamidad', reason: MARCA,
      isPlanned: false, noticeDays: 0, status: 'confirmada', reportedBy: autor.id, confirmedBy: autor.id, confirmedAt: new Date(),
      patientsAffected: 0,
    },
  })
  log(`Listo en ${sede.name}, semana del ${semana.startDate.toISOString().slice(0, 10)}:`)
  log(`  ${liliana.name}: 30 h de atención${tarea ? ' + 6 h de backoffice' : ' (no hay tarea de backoffice activa)'}`)
  log(`  ${jhon.name}: 24 h de atención y 1 ausencia imprevista hace 20 días`)
}

try {
  if (process.argv.includes('--limpiar')) await limpiar()
  else await crear()
} finally {
  await prisma.$disconnect()
}
