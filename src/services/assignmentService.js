import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { horasEfectivasFranja as horasEfectivasFranjaLib, minutosAlmuerzo, minutosUnion, hhmmAMinutos } from '../lib/workHours.js'
import { SIN_TOPE_DIARIO, ESPECIALIDADES_PERMITEN_APOYO, minutosAhhmm, solapan, solapaConAux, horarioEfectivoAuxEnAsig } from '../lib/timeSlots.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { assertSedePermitida } from '../lib/siteScope.js'

/**
 * Lógica central del SGRC — Diagrama 3.
 * Ejecuta las 6 verificaciones en orden estricto antes de INSERT.
 * Usa transacción + locks para garantizar atomicidad (RN-16).
 */

/**
 * Normaliza y valida los sub-horarios opcionales de los auxiliares.
 * - Si vienen null/undefined, heredan el horario del recurso principal.
 * - Cada sub-horario debe estar DENTRO del horario del recurso principal.
 * Retorna { auxIni, auxFin, aux2Ini, aux2Fin } con los valores efectivos.
 */
function normalizarSubHorariosAux(data) {
  const docIni = hhmmAMinutos(data.startTime)
  const docFin = hhmmAMinutos(data.endTime)

  const auxIni = data.assistantStartTime || data.startTime
  const auxFin = data.assistantEndTime    || data.endTime
  const aux2Ini = data.assistant2StartTime || data.startTime
  const aux2Fin = data.assistant2EndTime    || data.endTime

  if (data.assistantId) {
    const ai = hhmmAMinutos(auxIni), af = hhmmAMinutos(auxFin)
    if (ai >= af) throw errors.badRequest(`Horario de auxiliar inválido: ${auxIni}–${auxFin}`)
    if (ai < docIni || af > docFin) {
      throw errors.badRequest(`El horario de la auxiliar (${auxIni}–${auxFin}) debe estar dentro del horario del recurso principal (${data.startTime}–${data.endTime})`)
    }
  }
  if (data.assistant2Id) {
    const ai = hhmmAMinutos(aux2Ini), af = hhmmAMinutos(aux2Fin)
    if (ai >= af) throw errors.badRequest(`Horario de auxiliar #2 inválido: ${aux2Ini}–${aux2Fin}`)
    if (ai < docIni || af > docFin) {
      throw errors.badRequest(`El horario de la auxiliar #2 (${aux2Ini}–${aux2Fin}) debe estar dentro del horario del recurso principal (${data.startTime}–${data.endTime})`)
    }
  }

  return { auxIni, auxFin, aux2Ini, aux2Fin }
}

/**
 * Valida que la unión de los sub-horarios de aux1 + aux2 cubra COMPLETAMENTE
 * el horario del recurso principal. Solo aplica si el consultorio requiere
 * auxiliar y hay al menos una auxiliar asignada. Si hay hueco, devuelve mensaje
 * claro indicando el período sin cobertura.
 */
function validarCoberturaAuxiliares(data, subs, requiereAuxiliar) {
  if (!requiereAuxiliar) return
  if (!data.assistantId && !data.assistant2Id) return  // se valida aparte el "falta aux"

  const docIni = hhmmAMinutos(data.startTime)
  const docFin = hhmmAMinutos(data.endTime)

  const intervalos = []
  if (data.assistantId)  intervalos.push({ start: hhmmAMinutos(subs.auxIni),  end: hhmmAMinutos(subs.auxFin)  })
  if (data.assistant2Id) intervalos.push({ start: hhmmAMinutos(subs.aux2Ini), end: hhmmAMinutos(subs.aux2Fin) })

  intervalos.sort((a, b) => a.start - b.start)

  if (intervalos[0].start > docIni) {
    throw errors.badRequest(`Falta cubrir ${data.startTime}–${minutosAhhmm(intervalos[0].start)} con una auxiliar (el doctor está pero ninguna aux entra a esa hora)`)
  }
  let hasta = intervalos[0].end
  for (let i = 1; i < intervalos.length; i++) {
    if (intervalos[i].start > hasta) {
      throw errors.badRequest(`Falta cubrir ${minutosAhhmm(hasta)}–${minutosAhhmm(intervalos[i].start)} con una auxiliar (hueco entre auxiliares)`)
    }
    hasta = Math.max(hasta, intervalos[i].end)
  }
  if (hasta < docFin) {
    throw errors.badRequest(`Falta cubrir ${minutosAhhmm(hasta)}–${data.endTime} con una auxiliar (el doctor queda solo al final)`)
  }
}


const horasDeFranja = (hi, hf) => (hhmmAMinutos(hf) - hhmmAMinutos(hi)) / 60


/**
 * Calcula capacidad de pacientes según RN-11:
 * - Si jornada ≥ 6h:
 *     · Oftalmólogos / anestesiólogos / optómetras: descontar 30 min (almuerzo corto)
 *     · Resto (auxiliar, asesor, técnico): descontar 60 min
 * - capacidad = FLOOR(minutos_disponibles / intervalo_minutos)
 */
export function calcularCapacidad(horaInicio, horaFin, intervaloMinutos, tipoRecurso = null) {
  const inicio = hhmmAMinutos(horaInicio)
  const fin = hhmmAMinutos(horaFin)
  const minutos = fin - inicio
  if (minutos <= 0) return 0
  // Regla jul-2026 v2: solo descuenta almuerzo si el turno CRUZA la ventana
  // 12-13. Casos como 07-13 (matutino corrido) o 13-19 (vespertino) NO
  // descuentan. minutosAlmuerzo() encapsula toda la lógica (único punto de verdad).
  const almuerzo = minutosAlmuerzo(minutos, inicio, fin, tipoRecurso)
  const disponibles = minutos - almuerzo
  return Math.floor(disponibles / (intervaloMinutos || 15))
}

/**
 * Valida y crea una asignación aplicando las 6 reglas del Diagrama 3.
 *
 * @param {object} data - datos de la asignación a crear
 * @param {object} userCtx - { id, rol, sedes }
 */
/**
 * Edita una asignación existente reaplicando todas las validaciones del
 * Diagrama 3 con exclusión de la propia asignación en los chequeos de
 * conflicto (RN-08, RN-09, RN-13). Permite que el coordinador/supervisor
 * cambie recurso, auxiliar, día u horario de un slot ya colocado sin
 * tener que borrarlo y recrearlo (pierde el id + dispara notificaciones
 * duplicadas).
 *
 * @param {string} id - id de la asignación a editar
 * @param {object} data - nuevos valores (mismo shape que crear)
 * @param {object} userCtx - { id, rol, sedes }
 */
export async function editarAsignacion(id, data, userCtx) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.assignment.findUnique({
      where: { id },
      include: { week: true, execution: true, room: { include: { site: true } } },
    })
    if (!existing) throw errors.notFound('Asignación no encontrada')

    const consultorio = await tx.room.findUnique({
      where: { id: data.roomId },
      include: { site: true },
    })
    if (!consultorio) throw errors.notFound('Consultorio no encontrado')

    // ---- AISLAMIENTO POR SEDE (S-1) ----
    // Se comprueban las DOS sedes, no solo una:
    //   · la de ORIGEN, para que un coordinador no pueda tocar una asignación
    //     que no es suya;
    //   · la de DESTINO, para que no pueda mover una asignación suya hacia una
    //     sede ajena (ni traerse una ajena a la suya cambiando el consultorio).
    // Con una sola de las dos comprobaciones, la otra dirección quedaba abierta.
    assertSedePermitida(userCtx, existing.room.siteId, existing.room.site.name)
    assertSedePermitida(userCtx, consultorio.siteId, consultorio.site.name)

    const recurso = await tx.resource.findUnique({ where: { id: data.resourceId } })
    if (!recurso) throw errors.notFound('Recurso no encontrado')
    if (!recurso.active) throw errors.badRequest('El recurso está inactivo')

    // ---- VAL 1: la SEDE del consultorio debe estar abierta para el coord ----
    // (Antes era el estado global de la semana. Ahora cada sede tiene su propio
    // cierre — un coord puede modificar mientras SU sede no esté cerrada,
    // aunque otras sedes ya hayan cerrado).
    const cierreSede = await tx.weekSiteClosure.findUnique({
      where: { weekId_siteId: { weekId: existing.weekId, siteId: consultorio.siteId } },
    })
    // El modo de programación libre levanta esta restricción temporalmente
    // (ver lib/modoProgramacion.js). El resto de validaciones siguen igual.
    if (cierreSede && !programacionLibre()) {
      if (userCtx.role !== 'supervisor') {
        throw errors.forbidden('No tienes permiso para modificar esta sede — su cierre semanal ya fue procesado')
      }
      if (!data.supervisorReason || data.supervisorReason.trim().length < 5) {
        throw errors.badRequest('Modificar una sede cerrada requiere un motivo (mín 5 caracteres)')
      }
    }

    // RN-17: si tiene ejecución registrada, no se puede modificar (sólo cancelar)
    if (existing.execution) {
      throw errors.badRequest('La asignación ya tiene ejecución registrada — no se puede editar')
    }

    // ---- RN-16: lock de filas del recurso + auxiliar ----
    const lockIds = data.assistantId
      ? [data.resourceId, data.assistantId].sort()
      : [data.resourceId]
    for (const lockId of lockIds) {
      await tx.$queryRawUnsafe(`SELECT id FROM recursos WHERE id = ? FOR UPDATE`, lockId)
    }

    // ---- VALIDACIONES 2-6 — idénticas a crear pero excluyendo SU PROPIO id ----
    const excludeSelf = { id: { not: id } }

    // VAL 2 (RN-08): recurso libre en franja
    if (!recurso.multiRoom) {
      const conflictoRecurso = await tx.assignment.findFirst({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoRecurso && solapan(conflictoRecurso, data.startTime, data.endTime)) {
        throw errors.conflict(
          `Conflicto: ${recurso.name} ya está asignado el ${data.weekday} en ${conflictoRecurso.room.name} (Sede ${conflictoRecurso.room.site.name} · ${conflictoRecurso.room.site.city}) de ${conflictoRecurso.startTime} a ${conflictoRecurso.endTime}. Si necesitas usarlo en tu sede, coordina con esa sede o crea una Solicitud de recurso.`
        )
      }
    }

    // VAL 3 (RN-09): ciudad única
    const otraDelDia = await tx.assignment.findFirst({
      where: {
        ...excludeSelf,
        weekId: existing.weekId,
        weekday: data.weekday,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
      include: { room: { include: { site: true } } },
    })
    if (otraDelDia && otraDelDia.room.site.city !== consultorio.site.city) {
      throw errors.conflict(
        `${recurso.name} no puede estar en dos ciudades el mismo día: ya tiene asignación en ${otraDelDia.room.name} (Sede ${otraDelDia.room.site.name} · ${otraDelDia.room.site.city}) y la nueva sería en ${consultorio.name} (Sede ${consultorio.site.name} · ${consultorio.site.city}).`
      )
    }

    // Normalizar sub-horarios opcionales de aux1 y aux2 (validan que estén dentro del doc).
    const subsEd = normalizarSubHorariosAux(data)

    // VAL 4 (RN-08 aux): auxiliar libre — usa el sub-horario real
    if (data.assistantId && consultorio.requiresAssistant) {
      const conflictoAux = await tx.assignment.findFirst({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [{ assistantId: data.assistantId }, { assistant2Id: data.assistantId }, { resourceId: data.assistantId }],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoAux && solapaConAux(conflictoAux, data.assistantId, subsEd.auxIni, subsEd.auxFin)) {
        // EXCEPCIÓN multi-cons: si la otra asignación es del mismo doctor multi-consultorio, permitir.
        const mismoDoctorMulti = conflictoAux.resourceId === data.resourceId && recurso.multiRoom
        if (!mismoDoctorMulti) {
          const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
          const ef = horarioEfectivoAuxEnAsig(conflictoAux, data.assistantId)
          throw errors.conflict(
            `Conflicto de auxiliar: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux.room.name} (Sede ${conflictoAux.room.site.name} · ${conflictoAux.room.site.city}) de ${ef.ini} a ${ef.fin}.`
          )
        }
      }
    }

    // VAL 4b: segundo auxiliar (si viene)
    if (data.assistant2Id) {
      if (data.assistant2Id === data.assistantId) {
        throw errors.badRequest('El segundo auxiliar debe ser distinto al primero')
      }
      if (!ESPECIALIDADES_PERMITEN_APOYO.has(consultorio.specialty)) {
        throw errors.badRequest('Este consultorio no acepta apoyo de auxiliar/técnico')
      }
      const conflictoAux2 = await tx.assignment.findFirst({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [{ assistantId: data.assistant2Id }, { assistant2Id: data.assistant2Id }, { resourceId: data.assistant2Id }],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoAux2 && solapaConAux(conflictoAux2, data.assistant2Id, subsEd.aux2Ini, subsEd.aux2Fin)) {
        const mismoDoctorMulti2 = conflictoAux2.resourceId === data.resourceId && recurso.multiRoom
        if (!mismoDoctorMulti2) {
          const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
          const ef = horarioEfectivoAuxEnAsig(conflictoAux2, data.assistant2Id)
          throw errors.conflict(
            `Conflicto de auxiliar #2: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux2.room.name} (Sede ${conflictoAux2.room.site.name} · ${conflictoAux2.room.site.city}) de ${ef.ini} a ${ef.fin}.`
          )
        }
      }
    }

    // VAL 4c: cobertura completa
    validarCoberturaAuxiliares(data, subsEd, consultorio.requiresAssistant)

    // VAL 5 (RN-13): tope diario en horas EFECTIVAS (descontando almuerzo).
    // Una franja 07:00–18:00 son 11h brutas pero 10h efectivas (1h almuerzo)
    // — y son las 10h las que pesan contra el tope diario (igual que el tope
    // semanal). Si el recurso trabaja horas extras habituales el supervisor
    // sube "Horas máx. día" en su catálogo.
    const horasNuevaBruta = horasDeFranja(data.startTime, data.endTime)
    if (horasNuevaBruta <= 0) throw errors.badRequest('Franja horaria inválida')
    const horasNuevaEfectivaDia = horasEfectivasFranjaLib(data.startTime, data.endTime, recurso.type)

    const otrasDelDia = await tx.assignment.findMany({
      where: {
        ...excludeSelf,
        weekId: existing.weekId,
        weekday: data.weekday,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
    })

    let horasDiaActual, horasDiaTotal
    if (recurso.multiRoom) {
      // multiConsultorio: unión de intervalos (no doble-conteo) y descuento de
      // almuerzo si el bloque del día llega a 6h Y empieza antes de las 12:00.
      // Usa minutosAlmuerzo del lib para tener una sola fuente de verdad.
      const aplicarAlmuerzo = (ivs) => {
        if (ivs.length === 0) return 0
        const total = minutosUnion(ivs)
        const inicioMin = Math.min(...ivs.map((i) => i.start))
        const finMin = Math.max(...ivs.map((i) => i.end))
        return total - minutosAlmuerzo(total, inicioMin, finMin, recurso.type)
      }
      const intervalosTotal = [
        ...otrasDelDia.map((a) => ({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) })),
        { start: hhmmAMinutos(data.startTime), end: hhmmAMinutos(data.endTime) },
      ]
      horasDiaTotal = aplicarAlmuerzo(intervalosTotal) / 60
      horasDiaActual = otrasDelDia.length > 0
        ? aplicarAlmuerzo(intervalosTotal.slice(0, -1)) / 60
        : 0
    } else {
      horasDiaActual = otrasDelDia.reduce(
        (acc, a) => acc + horasEfectivasFranjaLib(a.startTime, a.endTime, recurso.type),
        0
      )
      horasDiaTotal = horasDiaActual + horasNuevaEfectivaDia
    }

    // Oftalmólogos y anestesiólogos son rotativos sin tope diario — saltan el check.
    if (!SIN_TOPE_DIARIO.has(recurso.type) && horasDiaTotal > (recurso.maxHoursPerDay ?? 10)) {
      const topeActual = recurso.maxHoursPerDay ?? 10
      throw errors.badRequest(
        `${recurso.name} superaría el tope diario de ${topeActual}h efectivas (lleva ${horasDiaActual.toFixed(1)}h asignadas, agregarías ${(horasDiaTotal - horasDiaActual).toFixed(1)}h más = ${horasDiaTotal.toFixed(1)}h total — descontando almuerzo). Si este recurso trabaja habitualmente horas extras, pide al supervisor que aumente "Horas máx. día" en el catálogo de Recursos.`
      )
    }

    // VAL 6 (RN-13): tope semanal Ley 2101 → flag horas extras
    // Comparamos contra horas EFECTIVAS (descontando almuerzo de cada franja).
    // Una franja 08:00–17:00 son 9h brutas pero 8h efectivas (1h almuerzo).
    // El tope contractual horasMaxSemana se interpreta como horas efectivas.
    const otrasSemana = await tx.assignment.findMany({
      where: {
        ...excludeSelf,
        weekId: existing.weekId,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
    })

    const horasNuevaEfectivas = horasEfectivasFranjaLib(data.startTime, data.endTime, recurso.type)
    let horasSemanaTotal
    if (recurso.multiRoom) {
      // multiConsultorio: el recurso comparte franjas entre consultorios. Aplicamos
      // unión de minutos por día (no doble-conteo) y descontamos almuerzo si el
      // bloque del día llega a 6h Y empieza antes de las 12:00 (regla jul-2026).
      const porDia = {}
      const todas = [...otrasSemana, { weekday: data.weekday, startTime: data.startTime, endTime: data.endTime }]
      for (const a of todas) {
        (porDia[a.weekday] ??= []).push({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) })
      }
      horasSemanaTotal = Object.values(porDia).reduce((acc, ivs) => {
        const minutosBrutos = minutosUnion(ivs)
        const inicioMin = Math.min(...ivs.map((i) => i.start))
        const finMin = Math.max(...ivs.map((i) => i.end))
        const minutosEfectivos = minutosBrutos - minutosAlmuerzo(minutosBrutos, inicioMin, finMin, recurso.type)
        return acc + minutosEfectivos / 60
      }, 0)
    } else {
      horasSemanaTotal =
        otrasSemana.reduce((acc, a) => acc + horasEfectivasFranjaLib(a.startTime, a.endTime, recurso.type), 0) +
        horasNuevaEfectivas
    }
    // Si horasMaxSemana es null (típico de oftalmólogos por paciente) → nunca
    // se marca como horas extras: el recurso no tiene tope contractual semanal.
    const esHorasExtras = recurso.maxHoursPerWeek != null && horasSemanaTotal > recurso.maxHoursPerWeek
    const tieneHorasNocturnas = data.endTime > '18:00' || data.startTime >= '18:00'

    // Override manual del coordinador: si conoce los pacientes REALES que se le
    // programaron desde la agenda externa, los usa; si no, cae al cálculo nominal.
    const pacientesCapacidad = data.expectedPatients != null
      ? data.expectedPatients
      : calcularCapacidad(
          data.startTime,
          data.endTime,
          recurso.slotMinutes ?? 15,
          recurso.type,
        )

    const actualizada = await tx.assignment.update({
      where: { id },
      data: {
        resourceId: data.resourceId,
        assistantId: data.assistantId,
        // Sub-horarios: si CUALQUIERA de las dos horas difiere del horario del
        // doctor, guardamos AMBAS explícitamente. Antes guardábamos solo la que
        // difería y dejábamos la otra en null ("hereda"), pero eso generaba un
        // bug al validar conflictos en otro consultorio: la aux 07-09 quedaba
        // con inicio=null/fin=09 y el sistema la interpretaba mal.
        assistantStartTime: data.assistantId && (subsEd.auxIni !== data.startTime || subsEd.auxFin !== data.endTime) ? subsEd.auxIni : null,
        assistantEndTime:    data.assistantId && (subsEd.auxIni !== data.startTime || subsEd.auxFin !== data.endTime) ? subsEd.auxFin : null,
        assistant2Id: data.assistant2Id,
        assistant2StartTime: data.assistant2Id && (subsEd.aux2Ini !== data.startTime || subsEd.aux2Fin !== data.endTime) ? subsEd.aux2Ini : null,
        assistant2EndTime:    data.assistant2Id && (subsEd.aux2Ini !== data.startTime || subsEd.aux2Fin !== data.endTime) ? subsEd.aux2Fin : null,
        roomId: data.roomId,
        weekday: data.weekday,
        startTime: data.startTime,
        endTime: data.endTime,
        patientCapacity: pacientesCapacidad,
        isOvertime: esHorasExtras,
        hasNightHours: tieneHorasNocturnas,
      },
      include: {
        resource: true,
        assistant: true,
        assistant2: true,
        room: { include: { site: true } },
      },
    })

    return {
      assignment: actualizada,
      // Estado previo, para que la auditoría pueda registrar qué cambió y no
      // solo cómo quedó. `existing` se cargó al principio de la transacción.
      anterior: existing,
      wasSupervisor: userCtx.role === 'supervisor' && !!cierreSede,
    }
  }, { isolationLevel: 'ReadCommitted' })
}

export async function crearAsignacion(data, userCtx) {
  return prisma.$transaction(async (tx) => {
    // ---- Cargar entidades base ----
    const semana = await tx.week.findUnique({ where: { id: data.weekId } })
    if (!semana) throw errors.notFound('Semana no encontrada')

    const consultorio = await tx.room.findUnique({
      where: { id: data.roomId },
      include: { site: true },
    })
    if (!consultorio) throw errors.notFound('Consultorio no encontrado')

    const recurso = await tx.resource.findUnique({ where: { id: data.resourceId } })
    if (!recurso) throw errors.notFound('Recurso no encontrado')
    if (!recurso.active) throw errors.badRequest('El recurso está inactivo')

    // ---- AISLAMIENTO POR SEDE (S-1) ----
    // Un coordinador solo programa en las sedes a las que está vinculado.
    assertSedePermitida(userCtx, consultorio.siteId, consultorio.site.name)

    // ---- VALIDACIÓN 1: la SEDE del consultorio debe estar abierta ----
    // (Antes era el estado global de la semana. Ahora se valida que NO exista
    // un registro de cierre para la sede del consultorio. Si la sede está
    // cerrada, el coord no puede modificar; el supervisor sí pero con motivo).
    const cierreSede = await tx.weekSiteClosure.findUnique({
      where: { weekId_siteId: { weekId: data.weekId, siteId: consultorio.siteId } },
    })
    // Ver comentario equivalente en editarAsignacion.
    if (cierreSede && !programacionLibre()) {
      if (userCtx.role !== 'supervisor') {
        throw errors.forbidden('No tienes permiso para asignar en esta sede — su cierre semanal ya fue procesado')
      }
      if (!data.supervisorReason || data.supervisorReason.trim().length < 5) {
        throw errors.badRequest('Modificar una sede cerrada requiere un motivo (mín 5 caracteres)')
      }
    }

    // ---- RN-16: condición de carrera (MySQL — lock de fila FOR UPDATE) ----
    // Bloqueamos la fila del recurso (y del auxiliar si aplica) con FOR UPDATE.
    // InnoDB serializa las transacciones concurrentes para el mismo recurso y
    // LIBERA el lock recién en el COMMIT/ROLLBACK — así NO hay ventana entre la
    // validación y el insert (el bug que tendría GET_LOCK, que se libera antes del
    // commit). Funciona aunque no existan asignaciones previas, porque la fila del
    // recurso siempre existe. Orden de ids consistente = sin deadlocks.
    const lockIds = data.assistantId
      ? [data.resourceId, data.assistantId].sort()
      : [data.resourceId]
    for (const id of lockIds) {
      // $queryRawUnsafe (no $executeRawUnsafe) para que el SELECT ... FOR UPDATE
      // se ejecute como consulta y tome el lock de fila en InnoDB.
      await tx.$queryRawUnsafe(`SELECT id FROM recursos WHERE id = ? FOR UPDATE`, id)
    }

    // ---- VALIDACIÓN 2: recurso libre en franja ese día (RN-08) ----
    // EXCEPCIÓN: si el recurso tiene multiConsultorio=true (médicos que cubren
    // 2-3 salas en paralelo con auxiliares), se omite este conflicto.
    if (!recurso.multiRoom) {
      const conflictoRecurso = await tx.assignment.findFirst({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [
            { resourceId: data.resourceId },
            { assistantId: data.resourceId },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoRecurso && solapan(conflictoRecurso, data.startTime, data.endTime)) {
        throw errors.conflict(
          `Conflicto: ${recurso.name} ya está asignado el ${data.weekday} en ${conflictoRecurso.room.name} (Sede ${conflictoRecurso.room.site.name} · ${conflictoRecurso.room.site.city}) de ${conflictoRecurso.startTime} a ${conflictoRecurso.endTime}. Si necesitas usarlo en tu sede, coordina con esa sede o crea una Solicitud de recurso.`
        )
      }
    }

    // ---- VALIDACIÓN 3: ciudad única ese día (RN-09) ----
    const otraDelDia = await tx.assignment.findFirst({
      where: {
        weekId: data.weekId,
        weekday: data.weekday,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
      include: { room: { include: { site: true } } },
    })
    if (otraDelDia && otraDelDia.room.site.city !== consultorio.site.city) {
      throw errors.conflict(
        `${recurso.name} no puede estar en dos ciudades el mismo día: ya tiene asignación en ${otraDelDia.room.name} (Sede ${otraDelDia.room.site.name} · ${otraDelDia.room.site.city}) y la nueva sería en ${consultorio.name} (Sede ${consultorio.site.name} · ${consultorio.site.city}).`
      )
    }

    // ---- Normalizar sub-horarios de auxiliares (si vienen, validan que estén dentro) ----
    const subs = normalizarSubHorariosAux(data)

    // ---- VALIDACIÓN 4: auxiliar libre si aplica (RN-08 para aux) ----
    // Usa el sub-horario de la auxiliar (si fue parcial) para detectar conflicto real.
    // EXCEPCIÓN: si la otra asignación es del MISMO doctor multi-consultorio,
    // la aux puede estar simultáneamente — está asistiendo al mismo doc rotando entre salas.
    if (data.assistantId && consultorio.requiresAssistant) {
      const conflictoAux = await tx.assignment.findFirst({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [
            { assistantId: data.assistantId },
            { assistant2Id: data.assistantId },
            { resourceId: data.assistantId },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoAux && solapaConAux(conflictoAux, data.assistantId, subs.auxIni, subs.auxFin)) {
        const mismoDoctorMulti = conflictoAux.resourceId === data.resourceId && recurso.multiRoom
        if (!mismoDoctorMulti) {
          const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
          const ef = horarioEfectivoAuxEnAsig(conflictoAux, data.assistantId)
          throw errors.conflict(
            `Conflicto de auxiliar: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux.room.name} (Sede ${conflictoAux.room.site.name} · ${conflictoAux.room.site.city}) de ${ef.ini} a ${ef.fin}.`
          )
        }
      }
    }

    // ---- VALIDACIÓN 4b: segundo auxiliar (si viene) — libre y distinto del primero ----
    if (data.assistant2Id) {
      if (data.assistant2Id === data.assistantId) {
        throw errors.badRequest('El segundo auxiliar debe ser distinto al primero')
      }
      if (!ESPECIALIDADES_PERMITEN_APOYO.has(consultorio.specialty)) {
        throw errors.badRequest('Este consultorio no acepta apoyo de auxiliar/técnico')
      }
      const conflictoAux2 = await tx.assignment.findFirst({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          OR: [
            { assistantId: data.assistant2Id },
            { assistant2Id: data.assistant2Id },
            { resourceId: data.assistant2Id },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      if (conflictoAux2 && solapaConAux(conflictoAux2, data.assistant2Id, subs.aux2Ini, subs.aux2Fin)) {
        const mismoDoctorMulti2 = conflictoAux2.resourceId === data.resourceId && recurso.multiRoom
        if (!mismoDoctorMulti2) {
          const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
          const ef = horarioEfectivoAuxEnAsig(conflictoAux2, data.assistant2Id)
          throw errors.conflict(
            `Conflicto de auxiliar #2: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux2.room.name} (Sede ${conflictoAux2.room.site.name} · ${conflictoAux2.room.site.city}) de ${ef.ini} a ${ef.fin}.`
          )
        }
      }
    }

    // ---- VALIDACIÓN 4c: cobertura completa del doctor por las auxiliares ----
    // Si el consultorio requiere auxiliar y hay al menos una asignada, la unión
    // de los sub-horarios de aux1 + aux2 debe cubrir TODO el horario del doctor.
    validarCoberturaAuxiliares(data, subs, consultorio.requiresAssistant)

    // ---- VALIDACIÓN 5: tope diario en horas EFECTIVAS (RN-13) ----
    // Comparamos contra horas EFECTIVAS (descontando almuerzo). Una franja
    // 07:00–18:00 son 11h brutas pero 10h efectivas (1h almuerzo) — y son
    // las 10h las que pesan contra el tope diario, coherente con el tope
    // semanal. Si el recurso trabaja horas extras habituales el supervisor
    // sube "Horas máx. día" en su catálogo.
    const horasNuevaBruta = horasDeFranja(data.startTime, data.endTime)
    if (horasNuevaBruta <= 0) throw errors.badRequest('Franja horaria inválida')
    const horasNuevaEfectivaDia = horasEfectivasFranjaLib(data.startTime, data.endTime, recurso.type)

    const otrasDelDia = await tx.assignment.findMany({
      where: {
        weekId: data.weekId,
        weekday: data.weekday,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
    })

    // Para multi-consultorio se cuentan las horas por UNIÓN de intervalos (el
    // médico físicamente está N horas aunque cubra 3 salas). Para el resto,
    // suma simple. En ambos casos descontamos almuerzo si el bloque llega a 6h.
    let horasDiaActual, horasDiaTotal
    if (recurso.multiRoom) {
      // Regla almuerzo (jul-2026): solo descuenta si dura ≥6h Y empieza <12:00.
      // minutosAlmuerzo() del lib es la única fuente de verdad.
      const aplicarAlmuerzo = (ivs) => {
        if (ivs.length === 0) return 0
        const total = minutosUnion(ivs)
        const inicioMin = Math.min(...ivs.map((i) => i.start))
        const finMin = Math.max(...ivs.map((i) => i.end))
        return total - minutosAlmuerzo(total, inicioMin, finMin, recurso.type)
      }
      const intervalosTotal = [
        ...otrasDelDia.map((a) => ({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) })),
        { start: hhmmAMinutos(data.startTime), end: hhmmAMinutos(data.endTime) },
      ]
      horasDiaTotal = aplicarAlmuerzo(intervalosTotal) / 60
      horasDiaActual = otrasDelDia.length > 0
        ? aplicarAlmuerzo(intervalosTotal.slice(0, -1)) / 60
        : 0
    } else {
      horasDiaActual = otrasDelDia.reduce(
        (acc, a) => acc + horasEfectivasFranjaLib(a.startTime, a.endTime, recurso.type),
        0
      )
      horasDiaTotal = horasDiaActual + horasNuevaEfectivaDia
    }

    // Oftalmólogos y anestesiólogos son rotativos sin tope diario — saltan el check.
    if (!SIN_TOPE_DIARIO.has(recurso.type) && horasDiaTotal > (recurso.maxHoursPerDay ?? 10)) {
      const topeActual = recurso.maxHoursPerDay ?? 10
      throw errors.badRequest(
        `${recurso.name} superaría el tope diario de ${topeActual}h efectivas (lleva ${horasDiaActual.toFixed(1)}h asignadas, agregarías ${(horasDiaTotal - horasDiaActual).toFixed(1)}h más = ${horasDiaTotal.toFixed(1)}h total — descontando almuerzo). Si este recurso trabaja habitualmente horas extras, pide al supervisor que aumente "Horas máx. día" en el catálogo de Recursos.`
      )
    }

    // ---- VALIDACIÓN 6: tope semanal Ley 2101 → flag, NO bloquea (RN-13) ----
    // Comparamos contra horas EFECTIVAS (descontando almuerzo de cada franja
    // que duré ≥6h). horasMaxSemana es el tope contractual del recurso en horas
    // efectivas (default 44h Ley 2101 fase actual, baja a 42h el 15-jul-2026).
    const otrasSemana = await tx.assignment.findMany({
      where: {
        weekId: data.weekId,
        status: { not: 'cancelada' },
        OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      },
    })

    const horasNuevaEfectivas = horasEfectivasFranjaLib(data.startTime, data.endTime, recurso.type)
    let horasSemanaTotal
    if (recurso.multiRoom) {
      // multiConsultorio: aplicamos unión de minutos por día (no doble-conteo)
      // y descontamos almuerzo si el bloque del día llega a 6h Y empieza <12h.
      const porDia = {}
      const todas = [...otrasSemana, { weekday: data.weekday, startTime: data.startTime, endTime: data.endTime }]
      for (const a of todas) {
        (porDia[a.weekday] ??= []).push({ start: hhmmAMinutos(a.startTime), end: hhmmAMinutos(a.endTime) })
      }
      horasSemanaTotal = Object.values(porDia).reduce((acc, ivs) => {
        const minutosBrutos = minutosUnion(ivs)
        const inicioMin = Math.min(...ivs.map((i) => i.start))
        const finMin = Math.max(...ivs.map((i) => i.end))
        const minutosEfectivos = minutosBrutos - minutosAlmuerzo(minutosBrutos, inicioMin, finMin, recurso.type)
        return acc + minutosEfectivos / 60
      }, 0)
    } else {
      horasSemanaTotal =
        otrasSemana.reduce((acc, a) => acc + horasEfectivasFranjaLib(a.startTime, a.endTime, recurso.type), 0) +
        horasNuevaEfectivas
    }
    // Si horasMaxSemana es null (típico de oftalmólogos por paciente) → nunca
    // se marca como horas extras: el recurso no tiene tope contractual semanal.
    const esHorasExtras = recurso.maxHoursPerWeek != null && horasSemanaTotal > recurso.maxHoursPerWeek

    // Horas nocturnas: cualquier minuto >= 18:00
    const tieneHorasNocturnas = data.endTime > '18:00' || data.startTime >= '18:00'

    // ---- INSERT con todas las validaciones pasadas ----
    // Override manual: si el coord conoce los pacientes REALES, los usa.
    const pacientesCapacidad = data.expectedPatients != null
      ? data.expectedPatients
      : calcularCapacidad(
          data.startTime,
          data.endTime,
          recurso.slotMinutes ?? 15,
          recurso.type,
        )

    const nueva = await tx.assignment.create({
      data: {
        weekId: data.weekId,
        resourceId: data.resourceId,
        assistantId: data.assistantId,
        // Sub-horarios: si CUALQUIERA de las dos horas difiere del horario del
        // doctor, guardamos AMBAS explícitamente. Si son IGUALES en ambas, dejamos
        // null (hereda del doctor). Antes solo guardábamos la que difería, pero
        // eso causaba que aux 07-09 con doc 07-15 quedara como inicio=null/fin=09,
        // y al validar conflictos en otro consultorio la aux se "estiraba" mal.
        assistantStartTime: data.assistantId && (subs.auxIni !== data.startTime || subs.auxFin !== data.endTime) ? subs.auxIni : null,
        assistantEndTime:    data.assistantId && (subs.auxIni !== data.startTime || subs.auxFin !== data.endTime) ? subs.auxFin : null,
        assistant2Id: data.assistant2Id,
        assistant2StartTime: data.assistant2Id && (subs.aux2Ini !== data.startTime || subs.aux2Fin !== data.endTime) ? subs.aux2Ini : null,
        assistant2EndTime:    data.assistant2Id && (subs.aux2Ini !== data.startTime || subs.aux2Fin !== data.endTime) ? subs.aux2Fin : null,
        roomId: data.roomId,
        weekday: data.weekday,
        startTime: data.startTime,
        endTime: data.endTime,
        patientCapacity: pacientesCapacidad,
        isOvertime: esHorasExtras,
        hasNightHours: tieneHorasNocturnas,
        isReplacement: data.isReplacement ?? false,
        coveredAbsenceId: data.coveredAbsenceId,
      },
      include: {
        resource: true,
        assistant: true,
        assistant2: true,
        room: { include: { site: true } },
      },
    })

    return { assignment: nueva, wasSupervisor: userCtx.role === 'supervisor' && semana.status === 'cerrada' }
  }, { isolationLevel: 'ReadCommitted' })
  // READ COMMITTED: tras esperar el FOR UPDATE, la 2ª transacción ve el INSERT ya
  // commiteado por la 1ª y detecta el conflicto. En REPEATABLE READ (default de
  // MySQL) leería un snapshot viejo y dejaría pasar la asignación duplicada.
}
