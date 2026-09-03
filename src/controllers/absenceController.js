import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { differenceInDays, parseISO } from 'date-fns'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar, notificarCoordinadoresDeSede, notificarSupervisores, notificarDirectivos, notificarDireccionMedica } from '../services/notificationService.js'
import { calcularImpacto, liberarAuxiliaresSiAplica } from '../services/absenceService.js'
import { generarFormatoFAA126 } from '../services/faa126FormService.js'

// Tipos de recurso "médicos" que califican para el formato F-AA-126 (formato
// oficial de continuidad del servicio para prestadores oftalmología-optometría).
// Al confirmar una ausencia de estos tipos, el coord puede descargar el PDF.
const TIPOS_RECURSO_MEDICOS_FAA126 = new Set([
  'oftalmologo', 'optometra', 'anestesiologo', 'otorrino', 'fonoaudiologa',
])

const TIPOS = ['enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion', 'licencia_remunerada', 'licencia_no_remunerada', 'otra']

// Convierte strings vacías → undefined ANTES de validar.
// El frontend manda `""` cuando no hay valor (typical de inputs no llenos);
// sin esto, Zod rebota con "Datos inválidos" en campos opcionales.
const emptyToUndef = (v) => (v === '' ? undefined : v)

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
  recordedByCoordinator: z.boolean().optional(),
})

const confirmarSchema = z.object({
  notaCoordinador: z.string().optional(),
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
    if (sedeIdFinal) {
      if (!misSedes.includes(sedeIdFinal)) {
        throw errors.forbidden('No tienes acceso a esta sede')
      }
    } else if (misSedes.length > 0) {
      // Sin sede_id explícita → restringe a TODAS sus sedes.
      where.resource = {
        is: { user: { is: { sites: { some: { siteId: { in: misSedes } } } } } },
      }
    }
  }
  // supervisor / gerencia / directivo: pasan sin restricción extra.

  if (recurso_id && rol !== 'recurso') where.resourceId = recurso_id

  if (sedeIdFinal) {
    where.resource = {
      is: { user: { is: { sites: { some: { siteId: sedeIdFinal } } } } },
    }
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
      resource: true,
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
  const { confirmadorId, notaCoordinador, ipAddress, auditReason: motivoAudit } = opts
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
  const fmt = (d) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
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

  const fmt = (d) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
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

  // Auto-confirmación (jul-2026): si quien registra tiene rol autoritativo,
  // la ausencia queda confirmada al instante. Evita el problema de "se
  // olvida aprobarla y se pierde en la semana". El propio recurso siguen
  // pendiente (necesita validación humana).
  const esRegistroAutoritativo = ROLES_AUTORIDAD_AUSENCIA.has(req.user.role)
  const seAutoConfirmara = esRegistroAutoritativo

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
  const { notaCoordinador } = confirmarSchema.parse(req.body)
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
  const fmtDir = (d) => new Date(d).toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
  })
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

/**
 * GET /ausencias/:id/formato-faa126.pdf
 * Genera el formato oficial F-AA-126 en PDF para una ausencia CONFIRMADA de
 * un recurso médico (oftalmólogo/optómetra/anestesiólogo/otorrino/fonoaudiologa).
 * Requiere rol coord/supervisor/gerencia.
 */
export async function formatoFAA126Pdf(req, res) {
  const ausencia = await prisma.absence.findUnique({
    where: { id: req.params.id },
    // Fase 5 · v04: incluimos motivoRef para pintar el checkbox del motivo y
    // hacemos lookup del confirmador (Ausencia.confirmadoPor es solo String,
    // sin relación FK — resolvemos el nombre manualmente).
    include: { resource: true, reasonRef: true },
  })
  if (!ausencia) throw errors.notFound('Ausencia no encontrada')
  if (ausencia.status !== 'confirmada') {
    throw errors.badRequest('El formato F-AA-126 solo se emite para ausencias CONFIRMADAS')
  }
  if (!TIPOS_RECURSO_MEDICOS_FAA126.has(ausencia.resource?.type)) {
    throw errors.badRequest(
      `El formato F-AA-126 solo aplica a médicos. Este recurso es "${ausencia.resource?.type}".`
    )
  }
  // Fase 5 verify: IDOR — coord solo puede descargar PDFs de recursos que
  // trabajan en alguna de SUS sedes. supervisor/gerencia pasan derecho (scope
  // global). Datos sensibles del profesional (motivo/salud) → Ley 1581 Colombia.
  if (req.user?.role === 'coordinador') {
    const misSedes = req.user.sites ?? []
    const asigs = await prisma.assignment.findMany({
      where: {
        OR: [{ resourceId: ausencia.resourceId }, { assistantId: ausencia.resourceId }],
        status: { not: 'cancelada' },
      },
      include: { room: { select: { siteId: true } } },
    })
    const sedesRecurso = [...new Set(asigs.map((a) => a.room.siteId))]
    const overlap = sedesRecurso.some((s) => misSedes.includes(s))
    if (!overlap) throw errors.forbidden('No tienes acceso a esta ausencia')
  }

  // Vo Bo: nombre del usuario que confirmó la ausencia.
  let confirmador = null
  if (ausencia.confirmedBy) {
    confirmador = await prisma.user.findUnique({
      where: { id: ausencia.confirmedBy },
      select: { name: true, role: true },
    })
  }
  const pdf = await generarFormatoFAA126({ ...ausencia, confirmador })
  const nombreSafe = (ausencia.resource?.name ?? 'profesional')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="F-AA-126_${nombreSafe}_${ausencia.id.slice(0,8)}.pdf"`)
  res.send(pdf)
}
