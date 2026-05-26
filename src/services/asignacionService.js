import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'

/**
 * Lógica central del SGRC — Diagrama 3.
 * Ejecuta las 6 verificaciones en orden estricto antes de INSERT.
 * Usa transacción + locks para garantizar atomicidad (RN-16).
 */

const hhmmAMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const horasDeFranja = (hi, hf) => (hhmmAMinutos(hf) - hhmmAMinutos(hi)) / 60

const solapan = (a, hi, hf) => !(hf <= a.horaInicio || hi >= a.horaFin)

/**
 * Calcula capacidad de pacientes según RN-11:
 * - Si jornada ≥ 6h: descontar 60min de almuerzo
 * - capacidad = FLOOR(minutos_disponibles / intervalo_minutos)
 */
export function calcularCapacidad(horaInicio, horaFin, intervaloMinutos) {
  const minutos = hhmmAMinutos(horaFin) - hhmmAMinutos(horaInicio)
  if (minutos <= 0) return 0
  const almuerzo = minutos >= 360 ? 60 : 0
  const disponibles = minutos - almuerzo
  return Math.floor(disponibles / (intervaloMinutos || 15))
}

/**
 * Valida y crea una asignación aplicando las 6 reglas del Diagrama 3.
 *
 * @param {object} data - datos de la asignación a crear
 * @param {object} userCtx - { id, rol }
 */
export async function crearAsignacion(data, userCtx) {
  return prisma.$transaction(async (tx) => {
    // ---- Cargar entidades base ----
    const semana = await tx.semana.findUnique({ where: { id: data.semanaId } })
    if (!semana) throw errors.notFound('Semana no encontrada')

    const consultorio = await tx.consultorio.findUnique({
      where: { id: data.consultorioId },
      include: { sede: true },
    })
    if (!consultorio) throw errors.notFound('Consultorio no encontrado')

    const recurso = await tx.recurso.findUnique({ where: { id: data.recursoId } })
    if (!recurso) throw errors.notFound('Recurso no encontrado')
    if (!recurso.activo) throw errors.badRequest('El recurso está inactivo')

    // ---- VALIDACIÓN 1: semana abierta o supervisor (RN crítica) ----
    if (semana.estado === 'cerrada' && userCtx.rol !== 'supervisor') {
      throw errors.forbidden('No tienes permiso para modificar esta semana — está cerrada')
    }

    // Si es supervisor sobre semana cerrada, requiere motivo
    if (semana.estado === 'cerrada' && userCtx.rol === 'supervisor') {
      if (!data.motivoSupervisor || data.motivoSupervisor.trim().length < 5) {
        throw errors.badRequest('Modificar una semana cerrada requiere un motivo (mín 5 caracteres)')
      }
    }

    // ---- RN-16: condición de carrera (MySQL — lock de fila FOR UPDATE) ----
    // Bloqueamos la fila del recurso (y del auxiliar si aplica) con FOR UPDATE.
    // InnoDB serializa las transacciones concurrentes para el mismo recurso y
    // LIBERA el lock recién en el COMMIT/ROLLBACK — así NO hay ventana entre la
    // validación y el insert (el bug que tendría GET_LOCK, que se libera antes del
    // commit). Funciona aunque no existan asignaciones previas, porque la fila del
    // recurso siempre existe. Orden de ids consistente = sin deadlocks.
    const lockIds = data.auxiliarId
      ? [data.recursoId, data.auxiliarId].sort()
      : [data.recursoId]
    for (const id of lockIds) {
      // $queryRawUnsafe (no $executeRawUnsafe) para que el SELECT ... FOR UPDATE
      // se ejecute como consulta y tome el lock de fila en InnoDB.
      await tx.$queryRawUnsafe(`SELECT id FROM recursos WHERE id = ? FOR UPDATE`, id)
    }

    // ---- VALIDACIÓN 2: recurso libre en franja ese día (RN-08) ----
    const conflictoRecurso = await tx.asignacion.findFirst({
      where: {
        semanaId: data.semanaId,
        diaSemana: data.diaSemana,
        estado: { not: 'cancelada' },
        OR: [
          { recursoId: data.recursoId },
          { auxiliarId: data.recursoId },
        ],
      },
      include: { consultorio: true },
    })
    if (conflictoRecurso && solapan(conflictoRecurso, data.horaInicio, data.horaFin)) {
      throw errors.conflict(
        `Conflicto: ${recurso.nombre} ya está asignado en ${conflictoRecurso.consultorio.nombre} de ${conflictoRecurso.horaInicio} a ${conflictoRecurso.horaFin}`
      )
    }

    // ---- VALIDACIÓN 3: ciudad única ese día (RN-09) ----
    const otraDelDia = await tx.asignacion.findFirst({
      where: {
        semanaId: data.semanaId,
        diaSemana: data.diaSemana,
        estado: { not: 'cancelada' },
        OR: [{ recursoId: data.recursoId }, { auxiliarId: data.recursoId }],
      },
      include: { consultorio: { include: { sede: true } } },
    })
    if (otraDelDia && otraDelDia.consultorio.sede.ciudad !== consultorio.sede.ciudad) {
      throw errors.conflict(
        `${recurso.nombre} no puede estar en dos ciudades el mismo día (${otraDelDia.consultorio.sede.ciudad} y ${consultorio.sede.ciudad})`
      )
    }

    // ---- VALIDACIÓN 4: auxiliar libre si aplica (RN-08 para aux) ----
    if (data.auxiliarId && consultorio.requiereAuxiliar) {
      const conflictoAux = await tx.asignacion.findFirst({
        where: {
          semanaId: data.semanaId,
          diaSemana: data.diaSemana,
          estado: { not: 'cancelada' },
          OR: [{ auxiliarId: data.auxiliarId }, { recursoId: data.auxiliarId }],
        },
        include: { consultorio: true },
      })
      if (conflictoAux && solapan(conflictoAux, data.horaInicio, data.horaFin)) {
        const aux = await tx.recurso.findUnique({ where: { id: data.auxiliarId } })
        throw errors.conflict(
          `Conflicto de auxiliar: ${aux?.nombre} ya está asignada en ${conflictoAux.consultorio.nombre} en esa franja`
        )
      }
    }

    // ---- VALIDACIÓN 5: ≤10h diarias (RN-13) ----
    const horasNueva = horasDeFranja(data.horaInicio, data.horaFin)
    if (horasNueva <= 0) throw errors.badRequest('Franja horaria inválida')

    const otrasDelDia = await tx.asignacion.findMany({
      where: {
        semanaId: data.semanaId,
        diaSemana: data.diaSemana,
        estado: { not: 'cancelada' },
        OR: [{ recursoId: data.recursoId }, { auxiliarId: data.recursoId }],
      },
    })
    const horasDia = otrasDelDia.reduce((acc, a) => acc + horasDeFranja(a.horaInicio, a.horaFin), 0)
    if (horasDia + horasNueva > (recurso.horasMaxDia ?? 10)) {
      throw errors.badRequest(
        `${recurso.nombre} superaría el máximo de ${recurso.horasMaxDia ?? 10} horas diarias (lleva ${horasDia}h, suma ${horasNueva}h)`
      )
    }

    // ---- VALIDACIÓN 6: >42h semanales → flag, NO bloquea (RN-13) ----
    const otrasSemana = await tx.asignacion.findMany({
      where: {
        semanaId: data.semanaId,
        estado: { not: 'cancelada' },
        OR: [{ recursoId: data.recursoId }, { auxiliarId: data.recursoId }],
      },
    })
    const horasSemana = otrasSemana.reduce((acc, a) => acc + horasDeFranja(a.horaInicio, a.horaFin), 0)
    const esHorasExtras = (horasSemana + horasNueva) > (recurso.horasMaxSemana ?? 42)

    // Horas nocturnas: cualquier minuto >= 18:00
    const tieneHorasNocturnas = data.horaFin > '18:00' || data.horaInicio >= '18:00'

    // ---- INSERT con todas las validaciones pasadas ----
    const pacientesCapacidad = calcularCapacidad(
      data.horaInicio,
      data.horaFin,
      recurso.intervaloMinutos ?? 15
    )

    const nueva = await tx.asignacion.create({
      data: {
        semanaId: data.semanaId,
        recursoId: data.recursoId,
        auxiliarId: data.auxiliarId,
        consultorioId: data.consultorioId,
        diaSemana: data.diaSemana,
        horaInicio: data.horaInicio,
        horaFin: data.horaFin,
        pacientesCapacidad,
        esHorasExtras,
        tieneHorasNocturnas,
        esReemplazo: data.esReemplazo ?? false,
        ausenciaCubiertaId: data.ausenciaCubiertaId,
      },
      include: {
        recurso: true,
        auxiliar: true,
        consultorio: { include: { sede: true } },
      },
    })

    return { asignacion: nueva, fueSupervisor: userCtx.rol === 'supervisor' && semana.estado === 'cerrada' }
  }, { isolationLevel: 'ReadCommitted' })
  // READ COMMITTED: tras esperar el FOR UPDATE, la 2ª transacción ve el INSERT ya
  // commiteado por la 1ª y detecta el conflicto. En REPEATABLE READ (default de
  // MySQL) leería un snapshot viejo y dejaría pasar la asignación duplicada.
}
