import { z } from 'zod'
import PDFDocument from 'pdfkit'
import ExcelJS from 'exceljs'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { crearAsignacion, editarAsignacion, ROLES_EDITAN_CERRADA, pacientesPorReprogramar } from '../services/assignmentService.js'
import { copiarAsignacionesValidadas } from '../services/assignmentCopyService.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { horasEfectivasFranja } from '../lib/workHours.js'
import { SIN_TOPE_DIARIO } from '../lib/timeSlots.js'
import { assertSedePermitida } from '../lib/siteScope.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar } from '../services/notificationService.js'
import { TIPOS_CON_PRIORIDAD, prioridadDeReemplazo, compararPorPrioridad } from '../lib/prioridadReemplazo.js'
import { TIPOS_QUE_LIBERAN_AUXILIAR, coordSoloVe, MSG_SOLO_VE } from '../lib/resourceTypes.js'
import { diasDeAnticipacion } from '../lib/anticipacion.js'

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
  // Oct-2026 · "Se hace cargo aunque ya tenga turno esa franja". Unica
  // excepcion a RN-08 y solo vale junto a coveredAbsenceId.
  assumeOverlap: z.boolean().optional(),
  // 3739 · Crear el turno ya en contingencia (naranja, pacientes vacíos).
  contingency: z.boolean().optional(),
  supervisorReason: z.preprocess(emptyToUndef, z.string().optional()),
  // Override manual de pacientes programados — cuando el coord conoce el dato
  // real de la agenda externa (call center / eCitas) y este número difiere del
  // calculado. Si viene null/undefined, el backend usa la capacidad nominal.
  expectedPatients: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(200).nullable().optional()),
  // Sep-2026 · Ley 2101 · Autorización directivo para aux que trabajan sáb+dom
  // en la misma semana. Solo se envían cuando el frontend detecta el escenario
  // y pide al coord elegir un directivo. El backend valida el rol del autorizador.
  authorizedById: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  authorizationReason: z.preprocess(emptyToUndef, z.string().min(5).max(500).optional().nullable()),
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

  // 3739 · Hector, 21-oct: también se crea en contingencia desde una casilla
  // vacía, con el mismo flujo: naranja, pacientes vacíos, la líder aprueba.
  if (data.contingency) {
    result.assignment = await prisma.assignment.update({
      where: { id: result.assignment.id },
      data: { contingency: true, patientCapacity: 0 },
      include: { room: { select: { name: true, site: { select: { name: true } } } }, resource: { select: { name: true } } },
    })
    await registrarAuditoria({
      userId: req.user.id, action: 'contingencia_marcar', entity: 'asignaciones', entityId: result.assignment.id,
      newValue: { ...resumenAsignacion(result.assignment), contingencia: true },
      ipAddress: getIp(req),
    })
  }

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
      title: 'Nueva asignación en su horario',
      message: `Tiene una asignación el ${a.weekday} de ${a.startTime} a ${a.endTime} en ${a.room?.name ?? 'un consultorio'}.`,
      // Criticidad baja: el recurso lo ve en la app cuando entra. No saturamos
      // su bandeja con un email por cada nueva asignación (los coords editan
      // muchas asignaciones al cuadrar la semana).
      criticidad: 'baja',
      referenceId: a.id,
    })
  }

  // Oct-2026 · Si se uso la excepcion a RN-08, el aviso generico de arriba no
  // alcanza: el profesional tiene que enterarse de QUE agenda esta asumiendo y
  // de quien, y la excepcion tiene que quedar registrada aparte.
  if (data.assumeOverlap && data.coveredAbsenceId) {
    const ausencia = await prisma.absence.findUnique({
      where: { id: data.coveredAbsenceId },
      include: { resource: { select: { name: true } } },
    })
    const deQuien = ausencia?.resource?.name ?? 'otro profesional'

    await registrarAuditoria({
      userId: req.user.id,
      action: 'asumir_agenda_sobre_turno_propio',
      entity: 'asignaciones',
      entityId: a.id,
      newValue: {
        profesional: a.resource?.name ?? a.resourceId,
        asume_la_agenda_de: deQuien,
        dia: a.weekday,
        franja: `${a.startTime}-${a.endTime}`,
        pacientes_del_ausente: ausencia?.patientsAffected ?? null,
      },
      reason: 'Excepción a RN-08: se hace cargo de la agenda de un ausente teniendo turno propio en esa franja',
      ipAddress: getIp(req),
    })

    const quienAsume = await prisma.user.findFirst({ where: { resourceId: a.resourceId } })
    if (quienAsume) {
      await notificar({
        userId: quienAsume.id,
        type: 'agenda_asumida',
        title: `Atenderá además la agenda de ${deQuien}`,
        message: `<p>Se le asignó un turno <strong>adicional</strong> el ${a.weekday} de ${a.startTime} a ${a.endTime}: son los pacientes que tenía programados <strong>${deQuien}</strong>, que se ausentó.</p><p>Su turno propio de esa franja no cambia — este se suma.</p>`,
        contexto: 'Reprogramación de agendas',
        criticidad: 'alta',
        referenceId: a.id,
      })
    }
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
      title: 'Asignación actualizada en su horario',
      message: `Cambió su asignación el ${a.weekday}: ahora ${a.startTime}–${a.endTime} en ${a.room?.name ?? 'un consultorio'}.`,
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
      coveredAbsenceId: true,
      patientCapacity: true,
      weekId: true, weekday: true, startTime: true, endTime: true, roomId: true, resourceId: true,
      resource: { select: { name: true } },
      room: { select: { siteId: true, name: true, site: { select: { name: true } } } },
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

  // 21-oct · Hector cambia desde el caso los pacientes de cada persona que
  // cubre. El mismo tope que al crear: no más de los que faltan del caso,
  // sin contar los que ya tenía este turno.
  if (asig.coveredAbsenceId) {
    const cubierta = await prisma.absence.findUnique({ where: { id: asig.coveredAbsenceId }, select: { resource: { select: { type: true } } } })
    if (coordSoloVe(req.user, cubierta?.resource?.type)) throw errors.forbidden(MSG_SOLO_VE)
    const pendientes = await pacientesPorReprogramar(prisma, asig.coveredAbsenceId, req.params.id)
    if (pendientes != null && pacientesCapacidad > pendientes) {
      throw errors.badRequest(`Quedan ${pendientes} pacientes por reprogramar en el caso: no se pueden poner ${pacientesCapacidad}.`)
    }
  }

  const actualizada = await prisma.assignment.update({
    where: { id: req.params.id },
    data: { patientCapacity: pacientesCapacidad },
  })
  await registrarAuditoria({
    userId: req.user.id, action: 'asignacion_pacientes', entity: 'asignaciones', entityId: req.params.id,
    oldValue: { pacientes: asig.patientCapacity }, newValue: resumenAsignacion({ ...asig, patientCapacity: pacientesCapacidad }),
    ipAddress: getIp(req),
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

  // RN — semana o SEDE cerrada: solo supervisor/gerencia. Antes solo se miraba
  // la semana global, así que un coord podía borrar asignaciones de su sede
  // después de cerrarla (mientras otras sedes seguían abiertas). Misma regla
  // que crear/editar en assignmentService.
  if (!programacionLibre() && !ROLES_EDITAN_CERRADA.has(req.user.role)) {
    if (a.week.status === 'cerrada') {
      throw errors.forbidden('Semana cerrada — solo supervisor o gerencia pueden modificar')
    }
    const cierreSede = await prisma.weekSiteClosure.findUnique({
      where: { weekId_siteId: { weekId: a.weekId, siteId: a.room.siteId } },
    })
    if (cierreSede) {
      throw errors.forbidden('No puedes borrar asignaciones de esta sede — su cierre semanal ya fue procesado')
    }
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
 * La fecha de un día de la semana, por nombre. Se busca recorriendo los siete
 * días en UTC —las fechas de solo-día se guardan a medianoche UTC— para no
 * depender de en qué día arranca la semana.
 */
function fechaDelDiaEnSemana(inicioSemana, nombreDia) {
  const NOMBRES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
  for (let i = 0; i < 7; i++) {
    const d = new Date(inicioSemana)
    d.setUTCDate(d.getUTCDate() + i)
    if (NOMBRES[d.getUTCDay()] === nombreDia) return d
  }
  return null
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
      OR: [{ resourceId: { in: ids } }, { assistantId: { in: ids } }, { assistant2Id: { in: ids } }],
    },
    select: {
      resourceId: true,
      assistantId: true,
      assistant2Id: true,
      startTime: true,
      endTime: true,
      // Oct-2026 · Antes solo viajaba siteId, que alcanzaba para el booleano
      // "misma sede". Pero decirle a alguien "tiene que desplazarse" sin decir
      // DESDE DONDE no le sirve para decidir: la pantalla necesita el nombre.
      room: { select: { id: true, name: true, siteId: true, site: { select: { name: true, city: true } } } },
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
    for (const rid of [a.resourceId, a.assistantId, a.assistant2Id]) {
      if (!rid || !franjasPorRecurso.has(rid)) continue
      franjasPorRecurso.get(rid).push(a)
      if (a.room?.siteId) sedesPorRecurso.get(rid).add(a.room.siteId)
    }
  }

  // Solape: las horas son "HH:MM" de longitud fija, así que comparar como
  // strings equivale a comparar minutos. Se mantiene el criterio original.
  const solapa = (a) => !(hora_fin <= a.startTime || hora_inicio >= a.endTime)

  // ── Oct-2026 · Dos filtros que faltaban ────────────────────────────────
  //
  // Los dos hacían lo mismo en pantalla: ofrecer a alguien que luego, al
  // pulsar "Asignar", el servidor rechaza. Hector: "intentaba asignar a alguno
  // y no me dejaba en nada". La lista tiene que ofrecer solo lo que se puede.
  //
  // 1. LA CIUDAD (RN-09). La pantalla manda `city` y aquí se ignoraba: salía
  //    quien ese día ya trabaja en Sabanalarga para cubrir en Barranquilla, y
  //    la creación lo rebotaba por estar en dos ciudades el mismo día.
  let ciudadObjetivo = req.query.city || null
  if (!ciudadObjetivo && sedeObjetivo) {
    const s = await prisma.site.findUnique({ where: { id: sedeObjetivo }, select: { city: true } })
    ciudadObjetivo = s?.city ?? null
  }
  const enOtraCiudad = (rid) => !!ciudadObjetivo &&
    franjasPorRecurso.get(rid).some((a) => a.room?.site?.city && a.room.site.city !== ciudadObjetivo)

  // 2. QUIEN ESTÁ AUSENTE. Un médico de vacaciones no tiene turnos ese día, y
  //    por eso salía como "tiene el día libre". Cuentan también las ausencias
  //    por confirmar: quien avisó que falta no es un candidato.
  const ausentes = new Set()
  if (semana_id) {
    const semana = await prisma.week.findUnique({ where: { id: semana_id }, select: { startDate: true } })
    const fecha = semana && fechaDelDiaEnSemana(semana.startDate, dia)
    if (fecha) {
      const aus = await prisma.absence.findMany({
        where: {
          resourceId: { in: ids },
          status: { in: ['pendiente', 'confirmada'] },
          startDate: { lte: fecha },
          endDate: { gte: fecha },
        },
        select: { resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
      })
      for (const a of aus) {
        // Una parcial solo lo saca de la lista si pisa la franja a cubrir.
        const pisa = !a.isPartial || !a.absenceStartTime || !a.absenceEndTime ||
          !(hora_fin <= a.absenceStartTime || hora_inicio >= a.absenceEndTime)
        if (pisa) ausentes.add(a.resourceId)
      }
    }
  }

  // 3. EL TOPE DIARIO DE HORAS (RN-13). Oct-2026 · El barrido de QA que pulsa
  //    Asignar en todos los casos encontró a una técnica con 6 h ese día
  //    ofrecida para 6 h más: el servidor la rechazaba por pasar de 10 h. Se
  //    calcula igual que VALIDACIÓN 5 de crearAsignacion (horas efectivas,
  //    como profesional o auxiliar). Los de agenda sin tope diario y los
  //    multi-consultorio (que allá se miden por unión de horas) no se filtran.
  const pasaElTopeDiario = (r) => {
    if (SIN_TOPE_DIARIO.has(r.type) || r.multiRoom) return false
    // Un turno caído por la ausencia de su médico no suma horas ese día.
    const delDia = franjasPorRecurso.get(r.id)
      .filter((a) => a.resourceId === r.id || a.assistantId === r.id)
      .filter((a) => !liberada(a))
    const horas = delDia.reduce((n, a) => n + horasEfectivasFranja(a.startTime, a.endTime, r.type), 0) +
      horasEfectivasFranja(hora_inicio, hora_fin, r.type)
    return horas > (r.maxHoursPerDay ?? 10)
  }

  // 4. PRIORIDAD PARA AUXILIARES Y ASESORES (3583). La auxiliar cuyo médico
  //    falta ese día tiene su turno caído: está libre, no ocupada. Antes ese
  //    turno contaba como ocupación y la candidata número 1 no salía nunca.
  const conPrioridad = TIPOS_CON_PRIORIDAD.has(tipo) && !!semana_id
  let liberada = () => false
  const horasSemana = new Map()
  let esMismoDia = false
  if (conPrioridad) {
    const semana = await prisma.week.findUnique({ where: { id: semana_id }, select: { startDate: true } })
    const fecha = semana && fechaDelDiaEnSemana(semana.startDate, dia)
    esMismoDia = !!fecha && diasDeAnticipacion(fecha.toISOString()) <= 0
    const medicos = [...new Set(ocupacion
      .filter((a) => ids.includes(a.assistantId) || ids.includes(a.assistant2Id))
      .map((a) => a.resourceId))]
    const ausMedicos = fecha && medicos.length
      ? await prisma.absence.findMany({
          // Solo confirmadas: es lo que el servidor acepta al asignar
          // (turnosCaidosPorAusenciaDelMedico).
          where: {
            resourceId: { in: medicos }, status: 'confirmada', startDate: { lte: fecha }, endDate: { gte: fecha },
            resource: { is: { type: { in: [...TIPOS_QUE_LIBERAN_AUXILIAR] } } },   // RN-24
          },
          select: { resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
        })
      : []
    liberada = (a) => ausMedicos.some((x) => x.resourceId === a.resourceId &&
      (!x.isPartial || !x.absenceStartTime || !x.absenceEndTime ||
        !(a.endTime <= x.absenceStartTime || a.startTime >= x.absenceEndTime)))
    const semanaEntera = await prisma.assignment.findMany({
      where: {
        weekId: semana_id, status: { not: 'cancelada' },
        OR: [{ resourceId: { in: ids } }, { assistantId: { in: ids } }, { assistant2Id: { in: ids } }],
      },
      select: { resourceId: true, assistantId: true, assistant2Id: true, startTime: true, endTime: true },
    })
    for (const a of semanaEntera) {
      for (const rid of new Set([a.resourceId, a.assistantId, a.assistant2Id])) {
        if (!rid || !ids.includes(rid)) continue
        const r = candidatos.find((c) => c.id === rid)
        horasSemana.set(rid, (horasSemana.get(rid) ?? 0) + horasEfectivasFranja(a.startTime, a.endTime, r.type))
      }
    }
  }
  const propias = (r) => franjasPorRecurso.get(r.id).filter((a) => !liberada(a))

  const disponibles = candidatos
    .filter((r) => !propias(r).some(solapa))
    .filter((r) => !ausentes.has(r.id))
    .filter((r) => !enOtraCiudad(r.id))
    .filter((r) => !pasaElTopeDiario(r))
    .map((r) => ({
      ...r,
      misma_sede: sedeObjetivo ? sedesPorRecurso.get(r.id).has(sedeObjetivo) : true,
      // Donde esta ese dia, franja por franja. Vacio = tiene el dia libre, que
      // tambien es un dato: no hay que sacarlo de ningun lado.
      ocupacion_ese_dia: franjasPorRecurso.get(r.id)
        .slice()
        .sort((x, y) => (x.startTime ?? '').localeCompare(y.startTime ?? ''))
        .map((a) => ({
          start_time: a.startTime,
          end_time: a.endTime,
          room: a.room?.name ?? null,
          site: a.room?.site?.name ?? null,
          city: a.room?.site?.city ?? null,
          liberada: liberada(a),
        })),
      ...(conPrioridad ? (() => {
        const p = prioridadDeReemplazo({
          liberadaPorAusencia: franjasPorRecurso.get(r.id).some(liberada),
          horasSemana: horasSemana.get(r.id) ?? 0,
          topeSemanal: r.maxHoursPerWeek,
          esMismoDia,
        })
        return {
          prioridad: p.prioridad,
          prioridad_motivo: p.motivo,
          aviso_mismo_dia: !!p.avisoMismoDia,
          horas_semana: Math.round((horasSemana.get(r.id) ?? 0) * 10) / 10,
        }
      })() : {}),
    }))

  res.json(conPrioridad ? disponibles.sort(compararPorPrioridad) : disponibles)
}

// ============================================================================
// EXPORTAR SEMANA — PDF/Excel de la programación semanal de una sede
// ============================================================================
// El coordinador imprime o comparte el horario semanal por consultorio × día.
// Cada celda: recurso, franja horaria, auxiliar(es), pacientes.
// Formato PDF: A3 landscape (7 días son muchos para A4). Formato XLSX: hoja única.

const DIA_LABEL = { lunes: 'LUN', martes: 'MAR', miercoles: 'MIÉ', jueves: 'JUE', viernes: 'VIE', sabado: 'SÁB', domingo: 'DOM' }

async function armarGridSemana(weekId, siteId) {
  if (!weekId || !siteId) throw errors.badRequest('week_id y site_id son requeridos')

  const [semana, sede, asignaciones, consultorios] = await Promise.all([
    prisma.week.findUnique({ where: { id: weekId } }),
    prisma.site.findUnique({ where: { id: siteId } }),
    prisma.assignment.findMany({
      where: { weekId, status: { not: 'cancelada' }, room: { siteId } },
      include: {
        resource: { select: { name: true, type: true } },
        assistant: { select: { name: true } },
        assistant2: { select: { name: true } },
        room: { select: { id: true, name: true, specialty: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    }),
    prisma.room.findMany({
      where: { siteId, active: true },
      orderBy: [{ specialty: 'asc' }, { name: 'asc' }],
    }),
  ])

  if (!semana) throw errors.notFound('Semana no encontrada')
  if (!sede) throw errors.notFound('Sede no encontrada')

  // Índice: consultorio_id → dia → [asignaciones]
  const grid = new Map()
  for (const c of consultorios) {
    grid.set(c.id, { room: c, dias: Object.fromEntries(DIAS.map((d) => [d, []])) })
  }
  for (const a of asignaciones) {
    const cell = grid.get(a.roomId)
    if (cell) cell.dias[a.weekday].push(a)
  }

  return { semana, sede, grid: [...grid.values()] }
}

/**
 * GET /api/assignments/export?week_id=X&site_id=Y&format=pdf|xlsx
 * Descarga la programación semanal de la sede como PDF o Excel.
 */
export async function exportarSemana(req, res) {
  const { week_id: weekId, site_id: siteId, format = 'pdf' } = req.query
  const { semana, sede, grid } = await armarGridSemana(weekId, siteId)

  const fechaIni = semana.startDate.toISOString().slice(0, 10)
  const fechaFin = semana.endDate.toISOString().slice(0, 10)
  const fileBase = `horarios_${sede.name.replace(/[^\w]/g, '_')}_${fechaIni}`

  if (format === 'xlsx') {
    const buffer = await generarXLSX(semana, sede, grid)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`)
    return res.send(buffer)
  }

  const buffer = await generarPDFSemana(semana, sede, grid, fechaIni, fechaFin)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`)
  res.send(buffer)
}

function celdaText(a) {
  const partes = [
    a.resource?.name ?? '—',
    `${a.startTime}–${a.endTime}`,
  ]
  if (a.assistant?.name) partes.push(`Aux: ${a.assistant.name}`)
  if (a.assistant2?.name) partes.push(`Aux2: ${a.assistant2.name}`)
  partes.push(`${a.patientsCapacity} pac.`)
  return partes.join('\n')
}

function generarPDFSemana(semana, sede, grid, fechaIni, fechaFin) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 25, size: 'A3', layout: 'landscape' })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Encabezado
      doc.fillColor('#1B2A6C').fontSize(16).font('Helvetica-Bold').text('SGRC · Horarios semanales', 25, 25)
      doc.fillColor('#374151').fontSize(11).font('Helvetica')
        .text(`Sede: ${sede.name}${sede.city ? ' · ' + sede.city : ''}`, 25, 48)
      doc.text(`Semana: ${fechaIni} → ${fechaFin}`, 25, 63)
      doc.fillColor('#6B7280').fontSize(8)
        .text(`Generado: ${new Date().toLocaleString('es-CO')}`, 25, 78)

      // Tabla: Consultorio | LUN | MAR | MIÉ | JUE | VIE | SÁB | DOM
      const startX = 25
      const startY = 100
      const anchoCons = 110
      const anchoDia = (1140 - anchoCons) / 7
      const filaAlto = 90

      // Encabezado tabla
      doc.rect(startX, startY, anchoCons, 22).fill('#1B2A6C')
      doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('CONSULTORIO', startX + 4, startY + 7)
      DIAS.forEach((d, i) => {
        const x = startX + anchoCons + i * anchoDia
        doc.rect(x, startY, anchoDia, 22).fill('#1B2A6C')
        doc.fillColor('white').text(DIA_LABEL[d], x + 4, startY + 7)
      })

      let y = startY + 22
      grid.forEach((row, idx) => {
        // Salto de página si no cabe
        if (y + filaAlto > doc.page.height - 30) {
          doc.addPage()
          y = 40
        }
        const bg = idx % 2 === 0 ? '#F9FAFB' : '#FFFFFF'
        doc.rect(startX, y, anchoCons, filaAlto).fill(bg)
        doc.fillColor('#1F2937').fontSize(8).font('Helvetica-Bold').text(row.room.name, startX + 4, y + 6, { width: anchoCons - 8 })
        doc.fillColor('#6B7280').fontSize(7).font('Helvetica').text(row.room.specialty ?? '', startX + 4, y + 22, { width: anchoCons - 8 })

        DIAS.forEach((d, i) => {
          const x = startX + anchoCons + i * anchoDia
          doc.rect(x, y, anchoDia, filaAlto).fill(bg).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
          const asigs = row.dias[d]
          let cy = y + 4
          asigs.slice(0, 3).forEach((a) => {
            doc.fillColor('#111827').fontSize(6.5).font('Helvetica').text(celdaText(a), x + 3, cy, { width: anchoDia - 6, height: 25 })
            cy += 27
          })
          if (asigs.length > 3) {
            doc.fillColor('#6B7280').fontSize(6).text(`+ ${asigs.length - 3} más`, x + 3, cy)
          }
        })

        y += filaAlto
      })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

async function generarXLSX(semana, sede, grid) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SGRC'
  const ws = wb.addWorksheet('Horarios semana')

  // Encabezado meta
  ws.mergeCells('A1:H1')
  ws.getCell('A1').value = `Horarios semanales — ${sede.name}${sede.city ? ' · ' + sede.city : ''}`
  ws.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF1B2A6C' } }
  ws.mergeCells('A2:H2')
  ws.getCell('A2').value = `Semana: ${semana.startDate.toISOString().slice(0,10)} → ${semana.endDate.toISOString().slice(0,10)}`
  ws.getCell('A2').font = { size: 10 }

  // Header tabla
  const headers = ['Consultorio', ...DIAS.map((d) => DIA_LABEL[d])]
  const headerRow = ws.addRow([])
  ws.addRow(headers).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A6C' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
  })

  // Filas
  grid.forEach((row) => {
    const excelRow = ws.addRow([
      `${row.room.name}${row.room.specialty ? '\n' + row.room.specialty : ''}`,
      ...DIAS.map((d) => row.dias[d].map(celdaText).join('\n\n')),
    ])
    excelRow.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: 'top' }
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
      cell.font = { size: 9 }
    })
    excelRow.height = Math.max(60, row.dias.lunes.length * 40)
  })

  // Anchos
  ws.getColumn(1).width = 24
  for (let i = 2; i <= 8; i++) ws.getColumn(i).width = 26

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ============================================================================
// Oct-2026 · PROYECTOS-3739 punto 4 · TURNO EN CONTINGENCIA (agenda colchón)
// Hector, 21-oct: "turno en contingencia". El coordinador lo marca y sale
// naranja con los pacientes vacíos; la líder (o gerencia) pone los pacientes y
// lo aprueba, y vuelve a su color normal.
// ============================================================================
const aprobarContingenciaSchema = z.object({
  patientCapacity: z.number({ required_error: 'Indica los pacientes' }).int().min(0).max(500),
})

async function turnoParaContingencia(req) {
  const a = await prisma.assignment.findUnique({
    where: { id: req.params.id },
    include: { room: { select: { name: true, siteId: true, site: { select: { name: true } } } }, resource: { select: { name: true } } },
  })
  if (!a) throw errors.notFound('Asignación no encontrada')
  assertSedePermitida(req.user, a.room.siteId, a.room.site?.name)
  if (a.status === 'cancelada') throw errors.badRequest('El turno está cancelado.')
  return a
}

export async function marcarContingencia(req, res) {
  const a = await turnoParaContingencia(req)
  if (a.contingency) throw errors.badRequest('Ese turno ya está en contingencia.')
  const actualizada = await prisma.assignment.update({
    where: { id: a.id },
    data: { contingency: true, patientCapacity: 0 },
  })
  await registrarAuditoria({
    userId: req.user.id, action: 'contingencia_marcar', entity: 'asignaciones', entityId: a.id,
    oldValue: { pacientes: a.patientCapacity }, newValue: { ...resumenAsignacion(a), contingencia: true },
    ipAddress: getIp(req),
  })
  res.json(actualizada)
}

export async function aprobarContingencia(req, res) {
  const { patientCapacity } = aprobarContingenciaSchema.parse(req.body)
  const a = await turnoParaContingencia(req)
  if (!a.contingency) throw errors.badRequest('Ese turno no está en contingencia.')
  if (a.coveredAbsenceId) {
    const pendientes = await pacientesPorReprogramar(prisma, a.coveredAbsenceId, a.id)
    if (pendientes != null && patientCapacity > pendientes) {
      throw errors.badRequest(`Quedan ${pendientes} pacientes por reprogramar en el caso: no se pueden poner ${patientCapacity}.`)
    }
  }
  const actualizada = await prisma.assignment.update({
    where: { id: a.id },
    data: { contingency: false, patientCapacity },
  })
  await registrarAuditoria({
    userId: req.user.id, action: 'contingencia_aprobar', entity: 'asignaciones', entityId: a.id,
    oldValue: { contingencia: true }, newValue: { ...resumenAsignacion({ ...a, patientCapacity }), contingencia: false },
    ipAddress: getIp(req),
  })
  res.json(actualizada)
}
