/**
 * ESCENARIOS DE PRUEBA PARA EL MODULO DE AUSENCIAS Y REPROGRAMACION
 * =================================================================
 *
 * La base de desarrollo es demasiado flaca para probar el modulo: no existe la
 * semana en curso, hay 4-5 profesionales por tipo y los bloques de 07:00 a
 * 19:00 los dejan a todos ocupados, asi que "Buscar reemplazo" nunca encuentra
 * candidatos y la pantalla parece rota cuando en realidad esta bien.
 *
 * Esto monta la semana actual con casos reales de cada situacion que hay que
 * verificar, y se puede deshacer entero.
 *
 * SOLO LOCAL. Aborta si DATABASE_URL no apunta a localhost: estos datos son
 * inventados y no tienen nada que hacer en produccion.
 *
 * Todo lo que crea queda marcado para poder borrarlo sin tocar lo demas:
 *   · usuarios y recursos nuevos      -> los nombres de RECURSOS_PRUEBA / USUARIOS_PRUEBA
 *   · asignaciones y ausencias        -> viven en la semana en curso
 *
 * USO
 *   npm run datos:prueba                     # seco, dice que va a crear
 *   npm run datos:prueba -- --aplicar        # crea los escenarios
 *   npm run datos:prueba -- --limpiar --aplicar   # borra todo lo que creo
 */
import bcrypt from 'bcrypt'
import { prisma } from '../src/lib/prisma.js'

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const LIMPIAR = args.includes('--limpiar')

// Los nombres que crea este script. Se listan aqui para poder borrarlos sin
// marcarlos con un prefijo visible: Hector pidio nombres reales porque el
// 'PRU ·' se colaba en cada captura y en cada desplegable.
const RECURSOS_PRUEBA = ['Dra. Marcela Suárez', 'Dr. Andrés Camargo', 'Dra. Paula Olivares']
const USUARIOS_PRUEBA = ['Luisa Fernanda Movilla', 'Andrés Felipe Barraza']
const DOMINIO = 'prueba.local'
const PASS = 'Admin123'

// ---------------------------------------------------------------- guardarrail
const url = process.env.DATABASE_URL ?? ''
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('')
  console.error('ABORTADO — DATABASE_URL no apunta a localhost.')
  console.error('Estos datos son inventados y no van a produccion.')
  console.error('')
  process.exit(1)
}

const log = (...a) => console.log(...a)
const linea = () => log('-'.repeat(78))

/** Lunes de la semana que contiene a `hoy`, a medianoche UTC (como las guarda Prisma). */
function lunesDeEstaSemana(hoy = new Date()) {
  const d = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()))
  const diaSemana = d.getUTCDay()            // 0 domingo … 6 sabado
  const retroceso = diaSemana === 0 ? 6 : diaSemana - 1
  d.setUTCDate(d.getUTCDate() - retroceso)
  return d
}
const sumarDias = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }
const fecha = (d) => new Date(d).toISOString().slice(0, 10)

/** Capacidad nominal de pacientes de un bloque, segun el intervalo del recurso. */
function capacidad(horaInicio, horaFin, intervaloMin) {
  const [h1, m1] = horaInicio.split(':').map(Number)
  const [h2, m2] = horaFin.split(':').map(Number)
  const minutos = (h2 * 60 + m2) - (h1 * 60 + m1) - 30   // media hora de almuerzo
  return Math.max(0, Math.floor(minutos / (intervaloMin || 10)))
}

// ============================================================== LIMPIEZA
async function limpiar() {
  const lunes = lunesDeEstaSemana()
  const domingo = sumarDias(lunes, 6)

  const semana = await prisma.week.findFirst({ where: { startDate: lunes } })
  const recursosPru = await prisma.resource.findMany({ where: { name: { in: RECURSOS_PRUEBA } }, select: { id: true } })
  const idsPru = recursosPru.map((r) => r.id)

  log(`Semana en curso   : ${fecha(lunes)} → ${fecha(domingo)} ${semana ? '(existe)' : '(no existe)'}`)
  log(`Recursos de prueba: ${idsPru.length}`)

  const ausencias = await prisma.absence.count({
    where: { OR: [{ resourceId: { in: idsPru } }, { startDate: { gte: lunes, lte: domingo } }] },
  })
  const asignaciones = semana ? await prisma.assignment.count({ where: { weekId: semana.id } }) : 0
  const usuarios = await prisma.user.count({ where: { email: { endsWith: '@' + DOMINIO } } })

  log(`Ausencias a borrar: ${ausencias}`)
  log(`Asignaciones      : ${asignaciones}  (todas las de la semana en curso)`)
  log(`Usuarios de prueba: ${usuarios}`)

  if (!APLICAR) { log('\nCORRIDA EN SECO. Para borrar: npm run datos:prueba -- --limpiar --aplicar'); return }

  // Orden: lo que apunta a otras cosas primero.
  await prisma.absence.deleteMany({
    where: { OR: [{ resourceId: { in: idsPru } }, { startDate: { gte: lunes, lte: domingo } }] },
  })
  // Las asignaciones de los recursos de prueba van en CUALQUIER semana, no
  // solo en la de ahora: alcanza con que una prueba manual deje una suelta en
  // otra semana para que la clave foranea impida borrar el recurso.
  await prisma.assignment.deleteMany({
    where: {
      OR: [
        { resourceId: { in: idsPru } },
        { assistantId: { in: idsPru } },
        { assistant2Id: { in: idsPru } },
      ],
    },
  })
  if (semana) {
    await prisma.assignment.deleteMany({ where: { weekId: semana.id } })
    await prisma.weekSiteClosure.deleteMany({ where: { weekId: semana.id } })
    await prisma.week.delete({ where: { id: semana.id } })
  }
  await prisma.resource.deleteMany({ where: { id: { in: idsPru } } })
  await prisma.userSite.deleteMany({ where: { user: { is: { email: { endsWith: '@' + DOMINIO } } } } })
  await prisma.user.deleteMany({ where: { email: { endsWith: '@' + DOMINIO } } })

  log('\nLIMPIO. La semana en curso y todo lo marcado se borraron.')
}

// ============================================================== CREACION
async function crear() {
  const lunes = lunesDeEstaSemana()
  const domingo = sumarDias(lunes, 6)
  log(`Semana en curso: ${fecha(lunes)} → ${fecha(domingo)}`)

  const sedes = await prisma.site.findMany({
    where: { active: true },
    include: { rooms: { where: { active: true } } },
    orderBy: { name: 'asc' },
  })
  const sedeBq = sedes.find((s) => s.name.includes('Sede 1 Barranquilla')) ?? sedes[0]
  const sedeSm = sedes.find((s) => s.name.includes('Santa Marta')) ?? sedes[1] ?? sedes[0]
  const oftalBq = sedeBq.rooms.find((r) => r.specialty === 'oftalmologia')
  const optoBq = sedeBq.rooms.find((r) => r.specialty === 'optometria')
  const oftalSm = sedeSm.rooms.find((r) => r.specialty === 'oftalmologia')

  if (!oftalBq || !optoBq || !oftalSm) {
    log('\nNo encuentro consultorios suficientes. Reviso: oftalmologia y optometria en 2 sedes.')
    return
  }

  const motivos = await prisma.absenceReason.findMany({ select: { id: true, code: true, name: true } })
  const motivoPorCodigo = Object.fromEntries(motivos.map((m) => [m.code, m]))

  const auxiliares = await prisma.resource.findMany({ where: { type: 'auxiliar', active: true }, select: { id: true, name: true } })
  const alguienQueReporta = await prisma.user.findFirst({ where: { role: 'gerencia', active: true }, select: { id: true } })

  log('')
  log('VA A CREAR')
  linea()
  log('  1 semana en curso, abierta')
  log('  2 usuarios con rol reprogramador     (repro1@/repro2@' + DOMINIO + ')')
  log('  3 profesionales libres               (para que "Cambiar de médico" encuentre candidatos)')
  log('  9 asignaciones en bloques de 6h      (dejan la tarde libre: así hay con quién reemplazar)')
  log('  7 ausencias cubriendo cada caso:')
  log('       · confirmada, remunerada, con candidatos libres')
  log('       · PENDIENTE (sale en rojo con "sin confirmar")')
  log('       · con REEMPLAZO ya cargado      (casilla índigo montada sobre la roja)')
  log('       · ya ASIGNADA a un reprogramador')
  log('       · ya RESUELTA')
  log('       · no remunerada                 (para ver el color en el cronograma)')
  log('       · PARCIAL solo la mañana        (la tarde del mismo día NO se cae)')
  log('  1 celda con dos médicos              (para ver las casillas apiladas)')
  log('  + activa los motivos del catálogo que estaban apagados')
  linea()

  if (!APLICAR) { log('\nCORRIDA EN SECO. Para crearlo: npm run datos:prueba -- --aplicar'); return }

  // ---------------------------------------------------------------- semana
  let semana = await prisma.week.findFirst({ where: { startDate: lunes } })
  if (!semana) {
    semana = await prisma.week.create({
      data: { startDate: lunes, endDate: domingo, status: 'abierta' },
    })
  }

  // ------------------------------------------------- motivos del catalogo
  // El desplegable del formulario salia con una sola opcion porque 20 de los
  // 23 motivos estaban inactivos.
  await prisma.absenceReason.updateMany({
    where: { code: { in: ['enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'licencia_remunerada', 'licencia_no_remunerada', 'no_presentacion'] } },
    data: { active: true },
  })

  // ------------------------------------------------------------- usuarios
  const hash = await bcrypt.hash(PASS, 12)
  const repros = []
  for (const [i, nombre] of USUARIOS_PRUEBA.entries()) {
    const email = `repro${i + 1}@${DOMINIO}`
    const u = await prisma.user.upsert({
      where: { email },
      update: { name: nombre, role: 'reprogramador', active: true },
      create: { email, name: nombre, role: 'reprogramador', active: true, passwordHash: hash },
      select: { id: true, name: true, email: true },
    })
    repros.push(u)
  }

  // ------------------------------------------------------------- recursos
  // Tres profesionales que NO se programan: son los candidatos que la pantalla
  // de reemplazo tiene que ofrecer. Sin ellos no hay nada que elegir.
  const libres = []
  for (const [nombre, tipo, esp] of [
    [RECURSOS_PRUEBA[0], 'oftalmologo', 'Retina'],
    [RECURSOS_PRUEBA[1], 'oftalmologo', 'Córnea'],
    [RECURSOS_PRUEBA[2], 'optometra', 'General'],
  ]) {
    const existente = await prisma.resource.findFirst({ where: { name: nombre } })
    const r = existente ?? await prisma.resource.create({
      data: { name: nombre, type: tipo, specialty: esp, active: true, payScheme: 'fijo', maxHoursPerWeek: 42, maxHoursPerDay: 10, slotMinutes: 10 },
    })
    libres.push(r)
  }

  // ----------------------------------------------------------- ocupados
  const oftalmologos = await prisma.resource.findMany({
    where: { type: 'oftalmologo', active: true, name: { notIn: RECURSOS_PRUEBA } },
    orderBy: { name: 'asc' },
  })
  const optometras = await prisma.resource.findMany({
    where: { type: 'optometra', active: true, name: { notIn: RECURSOS_PRUEBA } },
    orderBy: { name: 'asc' },
  })
  if (oftalmologos.length < 2 || optometras.length < 1) { log('Faltan profesionales base.'); return }

  const [oft1, oft2] = oftalmologos
  const [opt1] = optometras

  const asignar = (recurso, room, weekday, startTime, endTime, extra = {}) => prisma.assignment.create({
    data: {
      weekId: semana.id,
      resourceId: recurso.id,
      roomId: room.id,
      weekday,
      startTime,
      endTime,
      patientCapacity: capacidad(startTime, endTime, recurso.slotMinutes),
      status: 'activa',
      assistantId: auxiliares[0]?.id ?? null,
      ...extra,
    },
    select: { id: true },
  })

  // Bloques de 6h: la tarde queda libre y por eso hay candidatos de verdad.
  await asignar(oft1, oftalBq, 'lunes', '07:00', '13:00')
  await asignar(oft1, oftalBq, 'martes', '07:00', '13:00')
  await asignar(oft2, oftalSm, 'lunes', '07:00', '13:00')
  await asignar(oft2, oftalSm, 'miercoles', '07:00', '13:00')
  await asignar(opt1, optoBq, 'martes', '07:00', '13:00')
  await asignar(opt1, optoBq, 'jueves', '07:00', '13:00')

  // El grupo verde —"misma sede, no hay que mover a nadie"— se calcula desde
  // los turnos del MISMO DIA: alguien totalmente libre nunca cae ahi, porque sin
  // turno ese dia no hay sede con la que comparar. Asi que cada candidato queda
  // anclado en la tarde del dia de su caso, en esa misma sede. No solapa con la
  // franja caida (que es de manana) y por eso sale como candidato Y como verde.
  await asignar(libres[0], oftalBq, 'lunes', '16:30', '19:00')
  await asignar(libres[1], oftalSm, 'miercoles', '14:00', '19:00')
  await asignar(libres[2], optoBq, 'martes', '14:00', '19:00')

  // AUSENCIA PARCIAL: el mismo medico con turno de mañana Y de tarde el
  // viernes. La ausencia solo cubre la mañana, asi que la casilla de la tarde
  // tiene que seguir verde. Es el caso que Hector pregunto: 'si se ausenta
  // para la mañana pero no para la tarde, ¿que se debe mostrar?'.
  await asignar(oft1, oftalBq, 'viernes', '07:00', '11:00')
  await asignar(oft1, oftalBq, 'viernes', '14:00', '19:00')

  // CASILLAS APILADAS: dos profesionales en el mismo consultorio y dia. La
  // segunda se monta sobre la primera, que es lo que Hector quiere ver.
  await asignar(oft2, oftalBq, 'lunes', '14:00', '16:00')

  // --------------------------------------------------------- ausencias
  const nueva = (recurso, dia, opciones = {}) => {
    const d = sumarDias(lunes, dia)
    return prisma.absence.create({
      data: {
        resourceId: recurso.id,
        startDate: d,
        endDate: d,
        type: opciones.type ?? 'enfermedad',
        reasonId: motivoPorCodigo[opciones.type ?? 'enfermedad']?.id ?? null,
        reason: opciones.reason ?? null,
        status: opciones.status ?? 'confirmada',
        patientsAffected: opciones.patients ?? 33,
        agendaAction: opciones.agendaAction ?? null,
        reportedBy: alguienQueReporta?.id ?? null,
        isPartial: !!opciones.parcial,
        absenceStartTime: opciones.parcial?.desde ?? null,
        absenceEndTime: opciones.parcial?.hasta ?? null,
        isPlanned: false,
        noticeDays: 0,
        reschedulerId: opciones.reschedulerId ?? null,
        assignedBy: opciones.reschedulerId ? alguienQueReporta?.id ?? null : null,
        assignedAt: opciones.reschedulerId ? new Date() : null,
        rescheduleStatus: opciones.rescheduleStatus ?? null,
        rescheduleNotes: opciones.rescheduleNotes ?? null,
        rescheduleDoneAt: opciones.rescheduleDoneAt ?? null,
      },
      select: { id: true },
    })
  }

  // 1 · Confirmada con candidatos libres — el caso principal.
  const a1 = await nueva(oft1, 0, { reason: 'Incapacidad de un día. Hay dos oftalmólogos libres esa tarde.' })

  // 2 · PENDIENTE: la casilla sale roja con "(sin confirmar)".
  await nueva(oft1, 1, { status: 'pendiente', type: 'calamidad', reason: 'Sin confirmar todavía.', patients: 33 })

  // 3 · Con REEMPLAZO ya cargado: roja + índigo montada encima.
  const a3 = await nueva(oft2, 2, { reason: 'Ya tiene reemplazo cargado: mira la casilla índigo.' })
  await prisma.assignment.create({
    data: {
      weekId: semana.id,
      resourceId: libres[0].id,
      roomId: oftalSm.id,
      weekday: 'miercoles',
      startTime: '07:00',
      endTime: '13:00',
      patientCapacity: capacidad('07:00', '13:00', libres[0].slotMinutes),
      status: 'activa',
      isReplacement: true,
      coveredAbsenceId: a3.id,
      assistantId: auxiliares[1]?.id ?? null,
    },
  })

  // 4 · Ya ASIGNADA a un reprogramador.
  await nueva(opt1, 1, {
    type: 'vacaciones',
    reason: 'Caso ya entregado a un reprogramador.',
    agendaAction: 'reprogramada',
    reschedulerId: repros[0].id,
    rescheduleStatus: 'asignada',
    rescheduleNotes: 'Mover los pacientes al jueves en la tarde. Avisar al coordinador.',
    patients: 36,
  })

  // 5 · Ya RESUELTA: el final de la cadena.
  await nueva(opt1, 3, {
    type: 'academico',
    reason: 'Caso cerrado por el reprogramador.',
    agendaAction: 'reprogramada',
    reschedulerId: repros[1].id,
    rescheduleStatus: 'resuelta',
    rescheduleNotes: 'Reubicados los 36 pacientes.',
    rescheduleDoneAt: new Date(),
    patients: 36,
  })

  // 7 · PARCIAL: solo la mañana. La tarde NO se cae.
  await nueva(oft1, 4, {
    type: 'enfermedad',
    reason: 'Cita médica en la mañana. Por la tarde atiende normal.',
    patients: 12,
    parcial: { desde: '07:00', hasta: '11:00' },
  })

  // 6 · NO REMUNERADA: para ver el otro color en el cronograma.
  await nueva(oft2, 0, {
    type: 'licencia_no_remunerada',
    reason: 'Permiso sin goce de sueldo.',
    patients: 33,
  })

  linea()
  log('LISTO. Entra con gerencia@cofca.co / ' + PASS)
  log('')
  log('  Programador → semana en curso (' + fecha(lunes) + ')')
  log('     lunes   · ' + sedeBq.name + ' / ' + oftalBq.name + '  → ' + oft1.name + ' en ROJO')
  log('                y debajo, APILADA, la casilla de ' + oft2.name + ' de la tarde')
  log('     miercoles · ' + sedeSm.name + ' / ' + oftalSm.name + ' → ROJA + INDIGO encima')
  log('')
  log('  Gestión de ausencias → Profesionales: 6 casos, uno de cada situación')
  log('  Reprogramadores para el desplegable: ' + repros.map((r) => r.name).join(', '))
  log('  Candidatos libres para reemplazo   : ' + libres.map((r) => r.name).join(', '))
  log('')
  log('  Ausencia principal (la del lunes): ' + a1.id)
  log('')
  log('  Para borrar todo: npm run datos:prueba -- --limpiar --aplicar')
  linea()
}

async function main() {
  linea()
  log(LIMPIAR ? 'DATOS DE PRUEBA — LIMPIEZA' : 'DATOS DE PRUEBA — ESCENARIOS DE AUSENCIAS Y REPROGRAMACION')
  log(APLICAR ? 'MODO: APLICAR' : 'MODO: CORRIDA EN SECO')
  linea()
  if (LIMPIAR) await limpiar()
  else await crear()
}

main()
  .catch((e) => { console.error('\nFALLO:'); console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
