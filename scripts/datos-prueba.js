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
// La convencion de la semana y los nombres de datos-masivos viven en un solo
// sitio: copiados, ya se desalinearon una vez (semanas que no arrancaban el lunes, como las de la app).
import {
  soloEnLocal, inicioDeSemana, semanaDeHoy, sumarDias, fecha, capacidad, NOMBRES_MASIVOS, completarImpacto,
  borrarReemplazosHuerfanos,
} from './lib/datos-comunes.js'

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

// Al elegir los "profesionales reales ocupados" se saltan los de prueba de
// los DOS guiones. Los de datos-masivos ordenan antes que algunos reales
// ("Dr. Joaquín..."), y sin esto este guion se los quedaria y los dos se
// pisarian las ausencias.
const NO_SON_REALES = [...RECURSOS_PRUEBA, ...NOMBRES_MASIVOS]

// Las que se avisan con tiempo: en la lista deben salir como "Programada".
const TIPOS_PROGRAMADOS = new Set(['vacaciones', 'academico', 'licencia_remunerada', 'licencia_no_remunerada'])

soloEnLocal()

const log = (...a) => console.log(...a)
const linea = () => log('-'.repeat(78))

/**
 * Los recursos que este guion toca: los tres de prueba que crea, mas los
 * profesionales reales que usa como "ocupados". Se calcula igual al crear y
 * al limpiar, para que la limpieza no se lleve nada ajeno.
 */
async function recursosQueToca() {
  const pru = await prisma.resource.findMany({ where: { name: { in: RECURSOS_PRUEBA } }, select: { id: true } })
  const ofts = await prisma.resource.findMany({
    where: { type: 'oftalmologo', active: true, name: { notIn: NO_SON_REALES } },
    orderBy: { name: 'asc' }, take: 2, select: { id: true },
  })
  const opts = await prisma.resource.findMany({
    where: { type: 'optometra', active: true, name: { notIn: NO_SON_REALES } },
    orderBy: { name: 'asc' }, take: 1, select: { id: true },
  })
  return [...pru, ...ofts, ...opts].map((r) => r.id)
}

// ============================================================== LIMPIEZA
async function limpiar() {
  const inicio = inicioDeSemana()
  const fin = sumarDias(inicio, 6)

  const semana = await semanaDeHoy()
  const recursosPru = await prisma.resource.findMany({ where: { name: { in: RECURSOS_PRUEBA } }, select: { id: true } })
  const idsPru = recursosPru.map((r) => r.id)
  // Oct-2026 · Solo lo que este guion toca.
  //
  // Antes borraba TODAS las asignaciones de la semana en curso. Mientras el
  // guion inventaba su propia semana eso era inofensivo, pero ahora reutiliza
  // la semana real del sistema: arrasar con ella se llevaria por delante la
  // programacion de verdad. Se borra solo lo de los recursos que usa.
  const idsTocados = await recursosQueToca()

  log(`Semana en curso   : ${fecha(inicio)} → ${fecha(fin)} ${semana ? '(existe, se reutiliza)' : '(no existe, se creará)'}`)
  log(`Recursos de prueba: ${idsPru.length}  ·  recursos que toca: ${idsTocados.length}`)

  const ausencias = await prisma.absence.count({
    where: { resourceId: { in: idsTocados }, startDate: { gte: inicio, lte: fin } },
  })
  const asignaciones = semana
    ? await prisma.assignment.count({ where: { weekId: semana.id, resourceId: { in: idsTocados } } })
    : 0
  const usuarios = await prisma.user.count({ where: { email: { endsWith: '@' + DOMINIO } } })

  log(`Ausencias a borrar: ${ausencias}  (solo de esos recursos, solo de esta semana)`)
  log(`Asignaciones      : ${asignaciones}  (solo de esos recursos)`)
  log(`Usuarios de prueba: ${usuarios}`)

  if (!APLICAR) { log('\nCORRIDA EN SECO. Para borrar: npm run datos:prueba -- --limpiar --aplicar'); return }

  // Orden: lo que apunta a otras cosas primero.
  await prisma.absence.deleteMany({
    where: { resourceId: { in: idsTocados }, startDate: { gte: inicio, lte: fin } },
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
  // Las de los profesionales reales que el guion usa como "ocupados": solo
  // las de esta semana, y solo de ellos. La semana NO se borra: ahora es la
  // real del sistema y puede tener programacion que no es de este guion.
  if (semana) {
    await prisma.assignment.deleteMany({
      where: { weekId: semana.id, resourceId: { in: idsTocados } },
    })
    const quedan = await prisma.assignment.count({ where: { weekId: semana.id } })
    log(`  La semana se conserva; le quedan ${quedan} asignacion(es) que no son de este guion.`)
  }
  // Los reemplazos que se crearon a mano para cubrir las ausencias borradas.
  const sueltos = await borrarReemplazosHuerfanos()
  if (sueltos) log(`  ${sueltos} reemplazo(s) de ausencias borradas, eliminados.`)
  await prisma.resource.deleteMany({ where: { id: { in: idsPru } } })
  await prisma.userSite.deleteMany({ where: { user: { is: { email: { endsWith: '@' + DOMINIO } } } } })

  // La auditoria de lo que hicieron los usuarios de prueba apunta a ellos por
  // clave foranea, asi que borrarlos sin mas falla con P2003. No se borra el
  // rastro: se le quita el autor, que para eso `usuario_id` acepta NULL desde
  // la correccion de oct-2026. La accion ocurrio y la fila se queda.
  const deDominio = await prisma.user.findMany({
    where: { email: { endsWith: '@' + DOMINIO } },
    select: { id: true },
  })
  if (deDominio.length) {
    const sueltos = await prisma.auditEntry.updateMany({
      where: { userId: { in: deDominio.map((u) => u.id) } },
      data: { userId: null },
    })
    if (sueltos.count) log(`  ${sueltos.count} entrada(s) de auditoria quedan sin autor (el usuario de prueba se va).`)
  }

  await prisma.user.deleteMany({ where: { email: { endsWith: '@' + DOMINIO } } })

  log('\nLIMPIO. La semana en curso y todo lo marcado se borraron.')
}

// ============================================================== CREACION
async function crear() {
  // `let` porque se reancla a la semana real en cuanto se resuelve: los días
  // de las ausencias se cuentan desde aquí, y si no coincidieran con el
  // arranque de la semana caerían fuera de ella.
  let lunes = inicioDeSemana()
  let domingo = sumarDias(lunes, 6)
  log(`Semana en curso: ${fecha(lunes)} → ${fecha(domingo)}  (lunes a domingo, como la usa el sistema)`)

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

  // Sin las de datos-masivos: si este guion tomara una de esas, la limpieza
  // del otro borraría los turnos de este al llevarse a su auxiliar.
  const auxiliares = await prisma.resource.findMany({
    where: { type: 'auxiliar', active: true, name: { notIn: NO_SON_REALES } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
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
  // Se reutiliza la semana REAL si ya existe. Crear una propia dejaba dos
  // semanas solapadas: los turnos iban a la del guion y el sistema buscaba en
  // la suya, asi que los casos salian sin franjas.
  let semana = await semanaDeHoy()
  if (!semana) {
    semana = await prisma.week.create({
      data: { startDate: lunes, endDate: domingo, status: 'abierta' },
    })
    log('  (no existía la semana, se creó)')
  } else {
    log(`  (se reutiliza la semana que ya existía: ${fecha(semana.startDate)} → ${fecha(semana.endDate)})`)
  }
  // Los días de las ausencias se cuentan desde el arranque REAL de la semana.
  lunes = new Date(semana.startDate)
  domingo = new Date(semana.endDate)

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
    where: { type: 'oftalmologo', active: true, name: { notIn: NO_SON_REALES } },
    orderBy: { name: 'asc' },
  })
  const optometras = await prisma.resource.findMany({
    where: { type: 'optometra', active: true, name: { notIn: NO_SON_REALES } },
    orderBy: { name: 'asc' },
  })
  if (oftalmologos.length < 2 || optometras.length < 1) { log('Faltan profesionales base.'); return }

  const [oft1, oft2] = oftalmologos
  const [opt1] = optometras

  // Oct-2026 · La auxiliar de cada turno se elige LIBRE en esa hora y en esa
  // ciudad. Antes era siempre `auxiliares[0]` para todos los turnos, y el
  // guion dejaba a Lina Torres el lunes de 07:00 a 13:00 en Santa Marta Y en
  // Barranquilla a la vez. El sistema rechazaba con razón cualquier reemplazo
  // que la tocara, y parecía que el botón Asignar estaba roto.
  const ciudadDeSede = new Map(sedes.map((s) => [s.id, s.city]))
  const agendaAux = new Map()   // "auxId|dia" -> { ciudad, franjas: [[ini, fin]] }
  const auxLibre = (weekday, ini, fin, ciudad) => auxiliares.find((x) => {
    const ag = agendaAux.get(x.id + '|' + weekday)
    if (!ag) return true
    if (ag.ciudad !== ciudad) return false   // nadie está en dos ciudades el mismo día
    return !ag.franjas.some(([a, b]) => !(fin <= a || ini >= b))
  }) ?? null

  const asignar = (recurso, room, weekday, startTime, endTime, extra = {}) => {
    const ciudad = ciudadDeSede.get(room.siteId)
    const aux = 'assistantId' in extra ? null : auxLibre(weekday, startTime, endTime, ciudad)
    if (aux) {
      const k = aux.id + '|' + weekday
      if (!agendaAux.has(k)) agendaAux.set(k, { ciudad, franjas: [] })
      agendaAux.get(k).franjas.push([startTime, endTime])
    }
    return prisma.assignment.create({
    data: {
      weekId: semana.id,
      resourceId: recurso.id,
      roomId: room.id,
      weekday,
      startTime,
      endTime,
      patientCapacity: capacidad(startTime, endTime, recurso.slotMinutes),
      status: 'activa',
      assistantId: aux?.id ?? null,
      ...extra,
    },
    select: { id: true },
    })
  }

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
  //
  // Oct-2026 · Era el Dr. Martínez (oft2), que ese mismo lunes trabaja en
  // Santa Marta por la mañana: quedaba en dos ciudades el mismo día, algo que
  // el sistema prohíbe (RN-09). Se usa a un candidato libre que ese lunes no
  // tiene nada fuera de Barranquilla.
  await asignar(libres[1], oftalBq, 'lunes', '14:00', '16:00')

  // --------------------------------------------------------- ausencias
  // Oct-2026 · El dia se resuelve POR NOMBRE, no contando desde el inicio.
  //
  // Antes era `sumarDias(lunes, dia)`, que daba por hecho que la semana
  // arrancaba en lunes. Cuando se corrigio a domingo —que es como las usa la
  // aplicacion— todas las ausencias se corrieron un dia y dejaron de caer
  // sobre los turnos: los casos salian sin franjas y sin pacientes, y por
  // tanto desaparecian de la lista de trabajo.
  //
  // Los turnos se crean por nombre ('lunes', 'miercoles'), asi que las
  // ausencias tambien. El indice 0 sigue siendo lunes, como en las llamadas.
  const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
  const DESDE_LUNES = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
  const fechaDelDia = (indiceDesdeLunes) => {
    const buscado = DESDE_LUNES[indiceDesdeLunes]
    for (let i = 0; i < 7; i++) {
      const d = sumarDias(lunes, i)
      if (NOMBRES_DIA[d.getUTCDay()] === buscado) return d
    }
    return sumarDias(lunes, indiceDesdeLunes)   // no deberia ocurrir
  }

  const nueva = (recurso, dia, opciones = {}) => {
    const d = fechaDelDia(dia)
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
        // Oct-2026 · Antes 0 días de aviso para todas, y en la lista salía un
        // congreso o unas vacaciones como "0 d · Imprevista", que no puede ser:
        // esas se avisan con tiempo. Más de 15 días = programada (regla del
        // sistema).
        isPlanned: TIPOS_PROGRAMADOS.has(opciones.type),
        noticeDays: TIPOS_PROGRAMADOS.has(opciones.type) ? 21 : 0,
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
      // Los pacientes de la agenda caída (Oct-2026): con la capacidad del que
      // cubre salían 33 reprogramados de una agenda de 16, y el servidor ya no
      // deja que un reemplazo tome más pacientes de los que faltan.
      patientCapacity: capacidad('07:00', '13:00', oft2.slotMinutes),
      status: 'activa',
      isReplacement: true,
      coveredAbsenceId: a3.id,
      assistantId: auxiliares[1]?.id ?? null,
    },
  })

  // Oct-2026 · PRIMERO CUBRIR, DESPUÉS REPARTIR (decisión de Hector). Un caso
  // repartido sin nada cubierto ya no es un estado posible: el servidor lo
  // rechaza. Los casos 4 y 5 se cubren antes con la Dra. Olivares, que esa
  // mañana está libre en el mismo consultorio — así el reprogramador sabe qué
  // decirle al paciente: "misma hora, lo atiende la Dra. Olivares".
  const cubrirConOlivares = (ausencia, dia) => asignar(libres[2], optoBq, dia, '07:00', '13:00', {
    isReplacement: true,
    coveredAbsenceId: ausencia.id,
    // Los pacientes del reemplazo son los de la agenda que se cayó: el
    // paciente conserva su hora. Igual que hace el servidor.
    patientCapacity: capacidad('07:00', '13:00', opt1.slotMinutes),
  })

  // 4 · Ya ASIGNADA a un reprogramador.
  const a4 = await nueva(opt1, 1, {
    type: 'vacaciones',
    reason: 'Caso ya entregado a un reprogramador.',
    agendaAction: 'reprogramada',
    reschedulerId: repros[0].id,
    rescheduleStatus: 'asignada',
    rescheduleNotes: 'Mover los pacientes al jueves en la tarde. Avisar al coordinador.',
    patients: 36,
  })
  await cubrirConOlivares(a4, 'martes')

  // 5 · Ya RESUELTA: el final de la cadena.
  const a5 = await nueva(opt1, 3, {
    type: 'academico',
    reason: 'Caso cerrado por el reprogramador.',
    agendaAction: 'reprogramada',
    reschedulerId: repros[1].id,
    rescheduleStatus: 'resuelta',
    rescheduleNotes: 'Reubicados los 36 pacientes.',
    rescheduleDoneAt: new Date(),
    patients: 36,
  })
  await cubrirConOlivares(a5, 'jueves')

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

  // ─────────────────────────────────────────────────────────────────────
  // Los pacientes impactados salen de la agenda, no de un numero a mano.
  //
  // Antes cada bloque traia su cifra escrita (33, 36, 12) y no tenia por que
  // coincidir con la capacidad de los turnos que se caian. Despues se cuadraba
  // con un calculo propio, que tampoco era el de la aplicacion: sin costo de
  // oportunidad ni detalle por dia, y las parciales contadas por turno entero.
  // Oct-2026 · Ahora se usa el mismo calculo que la aplicacion.
  const delaSemana = await prisma.absence.findMany({
    where: { startDate: { lte: domingo }, endDate: { gte: lunes } },
    select: { id: true },
  })
  const cuadradas = await completarImpacto(delaSemana.map((a) => a.id))
  log(`\n  ${cuadradas} ausencia(s) con pacientes y costo calculados como en la aplicación.`)

  linea()
  log('LISTO. Entra con gerencia@cofca.co / ' + PASS)
  log('')
  log('  Programador → semana en curso (' + fecha(lunes) + ')')
  log('     lunes   · ' + sedeBq.name + ' / ' + oftalBq.name + '  → ' + oft1.name + ' en ROJO')
  log('                y debajo, APILADA, la casilla de ' + libres[1].name + ' de la tarde')
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
  if (LIMPIAR) { await limpiar(); return }

  // Oct-2026 · Se limpia SIEMPRE antes de crear.
  //
  // Sin esto el guion no era idempotente: correrlo dos veces dejaba las
  // ausencias y las asignaciones por duplicado. Se vio en pantalla —dos
  // tarjetas identicas del mismo profesional, y la segunda sin franjas porque
  // la primera se las habia llevado todas— y costo un rato entender que el
  // problema no era la pantalla sino los datos.
  //
  // Correrlo de nuevo tiene que dejar el mismo resultado que la primera vez.
  if (APLICAR) {
    log('\nPrimero se borra lo de la corrida anterior, para no duplicar.')
    await limpiar()
    linea()
  }
  await crear()
}

main()
  .catch((e) => { console.error('\nFALLO:'); console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
