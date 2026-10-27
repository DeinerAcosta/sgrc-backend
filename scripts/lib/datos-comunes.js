// Lo que comparten los guiones de datos de prueba (datos-prueba.js y
// datos-masivos.js).
//
// Oct-2026 · Vive en un solo sitio a proposito. La convencion de la semana
// estuvo copiada y se desalineo: un guion creaba semanas que no arrancaban el
// mismo dia que las de la aplicacion (lunes a domingo), y los casos salian sin
// turnos. Lo mismo con las listas de nombres: si un guion no sabe que
// recursos son del otro, los toma como "profesionales reales" y se pisan.
import { prisma } from '../../src/lib/prisma.js'
import { calcularImpacto } from '../../src/services/absenceService.js'
import { lunesDeLaSemana } from '../../src/lib/semana.js'

// ---------------------------------------------------------------- guardarrail
/**
 * Aborta si la base no es local. Estos datos son inventados: nombres,
 * ausencias, llamadas. No tienen nada que hacer en produccion.
 */
export function soloEnLocal() {
  const url = process.env.DATABASE_URL ?? ''
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.error('')
    console.error('ABORTADO — DATABASE_URL no apunta a localhost.')
    console.error('Estos datos son inventados y no van a produccion.')
    console.error('')
    process.exit(1)
  }
}

// --------------------------------------------------------------------- fechas
export const sumarDias = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }
export const fecha = (d) => new Date(d).toISOString().slice(0, 10)

/** Domingo..sabado, en el orden de getUTCDay(). */
export const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

/**
 * El lunes de la semana de hoy, en UTC.
 *
 * Oct-2026 · La aplicacion usa semanas de LUNES A DOMINGO: weekController las
 * crea con lib/semana.js y en produccion todas arrancan en lunes. Antes este
 * guion las montaba de domingo a sabado (el comentario decia que la app las
 * creaba asi, y no era cierto desde jul-2026): en local la semana salia
 * "18 oct – 24 oct" y "Mover la agenda" abria la semana anterior, vacia.
 */
export function inicioDeSemana(hoy = new Date()) {
  const dia = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`
  return lunesDeLaSemana(dia)
}

/**
 * La semana de hoy segun la aplicacion: la que arranca el lunes.
 *
 * Se busca por fecha de inicio EXACTA, como hace weekController, y no por "la
 * que contenga hoy": buscar por solape encontraba semanas mal alineadas que
 * habia dejado una version anterior de un guion, y las daba por buenas.
 */
export function semanaDeHoy() {
  return prisma.week.findFirst({ where: { startDate: inicioDeSemana() } })
}

/** La de hoy, o la crea si no existe. Nunca inventa otra convencion. */
export async function asegurarSemanaDeHoy() {
  const existente = await semanaDeHoy()
  if (existente) return { semana: existente, creada: false }
  const ini = inicioDeSemana()
  const semana = await prisma.week.create({
    data: { startDate: ini, endDate: sumarDias(ini, 6), status: 'abierta' },
  })
  return { semana, creada: true }
}

/** La fecha de un dia de la semana, por nombre. No depende de en que dia arranque. */
export function fechaDelDia(semana, nombreDia) {
  for (let i = 0; i < 7; i++) {
    const d = sumarDias(semana.startDate, i)
    if (NOMBRES_DIA[d.getUTCDay()] === nombreDia) return d
  }
  throw new Error(`El dia ${nombreDia} no cae dentro de la semana ${fecha(semana.startDate)}`)
}

/** Capacidad nominal de pacientes de un bloque, segun el intervalo del recurso. */
export function capacidad(horaInicio, horaFin, intervaloMin) {
  const [h1, m1] = horaInicio.split(':').map(Number)
  const [h2, m2] = horaFin.split(':').map(Number)
  const minutos = (h2 * 60 + m2) - (h1 * 60 + m1) - 30   // media hora de almuerzo
  return Math.max(0, Math.floor(minutos / (intervaloMin || 10)))
}

/** ¿Se pisan dos franjas? Las horas son "HH:mm" de ancho fijo. */
export const solapan = (a1, a2, b1, b2) => !(a2 <= b1 || a1 >= b2)

// ------------------------------------------------------------------- nombres
/**
 * Los recursos que crea datos-masivos.js. Nombres inventados y distintivos.
 *
 * datos-prueba.js los EXCLUYE al elegir sus "profesionales reales ocupados":
 * los toma por orden alfabetico, y un "Dr. Joaquin..." creado aqui ordena
 * antes que los reales y se lo quedaria.
 */
export const RECURSOS_MASIVOS = [
  // nombre, tipo, especialidad, intervalo en minutos
  ['Dr. Joaquín Ortega Lemus', 'oftalmologo', 'Retina y vítreo', 15],
  ['Dra. Isabela Montoya Paz', 'oftalmologo', 'Córnea y refractiva', 15],
  ['Dr. Rafael Benítez Ariza', 'oftalmologo', 'Glaucoma', 15],
  ['Dra. Natalia Cuéllar Ibáñez', 'oftalmologo', 'Segmento anterior', 12],
  ['Dr. Emilio Rangel Saucedo', 'oftalmologo', 'Oculoplastia', 20],
  ['Dra. Carolina Villamizar Ochoa', 'oftalmologo', 'Oftalmopediatría', 15],
  ['Dr. Gustavo Lizcano Durán', 'oftalmologo', 'Oftalmopediatría', 15],
  ['Dra. Paola Echeverri Galvis', 'oftalmologo', 'Oftalmología general', 12],
  ['Dra. Mariana Cortés Rubio', 'optometra', 'Lentes de contacto', 20],
  ['Dr. Sebastián Quintero Vega', 'optometra', 'Baja visión', 20],
  ['Dra. Ximena Sierra Pardo', 'optometra', 'General', 15],
  ['Dr. Nicolás Barragán Torres', 'optometra', 'General', 15],
  ['Dra. Juliana Ospina Carmona', 'optometra', 'Ortóptica', 20],
  ['Dr. Mauricio Peña Albarracín', 'optometra', 'General', 15],
  ['Dr. Ricardo Salcedo Vargas', 'anestesiologo', 'Anestesiología', 30],
  ['Dra. Adriana Arango Restrepo', 'anestesiologo', 'Anestesiología', 30],
  ['Tec. Wilmer Cárdenas', 'tecnico', 'Métodos diagnósticos', 15],
  ['Tec. Yuliana Ballesteros', 'tecnico', 'Métodos diagnósticos', 15],
  ['Tec. Ferney Ospino', 'tecnico', 'Métodos diagnósticos', 15],
  ['Tec. Katherine Mercado', 'tecnico', 'Métodos diagnósticos', 15],
  ['Leidy Johana Romero', 'auxiliar', null, null],
  ['Yeimy Carolina Bolaño', 'auxiliar', null, null],
  ['Mayerlis Ortiz Fruto', 'auxiliar', null, null],
  ['Dayana Paola Lascarro', 'auxiliar', null, null],
  ['Kelly Johana Polo', 'auxiliar', null, null],
  ['Estefany Guerrero Rada', 'auxiliar', null, null],
  ['Liliana Charris Mejía', 'asesor_servicios', null, null],
  ['Jhon Fredy Cantillo', 'asesor_servicios', null, null],
]
export const NOMBRES_MASIVOS = RECURSOS_MASIVOS.map(([n]) => n)

/** Dominio de los usuarios de datos-masivos. Distinto del de datos-prueba a
 *  proposito: la limpieza de uno borra los usuarios de su dominio y no debe
 *  llevarse los del otro. */
export const DOMINIO_MASIVO = 'demo.local'

// ------------------------------------------------------------------ impacto
/**
 * Pacientes, costo de oportunidad y detalle por día con el MISMO cálculo que
 * hace la aplicación al registrar una ausencia (calcularImpacto).
 *
 * Oct-2026 · Los guiones escribían las ausencias directo en la base con un
 * número de pacientes propio y sin costo. Hector vio una ausencia con "Costo
 * de oportunidad" y otra sin él, y no había razón de negocio: una la había
 * registrado él desde la pantalla y la otra el guion. Las rechazadas no se
 * tocan (la aplicación tampoco les calcula impacto).
 */
export async function completarImpacto(ids) {
  const ausencias = await prisma.absence.findMany({
    where: { id: { in: ids }, status: { not: 'rechazada' } },
    include: { resource: true, reasonRef: true },
  })
  for (const a of ausencias) {
    const imp = await calcularImpacto(prisma, a)
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
  return ausencias.length
}

// ------------------------------------------------------- reemplazos huérfanos
/**
 * Borra los reemplazos que cubren ausencias que ya no existen, y sus
 * ejecuciones.
 *
 * Oct-2026 · Al regenerar, los guiones borraban sus ausencias pero no los
 * reemplazos que alguien había creado a mano para cubrirlas durante las
 * pruebas. Quedaban sueltos y ocupaban a la auxiliar: la revisión de datos
 * marcaba a Alba Tete "en dos turnos a la vez" por un reemplazo de una
 * ausencia borrada el día anterior. Solo corre en local (lo llaman los
 * guiones de datos, que abortan fuera de localhost).
 */
export async function borrarReemplazosHuerfanos() {
  const reemplazos = await prisma.assignment.findMany({
    where: { coveredAbsenceId: { not: null } },
    select: { id: true, coveredAbsenceId: true },
  })
  const ids = [...new Set(reemplazos.map((r) => r.coveredAbsenceId))]
  const existen = new Set((await prisma.absence.findMany({
    where: { id: { in: ids } }, select: { id: true },
  })).map((a) => a.id))
  const huerfanos = reemplazos.filter((r) => !existen.has(r.coveredAbsenceId)).map((r) => r.id)
  // Y los que quedaron sin enlace: al borrar una ausencia, la base pone
  // `ausencia_cubierta_id` en NULL y el turno sigue marcado como reemplazo de
  // nada. Solo en la semana en curso, para no tocar historial viejo.
  const semana = await prisma.week.findFirst({ where: { startDate: inicioDeSemana() }, select: { id: true } })
  if (semana) {
    const sinEnlace = await prisma.assignment.findMany({
      where: { weekId: semana.id, isReplacement: true, coveredAbsenceId: null },
      select: { id: true },
    })
    huerfanos.push(...sinEnlace.map((r) => r.id))
  }
  if (huerfanos.length) {
    await prisma.execution.deleteMany({ where: { assignmentId: { in: huerfanos } } })
    await prisma.assignment.deleteMany({ where: { id: { in: huerfanos } } })
  }
  return huerfanos.length
}
