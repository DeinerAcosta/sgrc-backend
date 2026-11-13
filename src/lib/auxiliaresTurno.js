import { auxiliaresDe } from './timeSlots.js'
import { hhmmAMinutos } from './workHours.js'

/**
 * LAS AUXILIARES DE UN TURNO — piezas comunes
 * ===========================================
 *
 * Nov-2026 · Hector: un turno lleva las auxiliares que hagan falta, en
 * secuencia hasta cubrir el horario del médico (o solapadas). Antes eran dos
 * columnas fijas en `asignaciones` (auxiliar_id / auxiliar2_id con sus horas);
 * ahora son filas de `asignacion_auxiliares` (modelo AssignmentAssistant).
 *
 * Aquí viven las piezas que repetían todos los controladores, para que leer,
 * escribir y devolver la lista se haga igual en todas partes:
 *   · los fragmentos de consulta de Prisma (include / select / where),
 *   · la conversión del body (lista nueva o los campos viejos de 2 auxiliares),
 *   · las filas a guardar (hora solo si difiere del turno),
 *   · el serializador de salida, que además rellena los campos viejos
 *     assistantId / assistant2Id… para el frontend que aún los lee.
 */

/** Para mostrar: la lista en orden, con nombre y tipo de cada auxiliar. */
export const INCLUDE_AUXILIARES = {
  orderBy: { position: 'asc' },
  select: {
    resourceId: true, startTime: true, endTime: true, position: true,
    breakStartTime: true, breakEndTime: true, coversBreakOf: true,
    resource: { select: { id: true, name: true, type: true } },
  },
}

/** Para calcular (conflictos, horas): sin el nombre. */
export const SELECT_AUXILIARES = {
  orderBy: { position: 'asc' },
  select: {
    resourceId: true, startTime: true, endTime: true, position: true,
    breakStartTime: true, breakEndTime: true, coversBreakOf: true,
  },
}

/** where: el turno tiene a `recursoId` (o a cualquiera de una lista) como auxiliar. */
export const whereEsAuxiliar = (recursoId) => ({
  assistants: { some: { resourceId: Array.isArray(recursoId) ? { in: recursoId } : recursoId } },
})

/** where: `recursoId` está en el turno como profesional o como auxiliar (en cualquier posición). */
export const whereParticipa = (recursoId) => ({
  OR: [
    { resourceId: Array.isArray(recursoId) ? { in: recursoId } : recursoId },
    whereEsAuxiliar(recursoId),
  ],
})

/**
 * La lista de auxiliares que pide el body, normalizada a
 * [{ resourceId, startTime, endTime }].
 *
 * Acepta las dos formas:
 *   · la nueva, `assistants: [{ resourceId, startTime?, endTime? }]`
 *     (el frontend manda resource_id / start_time / end_time y caseConverter
 *     lo pasa a camelCase);
 *   · la vieja, `assistantId` + `assistant2Id` con sus horas, para quien
 *     todavía no se haya actualizado.
 * Si vienen las dos, manda la nueva. Devuelve null si el body no dice nada de
 * auxiliares (ni lista ni campos viejos): al editar eso es "no tocar".
 */
export function listaAuxiliaresDelBody(data) {
  if (Array.isArray(data?.assistants)) {
    return data.assistants
      .filter((x) => x && x.resourceId)
      .map((x) => ({
        resourceId: x.resourceId,
        startTime: x.startTime || null,
        endTime: x.endTime || null,
        breakStartTime: x.breakStartTime || null,
        breakEndTime: x.breakEndTime || null,
        coversBreakOf: Number.isInteger(x.coversBreakOf) ? x.coversBreakOf : null,
      }))
  }
  // `!== undefined` y no `in`: zod deja la clave con undefined cuando llega ""
  // (emptyToUndef), y antes un "" tampoco cambiaba la auxiliar guardada.
  if (!data || (data.assistantId === undefined && data.assistant2Id === undefined)) return null
  const lista = []
  if (data.assistantId) {
    lista.push({ resourceId: data.assistantId, startTime: data.assistantStartTime || null, endTime: data.assistantEndTime || null })
  }
  if (data.assistant2Id) {
    lista.push({ resourceId: data.assistant2Id, startTime: data.assistant2StartTime || null, endTime: data.assistant2EndTime || null })
  }
  return lista
}

/**
 * Las filas a guardar en asignacion_auxiliares para un turno [ini, fin).
 *
 * Igual que se hacía con las columnas: si CUALQUIERA de las dos horas difiere
 * del turno se guardan AMBAS; si coinciden las dos, null ("hereda"). Guardar
 * solo la que difería dejaba a la auxiliar 07-09 como inicio=null/fin=09 y al
 * validar en otro consultorio se "estiraba" mal.
 */
export function filasAuxiliares(lista, turno) {
  return (lista ?? []).map((x, i) => {
    const ini = x.startTime || turno.startTime
    const fin = x.endTime || turno.endTime
    const propia = ini !== turno.startTime || fin !== turno.endTime
    return {
      resourceId: x.resourceId,
      startTime: propia ? ini : null,
      endTime: propia ? fin : null,
      position: i,
      breakStartTime: x.breakStartTime || null,
      breakEndTime: x.breakEndTime || null,
      coversBreakOf: Number.isInteger(x.coversBreakOf) ? x.coversBreakOf : null,
    }
  })
}

/**
 * Errores de forma de la lista (sin base de datos): repetidas, la misma
 * persona que el profesional, sub-horario fuera del turno o al revés.
 * Devuelve el primer mensaje, o null si está bien. Las validaciones que
 * necesitan la BD (tipo, choques) van en assignmentService.
 *
 * `nombres` es un Map resourceId → nombre, para que el mensaje diga quién.
 */
export function errorDeFormaAuxiliares(lista, turno, nombres = new Map()) {
  const nombre = (id) => nombres.get(id) ?? 'La auxiliar'
  const vistos = new Set()
  const docIni = hhmmAMinutos(turno.startTime)
  const docFin = hhmmAMinutos(turno.endTime)
  for (const x of lista ?? []) {
    if (x.resourceId === turno.resourceId) {
      return `${nombre(x.resourceId)} es el profesional del turno: no puede ser también su auxiliar.`
    }
    if (vistos.has(x.resourceId)) {
      return `${nombre(x.resourceId)} está repetida en las auxiliares del turno.`
    }
    vistos.add(x.resourceId)
    const ini = x.startTime || turno.startTime
    const fin = x.endTime || turno.endTime
    const ai = hhmmAMinutos(ini), af = hhmmAMinutos(fin)
    if (ai >= af) return `Horario de auxiliar inválido (${nombre(x.resourceId)}): ${ini}–${fin}`
    if (ai < docIni || af > docFin) {
      return `El horario de la auxiliar ${nombre(x.resourceId)} (${ini}–${fin}) debe estar dentro del horario del recurso principal (${turno.startTime}–${turno.endTime})`
    }
  }
  return errorDeDescansos(lista, turno, nombre)
}

/**
 * Nov-2026 · Hector: el descanso (almuerzo) de una auxiliar va dentro de su
 * horario y es OBLIGATORIO que otra auxiliar del turno lo cubra, con
 * exactamente ese horario.
 */
function errorDeDescansos(lista, turno, nombre) {
  const l = lista ?? []
  const horario = (x) => [x.startTime || turno.startTime, x.endTime || turno.endTime]
  for (const [i, x] of l.entries()) {
    const di = x.breakStartTime, df = x.breakEndTime
    if (!di && !df) continue
    if (!di || !df) return `Falta la hora ${di ? 'de fin' : 'de inicio'} del descanso de ${nombre(x.resourceId)}.`
    const [ini, fin] = horario(x)
    if (hhmmAMinutos(di) >= hhmmAMinutos(df)) return `El descanso de ${nombre(x.resourceId)} (${di}–${df}) no es válido.`
    if (hhmmAMinutos(di) < hhmmAMinutos(ini) || hhmmAMinutos(df) > hhmmAMinutos(fin)) {
      return `El descanso de ${nombre(x.resourceId)} (${di}–${df}) debe estar dentro de su horario (${ini}–${fin}).`
    }
    const relevos = l.filter((y) => y.coversBreakOf === i)
    if (relevos.length === 0) return `Falta la auxiliar que cubre el descanso de ${nombre(x.resourceId)} (${di}–${df}).`
    if (relevos.length > 1) return `El descanso de ${nombre(x.resourceId)} lo cubre más de una auxiliar.`
  }
  for (const y of l) {
    if (y.coversBreakOf == null) continue
    const x = l[y.coversBreakOf]
    if (!x || !x.breakStartTime) return `${nombre(y.resourceId)} cubre un descanso que no existe.`
    const [ini, fin] = horario(y)
    if (ini !== x.breakStartTime || fin !== x.breakEndTime) {
      return `${nombre(y.resourceId)} cubre el descanso de ${nombre(x.resourceId)}: su horario debe ser ${x.breakStartTime}–${x.breakEndTime}.`
    }
  }
  return null
}

/**
 * El tipo de recurso que hace de apoyo en un consultorio: en diagnóstico es
 * OTRO TÉCNICO; en el resto, una auxiliar. Es la misma regla con la que el
 * Programador arma su lista (tipoApoyo en AssignmentModal).
 */
export const tipoDeApoyo = (especialidad) => (especialidad === 'diagnostico' ? 'tecnico' : 'auxiliar')

/** ¿Este recurso puede ir de apoyo ahí? Su tipo, o el mismo tipo en sus `supportTypes` (CSV). */
export function puedeSerApoyo(recurso, especialidad) {
  const tipo = tipoDeApoyo(especialidad)
  if (recurso?.type === tipo) return true
  const extra = (recurso?.supportTypes ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  return extra.includes(tipo)
}

/**
 * Un turno listo para responder: `assistants` en orden y, por compatibilidad,
 * los campos de solo lectura de antes (assistantId, assistant,
 * assistantStartTime, assistantEndTime y los mismos con 2) sacados de la 1ª y
 * la 2ª de la lista. El frontend nuevo lee `assistants`; los campos viejos
 * quedan para pantallas que aún no se hayan pasado.
 *
 * Si el turno no trae `assistants` (la consulta no lo pidió) se devuelve tal
 * cual: no se inventa una lista vacía que parezca "sin auxiliares".
 */
export function serializarAsignacion(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.assistants)) return a
  const ordenadas = [...a.assistants].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))
  const [p1, p2] = ordenadas
  return {
    ...a,
    assistants: ordenadas,
    assistantId: p1?.resourceId ?? null,
    assistant: p1?.resource ?? null,
    assistantStartTime: p1?.startTime ?? null,
    assistantEndTime: p1?.endTime ?? null,
    assistant2Id: p2?.resourceId ?? null,
    assistant2: p2?.resource ?? null,
    assistant2StartTime: p2?.startTime ?? null,
    assistant2EndTime: p2?.endTime ?? null,
  }
}

/** "Ana (07:00–09:00), Luz" — las auxiliares de un turno para PDF/Excel/correos. */
export function textoAuxiliares(a, { conHorario = true } = {}) {
  const efectivas = auxiliaresDe(a)
  return (a.assistants ?? [])
    .slice()
    .sort((x, y) => (x.position ?? 0) - (y.position ?? 0))
    .map((x) => {
      const nombre = x.resource?.name
      if (!nombre) return null
      const ef = efectivas.find((e) => e.resourceId === x.resourceId)
      const propia = conHorario && (x.startTime || x.endTime) && ef
      return propia ? `${nombre} (${ef.ini}–${ef.fin})` : nombre
    })
    .filter(Boolean)
    .join(', ')
}
