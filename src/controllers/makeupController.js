import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import {
  notificar,
  notificarCoordinadoresDeSede,
  notificarDireccionMedica,
} from '../services/notificationService.js'

// ============================================================================
// Fase 3 (ago-2026) — Reposición de ausencias.
//
// Flujo:
//   1. Profesional (rol=recurso) con ausencia CONFIRMADA propone reponer →
//      POST /reposiciones (estado='solicitada').
//   2. Coordinador de la sede + Dirección Médica reciben notificación.
//   3. Coord/gerencia aprueba o rechaza → PUT /reposiciones/:id/aprobar|rechazar.
//   4. El profesional queda notificado con el resultado.
//   5. (Opcional) tras la fecha, se marca realizada.
// ============================================================================

const emptyToUndef = (v) => (v === '' ? undefined : v)

const TIPOS_REPOSICION = ['misma_agenda', 'otra_sede', 'doble_jornada', 'otro']

const crearSchema = z.object({
  absenceId: z.string().uuid(),
  // Formato YYYY-MM-DD estricto. Sin regex, Zod aceptaba "tomorrow" y
  // rompía con 500 dentro de Prisma (ver verify Fase 3).
  makeupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  makeupType: z.enum(TIPOS_REPOSICION),
  requestReason: z.string().min(5, 'El motivo es obligatorio (mín 5 caracteres)'),
  roomId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  estimatedPatients: z.preprocess(
    emptyToUndef,
    z.coerce.number().int().min(0).max(999).optional().nullable(),
  ),
})

// ============================================================================
// Helper: sedes en las que "trabaja" un recurso (sedes de sus asignaciones no
// canceladas). Se usa para el sede-scope de coord/supervisor sobre reposiciones
// (verify Fase 3 encontró IDOR cross-sede en aprobar/rechazar/crear).
// Alternativa: usuario.sedes — no cubre recursos sin usuario vinculado, por
// eso preferimos asignaciones.
// ============================================================================
async function sedesDelRecurso(recursoId) {
  if (!recursoId) return []
  const asigs = await prisma.assignment.findMany({
    where: {
      OR: [{ resourceId: recursoId }, { assistantId: recursoId }],
      status: { not: 'cancelada' },
    },
    include: { room: { select: { siteId: true } } },
  })
  return [...new Set(asigs.map((a) => a.room.siteId))]
}

// Asegura que el coord tiene jurisdicción sobre el recurso. Gerencia/supervisor
// pasan derecho. directivo también (solo lee). Recurso solo su propio.
async function asegurarJurisdiccion(req, recursoId) {
  const rol = req.user?.role
  if (rol !== 'coordinador') return  // sup/gerencia/directivo/recurso ya validados por otro lado
  const sedes = await sedesDelRecurso(recursoId)
  const misSedes = req.user.sites ?? []
  const overlap = sedes.some((s) => misSedes.includes(s))
  if (!overlap) {
    throw errors.forbidden('No tienes jurisdicción sobre este profesional')
  }
}

const aprobarSchema = z.object({
  approverNote: z.preprocess(emptyToUndef, z.string().max(2000).optional()),
})

const rechazarSchema = z.object({
  reason: z.string().min(5, 'El motivo del rechazo es obligatorio (mín 5 caracteres)'),
})

// ============================================================================
// GET /reposiciones
// Filtros: estado, ausencia_id, recurso_id, sede_id
// Scoping por rol:
//   - recurso: solo sus propias reposiciones (por ausencia.recursoId)
//   - coordinador: solo las de sus sedes
//   - supervisor/gerencia/directivo: todo (con filtro opcional por sede_id)
// ============================================================================
export async function list(req, res) {
  const { status: estado, absence_id: ausencia_id, resource_id: recurso_id, site_id: sede_id } = req.query
  const rol = req.user?.role
  const where = {}

  if (estado) where.status = estado
  if (ausencia_id) where.absenceId = ausencia_id

  if (rol === 'recurso') {
    // El profesional solo ve sus propias reposiciones.
    where.absence = { is: { resourceId: req.user.resourceId ?? '__no_recurso__' } }
  } else if (rol === 'coordinador') {
    const misSedes = req.user.sites ?? []
    // Coord SIN sedes asignadas no ve nada — antes caía a query sin filtro y
    // devolvía TODO el sistema (verify Fase 3 flagged this as missing-auth).
    if (misSedes.length === 0) {
      res.json([])
      return
    }
    if (sede_id && !misSedes.includes(sede_id)) {
      throw errors.forbidden('No tienes acceso a esta sede')
    }
    const sedeFilter = sede_id ? [sede_id] : misSedes
    where.absence = {
      is: {
        resource: {
          is: { user: { is: { sites: { some: { siteId: { in: sedeFilter } } } } } },
        },
      },
    }
    if (recurso_id) {
      // Preserva el filtro anidado y agrega el filtro por recursoId.
      where.absence = {
        is: { ...where.absence.is, resourceId: recurso_id },
      }
    }
  } else {
    // supervisor / gerencia / directivo
    if (sede_id) {
      where.absence = {
        is: {
          resource: {
            is: { user: { is: { sites: { some: { siteId: sede_id } } } } },
          },
        },
      }
    }
    if (recurso_id) where.absence = { is: { ...(where.absence?.is ?? {}), resourceId: recurso_id } }
  }

  const items = await prisma.absenceMakeup.findMany({
    where,
    include: {
      absence: {
        include: {
          resource: true,
          reasonRef: { select: { id: true, code: true, name: true, family: true } },
        },
      },
      requester: { select: { id: true, name: true, email: true, role: true } },
      approver:   { select: { id: true, name: true, email: true, role: true } },
      room: { select: { id: true, name: true, siteId: true } },
    },
    orderBy: { requestedAt: 'desc' },
  })
  res.json(items)
}

// ============================================================================
// POST /reposiciones — solo rol=recurso propone reponer su propia ausencia.
// ============================================================================
export async function crear(req, res) {
  const body = crearSchema.parse(req.body)
  const rol = req.user?.role

  const ausencia = await prisma.absence.findUnique({
    where: { id: body.absenceId },
    include: { resource: true },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')
  if (ausencia.status !== 'confirmada') {
    throw errors.badRequest('Solo se puede reponer una ausencia confirmada')
  }

  // Ownership: el rol=recurso solo puede pedir reposición de su ausencia.
  // coord/sup/gerencia pueden crear en nombre del recurso (útil para llenar
  // el flujo cuando el prof no tiene el sistema disponible), pero SOLO si
  // el coord tiene jurisdicción sobre las sedes del recurso.
  if (rol === 'recurso' && ausencia.resourceId !== req.user.resourceId) {
    throw errors.forbidden('No puedes reponer una ausencia de otro profesional')
  }
  await asegurarJurisdiccion(req, ausencia.resourceId)

  // Consultorio opcional. Si viene, validamos que exista, esté activo y sea
  // de una sede donde el recurso realmente trabaja.
  if (body.roomId) {
    const c = await prisma.room.findUnique({ where: { id: body.roomId } })
    if (!c) throw errors.badRequest('Consultorio no encontrado')
    if (!c.active) throw errors.badRequest('Consultorio inactivo')
    const sedesRecurso = await sedesDelRecurso(ausencia.resourceId)
    if (sedesRecurso.length > 0 && !sedesRecurso.includes(c.siteId)) {
      throw errors.badRequest('El consultorio debe pertenecer a una sede donde trabaja el profesional')
    }
  }

  // Validación de horas: fin > inicio.
  if (body.endTime <= body.startTime) {
    throw errors.badRequest('La hora fin debe ser posterior a la hora inicio')
  }

  const reposicion = await prisma.absenceMakeup.create({
    data: {
      absenceId: body.absenceId,
      makeupDate: new Date(body.makeupDate),
      startTime: body.startTime,
      endTime: body.endTime,
      makeupType: body.makeupType,
      requestReason: body.requestReason,
      roomId: body.roomId ?? null,
      estimatedPatients: body.estimatedPatients ?? null,
      status: 'solicitada',
      requestedBy: req.user.id,
    },
    include: {
      absence: { include: { resource: true } },
      room: { select: { id: true, name: true, siteId: true } },
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'reposicion_solicitar',
    entity: 'reposiciones_ausencia',
    entityId: reposicion.id,
    newValue: {
      absenceId: reposicion.absenceId,
      date: body.makeupDate,
      type: body.makeupType,
    },
    ipAddress: getIp(req),
  })

  // ---- Notificaciones ----
  const detalles = detallesResumen(reposicion, ausencia)
  const front = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'

  // Sedes donde el recurso tiene asignaciones — para notificar a los coords correctos.
  const asigs = await prisma.assignment.findMany({
    where: {
      OR: [{ resourceId: ausencia.resourceId }, { assistantId: ausencia.resourceId }],
      status: { not: 'cancelada' },
    },
    include: { room: { select: { siteId: true } } },
  })
  const sedeIds = [...new Set(asigs.map((a) => a.room.siteId))]
  for (const sedeId of sedeIds) {
    await notificarCoordinadoresDeSede(sedeId, {
      type: 'reposicion_solicitada',
      title: `Reposición solicitada: ${ausencia.resource?.name ?? 'profesional'}`,
      message: `<p>El profesional <strong>${ausencia.resource?.name ?? ''}</strong> propuso una reposición para la ausencia del <strong>${new Date(ausencia.startDate).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}</strong>. Requiere tu aprobación.</p>`,
      contexto: 'Acción requerida — Reposiciones',
      criticidad: 'media',
      referenceId: reposicion.id,
      detalles,
      accionUrl: `${front}/app/ausencias-coord?tab=reposiciones`,
      accionTexto: 'Revisar reposición',
    })
  }

  // Dirección Médica: copia informativa.
  await notificarDireccionMedica({
    title: `Reposición solicitada: ${ausencia.resource?.name ?? 'profesional'}`,
    message: '<p>Se recibió una propuesta de reposición de ausencia. Está a la espera del coordinador de sede.</p>',
    contexto: 'Copia informativa — Reposiciones',
    detalles,
  })

  res.status(201).json(reposicion)
}

// ============================================================================
// PUT /reposiciones/:id/aprobar — coord/gerencia
// ============================================================================
export async function aprobar(req, res) {
  const { approverNote: notaAprobador } = aprobarSchema.parse(req.body ?? {})

  const rep = await prisma.absenceMakeup.findUnique({
    where: { id: req.params.id },
    include: { absence: { include: { resource: true } } },
  })
  if (!rep) throw errors.notFound('Reposición no encontrada')
  if (rep.status !== 'solicitada') {
    throw errors.badRequest(`La reposición ya fue procesada (estado: ${rep.status})`)
  }
  await asegurarJurisdiccion(req, rep.absence.resourceId)

  const actualizada = await prisma.absenceMakeup.update({
    where: { id: rep.id },
    data: {
      status: 'aprobada',
      approvedBy: req.user.id,
      approvedAt: new Date(),
      approverNote: notaAprobador ?? null,
    },
    include: {
      absence: { include: { resource: true } },
      room: { select: { id: true, name: true } },
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'reposicion_aprobar',
    entity: 'reposiciones_ausencia',
    entityId: rep.id,
    oldValue: { status: rep.status },
    newValue: { status: 'aprobada', nota: notaAprobador ?? null },
    ipAddress: getIp(req),
  })

  // Notificar al profesional que reportó la ausencia.
  const usuarioRecurso = await prisma.user.findUnique({ where: { resourceId: rep.absence.resourceId } })
  const detalles = detallesResumen(actualizada, actualizada.absence)
  const front = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  if (usuarioRecurso) {
    await notificar({
      userId: usuarioRecurso.id,
      type: 'reposicion_aprobada',
      title: 'Tu reposición fue aprobada',
      message: '<p>El coordinador aprobó tu solicitud de reposición de ausencia. Debes presentarte en el horario acordado.</p>',
      contexto: 'Confirmación — Reposiciones',
      criticidad: 'media',
      referenceId: rep.id,
      detalles,
      accionUrl: `${front}/app/ausencias`,
      accionTexto: 'Ver mis ausencias',
    })
  }

  await notificarDireccionMedica({
    title: `Reposición aprobada: ${rep.absence.resource?.name ?? ''}`,
    message: '<p>La reposición propuesta fue aprobada por el coordinador.</p>',
    contexto: 'Copia informativa — Reposiciones',
    detalles,
  })

  res.json(actualizada)
}

// ============================================================================
// PUT /reposiciones/:id/rechazar — coord/gerencia (motivo obligatorio)
// ============================================================================
export async function rechazar(req, res) {
  const { reason: motivo } = rechazarSchema.parse(req.body)

  const rep = await prisma.absenceMakeup.findUnique({
    where: { id: req.params.id },
    include: { absence: { include: { resource: true } } },
  })
  if (!rep) throw errors.notFound('Reposición no encontrada')
  if (rep.status !== 'solicitada') {
    throw errors.badRequest(`La reposición ya fue procesada (estado: ${rep.status})`)
  }
  await asegurarJurisdiccion(req, rep.absence.resourceId)

  const actualizada = await prisma.absenceMakeup.update({
    where: { id: rep.id },
    data: {
      status: 'rechazada',
      approvedBy: req.user.id,
      approvedAt: new Date(),
      rejectionReason: motivo,
    },
    include: {
      absence: { include: { resource: true } },
      room: { select: { id: true, name: true } },
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'reposicion_rechazar',
    entity: 'reposiciones_ausencia',
    entityId: rep.id,
    oldValue: { status: rep.status },
    newValue: { status: 'rechazada', reason: motivo },
    ipAddress: getIp(req),
  })

  // Notificar al profesional.
  const usuarioRecurso = await prisma.user.findUnique({ where: { resourceId: rep.absence.resourceId } })
  const detalles = [
    ...detallesResumen(actualizada, actualizada.absence),
    ['Motivo del rechazo', motivo],
  ]
  const front = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  if (usuarioRecurso) {
    await notificar({
      userId: usuarioRecurso.id,
      type: 'reposicion_rechazada',
      title: 'Tu reposición fue rechazada',
      message: `<p>El coordinador no aprobó tu solicitud de reposición. Puedes proponer otra fecha u horario y volver a solicitarla.</p>`,
      contexto: 'Novedad — Reposiciones',
      criticidad: 'media',
      referenceId: rep.id,
      detalles,
      accionUrl: `${front}/app/ausencias`,
      accionTexto: 'Ver mis ausencias',
    })
  }

  res.json(actualizada)
}

// ============================================================================
// PUT /reposiciones/:id/realizada — coord/gerencia marca que la reposición se
// ejecutó efectivamente. Útil para métricas.
// ============================================================================
export async function marcarRealizada(req, res) {
  const rep = await prisma.absenceMakeup.findUnique({
    where: { id: req.params.id },
    include: { absence: { select: { resourceId: true } } },
  })
  if (!rep) throw errors.notFound('Reposición no encontrada')
  if (rep.status !== 'aprobada') {
    throw errors.badRequest('Solo se marca realizada una reposición previamente aprobada')
  }
  await asegurarJurisdiccion(req, rep.absence.resourceId)
  const actualizada = await prisma.absenceMakeup.update({
    where: { id: rep.id },
    data: { completedAt: new Date() },
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'reposicion_realizada',
    entity: 'reposiciones_ausencia',
    entityId: rep.id,
    newValue: { completedAt: actualizada.completedAt },
    ipAddress: getIp(req),
  })
  res.json(actualizada)
}

// ============================================================================
// Helpers
// ============================================================================
function detallesResumen(rep, ausencia) {
  const fmtDate = (d) => new Date(d).toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
  })
  return [
    ['Profesional',         ausencia?.resource?.name ?? '—'],
    ['Ausencia original',   fmtDate(ausencia.startDate)],
    ['Fecha de reposición', fmtDate(rep.makeupDate)],
    ['Horario',             `${rep.startTime} – ${rep.endTime}`],
    ['Tipo',                TIPO_LABEL[rep.makeupType] ?? rep.makeupType],
    ['Motivo',              rep.requestReason],
    ...(rep.estimatedPatients != null ? [['Pacientes estimados', String(rep.estimatedPatients)]] : []),
  ]
}

const TIPO_LABEL = {
  misma_agenda:  'Misma agenda (mismo consultorio habitual)',
  otra_sede:     'Otra sede / consultorio',
  doble_jornada: 'Doble jornada (extender día habitual)',
  otro:          'Otro',
}
