import { prisma } from '../lib/prisma.js'
import { validarLote } from './batchValidationService.js'
import { calcularCapacidad } from './assignmentService.js'
import { horasEfectivasFranja } from '../lib/workHours.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { sedesDeUsuario } from '../lib/siteScope.js'

/**
 * COPIA VALIDADA DE ASIGNACIONES
 *
 * Punto único por el que pasan las cuatro operaciones de copia:
 *   - POST /asignaciones/copiar-dia
 *   - POST /asignaciones/copiar-consultorio
 *   - POST /asignaciones/:id/copiar-a-dias
 *   - POST /semanas/:id/copiar
 *
 * Antes cada una hacía algo distinto: las tres primeras llamaban a
 * crearAsignacion() en un bucle anidado (~360 consultas encadenadas para copiar
 * un día a cinco días), y copiar una semana insertaba con createMany SIN validar
 * nada, así que podía crear solapes en silencio.
 *
 * Ahora las cuatro:
 *   1. cargan el estado necesario en 4 consultas,
 *   2. validan TODAS las candidatas en memoria (validacionLote.js),
 *   3. insertan las que pasan con un solo createMany,
 *   4. devuelven el detalle de las omitidas y por qué.
 *
 * El coordinador ve "37 copiadas, 3 omitidas" con el motivo de cada una, en vez
 * de "40 copiadas" con tres solapes creados sin avisar.
 */

/** Roles que pueden escribir en una sede cuyo cierre semanal ya se procesó. */
const ROLES_EDITAN_CERRADA = new Set(['supervisor', 'gerencia'])

/**
 * Carga de una vez todo lo que el validador necesita.
 * 4 consultas, independientemente de cuántas asignaciones se copien.
 */
async function cargarEstado({ semanaIds, recursoIds, consultorioIds }, client) {
  const [asignaciones, recursosBd, consultoriosBd, cierres] = await Promise.all([
    client.assignment.findMany({
      where: { weekId: { in: semanaIds }, status: { not: 'cancelada' } },
      select: {
        weekId: true, weekday: true, roomId: true,
        resourceId: true, assistantId: true, assistant2Id: true,
        startTime: true, endTime: true,
        assistantStartTime: true, assistantEndTime: true,
        assistant2StartTime: true, assistant2EndTime: true,
      },
    }),
    client.resource.findMany({
      where: { id: { in: recursoIds } },
      select: {
        id: true, name: true, active: true, type: true,
        multiRoom: true, maxHoursPerDay: true, maxHoursPerWeek: true,
        slotMinutes: true,
      },
    }),
    client.room.findMany({
      where: { id: { in: consultorioIds } },
      select: {
        id: true, name: true, siteId: true, specialty: true,
        requiresAssistant: true,
        site: { select: { name: true, city: true } },
      },
    }),
    client.weekSiteClosure.findMany({
      where: { weekId: { in: semanaIds } },
      select: { weekId: true, siteId: true },
    }),
  ])

  return {
    assignments: asignaciones,
    resources: new Map(recursosBd.map((r) => [r.id, r])),
    rooms: new Map(consultoriosBd.map((c) => [c.id, c])),
    sedesCerradas: new Set(cierres.map((c) => `${c.weekId}|${c.siteId}`)),
  }
}

/**
 * Los consultorios de las asignaciones YA EXISTENTES también hacen falta: el
 * validador mira su ciudad (RN-09) y su nombre para el mensaje de conflicto.
 */
function idsNecesarios(candidatas, asignacionesExistentes = []) {
  const recursoIds = new Set()
  const consultorioIds = new Set()
  for (const c of [...candidatas, ...asignacionesExistentes]) {
    for (const r of [c.resourceId, c.assistantId, c.assistant2Id]) if (r) recursoIds.add(r)
    if (c.roomId) consultorioIds.add(c.roomId)
  }
  return { recursoIds: [...recursoIds], consultorioIds: [...consultorioIds] }
}

/** Horas efectivas que cada recurso ya acumula en cada semana (para horas extras). */
function horasSemanalesPrevias(asignaciones, recursos) {
  const acc = new Map()
  for (const a of asignaciones) {
    for (const rid of [a.resourceId, a.assistantId, a.assistant2Id]) {
      if (!rid) continue
      const r = recursos.get(rid)
      if (!r) continue
      const k = `${a.weekId}|${rid}`
      acc.set(k, (acc.get(k) ?? 0) + horasEfectivasFranja(a.startTime, a.endTime, r.type))
    }
  }
  return acc
}

/**
 * Valida e inserta un lote de asignaciones.
 *
 * @param {Array}  candidatas  Asignaciones a crear (mismo shape que la tabla).
 * @param {object} opciones
 * @param {string} opciones.userRol
 * @param {object} [opciones.client]  Cliente Prisma o transacción.
 * @returns {{ copiadas:number, omitidas:number, errores:Array, creadas:Array }}
 */
export async function copiarAsignacionesValidadas(candidatas, { userRol, userSedes = null, client = prisma } = {}) {
  if (candidatas.length === 0) {
    return { copied: 0, skipped: 0, errors: [], created: [] }
  }

  const semanaIds = [...new Set(candidatas.map((c) => c.weekId))]

  // Primera pasada: traer las asignaciones existentes para saber qué otros
  // recursos y consultorios entran en juego (los de los conflictos potenciales).
  const previas = await client.assignment.findMany({
    where: { weekId: { in: semanaIds }, status: { not: 'cancelada' } },
    select: { resourceId: true, assistantId: true, assistant2Id: true, roomId: true },
  })
  const { recursoIds, consultorioIds } = idsNecesarios(candidatas, previas)

  const estado = await cargarEstado({ semanaIds, recursoIds, consultorioIds }, client)
  const previasHoras = horasSemanalesPrevias(estado.assignments, estado.resources)

  // El acumulado semanal solo alimenta la marca de horas extras (no bloquea).
  const conContexto = candidatas.map((c) => ({
    ...c,
    _horasSemanaPrevias: previasHoras.get(`${c.weekId}|${c.resourceId}`) ?? 0,
  }))

  const { aceptadas, skipped: omitidas } = validarLote(conContexto, {
    ...estado,
    // programacionLibre() levanta el cierre para todos los roles mientras dure
    // el modo temporal; fuera de él, solo supervisor y gerencia.
    puedeEditarCerrada: programacionLibre() || ROLES_EDITAN_CERRADA.has(userRol),
    // Aislamiento por sede (S-1): null para roles globales, el conjunto propio
    // para el coordinador. Se deriva del mismo helper que usa el resto del CRUD.
    sedesPermitidas: sedesDeUsuario({ role: userRol, sites: userSedes ?? [] }),
  })

  const filas = aceptadas.map((a) => {
    const recurso = estado.resources.get(a.resourceId)
    return {
      weekId: a.weekId,
      resourceId: a.resourceId,
      assistantId: a.assistantId ?? null,
      assistant2Id: a.assistant2Id ?? null,
      assistantStartTime: a.assistantStartTime ?? null,
      assistantEndTime: a.assistantEndTime ?? null,
      assistant2StartTime: a.assistant2StartTime ?? null,
      assistant2EndTime: a.assistant2EndTime ?? null,
      roomId: a.roomId,
      weekday: a.weekday,
      startTime: a.startTime,
      endTime: a.endTime,
      // Se respeta la capacidad del origen si venía; si no, se recalcula igual
      // que hace crearAsignacion.
      patientCapacity: a.patientCapacity ?? calcularCapacidad(
        a.startTime, a.endTime, recurso?.slotMinutes ?? 15, recurso?.type,
      ),
      isOvertime: a.isOvertime,
      hasNightHours: a.hasNightHours,
    }
  })

  if (filas.length > 0) {
    await client.assignment.createMany({ data: filas })
  }

  return {
    copied: filas.length,
    skipped: omitidas.length,
    errors: omitidas.map((o) => ({
      day: o.candidata.weekday,
      room: estado.rooms.get(o.candidata.roomId)?.name ?? null,
      resource: estado.resources.get(o.candidata.resourceId)?.name ?? null,
      reason: o.reason,
      message: o.message,
    })),
    created: filas,
  }
}
