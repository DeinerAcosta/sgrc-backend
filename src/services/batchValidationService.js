import {
  SIN_TOPE_DIARIO,
  solapan,
  solapaConAux,
  horarioEfectivoAuxEnAsig,
} from '../lib/timeSlots.js'
import {
  hhmmAMinutos,
  horasEfectivasFranja,
  minutosAlmuerzo,
  minutosUnion,
} from '../lib/workHours.js'

/**
 * VALIDADOR EN LOTE DE ASIGNACIONES
 *
 * Problema que resuelve
 * ---------------------
 * Copiar un día llamaba a crearAsignacion() dentro de un bucle anidado, y cada
 * llamada abría su propia transacción con doce consultas: copiar 6 asignaciones
 * a 5 días eran 30 transacciones y ~360 idas y vueltas a la base en una sola
 * petición HTTP. Y copiar una SEMANA hacía lo contrario: insertaba con
 * createMany sin validar nada, así que podía crear solapes en silencio.
 *
 * Este módulo permite las dos cosas a la vez: validar de verdad y hacerlo de
 * una pasada, en memoria, sobre datos cargados con unas pocas consultas.
 *
 * Es PURO a propósito: no importa prisma. Así se puede probar exhaustivamente
 * sin base de datos, que es donde estaba el riesgo de esta reescritura.
 *
 * Lo importante: valida INCREMENTALMENTE
 * --------------------------------------
 * Cada candidata aceptada pasa a formar parte del estado con el que se valida
 * la siguiente. Sin eso, copiar cinco veces la misma franja al mismo día las
 * aceptaría todas: ninguna choca con lo que HABÍA, pero sí entre ellas.
 *
 * Qué reglas comprueba (las mismas de crearAsignacion que pueden fallar en una
 * copia; las que dependen del formulario —sub-horarios dentro del horario del
 * doctor, cobertura de auxiliares— ya venían satisfechas en el origen y se
 * copian tal cual):
 *
 *   1. Sede con el cierre semanal ya procesado
 *   2. Recurso inactivo o inexistente / consultorio inexistente
 *   3. RN-08 · el recurso ya está ocupado en esa franja ese día
 *   4. RN-09 · el recurso no puede estar en dos ciudades el mismo día
 *   5. RN-08 · la auxiliar (y la segunda) ya están ocupadas
 *   6. RN-13 · tope diario en horas efectivas
 *
 * El tope SEMANAL no bloquea: marca la asignación como horas extras, igual que
 * hace crearAsignacion.
 */

/** Motivos de rechazo, para que quien llame pueda agruparlos o traducirlos. */
export const MOTIVOS = {
  FUERA_DE_MI_SEDE: 'fuera_de_mi_sede',
  SEDE_CERRADA: 'sede_cerrada',
  RECURSO_INVALIDO: 'recurso_invalido',
  CONSULTORIO_INVALIDO: 'consultorio_invalido',
  RECURSO_OCUPADO: 'recurso_ocupado',
  DOS_CIUDADES: 'dos_ciudades',
  AUXILIAR_OCUPADO: 'auxiliar_ocupado',
  TOPE_DIARIO: 'tope_diario',
  FRANJA_INVALIDA: 'franja_invalida',
}

const clave = (a) => `${a.weekId}|${a.weekday}`

/**
 * Crea un validador sobre un estado inicial.
 *
 * @param {object} estado
 * @param {Array}  estado.asignaciones  Asignaciones NO canceladas ya existentes
 *                                      en las semanas destino. Cada una necesita
 *                                      semanaId, diaSemana, horaInicio, horaFin,
 *                                      recursoId, auxiliarId, auxiliar2Id y sus
 *                                      sub-horarios.
 * @param {Map}    estado.recursos      recursoId → { id, nombre, activo, tipo,
 *                                      multiConsultorio, horasMaxDia,
 *                                      horasMaxSemana, intervaloMinutos }
 * @param {Map}    estado.consultorios  consultorioId → { id, nombre, sedeId,
 *                                      especialidad, requiereAuxiliar,
 *                                      sede: { nombre, ciudad } }
 * @param {Set}    estado.sedesCerradas Claves "semanaId|sedeId" con cierre hecho
 * @param {boolean} estado.puedeEditarCerrada  true para supervisor/gerencia
 */
export function crearValidadorLote({
  assignments: asignaciones = [],
  resources: recursos = new Map(),
  rooms: consultorios = new Map(),
  sedesCerradas = new Set(),
  puedeEditarCerrada = false,
  // Sedes sobre las que puede actuar quien copia. null = sin restricción
  // (supervisor, gerencia). Para el coordinador son las suyas: sin esto podía
  // copiar el día de otra sede —o el de TODAS, dejando el filtro vacío— sobre
  // la programación ajena.
  sedesPermitidas = null,
}) {
  // Índice por (semana, día): las reglas de conflicto son siempre dentro del
  // mismo día de la misma semana, así que evitamos recorrer todo cada vez.
  const porDia = new Map()
  const indexar = (a) => {
    const k = clave(a)
    if (!porDia.has(k)) porDia.set(k, [])
    porDia.get(k).push(a)
  }
  for (const a of asignaciones) indexar(a)

  const delDia = (c) => porDia.get(clave(c)) ?? []

  /** Asignaciones del día en las que `recursoId` participa, como sea. */
  const dondeParticipa = (c, recursoId) =>
    delDia(c).filter(
      (a) => a.resourceId === recursoId || a.assistantId === recursoId || a.assistant2Id === recursoId
    )

  function validar(c) {
    const consultorio = consultorios.get(c.roomId)
    if (!consultorio) {
      return { ok: false, reason: MOTIVOS.CONSULTORIO_INVALIDO, message: 'El consultorio ya no existe.' }
    }

    const recurso = recursos.get(c.resourceId)
    if (!recurso) {
      return { ok: false, reason: MOTIVOS.RECURSO_INVALIDO, message: 'El recurso ya no existe.' }
    }
    if (!recurso.active) {
      return {
        ok: false,
        reason: MOTIVOS.RECURSO_INVALIDO,
        message: `${recurso.name} está inactivo.`,
      }
    }

    // ---- 0. Aislamiento por sede (S-1) ----
    // Va antes que el resto: si la sede no es suya, ni siquiera tiene sentido
    // mirar conflictos. El modo de programación libre NO exime de esto: levanta
    // el calendario, no los permisos.
    if (sedesPermitidas !== null && !sedesPermitidas.has(consultorio.siteId)) {
      return {
        ok: false,
        reason: MOTIVOS.FUERA_DE_MI_SEDE,
        message: `No estás vinculado a la sede ${consultorio.site.name}: esa asignación no se copia.`,
      }
    }

    // ---- 1. Sede con cierre semanal procesado ----
    if (sedesCerradas.has(`${c.weekId}|${consultorio.siteId}`) && !puedeEditarCerrada) {
      return {
        ok: false,
        reason: MOTIVOS.SEDE_CERRADA,
        message: `La sede ${consultorio.site.name} ya tiene el cierre semanal procesado.`,
      }
    }

    // ---- Franja válida ----
    const ini = hhmmAMinutos(c.startTime)
    const fin = hhmmAMinutos(c.endTime)
    if (!(fin > ini)) {
      return { ok: false, reason: MOTIVOS.FRANJA_INVALIDA, message: `Franja inválida: ${c.startTime}–${c.endTime}.` }
    }

    const mismoDia = delDia(c)

    // ---- 3. RN-08 · recurso libre en la franja ----
    // Excepción: multiConsultorio (médicos que cubren varias salas a la vez).
    if (!recurso.multiRoom) {
      const choque = mismoDia.find(
        (a) =>
          (a.resourceId === c.resourceId || a.assistantId === c.resourceId || a.assistant2Id === c.resourceId) &&
          solapan(a, c.startTime, c.endTime)
      )
      if (choque) {
        const cons = consultorios.get(choque.roomId)
        const donde = cons ? `${cons.name} (Sede ${cons.site.name})` : 'otro consultorio'
        return {
          ok: false,
          reason: MOTIVOS.RECURSO_OCUPADO,
          message: `${recurso.name} ya está asignado el ${c.weekday} en ${donde} de ${choque.startTime} a ${choque.endTime}.`,
        }
      }
    }

    // ---- 4. RN-09 · una sola ciudad por día ----
    const enOtraCiudad = dondeParticipa(c, c.resourceId).find((a) => {
      const cons = consultorios.get(a.roomId)
      return cons && cons.site.city !== consultorio.site.city
    })
    if (enOtraCiudad) {
      const cons = consultorios.get(enOtraCiudad.roomId)
      return {
        ok: false,
        reason: MOTIVOS.DOS_CIUDADES,
        message: `${recurso.name} no puede estar en dos ciudades el ${c.weekday}: ya tiene asignación en ${cons.site.city} y esta sería en ${consultorio.site.city}.`,
      }
    }

    // ---- 5. RN-08 para auxiliares ----
    // Excepción: si el choque es con el MISMO doctor multi-consultorio, la aux
    // le está asistiendo mientras rota entre salas — no es conflicto.
    const revisarAux = (auxId, subIni, subFin, etiqueta) => {
      if (!auxId) return null
      const choque = mismoDia.find(
        (a) =>
          (a.assistantId === auxId || a.assistant2Id === auxId || a.resourceId === auxId) &&
          solapaConAux(a, auxId, subIni, subFin)
      )
      if (!choque) return null
      if (choque.resourceId === c.resourceId && recurso.multiRoom) return null

      const aux = recursos.get(auxId)
      const ef = horarioEfectivoAuxEnAsig(choque, auxId)
      const cons = consultorios.get(choque.roomId)
      const donde = cons ? `${cons.name} (Sede ${cons.site.name})` : 'otro consultorio'
      return {
        ok: false,
        reason: MOTIVOS.AUXILIAR_OCUPADO,
        message: `${etiqueta}: ${aux?.name ?? 'la auxiliar'} ya está asignada el ${c.weekday} en ${donde} de ${ef.ini} a ${ef.fin}.`,
      }
    }

    if (consultorio.requiresAssistant) {
      const r = revisarAux(
        c.assistantId,
        c.assistantStartTime || c.startTime,
        c.assistantEndTime || c.endTime,
        'Conflicto de auxiliar'
      )
      if (r) return r
    }
    const r2 = revisarAux(
      c.assistant2Id,
      c.assistant2StartTime || c.startTime,
      c.assistant2EndTime || c.endTime,
      'Conflicto de auxiliar #2'
    )
    if (r2) return r2

    // ---- 6. RN-13 · tope diario en horas efectivas ----
    if (!SIN_TOPE_DIARIO.has(recurso.type)) {
      const tope = recurso.maxHoursPerDay ?? 10
      const suyasHoy = dondeParticipa(c, c.resourceId)
      let horasActuales, horasTotales

      if (recurso.multiRoom) {
        // Unión de intervalos: si cubre 3 salas de 7 a 13, son 6h, no 18.
        const conAlmuerzo = (ivs) => {
          if (ivs.length === 0) return 0
          const total = minutosUnion(ivs)
          const desde = Math.min(...ivs.map((i) => i.start))
          const hasta = Math.max(...ivs.map((i) => i.end))
          return total - minutosAlmuerzo(total, desde, hasta, recurso.type)
        }
        const previos = suyasHoy.map((a) => ({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) }))
        horasActuales = conAlmuerzo(previos) / 60
        horasTotales = conAlmuerzo([...previos, { start: ini, end: fin }]) / 60
      } else {
        horasActuales = suyasHoy.reduce(
          (acc, a) => acc + horasEfectivasFranja(a.startTime, a.endTime, recurso.type), 0
        )
        horasTotales = horasActuales + horasEfectivasFranja(c.startTime, c.endTime, recurso.type)
      }

      if (horasTotales > tope) {
        return {
          ok: false,
          reason: MOTIVOS.TOPE_DIARIO,
          message: `${recurso.name} superaría el tope de ${tope}h efectivas el ${c.weekday} (lleva ${horasActuales.toFixed(1)}h, quedaría en ${horasTotales.toFixed(1)}h).`,
        }
      }
    }

    return { ok: true, derivados: calcularDerivados(c, recurso, delDia) }
  }

  /** Marca la candidata como aceptada: entra en el estado para las siguientes. */
  function aceptar(c) {
    indexar(c)
  }

  return { validar, aceptar }
}

/**
 * Campos que crearAsignacion calcula al insertar. Se replican aquí para que una
 * asignación copiada quede idéntica a una creada a mano.
 */
function calcularDerivados(c, recurso, delDia) {
  // Horas extras: contra el tope semanal. Solo marca, no bloquea (RN-13).
  // Se mira la semana entera, no solo el día.
  let esHorasExtras = false
  if (recurso.maxHoursPerWeek != null) {
    // delDia solo indexa por día; para la semana recorremos lo que haga falta.
    // Quien llama pasa el acumulado semanal en c._horasSemanaPrevias si lo tiene.
    const previas = c._horasSemanaPrevias ?? 0
    const nuevas = horasEfectivasFranja(c.startTime, c.endTime, recurso.type)
    esHorasExtras = previas + nuevas > recurso.maxHoursPerWeek
  }
  void delDia

  return {
    isOvertime: esHorasExtras,
    hasNightHours: c.endTime > '18:00' || c.startTime >= '18:00',
  }
}

/**
 * Recorre las candidatas en orden y las reparte en aceptadas y omitidas.
 * Cada aceptada entra en el estado antes de validar la siguiente.
 *
 * @returns {{ aceptadas: Array, omitidas: Array<{candidata, motivo, mensaje}> }}
 */
export function validarLote(candidatas, estado) {
  const validador = crearValidadorLote(estado)
  const aceptadas = []
  const omitidas = []

  for (const c of candidatas) {
    const r = validador.validar(c)
    if (r.ok) {
      validador.aceptar(c)
      aceptadas.push({ ...c, ...r.derivados })
    } else {
      omitidas.push({ candidata: c, reason: r.reason, message: r.message })
    }
  }

  return { aceptadas, skipped: omitidas }
}
