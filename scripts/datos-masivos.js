/**
 * DATOS MASIVOS PARA PROBAR TODOS LOS PERFILES
 * ============================================
 *
 * Oct-2026 · Hector: "crea un data random de varios dentro de todos los
 * perfiles para hacer la prueba desde gerencia hasta los repro".
 *
 * datos-prueba.js monta siete casos hechos a mano, uno de cada situación: sirve
 * para ver cada pantalla una vez. Este guion monta VOLUMEN — una semana con
 * movimiento real en las siete sedes — para probar cómo se ve cada perfil
 * cuando tiene trabajo de verdad:
 *
 *   gerencia      ve todo
 *   la líder      tiene casos sin repartir y casos ya repartidos
 *   coordinadores cada uno con lo de su sede; las tres sedes que no tenían
 *                 coordinador reciben uno
 *   reprogramad.  cuatro, con cargas distintas: uno lleno, uno a medias, uno
 *                 con poco y uno SIN NADA (para ver la pantalla vacía)
 *   recursos      dos profesionales con cuenta propia, para ver "Mi horario"
 *
 * Aleatorio pero REPETIBLE: la misma semilla da los mismos datos, así que un
 * fallo que veas se puede volver a montar igual. Otra semilla, otro reparto:
 *
 *   npm run datos:masivos                      corrida en seco (no escribe)
 *   npm run datos:masivos -- --aplicar         crea (limpia antes lo suyo)
 *   npm run datos:masivos -- --aplicar --semilla=7
 *   npm run datos:masivos -- --limpiar --aplicar
 *
 * Convive con datos-prueba.js: usuarios en otro dominio (@demo.local) y
 * recursos con nombres propios, así que la limpieza de uno no toca al otro.
 * Respeta los consultorios que ya están ocupados en la semana.
 *
 * Solo corre contra una base local.
 */
import bcrypt from 'bcrypt'
import { prisma } from '../src/lib/prisma.js'
import { esProgramada } from '../src/lib/anticipacion.js'
import {
  soloEnLocal, semanaDeHoy, asegurarSemanaDeHoy, inicioDeSemana, fechaDelDia, sumarDias,
  fecha, capacidad, solapan, RECURSOS_MASIVOS, NOMBRES_MASIVOS, DOMINIO_MASIVO, completarImpacto,
  borrarReemplazosHuerfanos,
} from './lib/datos-comunes.js'

soloEnLocal()

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const LIMPIAR = args.includes('--limpiar')
const SEMILLA = Number(args.find((a) => a.startsWith('--semilla='))?.split('=')[1] ?? 42)
const PASS = 'Admin123'
const API = 'http://localhost:3001/api'

const log = (...a) => console.log(...a)
const linea = () => log('-'.repeat(78))

// ================================================================== AZAR
// mulberry32: pequeño, rápido y repetible. Math.random no se puede sembrar, y
// sin semilla un fallo que aparece una vez no se vuelve a montar nunca.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const azar = mulberry32(SEMILLA)
const entre = (a, b) => a + Math.floor(azar() * (b - a + 1))
const elegir = (arr) => arr[Math.floor(azar() * arr.length)]
const barajar = (arr) => {
  const c = [...arr]
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [c[i], c[j]] = [c[j], c[i]] }
  return c
}
/** [[valor, peso], ...] → un valor, con probabilidad proporcional al peso. */
const ponderado = (opciones) => {
  const total = opciones.reduce((n, [, p]) => n + p, 0)
  let r = azar() * total
  for (const [v, p] of opciones) { r -= p; if (r <= 0) return v }
  return opciones[opciones.length - 1][0]
}

// ================================================================ ELENCO
// Reprogramadores: quienes RECIBEN los encargos. Pesos distintos a propósito,
// para que el indicador de cada uno se vea diferente. Santiago queda en cero:
// así se prueba la pantalla vacía sin tener que vaciar a nadie.
const REPROGRAMADORES = [
  ['Valentina Rojas Medina', 'valentina.rojas', 6],
  ['Camilo Herrera Fuentes', 'camilo.herrera', 4],
  ['Daniela Pérez Cabrales', 'daniela.perez', 2],
  ['Santiago Mejía Vélez', 'santiago.mejia', 0],
]

// Las tres sedes que hoy no tienen coordinador. Sin esto, sus técnicos y
// auxiliares no serían "de" nadie y no se podría probar ese perfil allí.
const COORDINADORES_NUEVOS = [
  ['Laura Gómez Pinedo', 'coord.riohacha', 'Sede Riohacha'],
  ['Diana Ruiz Navarro', 'coord.sabanalarga', 'Sede Sabanalarga'],
  ['Felipe Castro Daza', 'coord.valledupar', 'Sede Valledupar'],
]

// Dos recursos con cuenta propia, para probar el perfil "recurso".
const RECURSOS_CON_CUENTA = [
  ['Dr. Joaquín Ortega Lemus', 'joaquin.ortega'],
  ['Tec. Wilmer Cárdenas', 'wilmer.cardenas'],
]

const ESPECIALIDAD_DE_TIPO = {
  oftalmologo: 'oftalmologia', optometra: 'optometria',
  anestesiologo: 'anestesiologia', tecnico: 'diagnostico',
}
// Mismo criterio que TIPOS_PROFESIONALES del servidor: de estos responde la
// líder; de los demás, el coordinador de la sede.
const PROFESIONALES = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'otorrino', 'fonoaudiologa'])
// Mismo criterio que TIPOS_QUE_IMPACTAN_PACIENTES: auxiliares y asesores no
// tienen agenda propia, así que su ausencia no deja pacientes sin atender.
const IMPACTAN = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'otorrino', 'fonoaudiologa', 'tecnico'])

const BLOQUES = { manana: ['07:00', '13:00'], tarde: ['13:00', '19:00'] }
const DIAS_LABORALES = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']

const TIPOS = [
  // tipo, peso, ¿programada?, motivo
  ['enfermedad', 28, false, ['Incapacidad por enfermedad general', 'Incapacidad por cirugía ambulatoria', 'Cuadro viral, incapacidad de un día']],
  ['calamidad', 9, false, ['Calamidad doméstica', 'Fallecimiento de un familiar']],
  ['academico', 12, true, ['Congreso de oftalmología', 'Curso de actualización en retina', 'Simposio de glaucoma']],
  ['familiar', 9, false, ['Cita médica de un hijo', 'Acompañamiento a familiar en cirugía']],
  ['vacaciones', 16, true, ['Vacaciones programadas', 'Vacaciones colectivas de fin de año']],
  ['licencia_remunerada', 8, true, ['Licencia por matrimonio', 'Licencia de paternidad']],
  ['licencia_no_remunerada', 8, true, ['Licencia no remunerada por asunto personal']],
  ['no_presentacion', 6, false, ['No se presentó y no avisó', 'No se presentó; se intentó contactar sin respuesta']],
  ['otra', 4, false, ['Diligencia personal inaplazable']],
]

// Lo que la líder le escribe a quien recibe el encargo.
const INDICACIONES = [
  'Mover los pacientes al jueves en la tarde.',
  'Priorizar postoperatorios y controles de retina.',
  'Llamar primero a los de primera vez; los controles pueden esperar a la próxima semana.',
  'Si no contestan en dos intentos, dejar mensaje y marcarlos como no contestó.',
  'Confirmar con el coordinador de la sede antes de dar la nueva hora.',
  'Ofrecerles la misma hora con el profesional que cubre; si no aceptan, reprogramar.',
  'Pacientes de cirugía: confirmar ayuno y hora nueva en la misma llamada.',
  null, // a veces la líder no deja indicación
]

// ============================================================== LIMPIEZA
/**
 * Borra SOLO lo de este guion: los recursos de RECURSOS_MASIVOS, los usuarios
 * @demo.local y todo lo que cuelga de ellos. Nunca borra semanas.
 *
 * El orden lo dicta el esquema: lo que tiene clave foránea con borrado
 * restringido va primero (ejecuciones antes que asignaciones, reemplazos antes
 * que ausencias, auditoría antes que usuarios).
 */
async function limpiar() {
  const recursos = await prisma.resource.findMany({ where: { name: { in: NOMBRES_MASIVOS } }, select: { id: true } })
  const idsR = recursos.map((r) => r.id)
  const usuarios = await prisma.user.findMany({ where: { email: { endsWith: '@' + DOMINIO_MASIVO } }, select: { id: true } })
  const idsU = usuarios.map((u) => u.id)
  const idsA = (await prisma.absence.findMany({ where: { resourceId: { in: idsR } }, select: { id: true } })).map((a) => a.id)
  const idsS = (await prisma.assignment.findMany({
    where: {
      OR: [
        { resourceId: { in: idsR } }, { assistantId: { in: idsR } }, { assistant2Id: { in: idsR } },
        // Reemplazos que alguien cargó a mano sobre un caso de prueba: también son de prueba.
        { coveredAbsenceId: { in: idsA } },
      ],
    },
    select: { id: true },
  })).map((x) => x.id)

  // Casos REALES que durante las pruebas se le asignaron a un reprogramador de
  // este guion. No se borran —no son nuestros—, pero no pueden quedar
  // apuntando a un usuario que desaparece.
  const realesConDemo = await prisma.absence.count({
    where: { resourceId: { notIn: idsR }, OR: [{ reschedulerId: { in: idsU } }, { assignedBy: { in: idsU } }] },
  })

  log(`Recursos de este guion : ${idsR.length}`)
  log(`Usuarios @${DOMINIO_MASIVO}     : ${idsU.length}`)
  log(`Ausencias              : ${idsA.length}`)
  log(`Asignaciones           : ${idsS.length}`)
  if (realesConDemo) log(`Casos REALES asignados a un usuario de prueba: ${realesConDemo} (se les quita la asignación, no se borran)`)

  if (!APLICAR) return

  await prisma.execution.deleteMany({ where: { assignmentId: { in: idsS } } })
  await prisma.assignment.deleteMany({ where: { id: { in: idsS } } })
  await prisma.backofficeAssignment.deleteMany({
    where: { OR: [{ sourceAbsenceId: { in: idsA } }, { assistantId: { in: idsR } }] },
  })
  await prisma.absence.deleteMany({ where: { id: { in: idsA } } })   // las reposiciones caen en cascada
  // Los reemplazos que se crearon a mano para cubrir esas ausencias.
  const sueltos = await borrarReemplazosHuerfanos()
  if (sueltos) log(`  ${sueltos} reemplazo(s) de ausencias borradas, eliminados.`)

  if (realesConDemo) {
    // Una asignada sin dueño no tiene sentido: vuelve a "sin asignar". Una ya
    // resuelta conserva su estado; solo pierde el nombre de quien la llevó.
    await prisma.absence.updateMany({
      where: { resourceId: { notIn: idsR }, reschedulerId: { in: idsU }, rescheduleStatus: 'asignada' },
      data: { reschedulerId: null, assignedBy: null, assignedAt: null, rescheduleStatus: null },
    })
    await prisma.absence.updateMany({ where: { resourceId: { notIn: idsR }, reschedulerId: { in: idsU } }, data: { reschedulerId: null } })
    await prisma.absence.updateMany({ where: { resourceId: { notIn: idsR }, assignedBy: { in: idsU } }, data: { assignedBy: null } })
  }

  await prisma.resourceRequest.deleteMany({ where: { OR: [{ requesterId: { in: idsU } }, { resourceId: { in: idsR } }] } })
  await prisma.resourceRequest.updateMany({ where: { decidedById: { in: idsU } }, data: { decidedById: null } })
  await prisma.absenceMakeup.deleteMany({ where: { requestedBy: { in: idsU } } })
  await prisma.absenceMakeup.updateMany({ where: { approvedBy: { in: idsU } }, data: { approvedBy: null } })
  await prisma.site.updateMany({ where: { managerId: { in: idsU } }, data: { managerId: null } })
  await prisma.assignment.updateMany({ where: { authorizedById: { in: idsU } }, data: { authorizedById: null } })
  // La auditoría no se borra: se le quita el autor. La acción ocurrió.
  await prisma.auditEntry.updateMany({ where: { userId: { in: idsU } }, data: { userId: null } })
  await prisma.user.deleteMany({ where: { id: { in: idsU } } })   // sedes, avisos y claves caen en cascada
  await prisma.resource.deleteMany({ where: { id: { in: idsR } } })
  log('  Limpio.')
}

// ================================================================== PLAN
/**
 * Todas las decisiones al azar se toman aquí, en memoria, sin escribir nada.
 * La corrida en seco imprime este plan; --aplicar lo escribe tal cual.
 */
async function planear(semanaReal) {
  const semana = semanaReal ?? { id: null, startDate: inicioDeSemana(), endDate: sumarDias(inicioDeSemana(), 6) }

  const sedes = await prisma.site.findMany({
    where: { active: true },
    select: {
      id: true, name: true, city: true,
      rooms: { where: { active: true }, select: { id: true, name: true, specialty: true, requiresAssistant: true } },
    },
    orderBy: { name: 'asc' },
  })

  // Lo que ya ocupa cada consultorio esta semana, sin contar lo de este guion
  // (que se va a borrar). Así no se monta un turno encima de uno real.
  const previos = await prisma.resource.findMany({ where: { name: { in: NOMBRES_MASIVOS } }, select: { id: true } })
  const idsPrevios = previos.map((r) => r.id)
  const ocupados = semanaReal
    ? await prisma.assignment.findMany({
        where: {
          weekId: semanaReal.id, status: { not: 'cancelada' },
          resourceId: { notIn: idsPrevios },
          OR: [{ coveredAbsenceId: null }, { coveredAbsence: { is: { resourceId: { notIn: idsPrevios } } } }],
        },
        select: { roomId: true, weekday: true, startTime: true, endTime: true },
      })
    : []
  const salaOcupada = new Map()   // "salaId|dia" -> [[ini, fin], ...]
  const marcarSala = (salaId, dia, ini, fin) => {
    const k = salaId + '|' + dia
    if (!salaOcupada.has(k)) salaOcupada.set(k, [])
    salaOcupada.get(k).push([ini, fin])
  }
  const salaLibre = (salaId, dia, ini, fin) => !(salaOcupada.get(salaId + '|' + dia) ?? []).some(([a, b]) => solapan(a, b, ini, fin))
  for (const o of ocupados) marcarSala(o.roomId, o.weekday, o.startTime, o.endTime)

  // Coordinador de cada sede: los reales que ya existen y los nuevos.
  const reales = await prisma.userSite.findMany({
    where: { user: { is: { role: 'coordinador', active: true, email: { not: { endsWith: '@' + DOMINIO_MASIVO } } } } },
    select: { siteId: true, user: { select: { email: true } } },
  })
  const coordDeSede = new Map(reales.map((r) => [r.siteId, r.user.email]))
  const coordsNuevos = []
  for (const [nombre, correo, sedeNombre] of COORDINADORES_NUEVOS) {
    const sede = sedes.find((s) => s.name === sedeNombre)
    if (!sede) { log(`  (no existe "${sedeNombre}": no se crea ${nombre})`); continue }
    const email = `${correo}@${DOMINIO_MASIVO}`
    coordsNuevos.push({ nombre, email, sedeId: sede.id })
    if (!coordDeSede.has(sede.id)) coordDeSede.set(sede.id, email)
  }

  // ---------------------------------------------------- recursos y su sede
  const salasDe = (sede, especialidad) => sede.rooms.filter((r) => r.specialty === especialidad)
  const recursos = []
  const porTipo = {}
  for (const [nombre, tipo, especialidad, intervalo] of RECURSOS_MASIVOS) {
    (porTipo[tipo] ??= []).push({ nombre, tipo, especialidad, intervalo })
  }
  for (const [tipo, lista] of Object.entries(porTipo)) {
    const esp = ESPECIALIDAD_DE_TIPO[tipo]
    // Cada sede recibe tantos "cupos" como consultorios de la especialidad
    // tiene: las grandes concentran más gente. Repartir uno por sede dejaba a
    // casi todos sin un colega cerca, y entonces nadie podía cubrir a nadie.
    // Auxiliares: según los consultorios que piden auxiliar. Asesores: a
    // cualquiera.
    const cupos = barajar(sedes.flatMap((s) => {
      const n = esp ? salasDe(s, esp).length
        : tipo === 'auxiliar' ? s.rooms.filter((x) => x.requiresAssistant).length
          : 1
      return Array(n).fill(s)
    }))
    if (cupos.length === 0) continue
    lista.forEach((r, i) => recursos.push({ ...r, sede: cupos[i % cupos.length] }))
  }

  // ------------------------------------------------------------- agenda
  const ocupadoRecurso = new Set()   // "nombre|dia|bloque"
  const turnos = []
  const auxDeSede = (sede) => recursos.filter((r) => r.tipo === 'auxiliar' && r.sede.id === sede.id)

  for (const r of recursos) {
    const esp = ESPECIALIDAD_DE_TIPO[r.tipo]
    if (!esp) continue   // auxiliares y asesores no tienen consultorio propio
    const huecos = barajar(DIAS_LABORALES.flatMap((d) => [[d, 'manana'], [d, 'tarde']]))
    if (azar() < 0.3) huecos.push(['sabado', 'manana'])
    const cuantos = entre(3, 6)
    for (const [dia, bloque] of huecos) {
      if (turnos.filter((t) => t.recurso === r).length >= cuantos) break
      const [ini, fin] = BLOQUES[bloque]
      const sala = barajar(salasDe(r.sede, esp)).find((s) => salaLibre(s.id, dia, ini, fin))
      if (!sala) continue
      // Auxiliar, si el consultorio la pide y hay una libre en la sede.
      let auxiliar = null
      if (sala.requiresAssistant) {
        auxiliar = barajar(auxDeSede(r.sede)).find((a) => !ocupadoRecurso.has(`${a.nombre}|${dia}|${bloque}`)) ?? null
        if (auxiliar) ocupadoRecurso.add(`${auxiliar.nombre}|${dia}|${bloque}`)
      }
      marcarSala(sala.id, dia, ini, fin)
      ocupadoRecurso.add(`${r.nombre}|${dia}|${bloque}`)
      turnos.push({ recurso: r, sala, dia, bloque, ini, fin, pacientes: capacidad(ini, fin, r.intervalo), auxiliar })
    }
  }

  // ----------------------------------------------------------- ausencias
  const ausencias = []
  const ausenteEl = new Set()   // "nombre|dia": nadie cubre estando ausente
  const repartibles = REPROGRAMADORES.filter(([, , peso]) => peso > 0)

  // Los estados se reparten como un MAZO, no tirando el dado caso por caso.
  // Con quince o veinte ausencias, el dado deja estados en cero —salió una
  // semana sin ningún caso "terminado"— y entonces esa pantalla no se puede
  // probar. El mazo garantiza uno de cada; el resto sí va al azar.
  const ESTADOS_PROF = [
    ['pendiente', 12], ['sin_repartir', 18], ['sin_llamar', 16], ['llamando', 20],
    ['completa', 12], ['corregida', 10], ['resuelta', 8], ['rechazada', 4],
  ]
  const ESTADOS_TEC = [['pendiente', 25], ['coordinador', 50], ['resuelta_coord', 25]]
  const ESTADOS_APOYO = [['pendiente', 50], ['coordinador', 50]]
  const mazo = (opciones, n) => barajar([
    ...opciones.map(([v]) => v),
    ...Array.from({ length: Math.max(0, n - opciones.length) }, () => ponderado(opciones)),
  ])

  const conAusencia = recursos.filter((r) => {
    const prob = PROFESIONALES.has(r.tipo) ? 0.85 : r.tipo === 'tecnico' ? 0.75 : 0.55
    return azar() < prob
  })
  const cuantos = (f) => conAusencia.filter(f).length
  const mazoProf = mazo(ESTADOS_PROF, cuantos((r) => PROFESIONALES.has(r.tipo)))
  const mazoTec = mazo(ESTADOS_TEC, cuantos((r) => r.tipo === 'tecnico'))
  const mazoApoyo = mazo(ESTADOS_APOYO, cuantos((r) => !PROFESIONALES.has(r.tipo) && r.tipo !== 'tecnico'))

  for (const r of conAusencia) {
    const suyos = turnos.filter((t) => t.recurso === r)
    const comoAux = turnos.filter((t) => t.auxiliar === r)

    // El día: uno en que tenga turno, para que la ausencia tumbe algo de verdad.
    const dias = [...new Set((suyos.length ? suyos : comoAux).map((t) => t.dia))]
    const dia = dias.length ? elegir(dias) : elegir(DIAS_LABORALES)
    const delDia = suyos.filter((t) => t.dia === dia)

    // A veces solo falta por la mañana: la tarde de ese día sigue en pie.
    const tieneManana = delDia.some((t) => t.bloque === 'manana')
    const parcial = tieneManana && delDia.length > 1 && azar() < 0.5 ? BLOQUES.manana
      : tieneManana && azar() < 0.15 ? BLOQUES.manana : null
    const caidos = delDia.filter((t) => !parcial || solapan(parcial[0], parcial[1], t.ini, t.fin))

    const [tipo, , programada, motivos] = ponderado(TIPOS.map((t) => [t, t[1]]))
    const estimado = IMPACTAN.has(r.tipo) ? caidos.reduce((n, t) => n + t.pacientes, 0) : 0

    const estado = PROFESIONALES.has(r.tipo) ? mazoProf.pop()
      : r.tipo === 'tecnico' ? mazoTec.pop()
        : mazoApoyo.pop()

    ausenteEl.add(`${r.nombre}|${dia}`)
    ausencias.push({
      recurso: r, dia, parcial, caidos, tipo, programada, motivo: elegir(motivos),
      estimado, estado, repro: null, llamadas: null, oficial: null, indicacion: null, cubre: null,
    })
  }

  // ------------------------------------------- encargos y llamadas
  // Los encargos se reparten también como mazo, en proporción a los pesos:
  // así cada reprogramador con carga recibe al menos uno, y Santiago (peso
  // cero) se queda vacío a propósito.
  const aRepartir = ausencias.filter((a) => ['sin_llamar', 'llamando', 'completa', 'corregida', 'resuelta'].includes(a.estado))
  // Cuántos le tocan a cada uno se calcula EXACTO, no al azar: con ocho o
  // diez encargos el azar se come los pesos —salió una corrida en que la que
  // debía ir "llena" tenía menos que la de carga media—. Reparto proporcional
  // al peso por el método del mayor residuo, con un mínimo de uno para que
  // nadie con carga quede vacío. Lo que sí va al azar es QUÉ caso le cae.
  const n = aRepartir.length
  const pesoTotal = repartibles.reduce((s, r) => s + r[2], 0)
  const exactos = repartibles.map((r) => ({ r, x: n * r[2] / pesoTotal }))
  const cuota = new Map(exactos.map(({ r, x }) => [r, Math.floor(x)]))
  let faltan = n - [...cuota.values()].reduce((s, v) => s + v, 0)
  for (const { r } of [...exactos].sort((p, q) => (q.x % 1) - (p.x % 1))) {
    if (faltan-- <= 0) break
    cuota.set(r, cuota.get(r) + 1)
  }
  // Mínimo uno: se le quita al que más tiene.
  for (const r of repartibles) {
    if (n < repartibles.length || cuota.get(r) > 0) continue
    const mayor = [...cuota.entries()].sort((p, q) => q[1] - p[1])[0][0]
    cuota.set(mayor, cuota.get(mayor) - 1)
    cuota.set(r, 1)
  }
  // Uno por cabeza va al FONDO del mazo (pop() los saca primero) y los casos
  // abiertos se reparten antes que los terminados. Así quien tiene uno solo
  // lo tiene abierto: si le cayera el terminado, su lista por defecto saldría
  // vacía y parecería que no tiene nada.
  const primeros = barajar(repartibles.filter((r) => cuota.get(r) > 0))
  const demas = barajar(repartibles.flatMap((r) => Array(Math.max(0, cuota.get(r) - 1)).fill(r)))
  const mazoRepro = [...demas, ...primeros]
  aRepartir.sort((x, y) => Number(x.estado === 'resuelta') - Number(y.estado === 'resuelta'))

  for (const a of aRepartir) {
    a.repro = mazoRepro.pop()
    a.indicacion = elegir(INDICACIONES)
    // El número real: a veces quien llama descubre que eran más o menos.
    a.oficial = a.estado === 'corregida'
      ? Math.max(1, a.estimado + elegir([-6, -4, -3, -2, 2, 3, 5, 8]))
      : a.estimado
    const meta = a.oficial
    let llamados = 0
    if (a.estado === 'llamando') llamados = Math.max(1, Math.round(meta * entre(30, 80) / 100))
    if (['completa', 'resuelta'].includes(a.estado)) llamados = meta
    if (a.estado === 'corregida') llamados = azar() < 0.5 ? meta : Math.max(1, Math.round(meta * entre(40, 85) / 100))
    if (meta === 0) llamados = 0
    if (a.estado !== 'sin_llamar' && llamados > 0) {
      const contestaron = Math.round(llamados * entre(65, 93) / 100)
      a.llamadas = { contestaron, noContestaron: llamados - contestaron }
    }
  }

  // ---------------------------------------------------------- reemplazos
  // Un colega del mismo tipo y la misma ciudad recoge la agenda. Si está
  // libre en el mismo bloque, la toma tal cual (el paciente conserva su cita y
  // solo cambia de profesional); si no, en el otro bloque del día.
  let hayEnOtroBloque = false
  // PRIMERO CUBRIR, DESPUÉS REPARTIR (decisión de Hector, oct-2026): un caso
  // repartido tiene que tener algo cubierto, así que para esos el reemplazo no
  // va al azar. Los demás sí: así salen casos "por cubrir" y "por repartir".
  const REPARTIDOS = ['sin_llamar', 'llamando', 'completa', 'corregida', 'resuelta']
  for (const a of ausencias) {
    if (!PROFESIONALES.has(a.recurso.tipo) || a.caidos.length === 0) continue
    if (['pendiente', 'rechazada'].includes(a.estado)) continue
    const obligatorio = REPARTIDOS.includes(a.estado)
    if (!obligatorio && azar() > 0.5) continue

    const caido = a.caidos[0]
    // De la misma CIUDAD, no solo de la misma sede: Barranquilla tiene dos y
    // un colega de la otra puede cruzar. RN-09 pide una ciudad por día, no
    // una sede, así que es un reemplazo que el sistema acepta.
    const colegas = barajar(recursos.filter((c) =>
      c !== a.recurso && c.tipo === a.recurso.tipo && c.sede.city === a.recurso.sede.city &&
      !ausenteEl.has(`${c.nombre}|${a.dia}`)))

    // Dos maneras de cubrir, y conviene que salgan las dos porque la pantalla
    // de quien llama dice cosas distintas en cada caso:
    //   · mismo bloque y consultorio: la casilla del reemplazo se monta sobre
    //     la del ausente (así lo hace la aplicación) y el paciente conserva su
    //     cita — "solo cambia de profesional".
    //   · el otro bloque del día: hay que darle una hora nueva al paciente.
    const mismoBloque = () => {
      const c = colegas.find((x) => !ocupadoRecurso.has(`${x.nombre}|${a.dia}|${caido.bloque}`))
      return c && { recurso: c, sala: caido.sala, dia: a.dia, bloque: caido.bloque, ini: caido.ini, fin: caido.fin }
    }
    const otroBloque = () => {
      const otro = caido.bloque === 'manana' ? 'tarde' : 'manana'
      const [ini, fin] = BLOQUES[otro]
      const esp = ESPECIALIDAD_DE_TIPO[a.recurso.tipo]
      for (const c of colegas) {
        if (ocupadoRecurso.has(`${c.nombre}|${a.dia}|${otro}`)) continue
        // Primero un consultorio de la sede del ausente; si no hay, uno de la
        // sede del colega. Es real: al paciente lo mandan a la otra sede de la
        // misma ciudad, y quien llama tiene que decírselo.
        const sala = [...barajar(salasDe(a.recurso.sede, esp)), ...barajar(salasDe(c.sede, esp))]
          .find((s) => salaLibre(s.id, a.dia, ini, fin))
        if (!sala) continue
        marcarSala(sala.id, a.dia, ini, fin)
        return { recurso: c, sala, dia: a.dia, bloque: otro, ini, fin }
      }
      return null
    }
    // Último recurso: el propio médico recupera su agenda OTRO día, en un
    // bloque y un consultorio libres de su sede. Es "Mover la agenda → el
    // mismo profesional" de la pantalla del caso.
    const otroDia = () => {
      const esp = ESPECIALIDAD_DE_TIPO[a.recurso.tipo]
      for (const dia of barajar(DIAS_LABORALES.filter((d) => d !== a.dia))) {
        for (const bloque of ['manana', 'tarde']) {
          if (ocupadoRecurso.has(`${a.recurso.nombre}|${dia}|${bloque}`)) continue
          const [ini, fin] = BLOQUES[bloque]
          const sala = barajar(salasDe(a.recurso.sede, esp)).find((s) => salaLibre(s.id, dia, ini, fin))
          if (!sala) continue
          marcarSala(sala.id, dia, ini, fin)
          return { recurso: a.recurso, sala, dia, bloque, ini, fin }
        }
      }
      return null
    }

    // Mientras no haya uno en otro horario, se intenta primero así: si se deja
    // al azar, hay semillas que no producen ninguno y ese mensaje no se puede
    // probar. Después, al azar.
    const preferirOtro = !hayEnOtroBloque || azar() < 0.4
    const cubre = (preferirOtro ? (otroBloque() ?? mismoBloque()) : (mismoBloque() ?? otroBloque()))
      ?? (obligatorio ? otroDia() : null)
    if (cubre && cubre.bloque !== caido.bloque) hayEnOtroBloque = true
    if (cubre) {
      ocupadoRecurso.add(`${cubre.recurso.nombre}|${cubre.dia}|${cubre.bloque}`)
      // Los pacientes del reemplazo son los de la franja que se cayó: el
      // paciente conserva su turno. Es lo que hace el servidor al crear uno.
      cubre.pacientes = caido.pacientes
      a.cubre = cubre
    }
  }

  // Lo que no se pudo cubrir de ninguna forma no puede quedar repartido: el
  // servidor no lo permitiría. Vuelve a "sin repartir", que según tenga o no
  // algo cubierto saldrá como "por cubrir" o "por repartir".
  for (const a of ausencias) {
    if (!REPARTIDOS.includes(a.estado) || a.cubre) continue
    a.estado = 'sin_repartir'
    a.repro = null
    a.llamadas = null
    a.oficial = null
    a.indicacion = null
  }

  return { semana, sedes, recursos, turnos, ausencias, coordsNuevos, coordDeSede }
}

// ============================================================ RESUMEN
function imprimirPlan(p) {
  const cuenta = (f) => p.ausencias.filter(f).length
  log(`Semana         : ${fecha(p.semana.startDate)} → ${fecha(p.semana.endDate)}  (lunes a domingo)`)
  log(`Semilla        : ${SEMILLA}   (otra semilla, otro reparto: --semilla=7)`)
  log('')
  log(`Recursos       : ${p.recursos.length} en ${new Set(p.recursos.map((r) => r.sede.id)).size} sedes`)
  log(`Turnos         : ${p.turnos.length}  (${p.turnos.filter((t) => t.auxiliar).length} con auxiliar)`)
  log(`Ausencias      : ${p.ausencias.length}  (${cuenta((a) => a.parcial)} parciales de solo la mañana)`)
  log(`Reemplazos     : ${cuenta((a) => a.cubre)}  (${cuenta((a) => a.cubre && a.cubre.dia === a.dia && a.cubre.bloque === a.caidos[0]?.bloque)} en el mismo horario)`)
  log('')
  log('Estado de las ausencias de profesionales (de la líder):')
  for (const [k, txt] of [
    ['pendiente', 'por confirmar'], ['sin_repartir', 'confirmadas, sin repartir'], ['sin_llamar', 'repartidas, sin llamar'],
    ['llamando', 'repartidas, llamando'], ['completa', 'llamadas completas'], ['corregida', 'con pacientes reales corregidos'],
    ['resuelta', 'terminadas'], ['rechazada', 'rechazadas'],
  ]) log(`   ${String(cuenta((a) => a.estado === k)).padStart(3)}  ${txt}`)
  log('Técnicos, auxiliares y asesores (de los coordinadores):')
  log(`   ${String(cuenta((a) => !PROFESIONALES.has(a.recurso.tipo) && a.estado === 'pendiente')).padStart(3)}  por confirmar`)
  log(`   ${String(cuenta((a) => a.estado === 'coordinador')).padStart(3)}  confirmadas`)
  log(`   ${String(cuenta((a) => a.estado === 'resuelta_coord')).padStart(3)}  terminadas`)
}

// ============================================================== CREAR
async function crear() {
  const real = await semanaDeHoy()
  const plan = await planear(real)
  imprimirPlan(plan)

  if (!APLICAR) {
    linea()
    log('CORRIDA EN SECO. Para crearlo:  npm run datos:masivos -- --aplicar')
    return
  }

  linea()
  log('Primero se borra lo de la corrida anterior, para no duplicar.')
  await limpiar()
  linea()

  const { semana } = await asegurarSemanaDeHoy()
  const hash = await bcrypt.hash(PASS, 12)

  // La líder: quien reparte. Si no está, cualquier supervisor.
  const lider = await prisma.user.findFirst({ where: { email: 'duarte@cofca.co' }, select: { id: true, name: true } })
    ?? await prisma.user.findFirst({ where: { role: 'supervisor', active: true }, select: { id: true, name: true } })

  // ------------------------------------------------------------- usuarios
  const idDeCorreo = new Map()
  for (const [nombre, correo] of REPROGRAMADORES) {
    const u = await prisma.user.create({
      data: { name: nombre, email: `${correo}@${DOMINIO_MASIVO}`, role: 'reprogramador', active: true, passwordHash: hash },
      select: { id: true, email: true },
    })
    idDeCorreo.set(u.email, u.id)
  }
  for (const c of plan.coordsNuevos) {
    const u = await prisma.user.create({
      data: { name: c.nombre, email: c.email, role: 'coordinador', active: true, passwordHash: hash },
      select: { id: true, email: true },
    })
    await prisma.userSite.create({ data: { userId: u.id, siteId: c.sedeId } })
    idDeCorreo.set(u.email, u.id)
  }
  const reales = await prisma.user.findMany({
    where: { email: { in: [...plan.coordDeSede.values()] } }, select: { id: true, email: true },
  })
  for (const u of reales) idDeCorreo.set(u.email, u.id)
  const coordIdDeSede = (sedeId) => idDeCorreo.get(plan.coordDeSede.get(sedeId)) ?? null

  // ------------------------------------------------------------- recursos
  const idDeRecurso = new Map()
  for (const r of plan.recursos) {
    const creado = await prisma.resource.create({
      data: {
        name: r.nombre, type: r.tipo, specialty: r.especialidad, active: true,
        payScheme: PROFESIONALES.has(r.tipo) ? 'por_paciente' : 'fijo',
        maxHoursPerWeek: 42, maxHoursPerDay: 10, slotMinutes: r.intervalo,
        // Auxiliares y asesores no tienen consultorio: es su coordinador líder
        // el que los hace "de la sede" para el coordinador.
        leadCoordinatorId: ESPECIALIDAD_DE_TIPO[r.tipo] ? null : coordIdDeSede(r.sede.id),
      },
      select: { id: true },
    })
    idDeRecurso.set(r, creado.id)
  }
  for (const [nombre, correo] of RECURSOS_CON_CUENTA) {
    const r = plan.recursos.find((x) => x.nombre === nombre)
    if (!r) continue
    const u = await prisma.user.create({
      data: {
        name: nombre.replace(/^(Dr\.|Dra\.|Tec\.)\s*/, ''), email: `${correo}@${DOMINIO_MASIVO}`,
        role: 'recurso', active: true, passwordHash: hash, resourceId: idDeRecurso.get(r),
      },
      select: { id: true, email: true },
    })
    await prisma.userSite.create({ data: { userId: u.id, siteId: r.sede.id } })
    idDeCorreo.set(u.email, u.id)
  }

  // --------------------------------------------------------------- turnos
  for (const t of plan.turnos) {
    await prisma.assignment.create({
      data: {
        weekId: semana.id, resourceId: idDeRecurso.get(t.recurso), roomId: t.sala.id,
        weekday: t.dia, startTime: t.ini, endTime: t.fin, patientCapacity: t.pacientes,
        status: 'activa', assistantId: t.auxiliar ? idDeRecurso.get(t.auxiliar) : null,
      },
    })
  }

  // ------------------------------------------------------------ ausencias
  const ahora = Date.now()
  const horasAtras = (h) => new Date(ahora - h * 3600 * 1000)
  const creadas = []
  for (const a of plan.ausencias) {
    const d = fechaDelDia(semana, a.dia)
    const coordId = coordIdDeSede(a.recurso.sede.id)
    const reporta = coordId ?? lider?.id
    const aviso = a.programada ? entre(16, 40) : entre(0, 8)
    const asignadaHace = entre(6, 72)
    const estadoAusencia = a.estado === 'pendiente' ? 'pendiente' : a.estado === 'rechazada' ? 'rechazada' : 'confirmada'
    const repartida = !!a.repro
    const terminada = ['resuelta', 'resuelta_coord'].includes(a.estado)

    const aus = await prisma.absence.create({
      data: {
        resourceId: idDeRecurso.get(a.recurso),
        startDate: d, endDate: d,
        isPartial: !!a.parcial,
        absenceStartTime: a.parcial?.[0] ?? null,
        absenceEndTime: a.parcial?.[1] ?? null,
        type: a.tipo, reason: a.motivo,
        isPlanned: esProgramada(aviso), noticeDays: aviso,
        status: estadoAusencia,
        patientsAffected: a.estimado,
        recordedByCoordinator: !!coordId,
        reportedBy: reporta,
        reportedAt: horasAtras(asignadaHace + aviso * 24),
        reschedulerId: repartida ? idDeCorreo.get(`${a.repro[1]}@${DOMINIO_MASIVO}`) : null,
        assignedBy: repartida ? lider?.id ?? null : null,
        assignedAt: repartida ? horasAtras(asignadaHace) : null,
        rescheduleStatus: terminada ? 'resuelta' : repartida ? 'asignada' : null,
        rescheduleNotes: repartida ? a.indicacion : null,
        rescheduleDoneAt: terminada ? horasAtras(entre(1, Math.max(1, asignadaHace - 1))) : null,
        patientsReached: a.llamadas?.contestaron ?? null,
        patientsNoAnswer: a.llamadas?.noContestaron ?? null,
        callLogAt: a.llamadas ? horasAtras(entre(1, Math.max(1, asignadaHace - 1))) : null,
        patientsConfirmed: a.estado === 'corregida' ? a.oficial : null,
      },
      select: { id: true },
    })
    creadas.push(aus.id)

    if (a.cubre) {
      await prisma.assignment.create({
        data: {
          weekId: semana.id, resourceId: idDeRecurso.get(a.cubre.recurso), roomId: a.cubre.sala.id,
          weekday: a.cubre.dia, startTime: a.cubre.ini, endTime: a.cubre.fin,
          patientCapacity: a.cubre.pacientes, status: 'activa',
          isReplacement: true, coveredAbsenceId: aus.id,
        },
      })
    }
  }

  // Pacientes, costo y detalle por día como los calcula la aplicación.
  const conImpacto = await completarImpacto(creadas)
  log(`Impacto calculado como en la aplicación en ${conImpacto} ausencia(s).`)

  linea()
  log('CREADO.')
  await comprobarPerfiles(plan)
}

// ========================================================= COMPROBACIÓN
/**
 * Entra con cada cuenta por la API y cuenta lo que DE VERDAD ve. No lo que el
 * plan dice que debería ver: si el servidor reparte distinto, aquí se nota.
 */
async function comprobarPerfiles(plan) {
  linea()
  log('QUIÉN VE QUÉ   (entrando de verdad con cada cuenta · clave Admin123)')
  linea()

  const vivo = await fetch(API + '/weeks').then(() => true).catch(() => false)
  if (!vivo) {
    log('  El backend no responde en el puerto 3001: no se puede comprobar.')
    log('  Levántalo y vuelve a correr con --aplicar, o entra a mano.')
    return
  }

  const entrar = async (email) => {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASS }),
    }).catch(() => null)
    return r?.ok ? (await r.json()).token : null
  }
  const pedir = async (t, ruta) => {
    const r = await fetch(API + ruta, { headers: { Authorization: 'Bearer ' + t } }).catch(() => null)
    return r?.ok ? r.json() : null
  }
  const linea2 = (correo, rol, txt) => log(`  ${correo.padEnd(34)} ${rol.padEnd(14)} ${txt}`)

  const cuentas = [
    ['gerencia@cofca.co', 'gerencia'],
    ['duarte@cofca.co', 'líder'],
    ...[...new Set(plan.coordDeSede.values())].map((c) => [c, 'coordinador']),
    ...REPROGRAMADORES.map(([, c]) => [`${c}@${DOMINIO_MASIVO}`, 'reprogramador']),
    ...RECURSOS_CON_CUENTA.map(([, c]) => [`${c}@${DOMINIO_MASIVO}`, 'recurso']),
  ]

  let sinEntrar = 0
  for (const [correo, rol] of cuentas) {
    const t = await entrar(correo)
    if (!t) { linea2(correo, rol, 'NO ENTRA con Admin123'); sinEntrar++; continue }

    if (rol === 'recurso') {
      // Lo mismo que hace su pantalla: su recurso sale del token y el horario
      // de /resources/:id/schedule para la semana en curso.
      const rid = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).resourceId
      const semanas = await pedir(t, `/weeks?resource_id=${rid}`)
      const lw = Array.isArray(semanas) ? semanas : (semanas?.data ?? [])
      const hoy = new Date()
      const actual = lw.find((w) => new Date(w.start_date) <= hoy && hoy <= new Date(w.end_date))
      const horario = actual && rid ? await pedir(t, `/resources/${rid}/schedule?week_id=${actual.id}`) : null
      const turnos = Array.isArray(horario) ? horario : (horario?.asignaciones ?? horario?.data ?? [])
      linea2(correo, rol, !rid ? 'NO tiene recurso ligado'
        : turnos.length ? `ve su horario · ${turnos.length} turnos esta semana`
          : 'entra, pero su horario sale VACÍO')
      if (!rid || !turnos.length) sinEntrar++
      continue
    }
    if (rol === 'líder') {
      // Solo profesionales: los técnicos y auxiliares son de los coordinadores.
      const aus = await pedir(t, '/absences')
      const lista = (Array.isArray(aus) ? aus : (aus?.data ?? []))
        .filter((a) => PROFESIONALES.has(a.resource?.type) && a.status === 'confirmada')
      const sinRepartir = lista.filter((a) => !a.rescheduler_id && (a.patients_affected ?? 0) > 0).length
      const enCurso = lista.filter((a) => a.rescheduler_id && a.reschedule_status === 'asignada').length
      const terminadas = lista.filter((a) => a.reschedule_status === 'resuelta').length
      linea2(correo, rol, `${sinRepartir} por repartir · ${enCurso} repartidas en curso · ${terminadas} terminadas`)
      continue
    }
    const mio = await pedir(t, '/reschedules/mine')
    const n = mio?.casos?.length ?? 0
    if (rol === 'reprogramador') {
      const ll = mio?.resumen?.llamadas ?? {}
      const completas = (mio?.casos ?? []).filter((c) => c.llamadas?.completa).length
      const terminados = mio?.resumen?.cerrados ?? 0
      linea2(correo, rol, n === 0 && terminados === 0
        ? 'sin encargos (la pantalla vacía)'
        : `${n} abiertos · ${ll.llamados ?? 0}/${mio.resumen.pacientes_impactados} llamados · ${completas} completos` +
          (terminados ? ` · ${terminados} terminado${terminados > 1 ? 's' : ''}` : ''))
    } else {
      const tipos = [...new Set((mio?.casos ?? []).map((c) => c.resource?.type))].join(', ')
      linea2(correo, rol, `${n} casos${tipos ? ' · ' + tipos : ''}`)
    }
  }
  linea()
  log(sinEntrar === 0 ? 'Todas las cuentas entran y ven lo suyo.' : `${sinEntrar} cuenta(s) con problema: míralas arriba.`)
}

// ================================================================= MAIN
async function main() {
  linea()
  log(LIMPIAR ? 'DATOS MASIVOS — LIMPIEZA' : 'DATOS MASIVOS — TODOS LOS PERFILES')
  log(APLICAR ? 'MODO: APLICAR' : 'MODO: CORRIDA EN SECO')
  linea()
  if (LIMPIAR) {
    await limpiar()
    if (!APLICAR) log('\nCORRIDA EN SECO. Para borrar:  npm run datos:masivos -- --limpiar --aplicar')
    return
  }
  await crear()
}

main()
  .catch((e) => { console.error('\nFALLO:'); console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
