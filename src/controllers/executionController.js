import { z } from 'zod'
import { format } from 'date-fns'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

// =============================================================================
// AISLAMIENTO POR SEDE — fix incidente jun-2026
// =============================================================================
// El coord SOLO puede leer/registrar ejecuciones de las sedes a las que está
// vinculado en `usuarios_sedes`. Supervisor y gerencia tienen vista global.
// Antes los endpoints no validaban esto; un coord podía registrar ejecuciones
// de otra sede si conocía el asignacionId. Mismo patrón que el bug histórico
// de "copiar semana".
//
// `sedesDelUsuario` carga las sedes del coord (o devuelve null para roles con
// acceso global). Caché en req para no consultar varias veces en saveDay.
async function sedesDelUsuario(req) {
  if (req._sedesCache !== undefined) return req._sedesCache
  // supervisor/gerencia: acceso global. recurso (aux): NO se filtra por sede
  // (la restricción del aux es por auxiliarId — se aplica aparte). Solo el
  // coordinador se filtra por su set de sedes vinculadas en usuarios_sedes.
  if (req.user.role === 'supervisor' || req.user.role === 'gerencia' || req.user.role === 'recurso') {
    req._sedesCache = null
    return null
  }
  const vinculos = await prisma.userSite.findMany({
    where: { userId: req.user.id },
    select: { siteId: true },
  })
  req._sedesCache = new Set(vinculos.map((v) => v.siteId))
  return req._sedesCache
}

// Lanza errors.forbidden si el coord no está vinculado a la sede del consultorio
// de la asignación. Para sup/gerencia siempre pasa.
async function validarAsignacionEsDeMisSedes(req, asignacionId) {
  const sedes = await sedesDelUsuario(req)
  if (sedes === null) return  // sup/ger acceso global
  const asig = await prisma.assignment.findUnique({
    where: { id: asignacionId },
    select: { room: { select: { siteId: true } } },
  })
  if (!asig) throw errors.notFound('Asignación no encontrada')
  if (!sedes.has(asig.room.siteId)) {
    throw errors.forbidden('No tienes permiso sobre esta asignación — no pertenece a tu sede')
  }
}

// =============================================================================
// AISLAMIENTO POR AUXILIAR (rol recurso) — aux 2026-08
// =============================================================================
// Un usuario con rol="recurso" (auxiliar) solo puede leer/registrar ejecución
// de asignaciones donde ÉL sea el auxiliar (asignacion.auxiliarId === recursoId
// del usuario). Doble llave — además del filtro server-side en misPendientesDelDia,
// las mutaciones (POST /ejecucion, /batch, PATCH pacientes-capacidad) validan
// server-side el ownership por auxiliarId. Nunca confiar en el frontend.
//
// Devuelve el recursoId vinculado al usuario logueado. Solo aplica a rol recurso:
// para el resto de roles devuelve null (no aplica filtro por auxiliarId).
// Lanza forbidden si el usuario rol=recurso no tiene recursoId vinculado.
async function recursoIdDelUsuario(req) {
  if (req._recursoIdCache !== undefined) return req._recursoIdCache
  if (req.user.role !== 'recurso') {
    req._recursoIdCache = null
    return null
  }
  const u = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { resourceId: true },
  })
  if (!u?.resourceId) {
    throw errors.forbidden('Tu usuario no está vinculado a un recurso. Contacta al supervisor.')
  }
  req._recursoIdCache = u.resourceId
  return u.resourceId
}

const ESTADOS = ['completa', 'parcial', 'no_ejecutada']
const emptyToUndef = (v) => (v === '' ? undefined : v)

// ============================================================================
// TEMPORAL (jul-2026): flag para desactivar el chequeo de "plazo de cierre"
// del registro de ejecución (lunes 23:59). Cuando está en `true`, cualquier
// coord puede registrar ejecución de cualquier día de la semana visible
// aunque haya pasado el lunes 23:59.
//
// Para RESTAURAR la seguridad normal: cambiar a `false` (una sola línea) y
// deploy backend + pm2 restart. El resto de la lógica sigue intacta.
// ============================================================================
const BYPASS_PLAZO_CIERRE = true

const crearSchema = z.object({
  assignmentId: z.string().uuid(),
  patientsSeen: z.number().int().min(0),
  shiftStatus: z.preprocess(emptyToUndef, z.enum(ESTADOS).optional()),
  notes: z.preprocess(emptyToUndef, z.string().optional()),
})

const batchSchema = z.object({
  registros: z.array(crearSchema),
})

/**
 * Fecha límite para registrar la ejecución de las asignaciones de una semana.
 *
 * Regla de negocio (actualizada 2026): la semana corre domingo → sábado y el
 * registro de ejecución cierra el LUNES siguiente a las 23:59:59 (es decir,
 * 2 días después del sábado fin de semana). Si ese lunes es festivo, el cierre
 * se corre al siguiente día hábil (martes → miércoles → ... hasta no-festivo).
 *
 * fechaInicio viene de MySQL @db.Date como UTC-midnight del día calendario.
 * Operamos en UTC para evitar shifts de zona horaria. Construimos la fecha
 * 23:59:59 en LOCAL time del servidor (configurado en zona Bogotá).
 */
async function cierreEjecucionDe(semana) {
  const d = new Date(semana.startDate)
  const dowUtc = d.getUTCDay()                       // 0=dom, ..., 5=vie, 6=sáb
  // distAlSabado: días hasta el sábado de ESTA semana (fin de la semana operativa).
  const distAlSabado = (6 - dowUtc + 7) % 7
  // Lunes-de-cierre = sábado + 2 días (lunes de la semana siguiente).
  const yyyy = d.getUTCFullYear()
  const mm = d.getUTCMonth()
  let dd = d.getUTCDate() + distAlSabado + 2

  // Corrimiento por festivo: si el lunes es festivo, mover al siguiente día hábil.
  // Consultamos el catálogo de festivos en BD (gestionado por el supervisor).
  // Evaluamos hasta 7 días por seguridad (no hay 7 festivos seguidos en Colombia).
  for (let intentos = 0; intentos < 7; intentos++) {
    const candidato = new Date(Date.UTC(yyyy, mm, dd))
    const esFestivo = await prisma.holiday.findUnique({ where: { date: candidato } })
    if (!esFestivo) break
    dd += 1
  }

  return new Date(yyyy, mm, dd, 23, 59, 59, 999)     // lunes/siguiente hábil 23:59:59 LOCAL
}

export async function pendientesDelDia(req, res) {
  const { week_id: semana_id, day: dia, site_id: sede_id } = req.query
  if (!semana_id || !dia) throw errors.badRequest('Parámetros requeridos: semana_id, dia')

  // AISLAMIENTO POR SEDE: para coordinador, filtramos SIEMPRE por sus sedes
  // (ignoramos sede_id si lo manda y no corresponde a una sede suya — el coord
  // no puede leer asignaciones de otras sedes). Para supervisor/gerencia,
  // si manda sede_id se respeta como filtro opcional; si no, devuelve global.
  const sedesUser = await sedesDelUsuario(req)

  const where = { weekId: semana_id, weekday: dia, status: { not: 'cancelada' } }
  if (sedesUser !== null) {
    // Coordinador: forzar filtro a SUS sedes
    const sedesFiltradas = sede_id && sedesUser.has(sede_id)
      ? [sede_id]                       // mando una sede mía → solo esa
      : [...sedesUser]                  // sin sede_id o sede ajena → todas las mías
    where.room = { is: { siteId: { in: sedesFiltradas } } }
  } else if (sede_id) {
    where.room = { is: { siteId: sede_id } }
  }

  const asigs = await prisma.assignment.findMany({
    where,
    include: {
      room: true,
      resource: true,
      assistant: true,
      execution: true,
    },
  })
  res.json(asigs)
}

/**
 * Vista del AUXILIAR: sus asignaciones del día donde él es el aux
 * (auxiliarId === recursoId del usuario logueado). El filtro es server-side —
 * el frontend no puede pedir asignaciones ajenas cambiando el query.
 */
export async function misPendientesDelDia(req, res) {
  const { week_id: semana_id, day: dia } = req.query
  if (!semana_id || !dia) throw errors.badRequest('Parámetros requeridos: semana_id, dia')

  const recursoId = await recursoIdDelUsuario(req)
  if (!recursoId) throw errors.forbidden('Este endpoint es solo para el rol recurso')

  const asigs = await prisma.assignment.findMany({
    where: {
      weekId: semana_id,
      weekday: dia,
      status: { not: 'cancelada' },
      // Aux: aparece como aux1 o aux2 en la asignación (bug histórico: el sistema
      // usa auxiliarId como principal; auxiliar2Id existe pero rara vez se popula).
      OR: [
        { assistantId: recursoId },
        { assistant2Id: recursoId },
      ],
    },
    include: {
      room: true,
      resource: true,
      assistant: true,
      execution: true,
    },
    orderBy: { startTime: 'asc' },
  })
  res.json(asigs)
}

export async function get(req, res) {
  const { assignment_id: asignacion_id } = req.query
  if (!asignacion_id) throw errors.badRequest('asignacion_id requerido')
  // AISLAMIENTO: valida que el coord pertenezca a la sede de esta asignación.
  // Para sup/ger es no-op (acceso global).
  await validarAsignacionEsDeMisSedes(req, asignacion_id)
  const e = await prisma.execution.findUnique({ where: { assignmentId: asignacion_id } })
  res.json(e)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)

  // AISLAMIENTO POR SEDE: el coord solo puede registrar ejecución en su sede.
  await validarAsignacionEsDeMisSedes(req, data.assignmentId)

  // AISLAMIENTO POR AUXILIAR: si es rol recurso, solo puede registrar ejecución
  // de asignaciones donde él sea el auxiliar.
  const recursoIdActor = await recursoIdDelUsuario(req)
  if (recursoIdActor) {
    const dueño = await prisma.assignment.findUnique({
      where: { id: data.assignmentId },
      select: { assistantId: true, assistant2Id: true },
    })
    if (!dueño || (dueño.assistantId !== recursoIdActor && dueño.assistant2Id !== recursoIdActor)) {
      throw errors.forbidden('No eres el auxiliar asignado — no puedes registrar esta ejecución')
    }
  }

  // Cierre semanal: el registro cierra el lunes siguiente 23:59 (o siguiente
  // día hábil si el lunes es festivo). Después de esa fecha no se acepta editar.
  const asig = await prisma.assignment.findUnique({
    where: { id: data.assignmentId },
    include: { week: true },
  })
  if (!asig) throw errors.notFound('Asignación no encontrada')
  // Chequeo de plazo (lunes 23:59). Se puede desactivar con BYPASS_PLAZO_CIERRE.
  if (!BYPASS_PLAZO_CIERRE) {
    const cierre = await cierreEjecucionDe(asig.week)
    if (new Date() > cierre) {
      throw errors.forbidden(`El registro de ejecución de esta semana cerró el ${format(cierre, 'EEEE d MMM HH:mm')}`)
    }
  }

  // Si ya existe, validar bloqueo manual y actualizar
  const existente = await prisma.execution.findUnique({ where: { assignmentId: data.assignmentId } })
  if (existente) {
    if (existente.locked) {
      throw errors.forbidden('Este registro de ejecución está bloqueado')
    }
    const actualizada = await prisma.execution.update({
      where: { assignmentId: data.assignmentId },
      data: {
        patientsSeen: data.patientsSeen,
        shiftStatus: data.shiftStatus ?? 'completa',
        notes: data.notes,
      },
    })
    await registrarAuditoria({
      userId: req.user.id,
      action: 'ejecucion_actualizar',
      entity: 'ejecucion',
      entityId: actualizada.id,
      oldValue: {
        patientsSeen: existente.patientsSeen,
        shiftStatus: existente.shiftStatus,
        notes: existente.notes,
      },
      newValue: {
        patientsSeen: actualizada.patientsSeen,
        shiftStatus: actualizada.shiftStatus,
        notes: actualizada.notes,
      },
      ipAddress: getIp(req),
    })
    return res.json(actualizada)
  }

  const nueva = await prisma.execution.create({
    data: {
      assignmentId: data.assignmentId,
      patientsSeen: data.patientsSeen,
      shiftStatus: data.shiftStatus ?? 'completa',
      notes: data.notes,
      recordedBy: req.user.id,
    },
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'ejecucion_crear',
    entity: 'ejecucion',
    entityId: nueva.id,
    newValue: {
      assignmentId: nueva.assignmentId,
      patientsSeen: nueva.patientsSeen,
      shiftStatus: nueva.shiftStatus,
      notes: nueva.notes,
    },
    ipAddress: getIp(req),
  })
  res.status(201).json(nueva)
}

export async function saveDay(req, res) {
  const { registros } = batchSchema.parse(req.body)

  // Una sola consulta para todas las asignaciones del batch (cada una con su semana)
  const ids = registros.map((r) => r.assignmentId)
  const asigs = await prisma.assignment.findMany({
    where: { id: { in: ids } },
    include: {
      week: true,
      room: { select: { siteId: true } },
    },
  })
  const asigMap = Object.fromEntries(asigs.map((a) => [a.id, a]))

  // AISLAMIENTO POR SEDE: para coord, validar que TODOS los registros del
  // batch pertenezcan a sus sedes. Si alguno no, rechazamos el batch entero
  // (es más seguro que ejecutar parcialmente — el frontend del coord nunca
  // debería mandar asignaciones de otra sede; si pasa, es bug o intento).
  const sedesUser = await sedesDelUsuario(req)
  if (sedesUser !== null) {
    const ajenas = asigs.filter((a) => !sedesUser.has(a.room.siteId))
    if (ajenas.length > 0) {
      throw errors.forbidden(`El batch incluye ${ajenas.length} asignación(es) de sedes que no coordinas. Operación rechazada.`)
    }
  }

  // AISLAMIENTO POR AUXILIAR: si el actor es rol recurso, validar que TODAS
  // las asignaciones del batch le pertenezcan como aux (aux1 o aux2). Rechazo
  // total en bloque — misma política que sedes. Requiere include auxiliarId +
  // auxiliar2Id, que ya vienen por default en findMany sin select restrictivo.
  const recursoIdBatch = await recursoIdDelUsuario(req)
  if (recursoIdBatch) {
    const ajenas = asigs.filter((a) => a.assistantId !== recursoIdBatch && a.assistant2Id !== recursoIdBatch)
    if (ajenas.length > 0) {
      throw errors.forbidden(`El batch incluye ${ajenas.length} asignación(es) que no te corresponden como auxiliar. Operación rechazada.`)
    }
  }

  let count = 0
  let creadas = 0
  let actualizadas = 0
  let bloqueadas = 0
  let fueraDePlazo = 0
  const idsCreados = []
  const idsActualizados = []
  for (const data of registros) {
    const asig = asigMap[data.assignmentId]
    if (!asig) continue

    if (!BYPASS_PLAZO_CIERRE) {
      const cierre = await cierreEjecucionDe(asig.week)
      if (new Date() > cierre) { fueraDePlazo++; continue }
    }

    const existente = await prisma.execution.findUnique({ where: { assignmentId: data.assignmentId } })
    if (existente) {
      if (existente.locked) { bloqueadas++; continue }
      const upd = await prisma.execution.update({
        where: { assignmentId: data.assignmentId },
        data: {
          patientsSeen: data.patientsSeen,
          shiftStatus: data.shiftStatus ?? 'completa',
          notes: data.notes,
        },
      })
      actualizadas++
      idsActualizados.push(upd.id)
    } else {
      const nueva = await prisma.execution.create({
        data: {
          assignmentId: data.assignmentId,
          patientsSeen: data.patientsSeen,
          shiftStatus: data.shiftStatus ?? 'completa',
          notes: data.notes,
          recordedBy: req.user.id,
        },
      })
      creadas++
      idsCreados.push(nueva.id)
    }
    count++
  }

  // Auditoría del batch: una sola entrada con resumen + IDs para trazabilidad.
  if (creadas > 0 || actualizadas > 0 || bloqueadas > 0 || fueraDePlazo > 0) {
    await registrarAuditoria({
      userId: req.user.id,
      action: 'ejecucion_batch_guardar',
      entity: 'ejecucion',
      entityId: null,
      newValue: {
        rolActor: req.user.role,
        created: creadas,
        actualizadas,
        bloqueadas,
        fueraDePlazo,
        idsCreados,
        idsActualizados,
      },
      ipAddress: getIp(req),
    })
  }

  res.json({ count, created: creadas, actualizadas, bloqueadas, fueraDePlazo })
}
