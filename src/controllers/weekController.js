import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { differenceInDays, addDays, startOfWeek } from 'date-fns'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { copiarAsignacionesValidadas } from '../services/assignmentCopyService.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { TIPOS_QUE_IMPACTAN_PACIENTES } from '../services/absenceService.js'

const crearSemanaSchema = z.object({
  startDate: z.string(), // YYYY-MM-DD
})

// RN-01 (jul-2026): anticipación mínima en días para crear una semana nueva.
// Antes eran 3 días; se relajó a 0 por decisión operativa — los coords deben
// poder programar la semana que arranca aunque queden pocos días o esté en
// curso. Solo bloqueamos crear semanas ya vencidas (dif < 0).
// Para restaurar la política estricta original: cambiar a 3.
const ANTICIPACION_MINIMA_DIAS = 0

export async function list(req, res) {
  const semanas = await prisma.week.findMany({ orderBy: { startDate: 'desc' }, take: 60 })
  res.json(semanas)
}

/** RN-01 relajada: puede crearse la semana actual o cualquier futura. */
export async function create(req, res) {
  const { startDate: fechaInicio } = crearSemanaSchema.parse(req.body)
  const inicio = new Date(fechaInicio)
  if (Number.isNaN(inicio.getTime())) throw errors.badRequest('Fecha inválida')
  // Semana operativa: LUNES → DOMINGO (fix jul-2026). weekStartsOn: 1 = lunes.
  // Antes era 0 (dom→sáb) pero el frontend siempre visualizó lun→dom,
  // generando desfase: las asignaciones con dia_semana='domingo' apuntaban
  // al domingo de INICIO de la semana en BD pero el coord esperaba el domingo
  // de FIN de semana en su UI. Con este cambio, dom queda como último día.
  const domingo = startOfWeek(inicio, { weekStartsOn: 1 })
  // Con programación libre se permiten semanas ya vencidas: es justo lo que
  // hace falta para cargar el mes pasado de forma retroactiva.
  const diff = differenceInDays(domingo, new Date())
  if (diff < ANTICIPACION_MINIMA_DIAS && !programacionLibre()) {
    const msg = ANTICIPACION_MINIMA_DIAS > 0
      ? `La programación debe crearse con al menos ${ANTICIPACION_MINIMA_DIAS} día(s) de anticipación`
      : 'No se pueden crear semanas ya vencidas'
    throw errors.badRequest(msg)
  }
  const fin = addDays(domingo, 6)
  const sem = await prisma.week.create({
    data: {
      startDate: domingo,
      endDate: fin,
      status: 'abierta',
    },
  })
  res.status(201).json(sem)
}

/**
 * Cierre de semana POR SEDE.
 *   - Coordinador: cierra automáticamente la sede en la que está trabajando
 *     (debe venir `sede_id` en el body, o se toma la primera de sus sedes).
 *   - Supervisor/gerencia: cierra cualquier sede pasando `sede_id` explícito.
 *
 * Cuando TODAS las sedes con asignaciones en esta semana tengan cierre, la
 * semana queda consolidada (`Semana.estado='cerrada'`).
 */
export async function cerrar(req, res) {
  const semanaId = req.params.id
  // Sep-2026 · FIX: esto leia `site_id` y siempre salia undefined. El middleware
  // snakeBodyToCamel (middleware/caseConverter.js, montado en index.js) convierte
  // TODO el body de snake_case a camelCase antes de llegar aca, asi que el
  // `site_id` que manda el frontend llega como `siteId`.
  //
  // Consecuencias que tenia: a supervisor y gerencia les respondia "Falta
  // sede_id en el cuerpo", y al coordinador le aplicaba el fallback de abajo y
  // le cerraba SIEMPRE su primera sede, aunque en el Programador tuviera
  // seleccionada otra. Eso ultimo es corrupcion de datos silenciosa.
  //
  // `copiar()` mas abajo ya leia bien `siteId`; era solo este.
  let { siteId: sede_id } = req.body ?? {}

  const semana = await prisma.week.findUnique({ where: { id: semanaId } })
  if (!semana) throw errors.notFound('Semana no encontrada')

  // Sep-28-2026 · SE QUITA EL FALLBACK A "LA PRIMERA SEDE DEL COORDINADOR".
  //
  // Era esto:
  //     if (!sede_id && req.user.role === 'coordinador') {
  //       const us = await prisma.userSite.findFirst({ where: { userId: req.user.id } })
  //       sede_id = us.siteId            // ← la primera que devuelva la BD
  //     }
  //
  // Adivinar la sede cuando el cliente no la manda es corrupcion de datos
  // silenciosa: la peticion responde 200, el cierre se crea, y queda cerrada
  // una sede que nadie pidio cerrar. Paso en produccion — una coordinadora con
  // 5 sedes tenia "Sede Galapa" en el selector y el sistema le cerro "Sede
  // Malambo", que es su sites[0]. Le llego una pestana con el bundle viejo (el
  // modal de cierre calculaba su propia sede), el body salio sin site_id y este
  // fallback remato el error en vez de frenarlo.
  //
  // Ahora falta sede = 400 explicito. Un cliente desactualizado recibe un error
  // que se ve, en vez de cerrar la sede equivocada sin que nadie se entere.
  // `findFirst` ademas no llevaba `orderBy`, asi que "la primera" era la que el
  // motor quisiera devolver: ni siquiera era predecible.
  if (!sede_id) {
    throw errors.badRequest(
      'Falta la sede a cerrar. Si el problema persiste, recarga la pagina con Ctrl+Shift+R: ' +
      'tu navegador puede tener una version antigua del programador.',
    )
  }

  // El coord solo puede cerrar sus propias sedes; supervisor/gerencia, cualquiera.
  if (req.user.role === 'coordinador') {
    const vinc = await prisma.userSite.findFirst({
      where: { userId: req.user.id, siteId: sede_id },
    })
    if (!vinc) throw errors.forbidden('No estás vinculado a esa sede')
  }

  // Idempotencia: si ya existe el cierre de esa sede para esta semana, devolverlo.
  const existente = await prisma.weekSiteClosure.findUnique({
    where: { weekId_siteId: { weekId: semanaId, siteId: sede_id } },
  })
  if (existente) {
    return res.json({ cierre: existente, week: semana, alreadyExisted: true })
  }

  // Crear el cierre por sede
  const cierre = await prisma.weekSiteClosure.create({
    data: { weekId: semanaId, siteId: sede_id, closedBy: req.user.id, closedAt: new Date() },
  })

  // Auditoría del cierre manual (fix jul-2026): antes NO se registraba y no
  // había forma de saber quién cerró la sede fuera de la propia tabla
  // CierreSemanaSede. Ahora queda en auditoria con la acción explícita.
  await registrarAuditoria({
    userId: req.user.id,
    action: 'cierre_semana_sede_manual',
    entity: 'cierre_semana_sede',
    entityId: cierre.id,
    newValue: {
      weekId: semanaId,
      siteId: sede_id,
      startWeek: semana.startDate,
      endWeek: semana.endDate,
      closedAt: cierre.closedAt,
    },
    ipAddress: getIp(req),
  })

  // Consolidar la semana si TODAS las sedes con asignaciones ya tienen su cierre.
  const sedeIdsConAsigs = await prisma.assignment.findMany({
    where: { weekId: semanaId, status: { not: 'cancelada' } },
    select: { room: { select: { siteId: true } } },
  }).then((rows) => [...new Set(rows.map((r) => r.room.siteId))])

  const cierres = await prisma.weekSiteClosure.findMany({
    where: { weekId: semanaId, siteId: { in: sedeIdsConAsigs } },
    select: { siteId: true },
  })
  const todasCerradas = sedeIdsConAsigs.every((sid) => cierres.some((c) => c.siteId === sid))

  let semanaActualizada = semana
  if (todasCerradas && semana.status === 'abierta') {
    semanaActualizada = await prisma.week.update({
      where: { id: semanaId },
      data: { status: 'cerrada', closedBy: req.user.id, closedAt: new Date() },
    })
    // Auditoría separada de la consolidación — evento distinto al cierre por
    // sede (puede ocurrir en la misma request si es la última sede que faltaba).
    await registrarAuditoria({
      userId: req.user.id,
      action: 'cierre_semana_consolidada',
      entity: 'semanas',
      entityId: semanaId,
      oldValue: { status: 'abierta' },
      newValue: { status: 'cerrada', sedesCerradas: sedeIdsConAsigs.length },
      ipAddress: getIp(req),
    })
  }

  res.json({ cierre, week: semanaActualizada, consolidated: todasCerradas })
}

/**
 * Estado de cierre por sede para una semana — útil para el frontend del coord
 * (muestra qué sedes ya cerraron y cuáles faltan).
 */
export async function estadoPorSede(req, res) {
  const semanaId = req.params.id
  const semana = await prisma.week.findUnique({ where: { id: semanaId } })
  if (!semana) throw errors.notFound('Semana no encontrada')

  // Sedes con asignaciones en esta semana
  const sedesConAsigs = await prisma.assignment.findMany({
    where: { weekId: semanaId, status: { not: 'cancelada' } },
    select: { room: { select: { site: { select: { id: true, name: true } } } } },
  })
  const mapSedes = new Map()
  for (const a of sedesConAsigs) {
    const s = a.room.site
    if (s) mapSedes.set(s.id, s)
  }

  const cierres = await prisma.weekSiteClosure.findMany({
    where: { weekId: semanaId, siteId: { in: [...mapSedes.keys()] } },
    include: { site: { select: { name: true } } },
  })
  const usuarios = await prisma.user.findMany({
    where: { id: { in: cierres.map((c) => c.closedBy).filter(Boolean) } },
    select: { id: true, name: true },
  })
  const usuarioMap = new Map(usuarios.map((u) => [u.id, u.name]))

  const filas = [...mapSedes.values()].map((sede) => {
    const c = cierres.find((x) => x.siteId === sede.id)
    return {
      site_id: sede.id,
      sede_nombre: sede.name,
      cerrada: !!c,
      closed_by: c?.closedBy ? usuarioMap.get(c.closedBy) ?? '?' : (c ? 'Sistema' : null),
      closed_at: c?.closedAt ?? null,
    }
  })

  res.json({ week: semana, sites: filas, consolidated: semana.status === 'cerrada' })
}

/**
 * RN-03: copiar semana anterior — duplica todas las asignaciones.
 *
 * SCOPE POR SEDE (fix incidente jun-2026):
 *   - Coordinador: REQUIERE `sedeId` (o `sedeIds[]`) y SOLO afecta esas sedes.
 *     Las asignaciones de OTRAS sedes en esa semana quedan intactas.
 *   - Supervisor/gerencia: si manda `sedeId`/`sedeIds`, filtra por esas sedes.
 *     Si no manda, opera GLOBAL (toda la plataforma) — comportamiento histórico
 *     pero requiere confirmación explícita del frontend.
 *
 * Antes del fix, un coord copiando su semana borraba el trabajo de TODAS las
 * sedes (cancel + recreate sin filtro por consultorio.sedeId).
 */
export async function copiar(req, res) {
  const { startDate: fechaInicio, siteId: sedeId, sedeIds } = req.body
  const origen = await prisma.week.findUnique({
    where: { id: req.params.id },
    include: { assignments: true },
  })
  if (!origen) throw errors.notFound()

  // Normalizar sedes objetivo
  let sedesObjetivo = sedeIds && Array.isArray(sedeIds) && sedeIds.length > 0
    ? sedeIds
    : sedeId
      ? [sedeId]
      : null

  // Coordinador: la operación SIEMPRE tiene scope de sede(s).
  // Validar que el coord esté vinculado a TODAS las sedes que pretende afectar.
  if (req.user.role === 'coordinador') {
    // AUTO-FALLBACK (fix jul-2026): si el frontend no envió sedeId por race
    // de hidratación del auth, y el coord tiene EXACTAMENTE 1 sede vinculada,
    // usamos esa. Evita el error "Debes especificar..." en el caso mayoritario
    // sin abrir la puerta a operaciones ambiguas para coords multi-sede.
    if (!sedesObjetivo || sedesObjetivo.length === 0) {
      const mias = await prisma.userSite.findMany({
        where: { userId: req.user.id },
        select: { siteId: true },
      })
      if (mias.length === 1) {
        sedesObjetivo = [mias[0].siteId]
      } else if (mias.length > 1) {
        throw errors.badRequest(
          `Tienes ${mias.length} sedes asignadas. Selecciona una en el panel antes de copiar la semana.`
        )
      } else {
        throw errors.badRequest(
          'No tienes sedes asignadas. Contacta al supervisor para que revise tu configuración.'
        )
      }
    }
    const misSedes = await prisma.userSite.findMany({
      where: { userId: req.user.id, siteId: { in: sedesObjetivo } },
      select: { siteId: true },
    })
    const misSedesSet = new Set(misSedes.map((u) => u.siteId))
    const noAutorizadas = sedesObjetivo.filter((s) => !misSedesSet.has(s))
    if (noAutorizadas.length > 0) {
      throw errors.forbidden('No estás vinculado a alguna de las sedes solicitadas')
    }
  }

  // Semana operativa: LUNES → DOMINGO (fix jul-2026). Ver comentario en create().
  const inicio = startOfWeek(new Date(fechaInicio), { weekStartsOn: 1 })
  const fin = addDays(inicio, 6)

  const existente = await prisma.week.findUnique({
    where: { startDate: inicio },
    include: { _count: { select: { assignments: true } } },
  })

  // RN-01: aplica solo cuando se va a CREAR una semana nueva (si ya existe,
  // se copia sobre ella sin restricción). Usa la misma constante que create().
  if (!existente && differenceInDays(inicio, new Date()) < ANTICIPACION_MINIMA_DIAS && !programacionLibre()) {
    const msg = ANTICIPACION_MINIMA_DIAS > 0
      ? `La nueva semana debe crearse con al menos ${ANTICIPACION_MINIMA_DIAS} día(s) de anticipación`
      : 'No se pueden crear semanas ya vencidas'
    throw errors.badRequest(msg)
  }

  // Filtrar las asignaciones a copiar SOLO de las sedes objetivo (si hay scope).
  // Necesitamos saber el consultorio.sedeId de cada asignación origen — lo
  // hidratamos vía una query rápida.
  let asigsACopiarFiltradas = origen.assignments
  if (sedesObjetivo) {
    const consultorioIds = [...new Set(origen.assignments.map((a) => a.roomId))]
    const consultorios = await prisma.room.findMany({
      where: { id: { in: consultorioIds } },
      select: { id: true, siteId: true },
    })
    const consSedeMap = new Map(consultorios.map((c) => [c.id, c.siteId]))
    const sedesObjetivoSet = new Set(sedesObjetivo)
    asigsACopiarFiltradas = origen.assignments.filter((a) => sedesObjetivoSet.has(consSedeMap.get(a.roomId)))
  }

  // Se copian también los sub-horarios de las auxiliares: sin ellos la copia no
  // es fiel y el validador vería a la aux ocupada el horario entero del doctor.
  const asigsACopiar = asigsACopiarFiltradas.map((a) => ({
    resourceId: a.resourceId,
    assistantId: a.assistantId,
    assistant2Id: a.assistant2Id,
    assistantStartTime: a.assistantStartTime,
    assistantEndTime: a.assistantEndTime,
    assistant2StartTime: a.assistant2StartTime,
    assistant2EndTime: a.assistant2EndTime,
    roomId: a.roomId,
    weekday: a.weekday,
    startTime: a.startTime,
    endTime: a.endTime,
    patientCapacity: a.patientCapacity,
  }))

  if (existente) {
    if (existente.status === 'cerrada' && !programacionLibre()) {
      throw errors.badRequest('La semana destino está cerrada. Reabre primero o edítala como supervisor.')
    }
    // SOFT-DELETE filtrado POR SEDE: solo cancelamos las asignaciones de las
    // sedes objetivo. Las demás sedes quedan intactas.
    const ahora = new Date()
    const idsParaRecuperacion = []
    // resultadoCopia queda fuera para poder informar de las omitidas al final.
    let resultadoCopia = { copied: 0, skipped: 0, errors: [] }

    const reemplazadas = await prisma.$transaction(async (tx) => {
      // Construir filtro where con scope de sede
      const whereFiltro = {
        weekId: existente.id,
        status: { not: 'cancelada' },
        ...(sedesObjetivo ? { room: { siteId: { in: sedesObjetivo } } } : {}),
      }

      const existentes = await tx.assignment.findMany({
        where: whereFiltro,
        select: { id: true },
      })
      idsParaRecuperacion.push(...existentes.map((a) => a.id))

      const upd = await tx.assignment.updateMany({
        where: whereFiltro,
        data: { status: 'cancelada' },
      })

      // VALIDACIÓN (fix sep-2026): antes esto era un createMany directo, sin
      // comprobar nada. Como la cancelación de arriba tiene alcance de SEDE,
      // cualquier recurso que ya tuviera horario esa semana en OTRA sede seguía
      // en pie, y la copia le encimaba una segunda consulta a la misma hora sin
      // avisar. Ahora pasa por el mismo validador que copiar día: lo que choca
      // se omite y se informa.
      //
      // Va DENTRO de la transacción para que vea las cancelaciones que se acaban
      // de hacer — si no, se detectaría conflicto contra asignaciones que este
      // mismo paso está retirando.
      resultadoCopia = await copiarAsignacionesValidadas(
        asigsACopiar.map((a) => ({ ...a, weekId: existente.id })),
        { userRol: req.user.role, userSedes: req.user.sites, client: tx },
      )
      return upd.count
    })

    await registrarAuditoria({
      userId: req.user.id,
      action: 'copiar_semana_reemplazo',
      entity: 'semanas',
      entityId: existente.id,
      newValue: {
        semana_origen_id: origen.id,
        semana_origen_inicio: origen.startDate,
        semana_destino_inicio: existente.startDate,
        sedes_objetivo: sedesObjetivo,
        scope: sedesObjetivo ? 'por_sede' : 'global',
        asignaciones_canceladas: reemplazadas,
        asignaciones_creadas: resultadoCopia.copied,
        asignaciones_omitidas: resultadoCopia.skipped,
        skip_reasons: resultadoCopia.errors,
        ids_canceladas: idsParaRecuperacion,
        date: ahora.toISOString(),
      },
      ipAddress: getIp(req),
    })

    const refrescada = await prisma.week.findUnique({
      where: { id: existente.id },
      include: { assignments: true },
    })
    return res.json({
      ...refrescada,
      replaced: reemplazadas,
      copied: resultadoCopia.copied,
      skipped: resultadoCopia.skipped,
      errors: resultadoCopia.errors,
    })
  }

  // Si la semana destino NO existe, se crea vacía y se copia con el mismo
  // validador. Aunque la semana esté vacía la validación no sobra: el lote
  // puede chocar consigo mismo, y desde el origen hasta hoy puede haberse
  // desactivado un recurso o un consultorio.
  const nueva = await prisma.week.create({
    data: { startDate: inicio, endDate: fin, status: 'abierta' },
  })

  const copia = await copiarAsignacionesValidadas(
    asigsACopiar.map((a) => ({ ...a, weekId: nueva.id })),
    { userRol: req.user.role, userSedes: req.user.sites },
  )

  const conAsignaciones = await prisma.week.findUnique({
    where: { id: nueva.id },
    include: { assignments: true },
  })

  res.status(201).json({
    ...conAsignaciones,
    replaced: 0,
    copied: copia.copied,
    skipped: copia.skipped,
    errors: copia.errors,
  })
}

// ============================================================================
// Oct-2026 · PROYECTOS-3398 §7 · QUIÉN FALTÓ LA SEMANA PASADA
//
// El coordinador abre la semana nueva, le da a "Copiar semana anterior" y
// arranca a programar. El problema es que la copia replica la semana anterior
// TAL COMO QUEDÓ PROGRAMADA, no como ocurrió: si un oftalmólogo faltó el
// miércoles, la copia le vuelve a poner ese miércoles como si nada, y la
// agenda que se cayó no se recupera nunca — nadie se acuerda de agregarla.
//
// Este endpoint es lo que alimenta el aviso: devuelve a quién hay que meter en
// la programación que se está armando, con lo que el coordinador necesita para
// decidir (qué días faltó, cuántos pacientes quedaron sin atender, si dijo que
// repondría y en qué fecha).
//
// Dos decisiones que vale la pena dejar escritas:
//
//  · Solo personal con agenda propia de pacientes. A una auxiliar que faltó no
//    hay agenda que reponerle, así que meterla en este aviso sería ruido sobre
//    la pantalla donde el coordinador tiene que decidir rápido.
//
//  · "Pendiente" se calcula contra la semana DESTINO, no contra la ausencia.
//    Un médico deja de estar pendiente cuando ya tiene horas programadas en la
//    semana que se está armando. Así el aviso se vacía solo a medida que el
//    coordinador trabaja, en vez de necesitar que alguien lo marque como visto.
// ============================================================================
export async function ausentesSemanaAnterior(req, res) {
  const { site_id: sedeId } = req.query

  const semana = await prisma.week.findUnique({ where: { id: req.params.id } })
  if (!semana) throw errors.notFound('Semana no encontrada')

  // La semana anterior se calcula por fecha y no por "la fila de antes en la
  // tabla": las semanas se crean a demanda, así que pueden faltar huecos y el
  // registro previo podría ser de hace un mes.
  const finAnterior = addDays(semana.startDate, -1)
  const inicioAnterior = addDays(semana.startDate, -7)

  // Alcance por sede. El coordinador solo ve las suyas; si pide una que no es,
  // se corta aquí igual que en el resto del módulo.
  let sedesAlcance = null
  if (req.user?.role === 'coordinador') {
    const mias = await prisma.userSite.findMany({
      where: { userId: req.user.id },
      select: { siteId: true },
    })
    const misSedes = mias.map((m) => m.siteId)
    if (sedeId && !misSedes.includes(sedeId)) throw errors.forbidden('No tienes acceso a esta sede')
    sedesAlcance = sedeId ? [sedeId] : misSedes
    if (sedesAlcance.length === 0) { res.json({ semana_anterior: null, ausentes: [] }); return }
  } else if (sedeId) {
    sedesAlcance = [sedeId]
  }

  const ausencias = await prisma.absence.findMany({
    where: {
      status: 'confirmada',
      startDate: { lte: finAnterior },
      endDate: { gte: inicioAnterior },
      resource: { is: { type: { in: [...TIPOS_QUE_IMPACTAN_PACIENTES] } } },
    },
    include: {
      resource: { select: { id: true, name: true, type: true, specialty: true } },
      reasonRef: { select: { name: true } },
      makeups: { where: { status: { in: ['solicitada', 'aprobada'] } }, select: { id: true, makeupDate: true, status: true } },
    },
    orderBy: { startDate: 'asc' },
  })

  if (ausencias.length === 0) {
    res.json({
      semana_anterior: { desde: inicioAnterior, hasta: finAnterior },
      semana_destino: { id: semana.id, desde: semana.startDate, hasta: semana.endDate },
      ausentes: [],
    })
    return
  }

  // ¿Qué tiene ya programado cada uno en la semana DESTINO y en qué sede?
  // Una sola consulta para todos: el bucle por recurso haría N consultas en una
  // pantalla que el coordinador abre varias veces al día.
  const idsRecursos = [...new Set(ausencias.map((a) => a.resourceId))]
  const asignacionesDestino = await prisma.assignment.findMany({
    where: {
      weekId: semana.id,
      status: { not: 'cancelada' },
      resourceId: { in: idsRecursos },
      ...(sedesAlcance ? { room: { siteId: { in: sedesAlcance } } } : {}),
    },
    select: { resourceId: true, weekday: true, startTime: true, endTime: true },
  })
  const programadoEnDestino = new Map()
  for (const a of asignacionesDestino) {
    if (!programadoEnDestino.has(a.resourceId)) programadoEnDestino.set(a.resourceId, [])
    programadoEnDestino.get(a.resourceId).push(a)
  }

  // Filtro por sede de la AUSENCIA: una ausencia no guarda sede, así que la
  // sede se deduce de dónde estaba programada esa persona la semana pasada.
  // Sin esto, el coordinador de Galapa vería los ausentes de Malambo.
  let recursosDeLaSede = null
  if (sedesAlcance) {
    const semanaAnterior = await prisma.week.findFirst({
      where: { startDate: { lte: finAnterior }, endDate: { gte: inicioAnterior } },
      select: { id: true },
    })
    if (semanaAnterior) {
      const asigsAnteriores = await prisma.assignment.findMany({
        where: {
          weekId: semanaAnterior.id,
          resourceId: { in: idsRecursos },
          room: { siteId: { in: sedesAlcance } },
        },
        select: { resourceId: true },
      })
      recursosDeLaSede = new Set(asigsAnteriores.map((a) => a.resourceId))
    } else {
      recursosDeLaSede = new Set()
    }
  }

  const ausentes = ausencias
    .filter((a) => !recursosDeLaSede || recursosDeLaSede.has(a.resourceId))
    .map((a) => {
      const yaProgramado = programadoEnDestino.get(a.resourceId) ?? []
      const reposicionAbierta = a.makeups[0] ?? null
      return {
        absence_id: a.id,
        resource: a.resource,
        desde: a.startDate,
        hasta: a.endDate,
        es_parcial: a.isPartial,
        motivo: a.reasonRef?.name ?? a.type,
        pacientes_impactados: a.patientsAffected ?? 0,
        accion_agenda: a.agendaAction,
        desea_reponer: a.wantsMakeup,
        // §4 · La fecha que el profesional propuso al registrar la ausencia. Es
        // el dato que el coordinador necesita para saber en qué día de ESTA
        // semana ubicarlo, y hasta ahora vivía dentro de un texto libre.
        fecha_reposicion_propuesta: a.makeupDate,
        observaciones_reposicion: a.makeupNotes,
        reposicion_registrada: reposicionAbierta
          ? { id: reposicionAbierta.id, fecha: reposicionAbierta.makeupDate, estado: reposicionAbierta.status }
          : null,
        // Lo que decide si sale resaltado: ya tiene horas en la semana que se
        // está armando, o todavía no.
        pendiente: yaProgramado.length === 0,
        programado_en_destino: yaProgramado,
      }
    })

  res.json({
    semana_anterior: { desde: inicioAnterior, hasta: finAnterior },
    semana_destino: { id: semana.id, desde: semana.startDate, hasta: semana.endDate },
    ausentes,
    // Atajo para que la grilla tiña celdas sin recorrer la lista en cada casilla.
    recursos_pendientes: ausentes.filter((x) => x.pendiente).map((x) => x.resource.id),
  })
}
