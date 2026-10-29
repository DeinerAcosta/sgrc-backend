import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { horasEfectivasFranja as horasEfectivasFranjaLib, minutosAlmuerzo, minutosUnion, hhmmAMinutos } from '../lib/workHours.js'
import { SIN_TOPE_DIARIO, ESPECIALIDADES_PERMITEN_APOYO, minutosAhhmm, solapan, solapaConAux, horarioEfectivoAuxEnAsig } from '../lib/timeSlots.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { pacientesDelTramo } from '../lib/tramos.js'
import { pacientesDelCaso } from '../lib/pacientesDelCaso.js'
import { assertSedePermitida } from '../lib/siteScope.js'
import { fechaDeTurno, bloqueoQueCubre, cargarBloqueos, mensajeBloqueo } from '../lib/bloqueosSede.js'
import { TIPOS_QUE_LIBERAN_AUXILIAR, coordSoloVe, MSG_SOLO_VE } from '../lib/resourceTypes.js'

// Roles que pueden tocar una sede ya cerrada (con motivo). Gerencia es
// super-usuario y tiene "Editar semana cerrada" en su menú: antes solo
// supervisor pasaba y gerencia recibía "No tienes permiso".
export const ROLES_EDITAN_CERRADA = new Set(['supervisor', 'gerencia'])

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
 * Sep-2026 · Ley 2101 · Autorización directivo para AUX que trabajan finde
 * completo (sábado + domingo la misma semana).
 *
 * Regla:
 *  - Un auxiliar (tipo=auxiliar) puede trabajar sábado O domingo sin problema.
 *  - Si un auxiliar tiene asignación en AMBOS días del finde, el segundo día
 *    exige autorización explícita de un directivo (o gerencia). El coord no
 *    puede saltarse este check.
 *
 * Se aplica a los 3 slots donde puede aparecer un aux en la asignación:
 * `resourceId` (raro), `assistantId` (típico), `assistant2Id` (2 aux).
 *
 * @param tx           transacción Prisma
 * @param data         payload de la asignación (weekId, weekday, ids, autorización)
 * @param recurso      el `resource` principal ya cargado (para saber si es aux)
 * @param editingId    id de la asignación si estamos EDITANDO (para excluirse a sí misma)
 */
async function validarAutorizacionFinDeSemana(tx, data, recurso, editingId = null) {
  if (data.weekday !== 'sabado' && data.weekday !== 'domingo') return

  const otroDia = data.weekday === 'sabado' ? 'domingo' : 'sabado'

  const auxsAChequear = []
  if (recurso.type === 'auxiliar') auxsAChequear.push({ id: data.resourceId, nombre: recurso.name })

  if (data.assistantId) {
    const a = await tx.resource.findUnique({ where: { id: data.assistantId }, select: { id: true, name: true, type: true } })
    if (a?.type === 'auxiliar') auxsAChequear.push({ id: a.id, nombre: a.name })
  }
  if (data.assistant2Id) {
    const a = await tx.resource.findUnique({ where: { id: data.assistant2Id }, select: { id: true, name: true, type: true } })
    if (a?.type === 'auxiliar') auxsAChequear.push({ id: a.id, nombre: a.name })
  }

  if (auxsAChequear.length === 0) return

  const auxsQueRequierenAutorizacion = []
  for (const aux of auxsAChequear) {
    const otraAsig = await tx.assignment.findFirst({
      where: {
        weekId: data.weekId,
        weekday: otroDia,
        status: { not: 'cancelada' },
        ...(editingId ? { id: { not: editingId } } : {}),
        OR: [
          { resourceId: aux.id },
          { assistantId: aux.id },
          { assistant2Id: aux.id },
        ],
      },
      select: { id: true },
    })
    if (otraAsig) auxsQueRequierenAutorizacion.push(aux.nombre)
  }

  if (auxsQueRequierenAutorizacion.length === 0) return

  const listaNombres = auxsQueRequierenAutorizacion.join(', ')
  if (!data.authorizedById || !data.authorizationReason || data.authorizationReason.trim().length < 5) {
    throw errors.badRequest(
      `Asignar a ${listaNombres} tanto sábado como domingo de la misma semana requiere autorización de un directivo (Ley 2101). Seleccione un directivo del sistema y anote el motivo (mínimo 5 caracteres).`,
    )
  }

  const autorizador = await tx.user.findUnique({
    where: { id: data.authorizedById },
    select: { id: true, name: true, role: true, active: true },
  })
  if (!autorizador || !autorizador.active) {
    throw errors.badRequest('El autorizador seleccionado no existe o está inactivo.')
  }
  if (!['directivo', 'gerencia'].includes(autorizador.role)) {
    throw errors.forbidden(`${autorizador.name} no tiene rol de directivo — solo directivos (o gerencia) pueden autorizar fin de semana completo.`)
  }
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
  // PROYECTOS-3255 #2.1: asesor_servicios NO atiende pacientes con cita
  // (hace recepcion/gestion). No se calcula ni almacena numero de pacientes.
  if (tipoRecurso === 'asesor_servicios') return 0
  const inicio = hhmmAMinutos(horaInicio)
  const fin = hhmmAMinutos(horaFin)
  const minutos = fin - inicio
  if (minutos <= 0) return 0
  // Regla jul-2026 v2: solo descuenta almuerzo si el turno CRUZA la ventana
  // 12-13. Casos como 07-13 (matutino corrido) o 13-19 (vespertino) NO
  // descuentan. minutosAlmuerzo() encapsula toda la lógica (único punto de verdad).
  const almuerzo = minutosAlmuerzo(minutos, inicio, fin, tipoRecurso)
  const disponibles = minutos - almuerzo
  // Sep-2026 · el default era 15 acá y 10 en el modal del frontend, así que el
  // coordinador veía una capacidad y se guardaba otra un tercio menor. Decisión
  // de dirección: la consulta dura 10 minutos para todos los tipos. El valor
  // queda además explícito en recursos.intervalo_minutos (migración
  // 20260924160000), así que este default solo actúa como red de seguridad.
  return Math.floor(disponibles / (intervaloMinutos || 10))
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
/** 3583 · Rechaza programar en una sede bloqueada ese día (lib/bloqueosSede.js). */
async function exigirSedeSinBloqueo(tx, consultorio, inicioSemana, weekday) {
  const fecha = fechaDeTurno(inicioSemana, weekday)
  if (!fecha) return
  const bloqueos = await cargarBloqueos(tx, fecha, fecha, [consultorio.siteId])
  const b = bloqueoQueCubre(bloqueos, consultorio.siteId, fecha)
  if (b) throw errors.badRequest(mensajeBloqueo(b, consultorio.site?.name ?? 'elegida'))
}

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
      if (!ROLES_EDITAN_CERRADA.has(userCtx.role)) {
        throw errors.forbidden('No tiene permiso para modificar esta sede — su cierre semanal ya fue procesado')
      }
      if (!data.supervisorReason || data.supervisorReason.trim().length < 5) {
        throw errors.badRequest('Modificar una sede cerrada requiere un motivo (mín 5 caracteres)')
      }
    }

    // ---- 3583 · La sede no puede estar BLOQUEADA ese día ----
    // Un bloqueo lo pone supervisor o gerencia cuando no hay disponibilidad;
    // mientras dure no se programa ahí, sin excepción por rol.
    await exigirSedeSinBloqueo(tx, consultorio, existing.week.startDate, data.weekday ?? existing.weekday)

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
    // FIX sep-2026: ignorar asignaciones en consultorios INACTIVOS (misma
    // razon que en crear — el consultorio viejo migrado no debe bloquear).
    if (!recurso.multiRoom) {
      // FIX oct-2026 · Mismo fallo que en crear: era findFirst, que trae UNA
      // asignacion cualquiera del dia. Con dos turnos ya cargados, si la que
      // devolvia no pisaba la franja nueva, el doble turno pasaba.
      const delDia = await tx.assignment.findMany({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
        },
        include: { room: { include: { site: true } } },
      })
      const conflictoRecurso = delDia.find((a) => solapan(a, data.startTime, data.endTime))
      if (conflictoRecurso) {
        throw errors.conflict(
          `Conflicto: ${recurso.name} ya está asignado el ${data.weekday} en ${conflictoRecurso.room.name} (Sede ${conflictoRecurso.room.site.name} · ${conflictoRecurso.room.site.city}) de ${conflictoRecurso.startTime} a ${conflictoRecurso.endTime}. Si necesita usarlo en su sede, coordine con esa sede o cree una Solicitud de recurso.`
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
        room: { active: true },
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

    // Igual que al crear: si este turno cubre una ausencia, los turnos que esa
    // ausencia tumbó no ocupan a la auxiliar. Sin esto, editar un reemplazo
    // —cambiarle la hora, por ejemplo— volvía a chocar contra el ausente.
    const vacantesEd = await turnosQueLiberaElReemplazo(tx, {
      weekId: existing.weekId,
      weekday: data.weekday,
      coveredAbsenceId: data.coveredAbsenceId ?? existing.coveredAbsenceId,
    })
    const caidosEd = await turnosCaidosPorAusenciaDelMedico(tx, existing.weekId, data.weekday, existing.week.startDate)

    // VAL 4 (RN-08 aux): auxiliar libre — usa el sub-horario real
    // FIX sep-2026: ignorar consultorios inactivos (mismo criterio que VAL 2).
    if (data.assistantId && consultorio.requiresAssistant) {
      // FIX oct-2026 · Era findFirst, igual que en crear.
      const auxDelDia = await tx.assignment.findMany({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [{ assistantId: data.assistantId }, { assistant2Id: data.assistantId }, { resourceId: data.assistantId }],
        },
        include: { room: { include: { site: true } } },
      })
      // EXCEPCIÓN multi-cons: asistir al MISMO doctor multi-consultorio no es
      // conflicto. Va dentro del filtro para no descartar otra que sí lo sea.
      const conflictoAux = auxDelDia.find((a) =>
        !vacantesEd.has(a.id) && !caidosEd.has(a.id) &&
        solapaConAux(a, data.assistantId, subsEd.auxIni, subsEd.auxFin) &&
        !(a.resourceId === data.resourceId && recurso.multiRoom)
      )
      if (conflictoAux) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
        const ef = horarioEfectivoAuxEnAsig(conflictoAux, data.assistantId)
        throw errors.conflict(
          `Conflicto de auxiliar: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux.room.name} (Sede ${conflictoAux.room.site.name} · ${conflictoAux.room.site.city}) de ${ef.ini} a ${ef.fin}.`
        )
      }
      // 21-oct · RN-09 también para la auxiliar: no puede estar en dos
      // ciudades el mismo día. Solo se validaba al profesional, y una auxiliar
      // liberada por la ausencia de su médico en la mañana quedaba asignada en
      // otra ciudad aunque en la tarde siguiera con otro médico en la suya.
      const otraCiudad = auxDelDia.find((a) =>
        !vacantesEd.has(a.id) && !caidosEd.has(a.id) && a.room.site.city !== consultorio.site.city
      )
      if (otraCiudad) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
        const o = otraCiudad
        throw errors.conflict(
          `${aux?.name} no puede estar en dos ciudades el mismo día: ya está el ${data.weekday} en ${o.room.name} (${o.room.site.name} · ${o.room.site.city}) de ${o.startTime} a ${o.endTime}, y este turno es en ${consultorio.site.city}.`
        )
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
      // FIX oct-2026 · Era findFirst, el ultimo de los cuatro.
      const aux2DelDia = await tx.assignment.findMany({
        where: {
          ...excludeSelf,
          weekId: existing.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [{ assistantId: data.assistant2Id }, { assistant2Id: data.assistant2Id }, { resourceId: data.assistant2Id }],
        },
        include: { room: { include: { site: true } } },
      })
      const conflictoAux2 = aux2DelDia.find((a) =>
        !vacantesEd.has(a.id) && !caidosEd.has(a.id) &&
        solapaConAux(a, data.assistant2Id, subsEd.aux2Ini, subsEd.aux2Fin) &&
        !(a.resourceId === data.resourceId && recurso.multiRoom)
      )
      if (conflictoAux2) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
        const ef = horarioEfectivoAuxEnAsig(conflictoAux2, data.assistant2Id)
        throw errors.conflict(
          `Conflicto de auxiliar #2: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux2.room.name} (Sede ${conflictoAux2.room.site.name} · ${conflictoAux2.room.site.city}) de ${ef.ini} a ${ef.fin}.`
        )
      }
      // 21-oct · RN-09 también para la auxiliar: no puede estar en dos
      // ciudades el mismo día. Solo se validaba al profesional, y una auxiliar
      // liberada por la ausencia de su médico en la mañana quedaba asignada en
      // otra ciudad aunque en la tarde siguiera con otro médico en la suya.
      const otraCiudad2 = aux2DelDia.find((a) =>
        !vacantesEd.has(a.id) && !caidosEd.has(a.id) && a.room.site.city !== consultorio.site.city
      )
      if (otraCiudad2) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
        const o = otraCiudad2
        throw errors.conflict(
          `${aux?.name} no puede estar en dos ciudades el mismo día: ya está el ${data.weekday} en ${o.room.name} (${o.room.site.name} · ${o.room.site.city}) de ${o.startTime} a ${o.endTime}, y este turno es en ${consultorio.site.city}.`
        )
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
        room: { active: true },
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
        `${recurso.name} superaría el tope diario de ${topeActual}h efectivas (lleva ${horasDiaActual.toFixed(1)}h asignadas, agregaría ${(horasDiaTotal - horasDiaActual).toFixed(1)}h más = ${horasDiaTotal.toFixed(1)}h total — descontando almuerzo). Si este recurso trabaja habitualmente horas extras, pida al supervisor que aumente "Horas máx. día" en el catálogo de Recursos.`
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
        room: { active: true },
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

    // ---- VALIDACIÓN 7: autorización directivo para AUX sáb+dom (Ley 2101) ----
    await validarAutorizacionFinDeSemana(tx, data, recurso, id)

    // Override manual del coordinador: si conoce los pacientes REALES que se le
    // programaron desde la agenda externa, los usa; si no, cae al cálculo nominal.
    let pacientesCapacidad = data.expectedPatients != null
      ? data.expectedPatients
      : calcularCapacidad(
          data.startTime,
          data.endTime,
          recurso.slotMinutes ?? 15,
          recurso.type,
        )

    // El mismo tope que al crear: editar un reemplazo no puede subirle los
    // pacientes por encima de los que faltaban por reprogramar.
    const pendientesEd = await pacientesPorReprogramar(tx, existing.coveredAbsenceId, id)
    if (pendientesEd != null) {
      if (data.expectedPatients != null && data.expectedPatients > pendientesEd) {
        throw errors.badRequest(
          `Son ${pendientesEd} pacientes por reprogramar: no se pueden poner ${data.expectedPatients}.`
        )
      }
      pacientesCapacidad = Math.min(pacientesCapacidad, pendientesEd)
    }

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
        // Autorización fin de semana (VAL 7). Si no se necesitó, quedan en null.
        authorizedById: data.authorizedById ?? null,
        authorizedAt: data.authorizedById ? new Date() : null,
        authorizationReason: data.authorizedById ? (data.authorizationReason?.trim() ?? null) : null,
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
      wasSupervisor: ROLES_EDITAN_CERRADA.has(userCtx.role) && !!cierreSede,
    }
  }, { isolationLevel: 'ReadCommitted' })
}

/**
 * Los turnos que un reemplazo deja LIBRES: los del ausente que su ausencia
 * tumbó ese día.
 *
 * Oct-2026 · Sin esto no se podía asignar a nadie en el caso más normal. El
 * colega entra a cubrir la misma franja, en el mismo consultorio, con la misma
 * auxiliar —Lina Torres asistía al Dr. Córnea y ahora asiste al Dr. Rangel—,
 * y la validación de auxiliar comparaba contra el turno del Dr. Córnea, que es
 * justo el que se cayó. Lo daba como "Lina está en dos sitios a la vez" y el
 * botón Asignar rebotaba con todos los candidatos.
 *
 * Solo se liberan los turnos que la ausencia DE VERDAD tumba. En una parcial,
 * los de fuera de su horario siguen en pie: si el Dr. Córnea falta en la
 * mañana y Lina lo asiste también por la tarde, ponerla con otro médico por la
 * tarde SÍ es un conflicto, y tiene que seguir saltando.
 *
 * @returns {Promise<Set<string>>} ids de asignaciones a ignorar como conflicto
 */
/**
 * 3583 · Los turnos de ese día cuyo MÉDICO está ausente (ausencia confirmada,
 * y en una parcial solo los que pisan sus horas). Ese turno no se atiende, así
 * que no ocupa a su auxiliar: queda libre para cubrir otro. Es la prioridad 1
 * de la lista de candidatas, y el servidor tiene que pensar igual que la lista
 * — antes la ofrecía primero y al asignarla la rechazaba por "conflicto".
 * Solo se usa en las validaciones de la auxiliar, nunca en la del médico.
 */
async function turnosCaidosPorAusenciaDelMedico(tx, weekId, weekday, inicioSemana) {
  const fecha = fechaDeTurno(inicioSemana, weekday)
  if (!fecha) return new Set()
  // Solo los tipos que liberan a su auxiliar al faltar (RN-24): oftalmólogo,
  // anestesiólogo y otorrino. Es la misma regla de liberarAuxiliaresSiAplica.
  const ausencias = await tx.absence.findMany({
    where: {
      source: 'sgrc',   // Oct-2026 · Sin el histórico del Excel: solo lo registrado en el SGRC.
      status: 'confirmada', startDate: { lte: new Date(fecha) }, endDate: { gte: new Date(fecha) },
      resource: { is: { type: { in: [...TIPOS_QUE_LIBERAN_AUXILIAR] } } },
    },
    select: { resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
  })
  if (!ausencias.length) return new Set()
  const turnos = await tx.assignment.findMany({
    where: { weekId, weekday, status: { not: 'cancelada' }, resourceId: { in: ausencias.map((a) => a.resourceId) } },
    select: { id: true, resourceId: true, startTime: true, endTime: true },
  })
  return new Set(turnos.filter((t) => ausencias.some((a) => a.resourceId === t.resourceId &&
    (!a.isPartial || !a.absenceStartTime || !a.absenceEndTime || solapan(t, a.absenceStartTime, a.absenceEndTime))))
    .map((t) => t.id))
}

async function turnosQueLiberaElReemplazo(tx, data) {
  if (!data.coveredAbsenceId) return new Set()
  const cubierta = await tx.absence.findUnique({
    where: { id: data.coveredAbsenceId },
    select: { resourceId: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
  })
  if (!cubierta) return new Set()

  const delAusente = await tx.assignment.findMany({
    where: {
      weekId: data.weekId,
      weekday: data.weekday,
      resourceId: cubierta.resourceId,
      status: { not: 'cancelada' },
    },
    select: { id: true, startTime: true, endTime: true },
  })
  const parcialConHoras = cubierta.isPartial && cubierta.absenceStartTime && cubierta.absenceEndTime
  const caidos = parcialConHoras
    ? delAusente.filter((a) => solapan(a, cubierta.absenceStartTime, cubierta.absenceEndTime))
    : delAusente
  return new Set(caidos.map((a) => a.id))
}

/**
 * El turno caído que este reemplazo cubre en el MISMO consultorio y día: el
 * del ausente que pisa su horario. null si el reemplazo va a otro sitio (otro
 * consultorio, otro día) — entonces no es un tramo de esa franja.
 */
async function turnoCaidoDelMismoConsultorio(tx, data) {
  if (!data.coveredAbsenceId) return null
  const cubierta = await tx.absence.findUnique({
    where: { id: data.coveredAbsenceId },
    select: { resourceId: true },
  })
  if (!cubierta) return null
  const caidos = await tx.assignment.findMany({
    where: {
      weekId: data.weekId, weekday: data.weekday, roomId: data.roomId,
      resourceId: cubierta.resourceId, status: { not: 'cancelada' },
    },
    select: { startTime: true, endTime: true, patientCapacity: true },
  })
  return caidos.find((a) => solapan(a, data.startTime, data.endTime)) ?? null
}

/**
 * Los pacientes de la agenda caída que caen en el tramo que se va a cubrir,
 * o null si no es un tramo de una franja caída. Mismo reparto proporcional que
 * la pantalla del caso (lib/tramos), así los tramos suman exacto la franja.
 */
async function pacientesDelTramoQueCubre(tx, data) {
  const caido = await turnoCaidoDelMismoConsultorio(tx, data)
  if (!caido) return null
  return pacientesDelTramo(
    caido.patientCapacity ?? 0,
    { desde: caido.startTime, hasta: caido.endTime },
    { desde: data.startTime, hasta: data.endTime },
  )
}

/**
 * Cuántos pacientes de una ausencia faltan por reprogramar: los afectados
 * menos los que ya tienen médico o día nuevo. null si no es una
 * reprogramación o la ausencia no tiene pacientes contados (datos viejos): en
 * ese caso no hay contra qué poner tope.
 */
export async function pacientesPorReprogramar(tx, coveredAbsenceId, excluirId = null) {
  if (!coveredAbsenceId) return null
  const ausencia = await tx.absence.findUnique({
    where: { id: coveredAbsenceId },
    select: { patientsAffected: true, patientsConfirmed: true },
  })
  // El real que puso la líder, si lo puso; si no, el estimado.
  const total = pacientesDelCaso(ausencia)
  if (total <= 0) return null
  const ya = await tx.assignment.aggregate({
    // Al editar, el turno que se edita no cuenta: sus pacientes son los que
    // se están volviendo a poner.
    where: { coveredAbsenceId, status: { not: 'cancelada' }, ...(excluirId ? { id: { not: excluirId } } : {}) },
    _sum: { patientCapacity: true },
  })
  return Math.max(0, total - (ya._sum.patientCapacity ?? 0))
}

/** Rechaza cubrir una ausencia que no está confirmada (pendiente o rechazada). */
async function exigirAusenciaConfirmada(tx, coveredAbsenceId, userCtx = null) {
  if (!coveredAbsenceId) return
  const ausencia = await tx.absence.findUnique({
    where: { id: coveredAbsenceId },
    select: { status: true, resource: { select: { type: true } } },
  })
  if (!ausencia) throw errors.notFound('La ausencia que se quiere cubrir no existe')
  // 21-oct · El coordinador no cubre la agenda de un profesional: es de la líder.
  if (coordSoloVe(userCtx, ausencia.resource?.type)) throw errors.forbidden(MSG_SOLO_VE)
  if (ausencia.status === 'pendiente') {
    throw errors.badRequest('Primero confirme la ausencia: no se cubre una agenda que no se sabe si se cayó.')
  }
  if (ausencia.status !== 'confirmada') {
    throw errors.badRequest('Esa ausencia fue rechazada: no hay agenda que cubrir.')
  }
}

/** Otro tramo de reemplazo de la MISMA ausencia, en el mismo consultorio y día, que pisa este. */
async function tramoQueSePisa(tx, data) {
  if (!data.coveredAbsenceId) return null
  const otros = await tx.assignment.findMany({
    where: {
      weekId: data.weekId, weekday: data.weekday, roomId: data.roomId,
      coveredAbsenceId: data.coveredAbsenceId, status: { not: 'cancelada' },
    },
    select: { startTime: true, endTime: true, resource: { select: { name: true } } },
  })
  return otros.find((a) => solapan(a, data.startTime, data.endTime)) ?? null
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

    // ---- Solo se cubre una ausencia CONFIRMADA ----
    // Oct-2026 · El orden que fijó Hector: por confirmar → por cubrir. Antes la
    // pantalla del caso dejaba cubrir una ausencia "Sin confirmar" y el caso se
    // quedaba arriba en "por confirmar" para siempre, cubierto o no.
    await exigirAusenciaConfirmada(tx, data.coveredAbsenceId, userCtx)

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
      if (!ROLES_EDITAN_CERRADA.has(userCtx.role)) {
        throw errors.forbidden('No tiene permiso para asignar en esta sede — su cierre semanal ya fue procesado')
      }
      if (!data.supervisorReason || data.supervisorReason.trim().length < 5) {
        throw errors.badRequest('Modificar una sede cerrada requiere un motivo (mín 5 caracteres)')
      }
    }

    // ---- 3583 · La sede no puede estar BLOQUEADA ese día ----
    // Un bloqueo lo pone supervisor o gerencia cuando no hay disponibilidad;
    // mientras dure no se programa ahí, sin excepción por rol.
    await exigirSedeSinBloqueo(tx, consultorio, semana.startDate, data.weekday)

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
    // FIX sep-2026: se ignoran asignaciones en consultorios INACTIVOS.
    // No aplica ese día, por lo tanto no debe bloquear. Evita el caso de
    // consultorios viejos migrados que quedan con asignaciones huerfanas.
    // Oct-2026 · LA UNICA EXCEPCION A RN-08.
    // Un profesional que se hace cargo de la agenda de alguien que falto puede
    // quedar con un turno ADICIONAL en una franja donde ya tiene el suyo: el
    // propio sigue siendo el propio y el nuevo dice de quien son los pacientes
    // que asume. Pide las dos condiciones a la vez —que el turno cubra una
    // ausencia Y que quien lo crea lo marque— asi que no se llega aqui sin
    // querer. El controlador deja auditoria y avisa al profesional.
    const asumeAgendaAjena = !!data.coveredAbsenceId && data.assumeOverlap === true
    if (!recurso.multiRoom && !asumeAgendaAjena) {
      // FIX oct-2026 · Esto era findFirst, y por ahi se colaba el doble turno.
      //
      // findFirst traia UNA asignacion cualquiera de ese dia, y solo esa se
      // comparaba. Si el profesional ya tenia dos turnos —muy normal: la
      // manana en una sala y la tarde en otra— y la que devolvia la consulta
      // no pisaba la franja nueva, RN-08 daba via libre aunque la OTRA si la
      // pisara.
      //
      // Resultado: bastaba con tener ya dos turnos ese dia para poder quedar
      // en dos sitios a la vez. Lo encontro qa:flujo en cuanto los datos de
      // prueba empezaron a dar mas de un turno por dia.
      //
      // Hay que mirarlas TODAS y quedarse con la que de verdad solapa.
      const delDia = await tx.assignment.findMany({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [
            { resourceId: data.resourceId },
            { assistantId: data.resourceId },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      const conflictoRecurso = delDia.find((a) => solapan(a, data.startTime, data.endTime))
      if (conflictoRecurso) {
        throw errors.conflict(
          `Conflicto: ${recurso.name} ya está asignado el ${data.weekday} en ${conflictoRecurso.room.name} (Sede ${conflictoRecurso.room.site.name} · ${conflictoRecurso.room.site.city}) de ${conflictoRecurso.startTime} a ${conflictoRecurso.endTime}. Si necesita usarlo en su sede, coordine con esa sede o cree una Solicitud de recurso.`
        )
      }
    }

    // ---- VALIDACIÓN 3: ciudad única ese día (RN-09) ----
    // Mismo criterio: consultorios inactivos no bloquean.
    const otraDelDia = await tx.assignment.findFirst({
      where: {
        weekId: data.weekId,
        weekday: data.weekday,
        status: { not: 'cancelada' },
        room: { active: true },
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

    // ---- Turnos que este reemplazo deja LIBRES ----
    const vacantes = await turnosQueLiberaElReemplazo(tx, data)
    const caidos = await turnosCaidosPorAusenciaDelMedico(tx, data.weekId, data.weekday, semana.startDate)

    // ---- Un tramo de reemplazo no pisa a otro ----
    // Oct-2026 · Una franja se puede cubrir por TRAMOS: cada médico toma una
    // parte del horario en el mismo consultorio. Dos tramos que se pisan son
    // dos médicos en el mismo consultorio a la misma hora, y los pacientes de
    // ese rato quedarían contados dos veces.
    //
    // Va ANTES de la validación de auxiliar a propósito: los dos tramos suelen
    // compartir auxiliar, así que esa también saltaría, pero con un motivo que
    // no ayuda ("conflicto de auxiliar"). Este dice qué está pasando.
    const tramoPrevio = await tramoQueSePisa(tx, data)
    if (tramoPrevio) {
      throw errors.conflict(
        `Ese horario ya lo cubre ${tramoPrevio.resource?.name ?? 'otro profesional'} de ${tramoPrevio.startTime} a ${tramoPrevio.endTime}. Elija el tramo que falta.`
      )
    }

    // ---- VALIDACIÓN 4: auxiliar libre si aplica (RN-08 para aux) ----
    // Usa el sub-horario de la auxiliar (si fue parcial) para detectar conflicto real.
    // EXCEPCIÓN: si la otra asignación es del MISMO doctor multi-consultorio,
    // la aux puede estar simultáneamente — está asistiendo al mismo doc rotando entre salas.
    if (data.assistantId && consultorio.requiresAssistant) {
      // FIX oct-2026 · Era findFirst: mismo fallo que en RN-08. Una auxiliar
      // con dos turnos ese dia podia quedar en dos sitios a la vez si la
      // asignacion que devolvia la consulta no era la que solapaba.
      const delDia = await tx.assignment.findMany({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [
            { assistantId: data.assistantId },
            { assistant2Id: data.assistantId },
            { resourceId: data.assistantId },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      // La excepcion entra en el filtro: asistir al MISMO doctor
      // multi-consultorio no es conflicto, es su trabajo. Tampoco lo es el
      // turno del ausente que este reemplazo viene a cubrir: ver
      // turnosQueLiberaElReemplazo.
      const conflictoAux = delDia.find((a) =>
        !vacantes.has(a.id) && !caidos.has(a.id) &&
        solapaConAux(a, data.assistantId, subs.auxIni, subs.auxFin) &&
        !(a.resourceId === data.resourceId && recurso.multiRoom)
      )
      if (conflictoAux) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
        const ef = horarioEfectivoAuxEnAsig(conflictoAux, data.assistantId)
        throw errors.conflict(
          `Conflicto de auxiliar: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux.room.name} (Sede ${conflictoAux.room.site.name} · ${conflictoAux.room.site.city}) de ${ef.ini} a ${ef.fin}.`
        )
      }
      // 21-oct · RN-09 también para la auxiliar: no puede estar en dos
      // ciudades el mismo día. Solo se validaba al profesional, y una auxiliar
      // liberada por la ausencia de su médico en la mañana quedaba asignada en
      // otra ciudad aunque en la tarde siguiera con otro médico en la suya.
      const otraCiudad = delDia.find((a) =>
        !vacantes.has(a.id) && !caidos.has(a.id) && a.room.site.city !== consultorio.site.city
      )
      if (otraCiudad) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistantId } })
        const o = otraCiudad
        throw errors.conflict(
          `${aux?.name} no puede estar en dos ciudades el mismo día: ya está el ${data.weekday} en ${o.room.name} (${o.room.site.name} · ${o.room.site.city}) de ${o.startTime} a ${o.endTime}, y este turno es en ${consultorio.site.city}.`
        )
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
      // FIX oct-2026 · Era findFirst, igual que los otros tres.
      const delDia2 = await tx.assignment.findMany({
        where: {
          weekId: data.weekId,
          weekday: data.weekday,
          status: { not: 'cancelada' },
          room: { active: true },
          OR: [
            { assistantId: data.assistant2Id },
            { assistant2Id: data.assistant2Id },
            { resourceId: data.assistant2Id },
          ],
        },
        include: { room: { include: { site: true } } },
      })
      const conflictoAux2 = delDia2.find((a) =>
        !vacantes.has(a.id) && !caidos.has(a.id) &&
        solapaConAux(a, data.assistant2Id, subs.aux2Ini, subs.aux2Fin) &&
        !(a.resourceId === data.resourceId && recurso.multiRoom)
      )
      if (conflictoAux2) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
        const ef = horarioEfectivoAuxEnAsig(conflictoAux2, data.assistant2Id)
        throw errors.conflict(
          `Conflicto de auxiliar #2: ${aux?.name} ya está asignada el ${data.weekday} en ${conflictoAux2.room.name} (Sede ${conflictoAux2.room.site.name} · ${conflictoAux2.room.site.city}) de ${ef.ini} a ${ef.fin}.`
        )
      }
      // 21-oct · RN-09 también para la auxiliar: no puede estar en dos
      // ciudades el mismo día. Solo se validaba al profesional, y una auxiliar
      // liberada por la ausencia de su médico en la mañana quedaba asignada en
      // otra ciudad aunque en la tarde siguiera con otro médico en la suya.
      const otraCiudad2 = delDia2.find((a) =>
        !vacantes.has(a.id) && !caidos.has(a.id) && a.room.site.city !== consultorio.site.city
      )
      if (otraCiudad2) {
        const aux = await tx.resource.findUnique({ where: { id: data.assistant2Id } })
        const o = otraCiudad2
        throw errors.conflict(
          `${aux?.name} no puede estar en dos ciudades el mismo día: ya está el ${data.weekday} en ${o.room.name} (${o.room.site.name} · ${o.room.site.city}) de ${o.startTime} a ${o.endTime}, y este turno es en ${consultorio.site.city}.`
        )
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
        room: { active: true },
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
        `${recurso.name} superaría el tope diario de ${topeActual}h efectivas (lleva ${horasDiaActual.toFixed(1)}h asignadas, agregaría ${(horasDiaTotal - horasDiaActual).toFixed(1)}h más = ${horasDiaTotal.toFixed(1)}h total — descontando almuerzo). Si este recurso trabaja habitualmente horas extras, pida al supervisor que aumente "Horas máx. día" en el catálogo de Recursos.`
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
        room: { active: true },
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

    // ---- VALIDACIÓN 7: autorización directivo para AUX sáb+dom (Ley 2101) ----
    await validarAutorizacionFinDeSemana(tx, data, recurso)

    // ---- INSERT con todas las validaciones pasadas ----
    // Override manual: si el coord conoce los pacientes REALES, los usa.
    // Si es un tramo de reemplazo, los pacientes son los de la AGENDA QUE SE
    // CAYÓ en ese rato —el paciente conserva su hora—, no la capacidad del
    // médico que cubre calculada por su propio intervalo.
    const pacientesDelTramoCaido = data.expectedPatients == null ? await pacientesDelTramoQueCubre(tx, data) : null
    let pacientesCapacidad = data.expectedPatients != null
      ? data.expectedPatients
      : pacientesDelTramoCaido != null
        ? pacientesDelTramoCaido
        : calcularCapacidad(
          data.startTime,
          data.endTime,
          recurso.slotMinutes ?? 15,
          recurso.type,
        )

    // ---- Una reprogramación no toma más pacientes de los que faltan ----
    // Oct-2026 · Hector: "en pacientes reales no aceptar una cantidad mayor a
    // la que debe ser repro: si son 20, bloquear 21 en adelante". La pantalla
    // ya lo bloquea; aquí se cierra para quien escriba la petición a mano.
    //
    // Y si el campo se deja vacío, tampoco: antes se guardaba la capacidad del
    // médico que cubre (24) aunque solo faltaran 10, y el caso contaba 24
    // pacientes reprogramados de una agenda de 10.
    const pendientes = await pacientesPorReprogramar(tx, data.coveredAbsenceId)
    if (pendientes != null) {
      if (data.expectedPatients != null && data.expectedPatients > pendientes) {
        throw errors.badRequest(
          `Son ${pendientes} pacientes por reprogramar: no se pueden poner ${data.expectedPatients}.`
        )
      }
      pacientesCapacidad = Math.min(pacientesCapacidad, pendientes)
    }

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
        // Autorización fin de semana (VAL 7). Si no se necesitó, quedan en null.
        authorizedById: data.authorizedById ?? null,
        authorizedAt: data.authorizedById ? new Date() : null,
        authorizationReason: data.authorizedById ? (data.authorizationReason?.trim() ?? null) : null,
      },
      include: {
        resource: true,
        assistant: true,
        assistant2: true,
        room: { include: { site: true } },
      },
    })

    return { assignment: nueva, wasSupervisor: ROLES_EDITAN_CERRADA.has(userCtx.role) && semana.status === 'cerrada' }
  }, { isolationLevel: 'ReadCommitted' })
  // READ COMMITTED: tras esperar el FOR UPDATE, la 2ª transacción ve el INSERT ya
  // commiteado por la 1ª y detecta el conflicto. En REPEATABLE READ (default de
  // MySQL) leería un snapshot viejo y dejaría pasar la asignación duplicada.
}
