import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { parseISO } from 'date-fns'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar, notificarCoordinadoresDeSede, notificarSupervisores, notificarDirectivos, notificarDireccionMedica } from '../services/notificationService.js'
import { calcularImpacto, liberarAuxiliaresSiAplica } from '../services/absenceService.js'
import { alcanceDeReprogramacion, TIPOS_PROFESIONALES, coordSoloVe, MSG_SOLO_VE } from '../lib/resourceTypes.js'
import { huecosDeFranja, pacientesDelTramo, parteAfectada, ausenciasSeCruzan, errorEnFechasDeAusencia } from '../lib/tramos.js'
import { pacientesDelCaso } from '../lib/pacientesDelCaso.js'
import { fechaSolo } from '../lib/fechas.js'
import { programacionLibre } from '../lib/schedulingMode.js'
import { esProgramada, diasDeAnticipacion } from '../lib/anticipacion.js'
import { AUTORIZACION_DATOS, pideAutorizacionDatos } from '../lib/datosPersonales.js'
import { fechaDeTurno, isoDia } from '../lib/bloqueosSede.js'
import { esRemunerada, sePuedeCambiarRemuneracion, SIEMPRE_REMUNERADA } from '../lib/remuneracion.js'
import { editarAsignacion } from '../services/assignmentService.js'

// La lista de "tipos que atienden pacientes" vive en lib/resourceTypes.js,
// que es donde debe consultarse.

const TIPOS = ['enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion', 'licencia_remunerada', 'licencia_no_remunerada', 'otra']

// Convierte strings vacías → undefined ANTES de validar.
// El frontend manda `""` cuando no hay valor (typical de inputs no llenos);
// sin esto, Zod rebota con "Datos inválidos" en campos opcionales.
const emptyToUndef = (v) => (v === '' ? undefined : v)

// Sep-2026: helper de scoping para coordinador. Un recurso "pertenece" al
// coordinador si CUALQUIERA de estas es cierta:
//   1. Tiene User cuyas sedes incluyen alguna de las del coord (patron clasico).
//   2. Su coordinador-lider es este coord (recursos rotativos como Munir/Katiuscka).
//   3. Tiene asignaciones en alguna sede del coord (fallback para recursos
//      sin User ni lider explicito pero programados de facto).
// Antes solo usabamos (1), lo que ocultaba ausencias/reposiciones de recursos
// sin User o del pool rotativo.
function recursoAlcanceCoord(misSedes, coordUserId) {
  return {
    OR: [
      { user: { is: { sites: { some: { siteId: { in: misSedes } } } } } },
      { leadCoordinatorId: coordUserId },
      { assignmentsAsLead:      { some: { room: { siteId: { in: misSedes } } } } },
      { assignmentsAsAssistant: { some: { room: { siteId: { in: misSedes } } } } },
    ],
  }
}

const crearSchema = z.object({
  resourceId: z.string().uuid(),
  startDate: z.string(),
  endDate: z.preprocess(emptyToUndef, z.string().optional()),
  isPartial: z.boolean().optional(),
  absenceStartTime: z.preprocess(emptyToUndef, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  absenceEndTime: z.preprocess(emptyToUndef, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  // tipo es el legacy enum, sigue requerido para retro-compatibilidad. El
  // frontend nuevo manda motivoId (catálogo editable); si solo manda tipo,
  // resolvemos motivoId automáticamente por codigo=tipo.
  type: z.enum(TIPOS),
  reasonId: z.preprocess(emptyToUndef, z.string().uuid().optional()),
  reason: z.preprocess(emptyToUndef, z.string().optional()),
  // Ciudad de cobertura cuando el motivo es "regional" (ago-2026).
  // Se ignora si el motivo no es regional — el controller no reproduce esa lógica
  // al usuario; simplemente guarda null si el motivo elegido no lo requiere.
  regionalCity: z.preprocess(emptyToUndef, z.string().max(60).optional()),
  // Versión del texto de datos personales que aceptó (lib/datosPersonales.js).
  dataConsentVersion: z.preprocess(emptyToUndef, z.string().max(40).optional()),
  // 3739 · Lo que se eligió en el primer nivel ("¿La ausencia es remunerada?").
  isPaid: z.boolean().optional(),
  // Empresa a la que aplica la ausencia. Decide la razón social con la que sale
  // en los informes: FOCA y VIU son entidades distintas.
  affectedCompany: z.preprocess(emptyToUndef, z.enum(['foca', 'viu', 'ambas']).optional()),
  // ¿Desea reponer? Dispara el flujo de reposición.
  // Parseo explícito: z.coerce.boolean() convierte "false" (string) → true,
  // corrompiendo la respuesta. Aceptamos solo boolean nativo
  // o los strings "true"/"false" / 0/1 que un cliente REST legítimo puede enviar.
  wantsMakeup: z.preprocess(
    (v) => {
      if (v === '' || v === undefined || v === null) return undefined
      if (typeof v === 'boolean') return v
      if (v === 'true' || v === 1 || v === '1' || v === 'si' || v === 'sí') return true
      if (v === 'false' || v === 0 || v === '0' || v === 'no') return false
      return v  // Deja que z.boolean() falle explícitamente con valores raros
    },
    z.boolean().optional(),
  ),
  // Observaciones de la reposición propuesta (texto libre, opcional).
  makeupNotes: z.preprocess(emptyToUndef, z.string().max(2000).optional()),
  // §4 · Fecha propuesta de reposicion. Opcional: el profesional puede no
  // tenerla todavia y acordarla despues con su coordinador.
  makeupDate: z.preprocess(emptyToUndef, z.string().optional()),
  // Oct-2026 · Varias fechas de reposición (calendario de selección múltiple).
  makeupDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida')).max(31, 'Máximo 31 fechas').optional(),
  recordedByCoordinator: z.boolean().optional(),
})

const ACCIONES_AGENDA = ['reprogramada', 'cubierta', 'perdida', 'sin_agenda']

const confirmarSchema = z.object({
  notaCoordinador: z.string().optional(),
  // Oct-2026 S 6.1 — que paso con la agenda. Codigo, no prosa: es lo que
  // permite contar cuantas se reprogramaron y cuantas se perdieron.
  actionTaken: z.preprocess(emptyToUndef, z.enum(ACCIONES_AGENDA).optional().nullable()),
})

const rechazarSchema = z.object({
  reason: z.string().min(5, 'El motivo es obligatorio (mín 5 caracteres)'),
})

export async function list(req, res) {
  const { status: estado, resource_id: recurso_id, site_id: sede_id, desde, hasta, family: familia, include_rejected: incluir_rechazadas } = req.query
  const where = {}
  if (estado) where.status = estado

  // ---- Scoping por rol (ago-2026, hardening tras Fase 2 verify) ----
  // Antes: GET /ausencias no validaba req.user vs sede_id enviado. Un coord
  // podía pedir sede_id de otra sede y ver ausencias ajenas. Un recurso podía
  // pedir cualquier recurso_id. Ahora forzamos el filtro por rol:
  //   - recurso:     solo su propio recursoId (ignoramos recurso_id y sede_id del query).
  //   - coordinador: si envía sede_id, debe estar en req.user.sedes; si no, se
  //                  restringe automáticamente a sus sedes propias.
  //   - supervisor/gerencia/directivo: acceso completo (opcional filtro por sede_id).
  const rol = req.user?.role
  let sedeIdFinal = sede_id

  if (rol === 'recurso') {
    // Recursos solo ven sus propias ausencias.
    where.resourceId = req.user.resourceId ?? '__no_recurso__'
    sedeIdFinal = null   // el filtro por sede ya no aplica
  } else if (rol === 'coordinador') {
    const misSedes = req.user.sites ?? []
    // Coord SIN sedes no ve nada — antes caía sin filtro y recibía las
    // ausencias de TODAS las sedes (mismo arreglo que reposiciones).
    if (misSedes.length === 0) {
      res.json([])
      return
    }
    if (sedeIdFinal) {
      if (!misSedes.includes(sedeIdFinal)) {
        throw errors.forbidden('No tiene acceso a esta sede')
      }
    } else if (misSedes.length > 0) {
      // Sin sede_id explícita → restringe a TODAS sus sedes.
      where.resource = { is: recursoAlcanceCoord(misSedes, req.user.id) }
    }
  } else if (rol === 'reprogramador') {
    // Oct-2026 · Este rol es el de QUIEN RECIBE el encargo, no el de la líder
    // —"este perfil es para las personas que Duarte asigna, no para Duarte"—,
    // así que solo ve las ausencias que le pasaron a él.
    //
    // Antes veía todas las de profesionales, que es el trabajo de repartir, y
    // eso ahora lo hace la líder desde el perfil de supervisor.
    //
    // ESTE RECORTE VA EN EL SERVIDOR A PROPÓSITO. Quitarle la entrada del
    // menú no es cerrarle la puerta: bastaría con escribir la dirección. Aquí
    // no hay URL que valga.
    where.reschedulerId = req.user.id
    sedeIdFinal = null   // sus casos, caigan en la sede que caigan
  }
  // supervisor / gerencia / directivo: pasan sin restricción extra.

  if (recurso_id && rol !== 'recurso') where.resourceId = recurso_id

  if (sedeIdFinal) {
    // Sep-2026: el filtro por sede antes solo miraba resource.user.sites, lo
    // que ocultaba ausencias de recursos SIN User vinculado (Munir/Katiuscka
    // creados manualmente + otros huerfanos). Ahora incluimos tambien
    // coord-lider directo y asignaciones en la sede.
    where.resource = { is: recursoAlcanceCoord([sedeIdFinal], req.user.id) }
  }

  // Rango de fechas para el cronograma (ago-2026). Una ausencia "toca" el rango
  // si su período [fecha_inicio..fecha_fin] intersecta [desde..hasta].
  //   Solapa ⇔  fechaInicio <= hasta  AND  fechaFin >= desde
  if (desde || hasta) {
    const cond = []
    if (hasta) cond.push({ startDate: { lte: new Date(hasta) } })
    if (desde) cond.push({ endDate: { gte: new Date(desde) } })
    where.AND = [...(where.AND ?? []), ...cond]
  }

  if (familia) {
    // Filtro por familia del motivo (dashboard/cronograma).
    // Ausencias legacy con motivoId=null se tratan como 'ausencia_profesional'
    // — mismo fallback que usa el frontend — para no desalinear los conteos.
    const orFamilia = [{ reasonRef: { is: { family: familia } } }]
    if (familia === 'ausencia_profesional') orFamilia.push({ reasonId: null })
    where.AND = [...(where.AND ?? []), { OR: orFamilia }]
  }

  // Por default, el cronograma no muestra ausencias rechazadas (ruido visual).
  // Se pueden incluir con ?incluir_rechazadas=true.
  if (incluir_rechazadas !== 'true' && !estado) {
    where.status = { not: 'rechazada' }
  }

  const list = await prisma.absence.findMany({
    where,
    include: {
      // Oct-2026 · Antes era `resource: true`, que arrastraba hasta ~6 MB por
      // recurso. Se selecciona campo por campo.
      resource: {
        select: {
          id: true, name: true, type: true, specialty: true,
          slotMinutes: true, payScheme: true, maxHoursPerWeek: true,
          maxHoursPerDay: true, multiRoom: true, supportTypes: true,
          leadCoordinatorId: true, active: true,
        },
      },
      reasonRef: { select: { id: true, code: true, name: true, family: true } },
    },
    orderBy: { reportedAt: 'desc' },
  })

  // Oct-2026 · Cuántos pacientes de cada ausencia ya tienen médico o día nuevo.
  // La lista lo necesita para ordenar por el PROCESO que fijó Hector —por
  // confirmar → por cubrir → por repartir → llamando → terminada—: "por
  // cubrir" y "por repartir" solo se distinguen por esto. Una consulta para
  // toda la lista, no una por ausencia.
  const cubiertos = list.length
    ? await prisma.assignment.groupBy({
        by: ['coveredAbsenceId'],
        where: { coveredAbsenceId: { in: list.map((a) => a.id) }, status: { not: 'cancelada' } },
        _sum: { patientCapacity: true },
      })
    : []
  const cubiertoDe = new Map(cubiertos.map((c) => [c.coveredAbsenceId, c._sum.patientCapacity ?? 0]))
  const auxDe = await turnosDeAuxiliar(list)
  res.json(list.map((a) => ({
    ...a,
    patientsCovered: cubiertoDe.get(a.id) ?? 0,
    ...(auxDe.get(a.id) ?? {}),
    remunerada: esRemunerada(a),
  })))
}

/**
 * 3583 · Para la lista: de cada ausencia de auxiliar, cuántos turnos que
 * acompañaba quedan sin cubrir y cuántos ya se cubrieron. Con eso la etapa sale
 * "por cubrir" / "por terminar" en vez de "sin pacientes". Pocas consultas para
 * toda la lista.
 */
async function turnosDeAuxiliar(list) {
  const aux = list.filter((a) => a.resource?.type === 'auxiliar' && a.status === 'confirmada')
  const out = new Map()
  if (!aux.length) return out
  const desde = aux.reduce((m, a) => (a.startDate < m ? a.startDate : m), aux[0].startDate)
  const hasta = aux.reduce((m, a) => (a.endDate > m ? a.endDate : m), aux[0].endDate)
  const semanas = await prisma.week.findMany({ where: { startDate: { lte: hasta }, endDate: { gte: desde } }, select: { id: true, startDate: true } })
  const ids = aux.map((a) => a.resourceId)
  const turnos = semanas.length
    ? await prisma.assignment.findMany({
        where: {
          weekId: { in: semanas.map((s) => s.id) }, status: { not: 'cancelada' },
          OR: [{ assistantId: { in: ids } }, { assistant2Id: { in: ids } }],
        },
        select: { weekId: true, weekday: true, startTime: true, endTime: true, assistantId: true, assistant2Id: true, assistantStartTime: true, assistantEndTime: true, assistant2StartTime: true, assistant2EndTime: true },
      })
    : []
  const inicioDe = new Map(semanas.map((s) => [s.id, s.startDate]))
  const cubiertos = await prisma.auditEntry.groupBy({
    by: ['entityId'], where: { entity: 'ausencias', action: 'auxiliar_reemplazo', entityId: { in: aux.map((a) => a.id) } }, _count: true,
  })
  const cubiertosDe = new Map(cubiertos.map((c) => [c.entityId, c._count]))
  for (const a of aux) {
    const pendientes = turnos.filter((t) => {
      const esPrimera = t.assistantId === a.resourceId
      if (!esPrimera && t.assistant2Id !== a.resourceId) return false
      const f = fechaDeTurno(inicioDe.get(t.weekId), t.weekday)
      if (!f || f < isoDia(a.startDate) || f > isoDia(a.endDate)) return false
      return !!parteAfectada({
        startTime: (esPrimera ? t.assistantStartTime : t.assistant2StartTime) ?? t.startTime,
        endTime: (esPrimera ? t.assistantEndTime : t.assistant2EndTime) ?? t.endTime,
        patientCapacity: 0,
      }, a)
    }).length
    out.set(a.id, { assistantShiftsPending: pendientes, assistantShiftsCovered: cubiertosDe.get(a.id) ?? 0 })
  }
  return out
}

// ============================================================================
// Helper interno: procesa la confirmación de una ausencia dentro de una
// transacción. Extraído para reusar en confirmar() (endpoint manual) y en
// create() (auto-confirmación cuando el registrador es coord/sup/gerencia).
//
// Devuelve { actualizada, pacImpactados, costoOportunidad, ejecucionesAuto,
// ejecucionesOmitidasPorBloqueo } para que quien llame arme la notificación.
// El caller es responsable de la notificación al recurso.
// ============================================================================
export async function procesarConfirmacionAusencia(tx, ausencia, opts) {
  const { confirmadorId, notaCoordinador, accionAgenda, ipAddress, auditReason: motivoAudit } = opts
  const { fechas, pacImpactados, opportunityCost: costoOportunidad, dailyImpact: impactoPorDia, quejasEstimadas } = await calcularImpacto(tx, ausencia)
  await liberarAuxiliaresSiAplica(tx, ausencia, fechas)

  // Auto-marcar ejecuciones no_ejecutada (mismo flujo que confirmar manual).
  let ejecucionesAuto = 0
  let ejecucionesOmitidasPorBloqueo = 0
  for (const { date: fecha, day: dia } of fechas) {
    const semana = await tx.week.findFirst({
      where: { startDate: { lte: new Date(fecha) }, endDate: { gte: new Date(fecha) } },
      select: { id: true },
    })
    if (!semana) continue
    const asigs = await tx.assignment.findMany({
      where: {
        weekId: semana.id,
        weekday: dia,
        status: { not: 'cancelada' },
        // Oct-2026 · Solo los turnos PROPIOS. Antes entraban también los que
        // acompañaba como auxiliar: confirmar la ausencia de una auxiliar dejaba
        // el turno del MÉDICO "no ejecutado, 0 pacientes", aunque él atendiera,
        // y además lo bloqueaba (RN-17) para ponerle otra auxiliar. La falta de
        // una auxiliar no le quita pacientes al médico (PROYECTOS-3485).
        resourceId: ausencia.resourceId,
      },
      select: { id: true },
    })
    for (const a of asigs) {
      const existente = await tx.execution.findUnique({
        where: { assignmentId: a.id },
        select: { id: true, locked: true },
      })
      if (existente?.locked) { ejecucionesOmitidasPorBloqueo++; continue }
      await tx.execution.upsert({
        where: { assignmentId: a.id },
        create: {
          assignmentId: a.id,
          patientsSeen: 0,
          shiftStatus: 'no_ejecutada',
          notes: `Generado automáticamente — ausencia confirmada (${ausencia.type})`,
          recordedBy: confirmadorId,
        },
        update: {
          patientsSeen: 0,
          shiftStatus: 'no_ejecutada',
          notes: `Sobreescrito automáticamente — ausencia confirmada (${ausencia.type})`,
        },
      })
      ejecucionesAuto++
    }
  }

  const actualizada = await tx.absence.update({
    where: { id: ausencia.id },
    data: {
      status: 'confirmada',
      patientsAffected: pacImpactados,
      opportunityCost: costoOportunidad,
      dailyImpact: impactoPorDia,
      complaintsLogged: quejasEstimadas,
      actionTaken: notaCoordinador,
      agendaAction: accionAgenda ?? null,
      confirmedBy: confirmadorId,
      confirmedAt: new Date(),
    },
    include: { resource: true },
  })

  if (ejecucionesAuto > 0 || ejecucionesOmitidasPorBloqueo > 0) {
    await registrarAuditoria({
      userId: confirmadorId,
      action: 'ejecucion_auto_por_ausencia',
      entity: 'ausencias',
      entityId: actualizada.id,
      newValue: {
        resource_id: ausencia.resourceId,
        tipo_ausencia: ausencia.type,
        ejecuciones_creadas_o_sobreescritas: ejecucionesAuto,
        ejecuciones_omitidas_por_bloqueo: ejecucionesOmitidasPorBloqueo,
      },
      reason: motivoAudit ?? 'Auto-marcado de ejecución no_ejecutada al confirmar ausencia',
      ipAddress,
    })
  }

  return { actualizada, pacImpactados, opportunityCost: costoOportunidad, ejecucionesAuto, ejecucionesOmitidasPorBloqueo }
}

// Envía la notificación al recurso cuando SU ausencia queda confirmada.
// Extraída para reusar en confirmación manual y auto-confirmación al crear.
async function notificarRecursoAusenciaConfirmada(tx, ausencia, actualizada, { pacImpactados, opportunityCost: costoOportunidad, notaCoordinador }) {
  const usuarioRecurso = await tx.user.findUnique({
    where: { resourceId: ausencia.resourceId },
  })
  if (!usuarioRecurso) return
  const fmt = fechaSolo
  const fechaInicioTxt = fmt(ausencia.startDate)
  const fechaFinTxt = fmt(ausencia.endDate)
  const periodoTxt = fechaInicioTxt === fechaFinTxt ? fechaInicioTxt : `${fechaInicioTxt} al ${fechaFinTxt}`
  const FRONT = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  setImmediate(() =>
    notificar({
      userId: usuarioRecurso.id,
      type: 'ausencia_confirmada',
      title: 'Ausencia confirmada y registrada en el sistema',
      message: `<p>El coordinador validó la ausencia que usted reportó y la registró como <strong>confirmada</strong>. A partir de este momento queda incluida en los informes de Ausentismo del sistema.</p>
      <p>Si tiene alguna observación, comuníquese con su coordinador. Puede ver el detalle y el impacto en la sección "Mis ausencias" del sistema.</p>`,
      contexto: 'Confirmación del módulo de Ausencias',
      criticidad: 'media',
      referenceId: actualizada.id,
      detalles: [
        ['Recurso',              ausencia.resource.name],
        ['Tipo de recurso',      ausencia.resource.type],
        ['Período de ausencia',  periodoTxt],
        ['Pacientes impactados', `${pacImpactados}`],
        ['Costo de oportunidad', new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(costoOportunidad ?? 0))],
        ['Estado actual',        'Confirmada'],
        ...(notaCoordinador ? [['Nota del coordinador', notaCoordinador]] : []),
      ],
      accionUrl: `${FRONT}/app/ausencias`,
      accionTexto: 'Ver mis ausencias',
    }),
  )
}

// Roles con autoridad para auto-confirmar ausencias al crearlas.
// El propio recurso reportándose queda pendiente (necesita validación).
const ROLES_AUTORIDAD_AUSENCIA = new Set(['coordinador', 'supervisor', 'gerencia'])

const ROL_LABEL = {
  coordinador: 'Coordinador', supervisor: 'Supervisor', gerencia: 'Gerencia',
  directivo: 'Directivo', resource: 'Recurso',
}

/** El texto vigente de la autorización de datos, para que el formulario muestre lo mismo que se guarda. */
export function autorizacionDatos(_req, res) {
  res.json(AUTORIZACION_DATOS)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const errorFechas = errorEnFechasDeAusencia(data)
  if (errorFechas) throw errors.badRequest(errorFechas)
  const fechaInicio = parseISO(data.startDate)
  const fechaFin = data.endDate ? parseISO(data.endDate) : fechaInicio
  const anticipacionDias = diasDeAnticipacion(data.startDate)

  // La autorización de datos se exige en el servidor: la casilla del
  // formulario se salta con una llamada directa a la API. Y tiene que ser la
  // versión vigente del texto, no cualquier valor.
  // 22-oct · QA (F3): un profesional solo registra SU propia ausencia. Antes
  // `create` no lo comprobaba: por la API se podía registrar a nombre de otra
  // persona, y quedaba guardada una autorización de datos que esa persona no dio.
  if (req.user.role === 'recurso') {
    const yo = await prisma.user.findUnique({ where: { id: req.user.id }, select: { resourceId: true } })
    if (!yo?.resourceId || yo.resourceId !== data.resourceId) {
      throw errors.forbidden('Solo puede registrar sus propias ausencias.')
    }
  }

  const pideDatos = pideAutorizacionDatos(req.user.role)
  if (pideDatos && data.dataConsentVersion !== AUTORIZACION_DATOS.version) {
    throw errors.badRequest('Para registrar la ausencia hay que autorizar el tratamiento de datos personales.')
  }

  // Resolver motivoId: si el frontend lo mandó explícito, validarlo y
  // sincronizar `tipo` con el codigo del motivo. Si no, mapear por codigo=tipo.
  let motivoId = data.reasonId
  let tipoFinal = data.type
  let motivoCodigoFinal = null
  if (motivoId) {
    const m = await prisma.absenceReason.findUnique({ where: { id: motivoId } })
    if (!m) throw errors.badRequest('Motivo de ausencia no encontrado')
    if (!m.active) throw errors.badRequest('Ese motivo está desactivado')
    motivoCodigoFinal = m.code
    // Si el motivo del catálogo corresponde a un código del enum legacy,
    // alineamos el campo `tipo`. Si no (motivo personalizado), `tipo` se queda
    // con lo que envió el frontend (típicamente 'otra').
    if (TIPOS.includes(m.code)) tipoFinal = m.code
  } else {
    // Fallback: mapear por código = tipo legacy
    const m = await prisma.absenceReason.findFirst({
      where: { code: data.type, active: true },
    })
    motivoId = m?.id ?? null
    motivoCodigoFinal = m?.code ?? data.type
  }

  // ciudad_regional solo se persiste si el motivo elegido es "regional" — para
  // cualquier otro motivo se guarda null aunque el frontend haya mandado algo
  // (evita ensuciar registros históricos y confundir el dashboard).
  const ciudadRegionalFinal = motivoCodigoFinal === 'regional'
    ? (data.regionalCity?.trim() || null)
    : null
  if (motivoCodigoFinal === 'regional' && !ciudadRegionalFinal) {
    throw errors.badRequest('El motivo "Regional" requiere indicar la ciudad de cobertura')
  }
  // 3650 · Un retraso es por horas: sin la hora en que debía empezar y la hora
  // en que empezó no hay cómo saber cuántos pacientes esperaron.
  if (motivoCodigoFinal === 'retraso_inicio' && !(data.isPartial && data.absenceStartTime && data.absenceEndTime)) {
    throw errors.badRequest('Un retraso se registra con la hora en que debía empezar y la hora en que empezó.')
  }

  // Auto-confirmación (jul-2026): si quien registra tiene rol autoritativo
  // (coord/sup/gerencia), la ausencia queda confirmada al instante. Evita el
  // problema de "se olvida aprobarla y se pierde en la semana". El propio
  // recurso reportandose sigue pendiente (necesita validacion humana).
  // Sep-2026 · hotfix: esto vivia en la linea 408 pero se USA en el INSERT
  // (linea 357), asi que provocaba `Cannot access 'seAutoConfirmara' before
  // initialization` (TDZ) y cualquier alta de ausencia caia con 500. Se sube.
  const esRegistroAutoritativo = ROLES_AUTORIDAD_AUSENCIA.has(req.user.role)
  const seAutoConfirmara = esRegistroAutoritativo

  // ---- ANTI-DUPLICADO (sep-2026) ----
  // En produccion habia ausencias registradas hasta 6 veces con las mismas
  // fechas exactas: cada copia volvia a sumar sus pacientes y sus dias en los
  // informes. Una persona no puede estar ausente dos veces a la vez, asi que
  // rechazamos cualquier solape con una ausencia viva del mismo recurso.
  //
  // Solape de rangos: inicioA <= finB  AND  finA >= inicioB.
  // Las rechazadas no cuentan (se pueden volver a pedir).
  // Oct-2026 · Dos permisos por horas del mismo día que no se pisan (08–09 y
  // 09–10:30) son dos ausencias distintas: lib/tramos ausenciasSeCruzan.
  // Las fechas guardadas son de solo-día (medianoche UTC): se compara contra
  // medianoche UTC, no contra parseISO, que en un equipo con hora de Colombia
  // da las 05:00 UTC y dejaba fuera la ausencia del mismo día.
  const diaUtc = (s) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
  const candidatas = await prisma.absence.findMany({
    where: {
      resourceId: data.resourceId,
      status: { not: 'rechazada' },
      startDate: { lte: diaUtc(data.endDate || data.startDate) },
      endDate: { gte: diaUtc(data.startDate) },
    },
    select: { id: true, startDate: true, endDate: true, status: true, isPartial: true, absenceStartTime: true, absenceEndTime: true },
  })
  const nueva = {
    startDate: data.startDate.slice(0, 10), endDate: (data.endDate || data.startDate).slice(0, 10),
    isPartial: data.isPartial ?? false, absenceStartTime: data.absenceStartTime, absenceEndTime: data.absenceEndTime,
  }
  const solapada = candidatas.find((a) => ausenciasSeCruzan(a, nueva))
  if (solapada) {
    const f = (d) => new Date(d).toISOString().slice(0, 10)
    const horario = solapada.isPartial && solapada.absenceStartTime && solapada.absenceEndTime
      ? ` de ${solapada.absenceStartTime} a ${solapada.absenceEndTime}`
      : ''
    const fechas = f(solapada.startDate) === f(solapada.endDate)
      ? `el ${f(solapada.startDate)}`
      : `del ${f(solapada.startDate)} al ${f(solapada.endDate)}`
    throw errors.badRequest(
      `El recurso ya tiene una ausencia ${solapada.status} ${fechas}${horario}, que se cruza con la que intenta registrar. No se registró.`
    )
  }

  // Oct-2026 · Fechas en que repondrá, sin repetir y en orden; la primera
  // queda también en makeupDate. Hector, 21-oct: se puede reponer ANTES de la
  // ausencia (la registra hoy para el 30-nov y repone desde mañana). Lo único
  // que no vale es un día ya pasado o un día de la propia ausencia.
  const inicioAusencia = data.startDate.slice(0, 10)
  const finAusencia = (data.endDate || data.startDate).slice(0, 10)
  const hoyCo = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
  const fechasReponer = data.wantsMakeup ? [...new Set(data.makeupDates ?? [])].sort() : []
  if (fechasReponer.some((f) => f <= hoyCo)) {
    throw errors.badRequest('Las fechas para reponer tienen que ser a partir de mañana.')
  }
  if (fechasReponer.some((f) => f >= inicioAusencia && f <= finAusencia)) {
    throw errors.badRequest('No se puede reponer en un día de la misma ausencia.')
  }
  // Hector, 21-oct: si NO desea reponer, el motivo es obligatorio.
  if (data.wantsMakeup === false && (data.makeupNotes?.trim().length ?? 0) < 5) {
    throw errors.badRequest('Indique el motivo por el que no va a reponer (mínimo 5 caracteres).')
  }

  const ausencia = await prisma.absence.create({
    data: {
      resourceId: data.resourceId,
      startDate: fechaInicio,
      endDate: fechaFin,
      isPartial: data.isPartial ?? false,
      absenceStartTime: data.absenceStartTime,
      absenceEndTime: data.absenceEndTime,
      type: tipoFinal,
      reasonId: motivoId,
      reason: data.reason,
      regionalCity: ciudadRegionalFinal,
      affectedCompany: data.affectedCompany ?? null,
      wantsMakeup: data.wantsMakeup ?? null,
      // Si repone: horario y modalidad. Si no: el motivo (obligatorio).
      makeupNotes: data.wantsMakeup != null ? (data.makeupNotes?.trim() || null) : null,
      // §4 · Fecha propuesta de reposición, como fecha y no dentro del texto
      // libre: así se puede filtrar y cruzar con la agenda de ese día.
      makeupDate: data.wantsMakeup && (fechasReponer[0] ?? data.makeupDate) ? parseISO(fechasReponer[0] ?? data.makeupDate) : null,
      makeupDates: data.wantsMakeup && fechasReponer.length ? fechasReponer : undefined,
      // 20 días o más de anticipación = programada (lib/anticipacion.js).
      // Antes era > 15 aquí y >= 2 en el correo de aviso.
      isPlanned: esProgramada(anticipacionDias),
      noticeDays: Math.max(0, anticipacionDias),
      recordedByCoordinator: data.recordedByCoordinator ?? false,
      reportedBy: req.user.id,
      isPaid: tipoFinal === SIEMPRE_REMUNERADA ? true : (data.isPaid ?? null),
      ...(pideDatos ? {
        dataConsentAt: new Date(),
        dataConsentVersion: AUTORIZACION_DATOS.version,
        dataConsentIp: getIp(req)?.slice(0, 45) ?? null,
      } : {}),
      // PROYECTOS-3255 · Duarte y equipo (coord/sup/gerencia) NO deben pasar por
      // "pendiente": lo que ellos registran se confirma al instante. El default
      // del schema es 'pendiente', asi que hay que pasarlo explicitamente aqui.
      // Antes se calculaba `seAutoConfirmara` (linea 400) pero solo se usaba
      // para el texto del email — el INSERT nunca lo aplicaba y todo caia al
      // default. Resultado: 12 ausencias reportadas por coord quedaban colgadas.
      // El propio recurso reportandose sigue en pendiente (necesita validacion).
      status: seAutoConfirmara ? 'confirmada' : 'pendiente',
    },
    include: { resource: true, reasonRef: true },
  })

  if (data.recordedByCoordinator) {
    await registrarAuditoria({
      userId: req.user.id,
      action: 'registrar_ausencia_por_recurso',
      entity: 'ausencias',
      entityId: ausencia.id,
      newValue: { resourceId: data.resourceId, type: data.type },
      ipAddress: getIp(req),
    })
  }

  // Levantamiento §9: al registrar una ausencia notificamos por App + Email
  // (y WhatsApp para los coordinadores, criticidad alta) a TRES destinatarios:
  //   1) Al recurso mismo: confirmación de que su ausencia quedó registrada.
  //   2) A los coordinadores de las sedes donde tiene asignaciones.
  //   3) A los supervisores activos (para visibilidad de gestión).
  const asigsRecurso = await prisma.assignment.findMany({
    where: {
      OR: [{ resourceId: data.resourceId }, { assistantId: data.resourceId }],
      status: { not: 'cancelada' },
    },
    include: { room: { select: { siteId: true } } },
  })
  const sedeIds = [...new Set(asigsRecurso.map((a) => a.room.siteId))]
  const sedesNombres = (await prisma.site.findMany({
    where: { id: { in: sedeIds } }, select: { name: true },
  })).map((s) => s.name).join(', ') || '(sin asignaciones esa fecha)'

  const fmt = fechaSolo
  const fechaInicioTxt = fmt(fechaInicio)
  const fechaFinTxt = fmt(fechaFin)
  const periodoTxt = fechaInicioTxt === fechaFinTxt ? fechaInicioTxt : `${fechaInicioTxt} al ${fechaFinTxt}`
  const TIPOS_AUSENCIA_LABEL = {
    enfermedad: 'Incapacidad por enfermedad', calamidad: 'Calamidad doméstica',
    academico: 'Evento académico (congreso)', familiar: 'Evento familiar',
    vacaciones: 'Vacaciones', no_presentacion: 'No presentación',
    licencia_remunerada: 'Licencia remunerada', licencia_no_remunerada: 'Licencia no remunerada',
    otra: 'Otra',
  }
  const tipoLabel = TIPOS_AUSENCIA_LABEL[data.type] ?? data.type

  // (Auto-confirmación: `seAutoConfirmara` ya fue calculada arriba, antes del
  // INSERT, para poder aplicarla directamente al `status`. Aqui se sigue
  // usando abajo para el texto del email.)

  // Nombre del usuario reportador para el texto "Reportada por" (antes salía
  // "Coordinador (a nombre del recurso)" impersonal). Lookup a BD porque el
  // JWT solo lleva id/rol, no el nombre.
  const reportador = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  })
  const rolLabel = ROL_LABEL[req.user.role] ?? 'Usuario'
  let reportadaPor
  if (data.recordedByCoordinator) {
    reportadaPor = reportador?.name
      ? `${reportador.name} (${rolLabel}, a nombre del recurso)`
      : `${rolLabel} (a nombre del recurso)`
  } else {
    reportadaPor = 'El propio recurso'
  }

  const estadoInicialTxt = seAutoConfirmara
    ? 'Confirmada automáticamente al registrar'
    : 'Pendiente de confirmación'

  const detallesComunes = [
    ['Recurso',            ausencia.resource.name],
    ['Tipo de recurso',    ausencia.resource.type],
    ['Sede(s) afectadas',  sedesNombres],
    ['Tipo de ausencia',   tipoLabel],
    ['Período',            periodoTxt],
    ...(data.isPartial && data.absenceStartTime ? [['Horario parcial', `${data.absenceStartTime} – ${data.absenceEndTime}`]] : []),
    ['Anticipación',       `${Math.max(0, anticipacionDias)} días`],
    ['Programada',         esProgramada(anticipacionDias) ? 'Sí (con anticipación)' : 'No (imprevista)'],
    ['Reportada por',      reportadaPor],
    ...(data.reason ? [['Observación', data.reason]] : []),
    ['Estado',             estadoInicialTxt],
  ]
  const FRONT = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'

  // Mensajes de notificación según si la ausencia queda confirmada o pendiente.
  const msgRecurso = seAutoConfirmara
    ? `<p>Se registró en el sistema una ausencia a su nombre — quedó <strong>confirmada automáticamente</strong> porque la reportó ${reportadaPor.split(' (')[0]}. Su impacto operativo (pacientes afectados, costo de oportunidad) ya se calculó y aparece en los informes.</p>
       <p>Si tiene alguna observación, comuníquese con su coordinador. Puede ver el detalle en "Mis ausencias".</p>`
    : `<p>Se registró en el sistema una ausencia a su nombre. Quedó en estado <strong>Pendiente de confirmación</strong> a la espera del coordinador, quien validará el impacto operativo y la marcará como confirmada.</p>
       <p>Una vez confirmada, recibirá una segunda notificación con el impacto registrado (pacientes afectados, costo de oportunidad, etc.).</p>`

  const msgCoord = seAutoConfirmara
    ? `<p>Se registró una ausencia que afecta a una de las sedes bajo su responsabilidad. <strong>Quedó confirmada automáticamente</strong> al reportarla ${reportadaPor.split(' (')[0]} — el impacto operativo (pacientes afectados, ejecuciones marcadas como no ejecutada, liberación de auxiliares) ya se aplicó.</p>
       <p>Si necesita revisar el detalle o hacer ajustes, ingrese al módulo de Ausencias.</p>`
    : `<p>Se reportó una ausencia que afecta a una de las sedes bajo su responsabilidad. La ausencia está en estado <strong>pendiente</strong> y requiere su revisión y confirmación para registrar el impacto operativo (pacientes afectados, asignaciones canceladas, costo de oportunidad).</p>
       <p>Por favor, ingrese al módulo de Ausencias en el sistema y procese esta solicitud antes de que comience la franja afectada para permitir reasignación si corresponde.</p>`

  const msgSup = seAutoConfirmara
    ? `<p>Se registró una nueva ausencia en el sistema y quedó <strong>confirmada automáticamente</strong>. El impacto operativo ya se aplicó. Esta notificación es informativa.</p>`
    : `<p>Se registró una nueva ausencia en el sistema. Está siendo procesada por el coordinador correspondiente. Esta notificación es informativa — no requiere acción inmediata salvo que el coordinador la escale.</p>`

  const msgDir = seAutoConfirmara
    ? `<p>Se registró y confirmó automáticamente una ausencia en el sistema. El impacto (pacientes afectados, costo de oportunidad) ya está reflejado en los informes de Ausentismo.</p>`
    : `<p>Se registró una ausencia en el sistema. El impacto definitivo (pacientes afectados, costo de oportunidad) aparecerá en los informes de Ausentismo cuando el coordinador confirme la ausencia.</p>`

  // 1) Al recurso (si está vinculado a un usuario)
  const usuarioRecurso = await prisma.user.findUnique({
    where: { resourceId: data.resourceId },
  })
  if (usuarioRecurso) {
    await notificar({
      userId: usuarioRecurso.id,
      type: seAutoConfirmara ? 'ausencia_confirmada' : 'ausencia_reportada',
      title: seAutoConfirmara ? `Ausencia confirmada: ${tipoLabel}` : `Registro de su ausencia: ${tipoLabel}`,
      message: msgRecurso,
      contexto: 'Notificación del módulo de Ausencias',
      criticidad: 'media',
      referenceId: ausencia.id,
      detalles: detallesComunes,
    })
  }

  // 2) Coordinadores de cada sede afectada (crit. alta → app + email + whatsapp)
  for (const sedeId of sedeIds) {
    await notificarCoordinadoresDeSede(sedeId, {
      type: 'ausencia_reportada',
      title: seAutoConfirmara
        ? `Ausencia confirmada: ${ausencia.resource.name} (${tipoLabel})`
        : `Ausencia reportada: ${ausencia.resource.name} (${tipoLabel})`,
      message: msgCoord,
      contexto: seAutoConfirmara ? 'Notificación del módulo de Ausencias' : 'Acción requerida del módulo de Ausencias',
      criticidad: seAutoConfirmara ? 'media' : 'alta',
      referenceId: ausencia.id,
      detalles: detallesComunes,
      accionUrl: `${FRONT}/app/ausencias`,
      accionTexto: seAutoConfirmara ? 'Ver ausencia' : 'Revisar ausencia',
    })
  }

  // 3) Supervisores activos (crit. media → app + email)
  await notificarSupervisores({
    type: 'ausencia_reportada',
    title: `Ausencia registrada: ${ausencia.resource.name}`,
    message: msgSup,
    contexto: 'Notificación informativa del módulo de Ausencias',
    criticidad: 'media',
    referenceId: ausencia.id,
    detalles: detallesComunes,
    accionUrl: `${FRONT}/app/admin/auditoria`,
    accionTexto: 'Ver en el sistema',
  })

  // 4) Directivos activos (crit. media → app + email; no WhatsApp para directivos)
  await notificarDirectivos({
    type: 'ausencia_reportada',
    title: `Reporte de ausencia: ${ausencia.resource.name}`,
    message: msgDir,
    contexto: 'Notificación ejecutiva del módulo de Ausencias',
    criticidad: 'media',
    referenceId: ausencia.id,
    detalles: detallesComunes,
    accionUrl: `${FRONT}/app/informes/ausentismo-impacto`,
    accionTexto: 'Ver en informes',
  })

  // 5) Dirección Médica (ago-2026): copia informativa por email a los buzones
  // institucionales — no son usuarios del sistema, así que solo llega email.
  await notificarDireccionMedica({
    title: `Ausencia registrada: ${ausencia.resource.name} (${tipoLabel})`,
    message: msgDir,
    contexto: 'Copia informativa para Dirección Médica',
    detalles: detallesComunes,
    accionUrl: `${FRONT}/app/informes/ausentismo-impacto`,
    accionTexto: 'Ver en informes',
  })

  // Auto-confirmación (jul-2026): si el rol es autoritativo, disparamos el
  // helper compartido en una tx propia. Falla-silenciosa a nivel de operación
  // principal — si la confirmación falla, la ausencia queda pendiente y alguien
  // la confirma manualmente. Devolvemos siempre 201 con la ausencia (posiblemente
  // ya actualizada al estado 'confirmada' si el helper corrió bien).
  let ausenciaFinal = ausencia
  if (seAutoConfirmara) {
    try {
      const resultado = await prisma.$transaction(async (tx) => {
        const ausFresh = await tx.absence.findUnique({
          where: { id: ausencia.id },
          include: { resource: true, reasonRef: true },
        })
        return procesarConfirmacionAusencia(tx, ausFresh, {
          confirmadorId: req.user.id,
          notaCoordinador: null,
          ipAddress: getIp(req),
          auditReason: 'Auto-confirmación al registrar por rol autoritativo',
        })
      })
      ausenciaFinal = resultado.actualizada
      await registrarAuditoria({
        userId: req.user.id,
        action: 'ausencia_auto_confirmada',
        entity: 'ausencias',
        entityId: ausenciaFinal.id,
        newValue: {
          rol_registrador: req.user.role,
          patients_affected: resultado.pacImpactados,
          opportunity_cost: resultado.opportunityCost,
        },
        reason: 'Auto-confirmación por rol autoritativo (coord/sup/gerencia)',
        ipAddress: getIp(req),
      })
    } catch (e) {
      console.error('[AUTO-CONFIRMAR-AUSENCIA] falló, queda pendiente:', e.message)
      // No propagamos el error — la ausencia ya existe en 'pendiente' y puede
      // confirmarse manualmente. El coord recibió notificación arriba.
    }
  }

  res.status(201).json(ausenciaFinal)
}

/**
 * Confirma una ausencia pendiente. Orquesta:
 *   - RN-18 + RN-19: cálculo de impacto día a día (en una parcial, solo las horas que faltó)
 *   - RN-24: liberación automática de auxiliares
 *   - HU-C-05: notifica al recurso tras el commit
 *
 * Toda la lógica de cálculo vive en `services/ausenciaService.js`.
 */
export async function confirmar(req, res) {
  const { notaCoordinador, actionTaken: accionAgenda } = confirmarSchema.parse(req.body)
  const resultado = await prisma.$transaction(async (tx) => {
    const ausencia = await tx.absence.findUnique({
      where: { id: req.params.id },
      include: { resource: true, reasonRef: true },
    })
    if (!ausencia) throw errors.notFound()
    if (coordSoloVe(req.user, ausencia.resource?.type)) throw errors.forbidden(MSG_SOLO_VE)
    if (ausencia.status !== 'pendiente') throw errors.badRequest('La ausencia ya fue procesada')

    return procesarConfirmacionAusencia(tx, ausencia, {
      confirmadorId: req.user.id,
      notaCoordinador,
      accionAgenda,
      ipAddress: getIp(req),
    })
  })

  // Notificación al recurso fuera de la tx (no bloquear la respuesta).
  await notificarRecursoAusenciaConfirmada(prisma, resultado.actualizada, resultado.actualizada, {
    pacImpactados: resultado.pacImpactados,
    opportunityCost: resultado.opportunityCost,
    notaCoordinador,
  })

  // Copia informativa a Dirección Médica (ago-2026) — buzones institucionales.
  const fmtDir = fechaSolo
  const finiDir = fmtDir(resultado.actualizada.startDate)
  const ffinDir = fmtDir(resultado.actualizada.endDate)
  const periodoDir = finiDir === ffinDir ? finiDir : `${finiDir} al ${ffinDir}`
  const FRONT_DM = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  const recursoNombre = resultado.actualizada.resource?.name ?? 'Profesional'
  setImmediate(() =>
    notificarDireccionMedica({
      title: `Ausencia confirmada: ${recursoNombre}`,
      message: `<p>La ausencia del profesional <strong>${recursoNombre}</strong> fue confirmada por el coordinador y quedó registrada en el sistema. Su impacto operativo (pacientes afectados, costo de oportunidad) ya está reflejado en los informes.</p>`,
      contexto: 'Copia informativa para Dirección Médica',
      detalles: [
        ['Recurso',              recursoNombre],
        ['Tipo de recurso',      resultado.actualizada.resource?.type ?? '—'],
        ['Período',              periodoDir],
        ['Pacientes impactados', `${resultado.pacImpactados}`],
        ['Costo de oportunidad', new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(resultado.opportunityCost ?? 0))],
        ['Estado',               'Confirmada'],
        ...(notaCoordinador ? [['Nota del coordinador', notaCoordinador]] : []),
      ],
      accionUrl: `${FRONT_DM}/app/informes/ausentismo-impacto`,
      accionTexto: 'Ver en informes',
    })
  )

  return res.json(resultado.actualizada)
}

/** RN-20: motivo obligatorio */
export async function rechazar(req, res) {
  const { reason: motivo } = rechazarSchema.parse(req.body)
  const previa = await prisma.absence.findUnique({ where: { id: req.params.id }, select: { resource: { select: { type: true } } } })
  if (!previa) throw errors.notFound()
  if (coordSoloVe(req.user, previa.resource?.type)) throw errors.forbidden(MSG_SOLO_VE)
  const actualizada = await prisma.absence.update({
    where: { id: req.params.id },
    data: { status: 'rechazada', rejectionReason: motivo },
    include: { resource: true },
  })
  res.json(actualizada)
}


// ============================================================================
// Oct-2026 · GET /absences/:id/replacement-context
//
// LA PANTALLA DE REEMPLAZO, DE UN SOLO VIAJE
//
// Hector: "debe ser una pantalla completa para el remplazo que debe mostrar el
// dia la hora, las sedes los coordinadores y todo eso para que pueda ser
// directo al programador".
//
// Antes esto era un modal que solo sabia de UNA franja: el coordinador tenia
// que abrirlo una vez por cada hueco y no veia el panorama. Una ausencia de
// martes a jueves de alguien que rota por tres sedes son nueve huecos.
//
// Devuelve la ausencia y TODAS las franjas que se cayeron, cada una con su
// sede, consultorio, horario, pacientes y coordinador. Quien decide necesita
// ver el conjunto: con el mismo dia en otra sede no hay que mover pacientes,
// que es justo el caso que Hector quiere poder resolver primero.
// ============================================================================

const NOMBRES_DIA_AUS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

export async function contextoReemplazo(req, res) {
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: {
      resource: { select: { id: true, name: true, type: true, specialty: true, leadCoordinatorId: true } },
      reasonRef: { select: { code: true, name: true, family: true } },
    },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')

  // Oct-2026 · Esta pantalla es para decidir el reemplazo: candidatos, sedes,
  // coordinadores. Quien recibe el encargo no decide nada de eso —"el
  // reprogramador solamente mira a que profesional le asignaron y pone
  // cuantos pacientes llamo"—, asi que no entra aqui. Su pantalla es
  // /reschedules/mine, que le da su caso y el registro de llamadas.
  if (req.user?.role === 'reprogramador') {
    throw errors.forbidden('Su caso se trabaja desde Mis reprogramaciones, no desde aqui')
  }

  // Oct-2026 · Los nombres de quien recibió el caso y de quien lo repartió
  // viajan con la ausencia. La pantalla los buscaba en la lista de
  // reprogramadores ACTUALES, y un caso que se le asignó a alguien que hoy
  // tiene otro rol (María Duarte el 14-oct, hoy supervisor) salía como
  // "Asignada a: otro usuario".
  const personas = new Map((await prisma.user.findMany({
    where: { id: { in: [ausencia.reschedulerId, ausencia.assignedBy].filter(Boolean) } },
    select: { id: true, name: true },
  })).map((u) => [u.id, u.name]))
  const conNombres = (base) => ({
    ...base,
    rescheduler_name: personas.get(ausencia.reschedulerId) ?? null,
    assigned_by_name: personas.get(ausencia.assignedBy) ?? null,
  })

  // La semana que contiene la ausencia. Si no existe (ausencia de una semana
  // que nadie programo), no hay franjas que reemplazar y se dice claro.
  const semana = await prisma.week.findFirst({
    where: { startDate: { lte: ausencia.endDate }, endDate: { gte: ausencia.startDate } },
    orderBy: { startDate: 'asc' },
  })
  if (!semana) {
    res.json({ ausencia: conNombres(serializarAusencia(ausencia, [], [])), semana: null, franjas: [] })
    return
  }

  // Dias que la ausencia cubre dentro de esa semana. En UTC: las fechas de
  // solo-dia se guardan a medianoche UTC y en Colombia la hora local las
  // correria al dia anterior.
  const ini = ausencia.startDate > semana.startDate ? ausencia.startDate : semana.startDate
  const fin = ausencia.endDate < semana.endDate ? ausencia.endDate : semana.endDate
  const dias = []
  // Las fechas van aparte del nombre del día, no en su lugar: la grilla cruza
  // por `weekday`, que es texto, y la pantalla necesita decir QUÉ miércoles.
  const fechas = []
  for (let d = new Date(ini); d <= fin; d = new Date(d.getTime() + 86400000)) {
    dias.push(NOMBRES_DIA_AUS[d.getUTCDay()])
    fechas.push(new Date(d))
  }

  const asignaciones = await prisma.assignment.findMany({
    where: {
      weekId: semana.id,
      resourceId: ausencia.resourceId,
      weekday: { in: dias },
      status: { not: 'cancelada' },
    },
    include: {
      room: { include: { site: { select: { id: true, name: true, city: true } } } },
      assistant: { select: { id: true, name: true } },
    },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  })
    // Cada turno con la parte que de verdad se cayó: en una parcial, solo las
    // horas que faltó (Hector, oct-2026). La franja que se cubre es esa parte.
    .then((lista) => lista
      .map((a) => ({ ...a, parte: parteAfectada(a, ausencia) }))
      .filter((a) => a.parte))

  // Los reemplazos ya cargados para esta ausencia, por consultorio+dia+hora:
  // asi cada franja sabe si ya esta resuelta y la pantalla no vuelve a ofrecer
  // candidatos para un hueco que ya se lleno.
  const reemplazos = await prisma.assignment.findMany({
    where: { weekId: semana.id, coveredAbsenceId: ausencia.id, status: { not: 'cancelada' } },
    include: { resource: { select: { id: true, name: true, type: true } } },
    orderBy: { startTime: 'asc' },
  })

  // Oct-2026 · Una franja puede cubrirse POR TRAMOS: cada médico toma una
  // parte del horario en el mismo consultorio (decisión de Hector). Antes se
  // indexaba un solo reemplazo por consultorio+día+hora de inicio, así que con
  // el primer médico la franja ya salía "cubierta" aunque solo tomara una
  // parte, y no quedaba forma de poner a un segundo para el resto.
  //
  // Ahora cada franja junta todos los reemplazos de su consultorio y día que
  // pisan su horario, y calcula qué le falta.
  const tramosDe = (a) => reemplazos
    .filter((r) => r.roomId === a.roomId && r.weekday === a.weekday &&
      !(r.endTime <= a.parte.desde || r.startTime >= a.parte.hasta))
  const estadoDeFranja = (a) => {
    const suyos = tramosDe(a)
    const franja = { desde: a.parte.desde, hasta: a.parte.hasta }
    const huecos = huecosDeFranja(franja, suyos.map((r) => ({ desde: r.startTime, hasta: r.endTime })))
    return {
      suyos,
      huecos: huecos.map((h) => ({
        start_time: h.desde,
        end_time: h.hasta,
        pacientes: pacientesDelTramo(a.parte.pacientes, franja, h),
      })),
      cubierta: huecos.length === 0,
    }
  }

  // Los coordinadores de cada sede involucrada, en una sola consulta. Hector
  // los pidio en la pantalla: el reemplazo cae en la programacion de alguien,
  // y hay que saber de quien.
  const sedeIds = [...new Set(asignaciones.map((a) => a.room?.siteId).filter(Boolean))]

  // Oct-2026 · Las sedes que ya cerraron esa semana. Ahí solo supervisión
  // puede asignar, y con motivo: la ventana de Asignar lo pide solo en ese
  // caso. Antes no lo pedía y en una semana cerrada fallaba siempre con
  // "Modificar una sede cerrada requiere un motivo". Con la programación libre
  // encendida el cierre no aplica (mismo criterio que crearAsignacion).
  const cierres = sedeIds.length && !programacionLibre()
    ? await prisma.weekSiteClosure.findMany({
        where: { weekId: semana.id, siteId: { in: sedeIds } },
        select: { siteId: true },
      })
    : []
  const sedesCerradas = new Set(cierres.map((c) => c.siteId))
  const coordinadores = sedeIds.length
    ? await prisma.userSite.findMany({
        where: { siteId: { in: sedeIds }, user: { is: { role: 'coordinador', active: true } } },
        select: { siteId: true, user: { select: { id: true, name: true, email: true } } },
      })
    : []
  const coordsPorSede = new Map()
  for (const c of coordinadores) {
    if (!coordsPorSede.has(c.siteId)) coordsPorSede.set(c.siteId, [])
    coordsPorSede.get(c.siteId).push(c.user)
  }

  // LA CUENTA DEL CASO. Sin esto no habia forma de saber si quedaba algo por
  // hacer: se asignaba un reemplazo y la pantalla se veia igual que antes.
  //
  // Los cubiertos salen de los turnos nuevos, no de las franjas que se cayeron:
  // quien cubre puede atender mas o menos pacientes que el ausente (otro
  // intervalo por paciente, otra franja horaria), y lo que importa es a cuanta
  // gente se le resolvio de verdad.
  // 3583 · Si quien falta acompaña turnos de otros (una auxiliar), esos turnos
  // también se caen: el médico se queda sin auxiliar. Se listan aparte, con lo
  // que ya se cubrió (sale de la auditoría del caso, porque al cubrirlo el
  // turno deja de tener a la ausente).
  const acompanaba = await prisma.assignment.findMany({
    where: {
      weekId: semana.id, weekday: { in: dias }, status: { not: 'cancelada' },
      OR: [{ assistantId: ausencia.resourceId }, { assistant2Id: ausencia.resourceId }],
    },
    include: { resource: { select: { id: true, name: true } }, room: { include: { site: { select: { id: true, name: true, city: true } } } } },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  }).then((lista) => lista
    .map((a) => {
      const esPrimera = a.assistantId === ausencia.resourceId
      const horario = {
        startTime: (esPrimera ? a.assistantStartTime : a.assistant2StartTime) ?? a.startTime,
        endTime: (esPrimera ? a.assistantEndTime : a.assistant2EndTime) ?? a.endTime,
        patientCapacity: 0,
      }
      return { a, parte: parteAfectada(horario, ausencia) }
    })
    .filter(({ parte }) => parte)
    .map(({ a, parte }) => ({
      assignment_id: a.id, week_id: semana.id, weekday: a.weekday,
      start_time: parte.desde, end_time: parte.hasta,
      medico: a.resource?.name ?? null, room: a.room ? { id: a.room.id, name: a.room.name } : null,
      room_id: a.roomId, site: a.room?.site ?? null,
    })))
  const auxiliarCubiertos = (await prisma.auditEntry.findMany({
    where: { entity: 'ausencias', entityId: ausencia.id, action: 'auxiliar_reemplazo' },
    orderBy: { createdAt: 'asc' },
    select: { newValue: true, createdAt: true },
  })).map((e) => ({ ...e.newValue, en: e.createdAt }))

  const pacientesCubiertos = reemplazos.reduce((n, r) => n + (r.patientCapacity ?? 0), 0)
  // El real que puso la líder si lo puso; si no, el estimado del sistema.
  const pacientesImpactados = pacientesDelCaso(ausencia)

  res.json({
    ausencia: conNombres(serializarAusencia(ausencia, dias, fechas)),
    cuenta: {
      pacientes_impactados: pacientesImpactados,
      pacientes_estimados: ausencia.patientsAffected ?? 0,
      pacientes_corregidos: ausencia.patientsConfirmed != null,
      pacientes_cubiertos: pacientesCubiertos,
      // Quedan los que faltan, nunca negativo: si quien cubre atiende de mas,
      // el caso esta resuelto, no "sobre-resuelto".
      pacientes_pendientes: Math.max(0, pacientesImpactados - pacientesCubiertos),
      franjas_totales: asignaciones.length,
      franjas_cubiertas: asignaciones.filter((a) => estadoDeFranja(a).cubierta).length,
      // Resuelto = no queda ningun paciente sin reubicar Y hubo al menos un
      // turno nuevo. Sin lo segundo, una ausencia sin pacientes impactados
      // nacería "resuelta" sin que nadie la toque.
      resuelto: pacientesImpactados > 0 && pacientesCubiertos >= pacientesImpactados,
      quienes_cubren: reemplazos.map((r) => ({
        nombre: r.resource?.name,
        dia: r.weekday,
        desde: r.startTime,
        hasta: r.endTime,
        pacientes: r.patientCapacity ?? 0,
      })),
    },
    semana: { id: semana.id, desde: semana.startDate, hasta: semana.endDate, estado: semana.status },
    acompanaba,
    auxiliar_cubiertos: auxiliarCubiertos,
    franjas: asignaciones.map((a) => {
      const { suyos, huecos, cubierta } = estadoDeFranja(a)
      // `reemplazo` se conserva con su significado de siempre —"la franja está
      // cubierta"— porque el Programador y la lista de ausencias lo leen así.
      // Solo se llena cuando está cubierta ENTERA; si no, ellos mostrarían
      // "✓ cubierta" de una franja a medias.
      const rp = cubierta ? suyos[0] : null
      return {
        assignment_id: a.id,
        week_id: semana.id,
        weekday: a.weekday,
        // La parte que se cayó. En una parcial puede ser menos que el turno:
        // falta de 07:00 a 11:00 en un turno de 07:00 a 13:00 → 07:00–11:00.
        start_time: a.parte.desde,
        end_time: a.parte.hasta,
        patient_capacity: a.parte.pacientes,
        turno_start_time: a.startTime,
        turno_end_time: a.endTime,
        assistant: a.assistant,
        assistant_id: a.assistantId,
        room: a.room ? { id: a.room.id, name: a.room.name } : null,
        room_id: a.roomId,
        site: a.room?.site ?? null,
        coordinadores: coordsPorSede.get(a.room?.siteId) ?? [],
        sede_cerrada: sedesCerradas.has(a.room?.siteId),
        reemplazo: rp
          ? { id: rp.id, resource: rp.resource, patient_capacity: rp.patientCapacity, start_time: rp.startTime, end_time: rp.endTime }
          : null,
        // Quién cubre cada tramo y qué falta. Con un solo médico que la toma
        // entera, `tramos` tiene uno y `huecos` está vacío.
        tramos: suyos.map((r) => ({
          id: r.id, resource: r.resource, start_time: r.startTime, end_time: r.endTime,
          patient_capacity: r.patientCapacity,
        })),
        huecos,
        cubierta,
      }
    }),
  })
}

function serializarAusencia(a, dias, fechas = []) {
  return {
    id: a.id,
    resource: a.resource,
    status: a.status,
    type: a.type,
    motivo_catalogo: a.reasonRef?.name ?? null,
    motivo_texto: a.reason ?? null,
    start_date: a.startDate,
    end_date: a.endDate,
    is_partial: a.isPartial,
    absence_start_time: a.absenceStartTime,
    absence_end_time: a.absenceEndTime,
    notice_days: a.noticeDays,
    patients_affected: a.patientsAffected,
    patients_confirmed: a.patientsConfirmed,
    agenda_action: a.agendaAction,
    rescheduler_id: a.reschedulerId,
    assigned_by: a.assignedBy,
    assigned_at: a.assignedAt,
    reschedule_status: a.rescheduleStatus,
    reschedule_notes: a.rescheduleNotes,
    reschedule_done_at: a.rescheduleDoneAt,
    dias,
    fechas,
  }
}


// ============================================================================
// Oct-2026 · ASIGNAR LA REPROGRAMACION A UN REPROGRAMADOR
//
// El ultimo paso del flujo que describio Hector: la lider ve la agenda caida,
// decide el reemplazo o el dia, y se lo pasa a un reprogramador para que llame
// a los pacientes. "La idea es que quede la trazabilidad de que Duarte realizo
// y asigno al reprogramador para que todo vaya correcto hasta ahi".
//
// Hasta ahi, literalmente: las llamadas no se modelan porque el SGRC no tiene
// pacientes, solo cuantos quedaron impactados. La cadena se cierra cuando el
// reprogramador marca su caso como resuelto.
// ============================================================================

// Nota de roles (oct-2026): `reprogramador` es la LÍDER del proceso, no
// quien recibe el caso. Conduce la reprogramación de principio a fin y al
// final se lo pasa a alguien para que haga las llamadas.
const asignarReprogramadorSchema = z.object({
  reschedulerId: z.string().uuid('Hay que elegir un reprogramador'),
  notes: z.preprocess(emptyToUndef, z.string().max(2000).optional()),
})

export async function asignarReprogramador(req, res) {
  const { reschedulerId, notes } = asignarReprogramadorSchema.parse(req.body)

  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: { resource: { select: { id: true, name: true, type: true } } },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')
  if (coordSoloVe(req.user, ausencia.resource?.type)) throw errors.forbidden(MSG_SOLO_VE)
  // Por confirmar → por cubrir → por repartir. Sin confirmar no hay caso.
  if (ausencia.status !== 'confirmada') {
    throw errors.badRequest(ausencia.status === 'pendiente'
      ? 'Primero confirme la ausencia.'
      : 'Esa ausencia fue rechazada: no hay pacientes que repartir.')
  }

  // Oct-2026 · PRIMERO CUBRIR, DESPUÉS REPARTIR. Decisión de Hector, que
  // describió el proceso así: la líder "selecciona el día o el reemplazo, y
  // entonces asigna al reprogramador".
  //
  // Antes se podía repartir un caso sin nada cubierto, y quien recibía el
  // encargo llamaba a los pacientes sin saber a dónde mandarlos —su tarjeta
  // decía "todavía nadie cubre esta agenda"—. Había seis casos así. Basta con
  // que haya algo cubierto, no todo: puede repartirse mientras se termina de
  // cubrir el resto.
  //
  // Va en el servidor y no solo en el botón: el botón se puede saltar
  // escribiendo la dirección.
  const cubiertos = await prisma.assignment.count({
    where: { coveredAbsenceId: ausencia.id, status: { not: 'cancelada' } },
  })
  if (cubiertos === 0) {
    throw errors.badRequest(
      'Primero cubra al menos una franja —con otro médico o moviendo la agenda—: así quien llama sabe qué decirle al paciente.'
    )
  }

  // Se comprueba el rol de verdad, no se confia en lo que mande el cliente:
  // asignarle esto a quien no puede entrar a la bandeja deja el caso en un
  // limbo que nadie ve.
  const destinatario = await prisma.user.findUnique({
    where: { id: reschedulerId },
    select: { id: true, name: true, email: true, role: true, active: true },
  })
  if (!destinatario || !destinatario.active) throw errors.badRequest('Ese usuario no existe o esta inactivo')
  if (destinatario.role !== 'reprogramador') {
    throw errors.badRequest(`${destinatario.name} no tiene el rol de reprogramador, asi que no veria el caso`)
  }

  const actualizada = await prisma.absence.update({
    where: { id: ausencia.id },
    data: {
      reschedulerId,
      assignedBy: req.user.id,
      assignedAt: new Date(),
      rescheduleStatus: 'asignada',
      rescheduleNotes: notes ?? null,
      // Reasignar reabre el caso: si ya estaba resuelto y se pasa a otra
      // persona, darlo por cerrado seria mentir.
      rescheduleDoneAt: null,
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'asignar_reprogramador',
    entity: 'ausencias',
    entityId: ausencia.id,
    newValue: { reprogramador: destinatario.name, recurso: ausencia.resource?.name, notas: notes ?? null },
    reason: 'Asignacion de la reprogramacion de la agenda',
    ipAddress: getIp(req),
  })

  await notificar({
    userId: reschedulerId,
    type: 'reprogramacion_asignada',
    title: `Se le asignó la reprogramación de ${ausencia.resource?.name}`,
    message: `<p>Se le asignó la reprogramación de la agenda de <strong>${ausencia.resource?.name}</strong>.</p>${notes ? `<p><em>Indicaciones:</em> ${notes}</p>` : ''}`,
    contexto: 'Gestion de ausencias',
  })

  res.json(actualizada)
}

/**
 * ¿Este recurso es de las sedes de este coordinador?
 *
 * Mismo criterio de pertenencia que usa el listado de ausencias, para que un
 * coordinador no pueda cerrar por URL un caso que su propia pantalla no le
 * muestra.
 */
async function recursoEsDelCoord(user, resourceId) {
  const misSedes = user.sites ?? []
  if (misSedes.length === 0) return false
  const hit = await prisma.resource.findFirst({
    where: { id: resourceId, ...recursoAlcanceCoord(misSedes, user.id) },
    select: { id: true },
  })
  return !!hit
}

/** Quien tiene el caso a cargo lo da por terminado. */
// ============================================================================
// Oct-2026 · PUT /absences/:id/assistant-cover · CUBRIR A UNA AUXILIAR
// (PROYECTOS-3583 §4). La auxiliar no tiene agenda propia: acompaña los turnos
// de un médico. Cubrirla es poner otra auxiliar en ESE turno, no crear uno
// nuevo. Se hace con editarAsignacion, así que pasan las mismas validaciones
// de siempre (sede del coordinador, cierre de semana, RN-08 de la auxiliar,
// tope de horas, sede bloqueada). Queda en la auditoría del caso y se le avisa
// a la nueva auxiliar.
// ============================================================================
const cubrirAuxSchema = z.object({
  assignmentId: z.string().uuid('Falta el turno'),
  assistantId: z.string().uuid('Elija quién la reemplaza'),
})

export async function cubrirAuxiliar(req, res) {
  const { assignmentId, assistantId } = cubrirAuxSchema.parse(req.body)
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: { resource: { select: { id: true, name: true, type: true } } },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')
  if (ausencia.status !== 'confirmada') throw errors.badRequest('Primero confirme la ausencia.')
  if (ausencia.rescheduleStatus === 'resuelta') throw errors.badRequest('El caso ya está terminado.')

  const turno = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: { week: true, room: { select: { name: true } }, resource: { select: { name: true } } },
  })
  const esSuyo = turno && (turno.assistantId === ausencia.resourceId || turno.assistant2Id === ausencia.resourceId)
  if (!esSuyo || turno.status === 'cancelada') throw errors.badRequest(`Ese turno no lo acompaña ${ausencia.resource.name}.`)
  const fecha = fechaDeTurno(turno.week.startDate, turno.weekday)
  if (!fecha || fecha < isoDia(ausencia.startDate) || fecha > isoDia(ausencia.endDate)) {
    throw errors.badRequest('Ese turno no cae en los días de la ausencia.')
  }
  if (assistantId === ausencia.resourceId) throw errors.badRequest('Elija a otra persona.')
  const nueva = await prisma.resource.findUnique({ where: { id: assistantId }, select: { id: true, name: true, type: true, active: true } })
  if (!nueva || !nueva.active) throw errors.badRequest('Esa persona no está activa.')
  if (nueva.type !== ausencia.resource.type) throw errors.badRequest('La reemplazante tiene que ser del mismo tipo.')

  const campo = turno.assistantId === ausencia.resourceId ? 'assistantId' : 'assistant2Id'
  const result = await editarAsignacion(turno.id, {
    weekId: turno.weekId, resourceId: turno.resourceId, roomId: turno.roomId, weekday: turno.weekday,
    startTime: turno.startTime, endTime: turno.endTime,
    assistantId: turno.assistantId, assistantStartTime: turno.assistantStartTime, assistantEndTime: turno.assistantEndTime,
    assistant2Id: turno.assistant2Id, assistant2StartTime: turno.assistant2StartTime, assistant2EndTime: turno.assistant2EndTime,
    expectedPatients: turno.patientCapacity,
    [campo]: nueva.id,
  }, { id: req.user.id, role: req.user.role, sites: req.user.sites })

  const detalle = {
    assignmentId: turno.id, weekId: turno.weekId, weekday: turno.weekday, startTime: turno.startTime, endTime: turno.endTime,
    roomId: turno.roomId, room: turno.room?.name ?? null, medico: turno.resource?.name ?? null,
    ausente: ausencia.resource.name, nuevaId: nueva.id, nueva: nueva.name,
    // 3583 · Llamarla para el mismo día es la excepción, y queda marcada.
    avisoMismoDia: diasDeAnticipacion(fecha) <= 0,
  }
  await registrarAuditoria({
    userId: req.user.id, action: 'auxiliar_reemplazo', entity: 'ausencias', entityId: ausencia.id,
    newValue: detalle, ipAddress: getIp(req),
  })
  // Para la vista de cambios del Programador, como cualquier edición de turno.
  await registrarAuditoria({
    userId: req.user.id, action: result.wasSupervisor ? 'modificar_semana_cerrada' : 'asignacion_editar',
    entity: 'asignaciones', entityId: turno.id,
    oldValue: { weekId: turno.weekId, weekday: turno.weekday, startTime: turno.startTime, endTime: turno.endTime, roomId: turno.roomId, room: turno.room?.name, resource: `${turno.resource?.name} · aux. ${ausencia.resource.name}` },
    newValue: { weekId: turno.weekId, weekday: turno.weekday, startTime: turno.startTime, endTime: turno.endTime, roomId: turno.roomId, room: turno.room?.name, resource: `${turno.resource?.name} · aux. ${nueva.name}` },
    ipAddress: getIp(req),
  })
  const usuarioNueva = await prisma.user.findFirst({ where: { resourceId: nueva.id, active: true }, select: { id: true } })
  if (usuarioNueva) {
    await notificar({
      userId: usuarioNueva.id,
      type: 'asignacion_cambiada',
      title: 'Se le asignó un turno',
      message: `Acompaña a ${turno.resource?.name} el ${turno.weekday} ${turno.startTime}–${turno.endTime} en ${turno.room?.name ?? 'un consultorio'}, en reemplazo de ${ausencia.resource.name}.`,
      criticidad: 'media',
    })
  }
  res.json({ ok: true, cubierto: detalle })
}

// ============================================================================
// Oct-2026 · PUT /absences/:id/paid · REMUNERADA O NO (PROYECTOS-3739 punto 1)
// "Agendas es responsable de asignar este dato, que aplica para todos los
// tipos de ausencia excepto licencia remunerada". Lo cambian la líder y
// gerencia; el coordinador, en lo de su reparto (no profesionales de su sede),
// igual que los pacientes reales.
// ============================================================================
const remuneracionSchema = z.object({ isPaid: z.boolean({ required_error: 'Indique si es remunerada' }) })

export async function corregirRemuneracion(req, res) {
  const { isPaid } = remuneracionSchema.parse(req.body)
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: { resource: { select: { id: true, name: true, type: true } } },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')
  if (ausencia.status === 'rechazada') throw errors.badRequest('La ausencia está rechazada.')
  if (!sePuedeCambiarRemuneracion(ausencia)) throw errors.badRequest('La licencia remunerada siempre es remunerada.')
  if (req.user.role === 'coordinador') {
    const delReparto = !TIPOS_PROFESIONALES.has(ausencia.resource?.type) && (await recursoEsDelCoord(req.user, ausencia.resourceId))
    if (!delReparto) throw errors.forbidden('Esta ausencia la gestiona la líder')
  }
  const antes = esRemunerada(ausencia)
  await prisma.absence.update({ where: { id: ausencia.id }, data: { isPaid } })
  await registrarAuditoria({
    userId: req.user.id, action: 'cambiar_remuneracion', entity: 'ausencias', entityId: ausencia.id,
    oldValue: { remunerada: antes }, newValue: { remunerada: isPaid, recurso: ausencia.resource?.name },
    ipAddress: getIp(req),
  })
  res.json({ id: ausencia.id, is_paid: isPaid, remunerada: isPaid })
}

export async function marcarReprogramacionResuelta(req, res) {
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: { resource: { select: { id: true, name: true, type: true } } },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')

  // Oct-2026 · El coordinador cierra lo suyo sin que nadie se lo asigne.
  // La reprogramacion de tecnicos, auxiliares y asesores es de el por reparto
  // —"la de los demas como tec, asesores, aux los hace los coordinadores de
  // sede"—, y en ese camino no existe el paso de asignar un reprogramador que
  // dejar registrado. Exigirle uno lo dejaba sin poder cerrar nunca.
  const esDeSuReparto =
    req.user.role === 'coordinador' &&
    !TIPOS_PROFESIONALES.has(ausencia.resource?.type) &&
    (await recursoEsDelCoord(req.user, ausencia.resourceId))

  // Lo cierra quien lo tiene asignado. Supervision y gerencia tambien, porque
  // alguien tiene que poder destrabarlo si el reprogramador se va de vacaciones.
  const esElAsignado = ausencia.reschedulerId === req.user.id
  const puedeDestrabar = ['supervisor', 'gerencia'].includes(req.user.role)
  // 3583 · Técnicos, auxiliares y asesores no pasan por un reprogramador: los
  // cierra su coordinador, y también supervisión y gerencia.
  const noProfesional = !TIPOS_PROFESIONALES.has(ausencia.resource?.type)
  if (!ausencia.reschedulerId && !esDeSuReparto && !(puedeDestrabar && noProfesional)) {
    throw errors.badRequest('Esta ausencia no tiene reprogramador asignado')
  }

  if (!esElAsignado && !puedeDestrabar && !esDeSuReparto) {
    throw errors.forbidden('Solo quien tiene a cargo la reprogramacion puede darla por resuelta')
  }

  const actualizada = await prisma.absence.update({
    where: { id: ausencia.id },
    data: { rescheduleStatus: 'resuelta', rescheduleDoneAt: new Date() },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'resolver_reprogramacion',
    entity: 'ausencias',
    entityId: ausencia.id,
    newValue: { cerrada_por: req.user.name, era_el_asignado: esElAsignado, por_reparto: esDeSuReparto },
    reason: esElAsignado
      ? 'El reprogramador dio el caso por terminado'
      : esDeSuReparto
        ? 'El coordinador cerro un caso de su reparto'
        : 'Cerrada por supervision',
    ipAddress: getIp(req),
  })

  res.json(actualizada)
}


// ============================================================================
// Oct-2026 · MI LISTA DE REPROGRAMACIONES
//
// Hector fijo el reparto del trabajo: "la reprogramacion de los profesionales
// la hace Maria Duarte. La de los demas como tec, asesores, aux los hace los
// coordinadores de sede".
//
// Hasta ahora no habia donde ver "lo mio". La lider entraba al tablero de
// indicadores —graficas del mes, para mirar, no para trabajar— y el
// coordinador no tenia ninguna puerta a reprogramacion: podia abrir el caso
// desde Gestion de ausencias, pero nada le decia cuales le tocaban.
//
// Esta es la pantalla de trabajo de los dos. Quien ve que lo decide
// alcanceDeReprogramacion(rol), en lib/resourceTypes.js, que es el unico sitio
// donde vive el reparto.
//
// Tres consultas para toda la lista, no tres por caso: las semanas, las
// franjas caidas y los reemplazos salen en bloque.
// ============================================================================

/**
 * ¿Este caso sigue necesitando que alguien lo trabaje?
 *
 * Son dos preguntas distintas y hay que cruzarlas: `status` dice si la
 * ausencia ocurrio, `rescheduleStatus` si ya se gestiono la agenda. Una
 * ausencia CONFIRMADA con pacientes sin reubicar es el caso mas urgente que
 * hay, y mirando solo la primera no aparecia como pendiente de nadie.
 *
 * Mismo criterio que `necesitaGestion` en CoordAbsencesPage.jsx. Si cambia
 * uno, cambia el otro: si no, la pestaña del coordinador y esta lista dirian
 * cosas distintas sobre la misma ausencia.
 */
function necesitaGestion(a) {
  if (a.status === 'rechazada') return false
  if (a.status === 'pendiente') return true
  return pacientesDelCaso(a) > 0 && a.rescheduleStatus !== 'resuelta'
}

export async function misReprogramaciones(req, res) {
  const rol = req.user?.role
  const incluirCerradas = req.query.incluir_cerradas === 'true'

  // ── 1. A quien le toca que ────────────────────────────────────────────────
  const alcance = alcanceDeReprogramacion(rol)
  const porTipo = {}
  if (alcance?.excluye) porTipo.type = { notIn: alcance.excluye }

  const where = { status: { not: 'rechazada' } }

  if (alcance?.asignadasAMi) {
    // El reprogramador ve LO QUE LE ASIGNARON, no todas las agendas de
    // profesionales. Es quien recibe el caso y llama a los pacientes: si le
    // mostraramos el reparto entero no sabria cual es el suyo.
    //
    // La lider no pasa por aqui: ella reparte desde la pantalla del caso, en
    // Gestion de ausencias, que sigue mostrandole todos los profesionales.
    where.reschedulerId = req.user.id
  } else if (rol === 'coordinador') {
    // Su sede, y dentro de su sede lo que no es profesional. Coord SIN sedes
    // no ve nada: sin este corte caeria sin filtro y recibiria las de todas.
    const misSedes = req.user.sites ?? []
    if (misSedes.length === 0) {
      res.json({ casos: [], resumen: { abiertos: 0, cerrados: 0, pacientes_impactados: 0, pacientes_pendientes: 0 } })
      return
    }
    where.resource = { is: { ...recursoAlcanceCoord(misSedes, req.user.id), ...porTipo } }
  } else if (porTipo.type) {
    where.resource = { is: porTipo }
  }
  // supervisor / gerencia / directivo: sin corte, ven el reparto completo.

  const ausencias = await prisma.absence.findMany({
    where,
    include: {
      resource: { select: { id: true, name: true, type: true, specialty: true } },
      reasonRef: { select: { code: true, name: true, family: true } },
    },
    orderBy: { startDate: 'asc' },
  })

  const abiertas = ausencias.filter(necesitaGestion)
  const trabajables = incluirCerradas ? ausencias : abiertas
  if (trabajables.length === 0) {
    res.json({ casos: [], resumen: { abiertos: 0, cerrados: ausencias.length - abiertas.length, pacientes_impactados: 0, pacientes_pendientes: 0 } })
    return
  }

  // ── 2. La semana de cada caso ─────────────────────────────────────────────
  // Una sola consulta para el rango completo, y despues se reparte en memoria.
  // Misma regla que contextoReemplazo: la primera semana que solapa.
  const desde = trabajables.reduce((m, a) => (a.startDate < m ? a.startDate : m), trabajables[0].startDate)
  const hasta = trabajables.reduce((m, a) => (a.endDate > m ? a.endDate : m), trabajables[0].endDate)
  const semanas = await prisma.week.findMany({
    where: { startDate: { lte: hasta }, endDate: { gte: desde } },
    orderBy: { startDate: 'asc' },
  })
  const semanaDe = (a) => semanas.find((w) => w.startDate <= a.endDate && w.endDate >= a.startDate) ?? null

  // Los dias que la ausencia cubre dentro de su semana. En UTC a proposito:
  // las fechas de solo-dia se guardan a medianoche UTC y en Colombia la hora
  // local las correria al dia anterior.
  const diasDe = (a, semana) => {
    const ini = a.startDate > semana.startDate ? a.startDate : semana.startDate
    const fin = a.endDate < semana.endDate ? a.endDate : semana.endDate
    const dias = []
    for (let d = new Date(ini); d <= fin; d = new Date(d.getTime() + 86400000)) {
      dias.push(NOMBRES_DIA_AUS[d.getUTCDay()])
    }
    return dias
  }

  const contexto = new Map()
  for (const a of trabajables) {
    const semana = semanaDe(a)
    contexto.set(a.id, { semana, dias: semana ? diasDe(a, semana) : [] })
  }

  // ── 3. Las franjas que se cayeron, todas de una ───────────────────────────
  const condiciones = trabajables
    .filter((a) => contexto.get(a.id).semana)
    .map((a) => ({
      weekId: contexto.get(a.id).semana.id,
      resourceId: a.resourceId,
      weekday: { in: contexto.get(a.id).dias },
    }))

  const franjas = condiciones.length
    ? await prisma.assignment.findMany({
        where: { status: { not: 'cancelada' }, OR: condiciones },
        include: { room: { select: { id: true, name: true, site: { select: { id: true, name: true, city: true } } } } },
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      })
    : []

  // Reparte cada franja a su caso. Dos ausencias del mismo recurso no pueden
  // solaparse en fechas (lo impide la validacion al registrarlas), asi que
  // semana + recurso + dia identifica el caso sin ambiguedad.
  const franjasDe = new Map(trabajables.map((a) => [a.id, []]))
  for (const f of franjas) {
    for (const a of trabajables) {
      const ctx = contexto.get(a.id)
      if (!ctx.semana || ctx.semana.id !== f.weekId) continue
      if (a.resourceId !== f.resourceId) continue
      if (!ctx.dias.includes(f.weekday)) continue
      // Parcial: solo las franjas que pisa su horario. Sin esto, quien falta
      // de 07:00 a 11:00 aparece con su turno de la tarde como caido.
      const parte = parteAfectada(f, a)
      if (!parte) continue
      franjasDe.get(a.id).push({ ...f, parte })
      break
    }
  }

  // ── 4. Lo que ya se cubrio ────────────────────────────────────────────────
  // Con el detalle completo, no solo el nombre: quien llama al paciente tiene
  // que poder decirle el dia, la hora y la sede a la que va ahora. "La cubre
  // la Dra. Suarez" no sirve para esa llamada.
  const reemplazos = await prisma.assignment.findMany({
    where: { coveredAbsenceId: { in: trabajables.map((a) => a.id) }, status: { not: 'cancelada' } },
    select: {
      id: true, coveredAbsenceId: true, patientCapacity: true, weekday: true,
      startTime: true, endTime: true, callsReached: true, callsNoAnswer: true,
      resource: { select: { name: true, type: true } },
      room: { select: { name: true, site: { select: { name: true } } } },
    },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  })
  const cubiertoDe = new Map()
  for (const r of reemplazos) {
    const acc = cubiertoDe.get(r.coveredAbsenceId) ?? { pacientes: 0, quienes: [] }
    acc.pacientes += r.patientCapacity ?? 0
    acc.quienes.push({
      id: r.id,
      contestaron: r.callsReached,
      no_contestaron: r.callsNoAnswer,
      nombre: r.resource?.name ?? null,
      tipo: r.resource?.type ?? null,
      dia: r.weekday,
      desde: r.startTime,
      hasta: r.endTime,
      sede: r.room?.site?.name ?? null,
      consultorio: r.room?.name ?? null,
      pacientes: r.patientCapacity ?? 0,
    })
    cubiertoDe.set(r.coveredAbsenceId, acc)
  }

  // Quien asigno cada caso, por nombre. `assignedBy` guarda el id del usuario
  // y no tiene relacion en el esquema, asi que se resuelven en una consulta.
  // Quien recibe el caso necesita saber de quien viene y que le dijeron.
  const asignadores = [...new Set(trabajables.map((a) => a.assignedBy).filter(Boolean))]
  const nombrePorId = new Map(
    asignadores.length
      ? (await prisma.user.findMany({
          where: { id: { in: asignadores } },
          select: { id: true, name: true },
        })).map((u) => [u.id, u.name])
      : []
  )

  // ── 5. Un caso por ausencia ───────────────────────────────────────────────
  const casos = trabajables.map((a) => {
    const ctx = contexto.get(a.id)
    const mias = franjasDe.get(a.id) ?? []
    const cub = cubiertoDe.get(a.id) ?? { pacientes: 0, quienes: [] }
    // El total del caso: el real que puso la líder, o el estimado.
    const impactados = pacientesDelCaso(a)

    const sedes = [...new Map(mias.filter((f) => f.room?.site).map((f) => [f.room.site.id, f.room.site])).values()]

    return {
      id: a.id,
      resource: a.resource,
      status: a.status,
      reschedule_status: a.rescheduleStatus,
      rescheduler_id: a.reschedulerId,
      // De quien viene el encargo y que indicaciones dejo. Para quien recibe
      // el caso esto no es adorno: es la mitad de la instruccion.
      asignada_por: a.assignedBy ? (nombrePorId.get(a.assignedBy) ?? null) : null,
      assigned_at: a.assignedAt,
      reschedule_notes: a.rescheduleNotes,
      // Las llamadas que ya anoto. NULL (no 0) mientras no registre nada:
      // "llame y no contesto nadie" es un dato y "todavia no he llamado" es
      // otro, y la pantalla los pinta distinto.
      llamadas: (() => {
        const sinEmpezar = a.patientsReached == null && a.patientsNoAnswer == null
        const llamados = sinEmpezar ? null : (a.patientsReached ?? 0) + (a.patientsNoAnswer ?? 0)
        const meta = pacientesDelCaso(a)
        return {
          contestaron: a.patientsReached,
          no_contestaron: a.patientsNoAnswer,
          llamados,
          registradas_en: a.callLogAt,
          // El cronograma pinta de verde con esto. Una agenda sin pacientes
          // no puede estar "completa": no habria a quien llamar.
          completa: meta > 0 && (llamados ?? 0) >= meta,
        }
      })(),
      start_date: a.startDate,
      end_date: a.endDate,
      is_partial: a.isPartial,
      absence_start_time: a.absenceStartTime,
      absence_end_time: a.absenceEndTime,
      motivo_catalogo: a.reasonRef?.name ?? null,
      dias: ctx.dias,
      // Sin semana programada no hay nada que reprogramar, y la pantalla lo
      // dice en vez de mostrar un caso vacio que no lleva a ningun lado.
      sin_semana: !ctx.semana,
      sedes,
      // Las horas de la agenda que se cayo. En una ausencia de dia completo no
      // hay hora de ausencia, y aun asi el turno tenia la suya.
      franjas: mias.map((f) => ({
        weekday: f.weekday,
        start_time: f.parte.desde,
        end_time: f.parte.hasta,
        patient_capacity: f.parte.pacientes,
        site: f.room?.site?.name ?? null,
        room: f.room?.name ?? null,
      })),
      cuenta: {
        // El estimado del sistema y el real que puso la líder. Se mandan los
        // dos: la pantalla usa el oficial y puede decir de dónde sale.
        pacientes_estimados: a.patientsAffected ?? 0,
        pacientes_oficiales: impactados,
        pacientes_corregidos: a.patientsConfirmed != null,
        pacientes_impactados: impactados,
        pacientes_cubiertos: cub.pacientes,
        // Nunca negativo: si quien cubre atiende de mas, el caso esta
        // resuelto, no "sobre-resuelto". Mismo criterio que contextoReemplazo.
        pacientes_pendientes: Math.max(0, impactados - cub.pacientes),
        franjas_totales: mias.length,
        resuelto: impactados > 0 && cub.pacientes >= impactados,
        quienes_cubren: cub.quienes,
      },
    }
  })

  // Lo mas urgente arriba: primero lo que mas pacientes deja sin reubicar, y
  // a igual numero, lo que cae antes en el calendario.
  casos.sort((x, y) => {
    const d = y.cuenta.pacientes_pendientes - x.cuenta.pacientes_pendientes
    return d !== 0 ? d : new Date(x.start_date) - new Date(y.start_date)
  })

  // El indicador de la persona: lo que lleva llamado sobre lo que le tocaba.
  // Es el numero que Hector quiere ver "para que todo vaya mas real" — el
  // trabajo de quien llama no se medía por ningun lado.
  const contestaron = casos.reduce((n, c) => n + (c.llamadas.contestaron ?? 0), 0)
  const noContestaron = casos.reduce((n, c) => n + (c.llamadas.no_contestaron ?? 0), 0)
  // El indicador se mide contra los pacientes OFICIALES: si quien llamó
  // corrigió el número, es ese el que manda. Medirlo contra el estimado daba
  // porcentajes que no cuadraban con la realidad de la agenda.
  const impactados = casos.reduce((n, c) => n + c.cuenta.pacientes_oficiales, 0)

  res.json({
    casos,
    resumen: {
      abiertos: abiertas.length,
      cerrados: ausencias.length - abiertas.length,
      pacientes_impactados: impactados,
      pacientes_pendientes: casos.reduce((n, c) => n + c.cuenta.pacientes_pendientes, 0),
      llamadas: {
        contestaron,
        no_contestaron: noContestaron,
        llamados: contestaron + noContestaron,
        // Los que nadie ha marcado todavia. Es el numero que dice cuanto falta.
        por_llamar: Math.max(0, impactados - contestaron - noContestaron),
        // De los que contestaron, sobre los llamados. Sin llamadas no hay
        // porcentaje: un 0% ahi diria "lo hizo mal" en vez de "aun no empieza".
        efectividad: contestaron + noContestaron > 0
          ? Math.round((contestaron / (contestaron + noContestaron)) * 100)
          : null,
      },
    },
  })
}


// ============================================================================
// Oct-2026 · EL REGISTRO DE LLAMADAS
//
// Lo que de verdad hace quien recibe el encargo. Hector, corrigiendome:
// "¿por que el reprogramador debe reprogramar? El reprogramador solamente
// mira a que profesional le asignaron y que el mismo ponga cuantos pacientes
// fueron los que llamo, cuales contestaron y cuales no, para asi ver en el
// indicador de su personal, para asi todo vaya mas real".
//
// No mueve agendas ni busca reemplazos: eso es de la lider y del coordinador.
// El toma el telefono y anota el resultado.
//
// El total de llamados no se guarda, se suma. Tres numeros guardados aparte
// se desincronizan; dos guardados y uno calculado, no pueden.
// ============================================================================

const llamadasSchema = z.object({
  reached: z.coerce.number().int().min(0, 'No puede ser negativo').optional(),
  noAnswer: z.coerce.number().int().min(0, 'No puede ser negativo').optional(),
  // Oct-2026 · Hector: una fila por cada médico que cubre. Cada una guarda sus
  // llamadas en el turno; la ausencia queda con la suma.
  tramos: z.array(z.object({
    assignmentId: z.string().uuid(),
    reached: z.coerce.number().int().min(0, 'No puede ser negativo'),
    noAnswer: z.coerce.number().int().min(0, 'No puede ser negativo'),
  })).optional(),
}).refine((d) => d.tramos?.length || (d.reached != null && d.noAnswer != null), {
  message: 'Faltan las llamadas',
})

export async function registrarLlamadas(req, res) {
  // Oct-2026 · El número real de pacientes ya no se pone aquí. Hector: "en
  // el momento del proceso de repro, en líder es donde pone los datos de los
  // pacientes reales afectados". Un solo dueño del dato: quien llama lo ve,
  // no lo cambia. Se rechaza en vez de ignorarlo en silencio, para que un
  // cliente viejo no crea que lo guardó.
  if (req.body?.patientsConfirmed !== undefined) {
    throw errors.badRequest('El número real de pacientes lo pone la líder en el caso, no en el registro de llamadas.')
  }
  const datos = llamadasSchema.parse(req.body)
  let { reached, noAnswer } = datos

  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, reschedulerId: true, patientsAffected: true, patientsConfirmed: true,
      patientsReached: true, patientsNoAnswer: true,
      resource: { select: { name: true } },
    },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')

  // Lo registra quien tiene el caso. Supervision tambien, para corregir un
  // numero mal puesto sin tener que entrar con la cuenta de la otra persona.
  const esElAsignado = ausencia.reschedulerId === req.user.id
  const esSupervision = ['supervisor', 'gerencia'].includes(req.user.role)
  if (!esElAsignado && !esSupervision) {
    throw errors.forbidden('Solo quien tiene el caso asignado puede registrar sus llamadas')
  }

  // Oct-2026 · Por cada médico que cubre. Cada fila no puede pasar de los
  // pacientes de ese turno; lo de la ausencia es la suma de todos sus turnos.
  if (datos.tramos?.length) {
    const turnos = await prisma.assignment.findMany({
      where: { coveredAbsenceId: ausencia.id, status: { not: 'cancelada' } },
      select: { id: true, patientCapacity: true, callsReached: true, callsNoAnswer: true, resource: { select: { name: true } } },
    })
    const porId = new Map(turnos.map((t) => [t.id, t]))
    for (const f of datos.tramos) {
      const t = porId.get(f.assignmentId)
      if (!t) throw errors.badRequest('Uno de los turnos no cubre esta ausencia.')
      if (f.reached + f.noAnswer > (t.patientCapacity ?? 0)) {
        throw errors.badRequest(`${t.resource?.name ?? 'Ese turno'} tiene ${t.patientCapacity ?? 0} pacientes: no pueden ser ${f.reached + f.noAnswer} llamadas.`)
      }
    }
    await prisma.$transaction(datos.tramos.map((f) => prisma.assignment.update({
      where: { id: f.assignmentId },
      data: { callsReached: f.reached, callsNoAnswer: f.noAnswer },
    })))
    const nuevos = new Map(datos.tramos.map((f) => [f.assignmentId, f]))
    reached = turnos.reduce((n, t) => n + (nuevos.get(t.id)?.reached ?? t.callsReached ?? 0), 0)
    noAnswer = turnos.reduce((n, t) => n + (nuevos.get(t.id)?.noAnswer ?? t.callsNoAnswer ?? 0), 0)
  }

  // El tope es el numero REAL si la líder lo corrigio; si no, el estimado.
  // Antes se medía siempre contra el estimado, que es justo lo que Hector
  // dice que "a veces son mas o menos": rebotaba llamadas correctas porque la
  // agenda tenia mas pacientes de los que el sistema calculaba.
  const tope = pacientesDelCaso(ausencia)
  const total = reached + noAnswer
  if (tope > 0 && total > tope) {
    throw errors.badRequest(
      `Son ${total} llamadas sobre una agenda de ${tope} pacientes. ` +
      `Si la agenda tenia mas pacientes, pidele a la lider que corrija el numero real en el caso.`
    )
  }

  const actualizada = await prisma.absence.update({
    where: { id: ausencia.id },
    data: {
      patientsReached: reached,
      patientsNoAnswer: noAnswer,
      callLogAt: new Date(),
    },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'registrar_llamadas',
    entity: 'ausencias',
    entityId: ausencia.id,
    oldValue: {
      contestaron: ausencia.patientsReached,
      no_contestaron: ausencia.patientsNoAnswer,
    },
    newValue: {
      contestaron: reached,
      no_contestaron: noAnswer,
      llamados: total,
      pacientes_del_caso: tope,
    },
    reason: `Llamadas de la agenda de ${ausencia.resource?.name ?? 'un profesional'}`,
    ipAddress: getIp(req),
  })

  res.json(actualizada)
}


// ============================================================================
// Oct-2026 · LOS PACIENTES REALES DEL CASO, QUE PONE LA LÍDER
//
// Hector: "en el momento del proceso de repro, en líder es donde pone los
// datos de los pacientes reales afectados". Eligió que se pongan en el caso,
// antes de cubrir, y que quien llama solo los vea.
//
// El sistema estima desde la capacidad del turno; la líder sabe cuántos había
// de verdad en la agenda externa. Desde que lo pone, ese número manda: la
// cuenta "0 de N reprogramados", el tope al cubrir y la meta de llamadas.
//
// Mandar null devuelve el caso al estimado.
// ============================================================================

const pacientesRealesSchema = z.object({
  patientsConfirmed: z.coerce.number().int('Tiene que ser un número entero')
    .min(0, 'No puede ser negativo').max(1000, 'Más de 1000 pacientes en una ausencia no es un número real').nullable(),
})

export async function corregirPacientes(req, res) {
  const { patientsConfirmed } = pacientesRealesSchema.parse(req.body)

  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, status: true, rescheduleStatus: true, resourceId: true,
      patientsAffected: true, patientsConfirmed: true,
      patientsReached: true, patientsNoAnswer: true,
      resource: { select: { name: true, type: true } },
    },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')

  // Quién: la líder y gerencia, en todo. El coordinador, solo en lo que es de
  // su reparto —técnicos, auxiliares y asesores de su sede—, igual que al
  // cerrar el caso. Los profesionales son de la líder.
  if (req.user.role === 'coordinador') {
    const esDeSuReparto = !TIPOS_PROFESIONALES.has(ausencia.resource?.type) &&
      (await recursoEsDelCoord(req.user, ausencia.resourceId))
    if (!esDeSuReparto) {
      throw errors.forbidden('Los pacientes de los profesionales los pone la líder de reprogramación')
    }
  }

  if (ausencia.status === 'rechazada') throw errors.badRequest('Esa ausencia fue rechazada: no tiene pacientes')
  if (ausencia.rescheduleStatus === 'resuelta') {
    throw errors.badRequest('El caso ya está terminado: sus números quedan como se cerraron')
  }

  // No puede quedar por debajo de lo ya hecho: ni de los pacientes que ya
  // tienen médico o día nuevo, ni de los que ya se llamaron. Con null se
  // vuelve al estimado, y el estimado tampoco puede quedar por debajo.
  const nuevoTotal = patientsConfirmed ?? ausencia.patientsAffected ?? 0
  const ya = await prisma.assignment.aggregate({
    where: { coveredAbsenceId: ausencia.id, status: { not: 'cancelada' } },
    _sum: { patientCapacity: true },
  })
  const reprogramados = ya._sum.patientCapacity ?? 0
  if (nuevoTotal < reprogramados) {
    throw errors.badRequest(`Ya hay ${reprogramados} pacientes reprogramados: el número real no puede ser menor.`)
  }
  const llamados = (ausencia.patientsReached ?? 0) + (ausencia.patientsNoAnswer ?? 0)
  if (nuevoTotal < llamados) {
    throw errors.badRequest(`Ya se llamó a ${llamados} pacientes: el número real no puede ser menor.`)
  }

  const actualizada = await prisma.absence.update({
    where: { id: ausencia.id },
    data: { patientsConfirmed },
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'corregir_pacientes_reales',
    entity: 'ausencias',
    entityId: ausencia.id,
    oldValue: { pacientes_reales: ausencia.patientsConfirmed, pacientes_estimados: ausencia.patientsAffected },
    newValue: { pacientes_reales: patientsConfirmed },
    reason: `Pacientes reales de la agenda de ${ausencia.resource?.name ?? 'un recurso'}`,
    ipAddress: getIp(req),
  })

  res.json(actualizada)
}
