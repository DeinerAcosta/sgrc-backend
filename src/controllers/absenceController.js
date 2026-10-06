import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { differenceInDays, parseISO } from 'date-fns'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar, notificarCoordinadoresDeSede, notificarSupervisores, notificarDirectivos, notificarDireccionMedica } from '../services/notificationService.js'
import { calcularImpacto, liberarAuxiliaresSiAplica, TIPOS_QUE_IMPACTAN_PACIENTES } from '../services/absenceService.js'
import { fechaSolo } from '../lib/fechas.js'

// Sep-2026 · Se eliminó TIPOS_RECURSO_MEDICOS_FAA126: solo servía para decidir
// quién podía descargar el PDF del formato, y ese PDF ya no existe. La lista
// equivalente de "tipos que atienden pacientes" vive en lib/resourceTypes.js,
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
  // ==== Fase 5 · F-AA-126 v04 ====
  // Empresa a la que aplica la ausencia. Refleja el checkbox del formato oficial.
  affectedCompany: z.preprocess(emptyToUndef, z.enum(['foca', 'viu', 'ambas']).optional()),
  // Bandera "¿DESEA REPONER?" del formato v04.
  // Parseo explícito: z.coerce.boolean() convierte "false" (string) → true,
  // corrompiendo la respuesta del formato oficial. Aceptamos solo boolean nativo
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
        throw errors.forbidden('No tienes acceso a esta sede')
      }
    } else if (misSedes.length > 0) {
      // Sin sede_id explícita → restringe a TODAS sus sedes.
      where.resource = { is: recursoAlcanceCoord(misSedes, req.user.id) }
    }
  } else if (rol === 'reprogramador') {
    // Sep-2026 · Reprograma agendas caídas, así que solo le competen las
    // ausencias de quien TIENE agenda propia de pacientes. Las de auxiliares,
    // técnicos y asesores no dejan nada que reprogramar.
    //
    // ESTE RECORTE VA EN EL SERVIDOR A PROPÓSITO. La pantalla ya agrupa por
    // tipo de personal, pero eso es organización, no permiso: bastaría con
    // cambiar `?grupo=profesionales` por `?grupo=auxiliares` en la barra de
    // direcciones para ver lo que no le toca. Aquí no hay URL que valga.
    where.resource = { is: { type: { in: [...TIPOS_QUE_IMPACTAN_PACIENTES] } } }
    sedeIdFinal = null   // trabaja sobre todas las sedes
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
      // Oct-2026 · Antes era `resource: true`, que arrastraba `firma_url`: un
      // MEDIUMTEXT con la firma escaneada en base64, hasta ~6 MB por recurso.
      // Pedir el listado completo de ausencias bajaba una firma por fila, y la
      // pantalla no dibuja ninguna. La firma solo se necesita al abrir el
      // formato, y para eso está GET /absences/:id/form.
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
  res.json(list)
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
async function procesarConfirmacionAusencia(tx, ausencia, opts) {
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
        OR: [{ resourceId: ausencia.resourceId }, { assistantId: ausencia.resourceId }],
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
      message: `<p>El coordinador validó la ausencia que reportaste y la registró como <strong>confirmada</strong>. A partir de este momento queda incluida en los informes de Ausentismo del sistema.</p>
      <p>Si tienes alguna observación, contacta a tu coordinador. Para visualizar el detalle e impacto, accede a la sección "Mis ausencias" en el sistema.</p>`,
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

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const fechaInicio = parseISO(data.startDate)
  const fechaFin = data.endDate ? parseISO(data.endDate) : fechaInicio
  const anticipacionDias = differenceInDays(fechaInicio, new Date())

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
  const solapada = await prisma.absence.findFirst({
    where: {
      resourceId: data.resourceId,
      status: { not: 'rechazada' },
      startDate: { lte: fechaFin },
      endDate: { gte: fechaInicio },
    },
    select: { id: true, startDate: true, endDate: true, status: true },
  })
  if (solapada) {
    const f = (d) => new Date(d).toISOString().slice(0, 10)
    const mismasFechas = f(solapada.startDate) === f(fechaInicio) && f(solapada.endDate) === f(fechaFin)
    throw errors.badRequest(
      mismasFechas
        ? `Esta ausencia ya está registrada (${f(solapada.startDate)} a ${f(solapada.endDate)}, estado: ${solapada.status}). No se registró de nuevo.`
        : `El recurso ya tiene una ausencia ${solapada.status} del ${f(solapada.startDate)} al ${f(solapada.endDate)}, que se cruza con estas fechas. Edita la existente en vez de crear otra.`
    )
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
      // Fase 5 · F-AA-126 v04 (ago-2026)
      affectedCompany: data.affectedCompany ?? null,
      wantsMakeup: data.wantsMakeup ?? null,
      makeupNotes: data.wantsMakeup ? (data.makeupNotes?.trim() || null) : null,
      // §4 · Fecha propuesta de reposición, como fecha y no dentro del texto
      // libre: así se puede filtrar y cruzar con la agenda de ese día.
      makeupDate: data.wantsMakeup && data.makeupDate ? parseISO(data.makeupDate) : null,
      // Umbral operativo (RN ago-2026): ausencia con más de 15 días de
      // anticipación se considera "programada" (hay margen para reprogramar
      // pacientes con menor impacto); ≤ 15 días es "imprevista". Antes era >= 2.
      isPlanned: anticipacionDias > 15,
      noticeDays: Math.max(0, anticipacionDias),
      recordedByCoordinator: data.recordedByCoordinator ?? false,
      reportedBy: req.user.id,
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
    ['Programada',         anticipacionDias >= 2 ? 'Sí (con anticipación)' : 'No (imprevista)'],
    ['Reportada por',      reportadaPor],
    ...(data.reason ? [['Observación', data.reason]] : []),
    ['Estado',             estadoInicialTxt],
  ]
  const FRONT = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'

  // Mensajes de notificación según si la ausencia queda confirmada o pendiente.
  const msgRecurso = seAutoConfirmara
    ? `<p>Se registró en el sistema una ausencia a tu nombre — quedó <strong>confirmada automáticamente</strong> porque la reportó ${reportadaPor.split(' (')[0]}. Su impacto operativo (pacientes afectados, costo de oportunidad) ya se calculó y aparece en los informes.</p>
       <p>Si tienes alguna observación, contacta a tu coordinador. Puedes ver el detalle en "Mis ausencias".</p>`
    : `<p>Se registró en el sistema una ausencia a tu nombre. Quedó en estado <strong>Pendiente de confirmación</strong> a la espera del coordinador, quien validará el impacto operativo y la marcará como confirmada.</p>
       <p>Una vez confirmada, recibirás una segunda notificación con el impacto registrado (pacientes afectados, costo de oportunidad, etc.).</p>`

  const msgCoord = seAutoConfirmara
    ? `<p>Se registró una ausencia que afecta a una de las sedes bajo tu responsabilidad. <strong>Quedó confirmada automáticamente</strong> al reportarla ${reportadaPor.split(' (')[0]} — el impacto operativo (pacientes afectados, ejecuciones marcadas como no ejecutada, liberación de auxiliares) ya se aplicó.</p>
       <p>Si necesitas revisar el detalle o hacer ajustes, ingresa al módulo de Ausencias.</p>`
    : `<p>Se reportó una ausencia que afecta a una de las sedes bajo tu responsabilidad. La ausencia está en estado <strong>pendiente</strong> y requiere tu revisión y confirmación para registrar el impacto operativo (pacientes afectados, asignaciones canceladas, costo de oportunidad).</p>
       <p>Por favor, ingresa al módulo de Ausencias en el sistema y procesa esta solicitud antes de que comience la franja afectada para permitir reasignación si corresponde.</p>`

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
      title: seAutoConfirmara ? `Ausencia confirmada: ${tipoLabel}` : `Registro de tu ausencia: ${tipoLabel}`,
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
 *   - RN-18 + RN-19: cálculo de impacto día a día con factor parcial
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
  const actualizada = await prisma.absence.update({
    where: { id: req.params.id },
    data: { status: 'rechazada', rejectionReason: motivo },
    include: { resource: true },
  })
  res.json(actualizada)
}

// Sep-2026 · Se eliminó `formatoFAA126Pdf`, que generaba el formato oficial
// en PDF. Decisión de negocio: el PDF sale del sistema por completo y el
// formato pasa a verse como formulario de solo lectura dentro del detalle
// de la ausencia (PROYECTOS-3398 §1). Con él se fue services/faa126FormService.js.

// ============================================================================
// Oct-2026 · PROYECTOS-3398 §1 · FORMATO DE SOLO LECTURA
//
// Lo que antes se bajaba en PDF ahora se consulta. El PDF imitaba una hoja que
// alguien iba a imprimir, firmar y archivar: traía 12 filas de meses vacías
// para rellenar a mano y repetía datos que el sistema ya tenía guardados. Al
// salir del sistema, lo que queda es el formato como PANTALLA: los mismos
// bloques del F-AA-126, con el dato real, sin casillas que llenar.
//
// Devuelve el formato armado desde el servidor y no desde la lista, por tres
// razones concretas:
//   1. La firma escaneada pesa hasta 6 MB en base64 (`firma_url` es MEDIUMTEXT).
//      Ir en cada fila de la lista hacía que pedir 131 ausencias arrastrara
//      todas las firmas. Aquí viaja una sola vez, al abrir el formato.
//   2. El "Vo Bo" es el nombre de quien confirmó, que vive en `usuarios` y no
//      en la ausencia: resolverlo en el cliente obligaba a una segunda consulta.
//   3. El alcance por rol se revisa aquí. Con la lista alcanzaba el filtro del
//      `where`; con un id en la URL hay que comprobar explícitamente que esa
//      ausencia cae dentro de lo que el rol puede ver.
// ============================================================================

const EMPRESA_LABEL = { foca: 'FOCA', viu: 'VIU', ambas: 'AMBAS' }

export async function formato(req, res) {
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    include: {
      resource: {
        select: {
          id: true, name: true, type: true, specialty: true, signatureUrl: true,
          leadCoordinatorId: true,
          user: { select: { email: true, sites: { select: { siteId: true } } } },
        },
      },
      reasonRef: { select: { code: true, name: true, family: true } },
    },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')

  // ---- Alcance por rol. Mismas reglas que list(), evaluadas sobre un registro.
  const rol = req.user?.role
  if (rol === 'recurso') {
    if (ausencia.resourceId !== req.user.resourceId) throw errors.forbidden('No tienes acceso a esta ausencia')
  } else if (rol === 'coordinador') {
    const misSedes = req.user.sites ?? []
    const sedesDelRecurso = (ausencia.resource.user?.sites ?? []).map((s) => s.siteId)
    const esSuya = ausencia.resource.leadCoordinatorId === req.user.id
      || sedesDelRecurso.some((s) => misSedes.includes(s))
    // Fallback de list(): el recurso puede no tener User ni líder y aun así
    // estar programado en una sede del coordinador.
    const programadoEnSusSedes = esSuya ? false : await prisma.assignment.findFirst({
      where: {
        room: { siteId: { in: misSedes } },
        OR: [{ resourceId: ausencia.resourceId }, { assistantId: ausencia.resourceId }],
      },
      select: { id: true },
    })
    if (!esSuya && !programadoEnSusSedes) throw errors.forbidden('No tienes acceso a esta ausencia')
  } else if (rol === 'reprogramador') {
    if (!TIPOS_QUE_IMPACTAN_PACIENTES.has(ausencia.resource.type)) {
      throw errors.forbidden('No tienes acceso a esta ausencia')
    }
  }
  // supervisor / gerencia / directivo: ven todo.

  // ---- Nombres de quien diligenció y quien dio el Vo Bo.
  const idsUsuarios = [ausencia.reportedBy, ausencia.confirmedBy].filter(Boolean)
  const usuarios = idsUsuarios.length > 0
    ? await prisma.user.findMany({ where: { id: { in: idsUsuarios } }, select: { id: true, name: true, role: true } })
    : []
  const porId = Object.fromEntries(usuarios.map((u) => [u.id, u]))

  res.json({
    codigo: 'F-AA-126',
    version: '05',
    // El encabezado del formato oficial cambia de razón social según la empresa
    // a la que se cargue la ausencia. 'ambas' y los registros viejos sin
    // empresa usan el de la clínica, igual que hacía el PDF.
    empresa: ausencia.affectedCompany ?? null,
    empresa_label: EMPRESA_LABEL[ausencia.affectedCompany] ?? null,
    razon_social: ausencia.affectedCompany === 'foca'
      ? 'FUNDACIÓN OFTALMOLÓGICA DEL CARIBE'
      : 'CLÍNICA OFTALMOLÓGICA DEL CARIBE',
    subtitulo: 'CONTINUIDAD DEL SERVICIO CON LOS PRESTADORES DE SERVICIO',
    especialidades: 'OFTALMOLOGÍA - OTORRINOLARINGOLOGÍA',

    ausencia: {
      id: ausencia.id,
      estado: ausencia.status,
      tipo: ausencia.type,
      motivo_catalogo: ausencia.reasonRef?.name ?? null,
      motivo_texto: ausencia.reason ?? null,
      fecha_salida: fechaSolo(ausencia.startDate),
      fecha_entrada: fechaSolo(ausencia.endDate),
      es_parcial: ausencia.isPartial,
      hora_inicio: ausencia.absenceStartTime,
      hora_fin: ausencia.absenceEndTime,
      ciudad_regional: ausencia.regionalCity,
      es_programada: ausencia.isPlanned,
      anticipacion_dias: ausencia.noticeDays,
      desea_reponer: ausencia.wantsMakeup,
      fecha_reposicion_propuesta: ausencia.makeupDate ? fechaSolo(ausencia.makeupDate) : null,
      observaciones_reposicion: ausencia.makeupNotes,
      accion_agenda: ausencia.agendaAction,
      accion_tomada: ausencia.actionTaken,
      motivo_rechazo: ausencia.rejectionReason,
      // El PDF dejaba 12 filas de meses en blanco "para llenar a mano". Eso lo
      // reemplaza el desglose que el sistema ya calcula al confirmar.
      pacientes_impactados: ausencia.patientsAffected,
      impacto_por_dia: ausencia.dailyImpact ?? null,
    },

    profesional: {
      nombre: ausencia.resource.name,
      tipo: ausencia.resource.type,
      especialidad: ausencia.resource.specialty,
      correo: ausencia.resource.user?.email ?? null,
      firma_url: ausencia.resource.signatureUrl ?? null,
    },

    diligenciamiento: {
      // `reportedAt` es un timestamp real, no una fecha suelta: va en hora de
      // Bogotá y no en UTC (lib/fechas.js).
      fecha: ausencia.reportedAt,
      por: porId[ausencia.reportedBy]?.name ?? null,
      rol: porId[ausencia.reportedBy]?.role ?? null,
      registrado_por_coordinador: ausencia.recordedByCoordinator,
    },

    vo_bo: ausencia.confirmedBy
      ? { nombre: porId[ausencia.confirmedBy]?.name ?? null, fecha: ausencia.confirmedAt }
      : null,

    nota: 'Las ausencias deben ser informadas con 20 días de anticipación.',
  })
}
