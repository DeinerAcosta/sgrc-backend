import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { crearAsignacion, editarAsignacion } from '../services/assignmentService.js'
import { copiarAsignacionesValidadas } from '../services/assignmentCopyService.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { assertSedePermitida } from '../lib/siteScope.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar } from '../services/notificationService.js'

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']

/**
 * Prepara una candidata a partir de una asignación de origen.
 *
 * Se copian TAMBIÉN los auxiliares y sus sub-horarios. Antes las tres rutas de
 * copia solo arrastraban `auxiliarId` y perdían el segundo auxiliar y los
 * sub-horarios, así que la copia no era fiel al original.
 */
const candidataDesde = (a, semanaId, diaSemana) => ({
  weekId: semanaId,
  weekday: diaSemana,
  roomId: a.roomId,
  resourceId: a.resourceId,
  assistantId: a.assistantId ?? null,
  assistant2Id: a.assistant2Id ?? null,
  assistantStartTime: a.assistantStartTime ?? null,
  assistantEndTime: a.assistantEndTime ?? null,
  assistant2StartTime: a.assistant2StartTime ?? null,
  assistant2EndTime: a.assistant2EndTime ?? null,
  startTime: a.startTime,
  endTime: a.endTime,
})

/**
 * Instantánea de una asignación para el log de auditoría.
 *
 * Se guardan solo los campos que describen QUÉ se programó — lo que hace falta
 * para reconstruir un cambio o rehacer un borrado. La fila entera sería ruido y
 * haría crecer la tabla más rápido de lo necesario.
 */
const resumenAsignacion = (a, data = null) => ({
  weekId: a.weekId,
  weekday: a.weekday,
  startTime: a.startTime,
  endTime: a.endTime,
  roomId: a.roomId,
  room: a.room?.name ?? null,
  site: a.room?.site?.name ?? null,
  resourceId: a.resourceId,
  resource: a.resource?.name ?? null,
  assistantId: a.assistantId ?? null,
  assistant2Id: a.assistant2Id ?? null,
  patientCapacity: a.patientCapacity ?? null,
  ...(data?.isReplacement ? { isReplacement: true, coveredAbsenceId: data.coveredAbsenceId ?? null } : {}),
})

/**
 * Auditoría de una operación de copia: UNA entrada con el resumen, no una por
 * asignación creada. Copiar un día a cinco días generaría 30 filas de ruido; lo
 * que interesa es qué operación se hizo, cuántas entraron y cuáles se omitieron.
 */
const auditarCopia = (req, accion, detalle, resultado) =>
  registrarAuditoria({
    userId: req.user.id,
    action: accion,
    entity: 'asignaciones',
    entityId: detalle.targetWeekId ?? detalle.weekId ?? 'lote',
    newValue: {
      ...detalle,
      copied: resultado.copied,
      skipped: resultado.skipped,
      skip_reasons: resultado.errors,
    },
    ipAddress: getIp(req),
  })

// Convierte strings vacías ("") → undefined ANTES de validar para que campos opcionales
// con validators estrictos (.uuid(), .regex(), etc.) no rebote con "Datos inválidos".
const emptyToUndef = (v) => (v === '' ? undefined : v)
const horaOpt = z.preprocess(emptyToUndef, z.string().regex(/^\d{2}:\d{2}$/).nullable().optional())

const crearSchema = z.object({
  weekId: z.string().uuid(),
  resourceId: z.string().uuid(),
  assistantId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  // Sub-horario opcional para la auxiliar (si null hereda del doctor).
  assistantStartTime: horaOpt,
  assistantEndTime: horaOpt,
  assistant2Id: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  assistant2StartTime: horaOpt,
  assistant2EndTime: horaOpt,
  roomId: z.string().uuid(),
  weekday: z.enum(DIAS),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  isReplacement: z.boolean().optional(),
  coveredAbsenceId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  supervisorReason: z.preprocess(emptyToUndef, z.string().optional()),
  // Override manual de pacientes programados — cuando el coord conoce el dato
  // real de la agenda externa (call center / eCitas) y este número difiere del
  // calculado. Si viene null/undefined, el backend usa la capacidad nominal.
  expectedPatients: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(200).nullable().optional()),
})

export async function list(req, res) {
  const { week_id: semana_id, site_id: sede_id, resource_id: recurso_id, day: dia } = req.query
  const where = { status: { not: 'cancelada' } }
  if (semana_id) where.weekId = semana_id
  if (recurso_id) where.OR = [
    { resourceId: recurso_id },
    { assistantId: recurso_id },
    { assistant2Id: recurso_id },
  ]
  if (dia) where.weekday = dia

  const list = await prisma.assignment.findMany({
    where,
    include: {
      resource: true,
      assistant: true,
      assistant2: true,
      room: { include: { site: true } },
    },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  })

  // Filtro post-query por sede (porque la relación es a través de consultorio)
  const filtradas = sede_id ? list.filter((a) => a.room.siteId === sede_id) : list
  res.json(filtradas)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const result = await crearAsignacion(data, { id: req.user.id, role: req.user.role, sites: req.user.sites })

  // Auditoría de TODA creación (RN-05/RN-34), no solo de las excepciones.
  //
  // Hasta ahora solo se registraba cuando un supervisor tocaba una semana
  // cerrada: crear, editar y borrar programación en el día a día no dejaba
  // ningún rastro. Es la operación central del sistema y la única sin log —
  // ejecución, ausencias, usuarios y parámetros sí lo tenían.
  //
  // registrarAuditoria() nunca lanza (se traga sus errores), así que esto no
  // puede tumbar la operación principal.
  await registrarAuditoria({
    userId: req.user.id,
    action: result.wasSupervisor ? 'modificar_semana_cerrada' : 'asignacion_crear',
    entity: 'asignaciones',
    entityId: result.assignment.id,
    newValue: resumenAsignacion(result.assignment, data),
    reason: data.supervisorReason ?? null,
    ipAddress: getIp(req),
  })

  // HU-R-07: notificar al recurso (y a la auxiliar si aplica) de su nueva asignación
  const a = result.assignment
  const destinatarios = await prisma.user.findMany({
    where: { resourceId: { in: [a.resourceId, a.assistantId].filter(Boolean) } },
  })
  for (const u of destinatarios) {
    await notificar({
      userId: u.id,
      type: 'asignacion_cambiada',
      title: 'Nueva asignación en tu horario',
      message: `Tienes una asignación el ${a.weekday} de ${a.startTime} a ${a.endTime} en ${a.room?.name ?? 'un consultorio'}.`,
      // Criticidad baja: el recurso lo ve en la app cuando entra. No saturamos
      // su bandeja con un email por cada nueva asignación (los coords editan
      // muchas asignaciones al cuadrar la semana).
      criticidad: 'baja',
      referenceId: a.id,
    })
  }

  res.status(201).json(result.assignment)
}

export async function update(req, res) {
  const data = crearSchema.parse(req.body)
  const result = await editarAsignacion(req.params.id, data, { id: req.user.id, role: req.user.role, sites: req.user.sites })

  // Ver comentario en create(): toda edición queda registrada, no solo las de
  // semana cerrada. Aquí además se guarda el valor ANTERIOR, que es lo que
  // permite reconstruir qué cambió.
  await registrarAuditoria({
    userId: req.user.id,
    action: result.wasSupervisor ? 'modificar_semana_cerrada' : 'asignacion_editar',
    entity: 'asignaciones',
    entityId: result.assignment.id,
    oldValue: result.anterior ? resumenAsignacion(result.anterior) : null,
    newValue: resumenAsignacion(result.assignment, data),
    reason: data.supervisorReason ?? null,
    ipAddress: getIp(req),
  })

  // HU-R-07: notificar al recurso (y a la auxiliar si aplica) del cambio en su asignación
  const a = result.assignment
  const destinatarios = await prisma.user.findMany({
    where: { resourceId: { in: [a.resourceId, a.assistantId].filter(Boolean) } },
  })
  for (const u of destinatarios) {
    await notificar({
      userId: u.id,
      type: 'asignacion_cambiada',
      title: 'Asignación actualizada en tu horario',
      message: `Cambió tu asignación el ${a.weekday}: ahora ${a.startTime}–${a.endTime} en ${a.room?.name ?? 'un consultorio'}.`,
      // Criticidad baja: solo in-app, sin email. Ver create() arriba.
      criticidad: 'baja',
      referenceId: a.id,
    })
  }

  res.json(result.assignment)
}

const pacientesCapacidadSchema = z.object({
  patientCapacity: z.coerce.number().int().min(0).max(200),
})

/**
 * Quick-edit del campo pacientesCapacidad sin re-validar la asignación entera.
 * El coordinador desde /app/ejecucion y el auxiliar desde /app/mi-ejecucion
 * ajustan los pacientes programados reales (que vienen de la agenda externa)
 * y persisten solo este número.
 *
 * AISLAMIENTO (aux 2026-08):
 * - coordinador: solo puede editar asignaciones cuyo consultorio pertenezca
 *   a una de sus sedes (usuarios_sedes).
 * - recurso (aux): solo puede editar asignaciones donde él sea auxiliar
 *   (aux1 o aux2).
 * - supervisor / gerencia: acceso global sin restricción por fila.
 */
export async function actualizarPacientesCapacidad(req, res) {
  const { patientCapacity: pacientesCapacidad } = pacientesCapacidadSchema.parse(req.body)

  // Traer datos mínimos de la asignación para validar ownership según rol
  const asig = await prisma.assignment.findUnique({
    where: { id: req.params.id },
    select: {
      assistantId: true,
      assistant2Id: true,
      room: { select: { siteId: true } },
    },
  })
  if (!asig) throw errors.notFound('Asignación no encontrada')

  const rol = req.user.role
  if (rol === 'coordinador') {
    const vinculos = await prisma.userSite.findMany({
      where: { userId: req.user.id },
      select: { siteId: true },
    })
    const misSedes = new Set(vinculos.map((v) => v.siteId))
    if (!misSedes.has(asig.room.siteId)) {
      throw errors.forbidden('No tienes permiso sobre esta asignación — no pertenece a tu sede')
    }
  } else if (rol === 'recurso') {
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { resourceId: true },
    })
    if (!u?.resourceId) {
      throw errors.forbidden('Tu usuario no está vinculado a un recurso. Contacta al supervisor.')
    }
    if (asig.assistantId !== u.resourceId && asig.assistant2Id !== u.resourceId) {
      throw errors.forbidden('No eres el auxiliar asignado — no puedes editar los pacientes de esta asignación')
    }
  }
  // supervisor/gerencia: sin restricción adicional

  const actualizada = await prisma.assignment.update({
    where: { id: req.params.id },
    data: { patientCapacity: pacientesCapacidad },
  })
  res.json(actualizada)
}

export async function remove(req, res) {
  const a = await prisma.assignment.findUnique({
    where: { id: req.params.id },
    // recurso y consultorio se incluyen para dejar en la auditoría los NOMBRES,
    // no solo los ids: una vez borrada la fila, los ids sueltos no dicen nada.
    include: {
      execution: true,
      week: true,
      resource: { select: { name: true } },
      room: { select: { name: true, siteId: true, site: { select: { name: true } } } },
    },
  })
  if (!a) throw errors.notFound()

  // AISLAMIENTO POR SEDE (S-1): borrar era la operación más expuesta — bastaba
  // el id de una asignación de otra ciudad para eliminarla.
  assertSedePermitida(req.user, a.room.siteId, a.room.site?.name)

  // RN — semana cerrada solo supervisor
  if (a.week.status === 'cerrada' && req.user.role !== 'supervisor' && !programacionLibre()) {
    throw errors.forbidden('Semana cerrada — solo supervisor puede modificar')
  }

  // El borrado era la única mutación de programación sin ningún rastro. Es
  // además la más difícil de reconstruir después: la fila desaparece y no queda
  // ni quién ni cuándo. Se registra ANTES de borrar, con los nombres resueltos.
  const auditoriaBorrado = {
    userId: req.user.id,
    entity: 'asignaciones',
    entityId: a.id,
    oldValue: resumenAsignacion(a),
    ipAddress: getIp(req),
  }

  // RN-17: si tiene ejecución registrada, marcar como cancelada (no eliminar)
  if (a.execution) {
    const updated = await prisma.assignment.update({
      where: { id: req.params.id },
      data: { status: 'cancelada' },
    })
    await registrarAuditoria({
      ...auditoriaBorrado,
      action: 'asignacion_cancelar',
      reason: 'Tenía ejecución registrada (RN-17): se cancela en lugar de borrarse',
    })
    return res.json({ ok: true, cancelled: true, assignment: updated })
  }

  await prisma.assignment.delete({ where: { id: req.params.id } })
  await registrarAuditoria({ ...auditoriaBorrado, action: 'asignacion_borrar' })
  res.json({ ok: true })
}

/**
 * POST /asignaciones/copiar-dia
 * Copia todas las asignaciones de un día a otro(s) día(s) de la misma semana.
 * Body: { semana_id, sede_id, dia_origen, dias_destino: [...] }
 * Si una asignación falla validación (conflicto, horas), se omite y se reporta.
 */
const copiarDiaSchema = z.object({
  weekId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  dayFrom: z.enum(DIAS),
  targetDays: z.array(z.enum(DIAS)).min(1),
  // Opcional: si se pasa, las asignaciones se crean en esta semana destino
  // (útil para copiar el martes de esta semana al martes de la siguiente).
  targetWeekId: z.string().uuid().optional(),
})

/** Valida que la semana destino exista y esté abierta (no cerrada).
 * Bypass para supervisor/gerencia: pueden copiar A una semana cerrada
 * (tienen permiso de "editar semana cerrada" en toda la app). */
async function asegurarSemanaDestino(semanaDestinoId, userRol) {
  if (!semanaDestinoId) return null
  const dest = await prisma.week.findUnique({ where: { id: semanaDestinoId } })
  if (!dest) throw errors.badRequest('La semana destino no existe.')
  const esSup = userRol === 'supervisor' || userRol === 'gerencia'
  if (dest.status === 'cerrada' && !esSup && !programacionLibre()) {
    throw errors.badRequest('La semana destino está cerrada — no se puede copiar.')
  }
  return dest
}

/** Si la semana ORIGEN está cerrada, fuerza que el destino sea OTRA semana
 * (no se puede crear/modificar asignaciones en una semana cerrada).
 * Bypass para supervisor/gerencia: pueden copiar DESDE (y hacia) una semana
 * cerrada — tienen el privilegio "editar semana cerrada". */
async function asegurarOrigenNoCerradaOAlternativa(semanaOrigenId, semanaDestinoId, userRol) {
  const esSup = userRol === 'supervisor' || userRol === 'gerencia'
  if (esSup || programacionLibre()) return
  const origen = await prisma.week.findUnique({ where: { id: semanaOrigenId } })
  if (!origen) throw errors.badRequest('La semana origen no existe.')
  if (origen.status !== 'cerrada') return
  if (!semanaDestinoId || semanaDestinoId === semanaOrigenId) {
    throw errors.badRequest('La semana origen está cerrada. Debes elegir otra semana destino para copiar.')
  }
}

/**
 * POST /asignaciones/:id/copiar-a-dias
 * Copia UNA asignación específica a uno o varios días de la misma semana.
 * Body: { diasDestino: [...] }
 * Respeta todas las validaciones (conflictos, horas, etc.) — si falla en algún día, se omite.
 */
const copiarAsigSchema = z.object({
  targetDays: z.array(z.enum(DIAS)).min(1),
  targetWeekId: z.string().uuid().optional(),
})

export async function copiarAsignacionADias(req, res) {
  const { targetDays: diasDestino, targetWeekId: semanaDestinoId } = copiarAsigSchema.parse(req.body)
  const { id } = req.params

  const origen = await prisma.assignment.findUnique({
    where: { id },
    include: { room: true, week: true },
  })
  if (!origen) throw errors.notFound('Asignación no encontrada')

  await asegurarSemanaDestino(semanaDestinoId, req.user.role)
  // Si la semana origen está cerrada, el destino debe ser OTRA semana.
  // Supervisor/gerencia bypasean esta regla (pueden editar semanas cerradas).
  await asegurarOrigenNoCerradaOAlternativa(origen.weekId, semanaDestinoId, req.user.role)
  const targetSemanaId = semanaDestinoId ?? origen.weekId

  const candidatas = []
  let omitidasPorSerElMismoDia = 0
  for (const diaDestino of diasDestino) {
    // Solo saltar mismo día si también es la MISMA semana — entre semanas
    // distintas tiene sentido copiar al mismo día (ej. martes → martes).
    if (diaDestino === origen.weekday && targetSemanaId === origen.weekId) {
      omitidasPorSerElMismoDia++
      continue
    }
    candidatas.push(candidataDesde(origen, targetSemanaId, diaDestino))
  }

  const r = await copiarAsignacionesValidadas(candidatas, { userRol: req.user.role, userSedes: req.user.sites })
  await auditarCopia(req, 'asignacion_copiar_a_dias', {
    asignacionOrigenId: id, targetWeekId: targetSemanaId, targetDays: diasDestino,
  }, r)
  res.json({
    ok: true,
    copied: r.copied,
    skipped: r.skipped + omitidasPorSerElMismoDia,
    errors: r.errors,
  })
}

/**
 * POST /asignaciones/copiar-consultorio
 * Copia todas las asignaciones de un consultorio+día a otros días.
 * Body: { semanaId, consultorioId, diaOrigen, diasDestino: [...] }
 * Útil para áreas como ÁREA ASESORES donde hay varios asesores en un día
 * y se quiere replicar el equipo completo a otro día.
 */
const copiarConsSchema = z.object({
  weekId: z.string().uuid(),
  roomId: z.string().uuid(),
  dayFrom: z.enum(DIAS),
  targetDays: z.array(z.enum(DIAS)).min(1),
  targetWeekId: z.string().uuid().optional(),
})

export async function copiarConsultorio(req, res) {
  const { weekId: semanaId, roomId: consultorioId, dayFrom: diaOrigen, targetDays: diasDestino, targetWeekId: semanaDestinoId } = copiarConsSchema.parse(req.body)
  await asegurarSemanaDestino(semanaDestinoId, req.user.role)
  await asegurarOrigenNoCerradaOAlternativa(semanaId, semanaDestinoId, req.user.role)
  const targetSemanaId = semanaDestinoId ?? semanaId

  const origen = await prisma.assignment.findMany({
    where: {
      weekId: semanaId,
      roomId: consultorioId,
      weekday: diaOrigen,
      status: { not: 'cancelada' },
    },
  })

  if (origen.length === 0) {
    return res.json({ ok: true, copied: 0, message: 'El consultorio no tiene asignaciones ese día' })
  }

  const candidatas = []
  for (const diaDestino of diasDestino) {
    // Mismo día solo si también es la MISMA semana — entre semanas distintas tiene sentido copiar al mismo día.
    if (diaDestino === diaOrigen && targetSemanaId === semanaId) continue
    for (const a of origen) candidatas.push(candidataDesde(a, targetSemanaId, diaDestino))
  }

  const r = await copiarAsignacionesValidadas(candidatas, { userRol: req.user.role, userSedes: req.user.sites })
  await auditarCopia(req, 'asignacion_copiar_consultorio', { roomId: consultorioId, weekId: semanaId, targetWeekId: targetSemanaId, dayFrom: diaOrigen, targetDays: diasDestino }, r)
  res.json({ ok: true, copied: r.copied, skipped: r.skipped, errors: r.errors })
}

export async function copiarDia(req, res) {
  const { weekId: semanaId, siteId: sedeId, dayFrom: diaOrigen, targetDays: diasDestino, targetWeekId: semanaDestinoId } = copiarDiaSchema.parse(req.body)
  await asegurarSemanaDestino(semanaDestinoId, req.user.role)
  await asegurarOrigenNoCerradaOAlternativa(semanaId, semanaDestinoId, req.user.role)
  const targetSemanaId = semanaDestinoId ?? semanaId

  // Cargar todas las asignaciones del día origen
  const where = { weekId: semanaId, weekday: diaOrigen, status: { not: 'cancelada' } }
  if (sedeId) where.room = { siteId: sedeId }

  const origen = await prisma.assignment.findMany({
    where,
    include: { room: true },
  })

  if (origen.length === 0) {
    return res.json({ ok: true, copied: 0, message: 'El día origen no tiene asignaciones' })
  }

  // Una sola pasada validada en lugar de un bucle anidado de transacciones.
  const candidatas = []
  for (const diaDestino of diasDestino) {
    if (diaDestino === diaOrigen && targetSemanaId === semanaId) continue
    for (const a of origen) candidatas.push(candidataDesde(a, targetSemanaId, diaDestino))
  }

  const r = await copiarAsignacionesValidadas(candidatas, { userRol: req.user.role, userSedes: req.user.sites })
  await auditarCopia(req, 'asignacion_copiar_dia', { siteId: sedeId ?? null, weekId: semanaId, targetWeekId: targetSemanaId, dayFrom: diaOrigen, targetDays: diasDestino }, r)
  res.json({ ok: true, copied: r.copied, skipped: r.skipped, errors: r.errors })
}

/**
 * GET /recursos/sugeridos — sugiere reemplazos para una franja (HU-C-12, RN-38)
 *
 * Dos defectos corregidos aquí (sep-2026):
 *
 * 1. DISPONIBILIDAD MAL CALCULADA. Se usaba `findFirst`, que devuelve UNA sola
 *    asignación del día. Si el recurso tenía tres y la primera que volvía no
 *    solapaba con la franja pedida, se le marcaba como disponible aunque otra sí
 *    solapara — el coordinador podía asignar un reemplazo que ya estaba ocupado.
 *    Ahora se miran TODAS sus franjas del día. (El mock de demo en api.js ya lo
 *    hacía bien con `.some()`; el fallo estaba solo en el backend real.)
 *
 * 2. `misma_sede` VALÍA SIEMPRE true por un `|| true` al final de la expresión,
 *    así que la sección "otras sedes · requiere desplazamiento" del modal nunca
 *    se mostraba. Ahora se resuelve de verdad a partir del consultorio del hueco
 *    que se quiere cubrir. Si no llega `consultorio_id` ni `sede_id` se mantiene
 *    el comportamiento anterior (todos en la misma sede), para no romper a
 *    ningún llamador que no los envíe.
 *
 * Además pasa de N+1 (una consulta por candidato) a 2 consultas fijas.
 */
export async function sugerirReemplazos(req, res) {
  const { type: tipo, day: dia, start_time: hora_inicio, end_time: hora_fin, week_id: semana_id, room_id: consultorio_id, site_id: sede_id } = req.query
  if (!tipo || !dia || !hora_inicio || !hora_fin) {
    throw errors.badRequest('Parámetros requeridos: tipo, dia, hora_inicio, hora_fin')
  }

  // Candidatos activos del tipo solicitado
  const candidatos = await prisma.resource.findMany({ where: { type: tipo, active: true } })
  if (candidatos.length === 0) return res.json([])

  const ids = candidatos.map((r) => r.id)

  // Todas las franjas de esos candidatos ese día, en UNA consulta.
  const ocupacion = await prisma.assignment.findMany({
    where: {
      weekId: semana_id || undefined,
      weekday: dia,
      status: { not: 'cancelada' },
      OR: [{ resourceId: { in: ids } }, { assistantId: { in: ids } }],
    },
    select: {
      resourceId: true,
      assistantId: true,
      startTime: true,
      endTime: true,
      room: { select: { siteId: true } },
    },
  })

  // Sede del hueco a cubrir, para distinguir "misma sede" de "requiere
  // desplazamiento". sede_id tiene prioridad; si no, se deduce del consultorio.
  let sedeObjetivo = sede_id || null
  if (!sedeObjetivo && consultorio_id) {
    const cons = await prisma.room.findUnique({
      where: { id: consultorio_id },
      select: { siteId: true },
    })
    sedeObjetivo = cons?.siteId ?? null
  }

  const franjasPorRecurso = new Map(ids.map((id) => [id, []]))
  const sedesPorRecurso = new Map(ids.map((id) => [id, new Set()]))
  for (const a of ocupacion) {
    for (const rid of [a.resourceId, a.assistantId]) {
      if (!rid || !franjasPorRecurso.has(rid)) continue
      franjasPorRecurso.get(rid).push(a)
      if (a.room?.siteId) sedesPorRecurso.get(rid).add(a.room.siteId)
    }
  }

  // Solape: las horas son "HH:MM" de longitud fija, así que comparar como
  // strings equivale a comparar minutos. Se mantiene el criterio original.
  const solapa = (a) => !(hora_fin <= a.startTime || hora_inicio >= a.endTime)

  const disponibles = candidatos
    .filter((r) => !franjasPorRecurso.get(r.id).some(solapa))
    .map((r) => ({
      ...r,
      misma_sede: sedeObjetivo ? sedesPorRecurso.get(r.id).has(sedeObjetivo) : true,
    }))

  res.json(disponibles)
}
