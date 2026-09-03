import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { titleCase } from '../lib/strings.js'
import { getSemanaActual } from '../lib/week.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { horasEfectivasFranja, horasDeFranja, JORNADA_LEGAL_SEMANAL } from '../lib/workHours.js'

const TIPOS = ['oftalmologo', 'optometra', 'anestesiologo', 'asesor_servicios', 'auxiliar', 'tecnico', 'fonoaudiologa', 'otorrino']
const ESQUEMAS = ['por_paciente', 'fijo', 'mixto']

// La especialidad de un consultorio determina qué tipo de recurso lo puede atender
const ESPECIALIDAD_A_TIPO = {
  oftalmologia: 'oftalmologo',
  optometria: 'optometra',
  anestesiologia: 'anestesiologo',
  diagnostico: 'tecnico',
  asesoria: 'asesor_servicios',
  fonoaudiologia: 'fonoaudiologa',
  otorrinolaringologia: 'otorrino',
}

const emptyToUndef = (v) => (v === '' ? undefined : v)

const recursoSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(TIPOS),
  specialty: z.preprocess(emptyToUndef, z.string().max(100).optional().nullable()),
  slotMinutes: z.preprocess(emptyToUndef, z.number().int().min(5).max(60).optional().nullable()),
  payScheme: z.enum(ESQUEMAS),
  maxHoursPerWeek: z.preprocess(emptyToUndef, z.number().int().min(1).max(60).optional()),
  maxHoursPerDay: z.preprocess(emptyToUndef, z.number().int().min(1).max(24).optional()),
  multiRoom: z.boolean().optional(),
  active: z.boolean().optional(),
  deactivationReason: z.preprocess(emptyToUndef, z.string().optional().nullable()),
  // CSV de tipos alternativos donde el recurso puede aparecer también como
  // apoyo (auxiliar/técnico). Ej. "auxiliar" o "auxiliar,tecnico". Solo valores
  // de TIPOS son válidos. Vacío/null = solo aparece en su tipo principal.
  supportTypes: z.preprocess(emptyToUndef, z.string().max(100).optional().nullable()),
})

/**
 * GET /recursos
 * Filtros: tipo, activo, especialidad_consultorio (→ mapea a tipo),
 * sede_id (filtra a los recursos cuyo usuario está vinculado a esa sede),
 * coordinador_lider_id (filtra a los recursos cuyo líder es ese coordinador).
 * Enriquece cada recurso con horas_asignadas y es_horas_extras de la
 * semana abierta más reciente — esto alimenta el dashboard del coordinador.
 */
export async function list(req, res) {
  const { type: tipo, active: activo, especialidad_consultorio, site_id: sede_id, lead_coordinator_id: coordinador_lider_id } = req.query
  const where = {}
  // Cuando se filtra por tipo, también incluir recursos cuyo `tiposApoyo` (CSV)
  // contiene ese tipo — son recursos multi-rol que pueden apoyar como ese tipo.
  // Ej. una técnica de diagnóstico con tiposApoyo='auxiliar' aparece tanto en
  // el pool de técnicos como en el pool de auxiliares de oftalmología.
  if (tipo) {
    where.OR = [
      { type: tipo },
      { supportTypes: { contains: tipo } },
    ]
  }
  if (especialidad_consultorio && ESPECIALIDAD_A_TIPO[especialidad_consultorio]) {
    const tipoPrincipal = ESPECIALIDAD_A_TIPO[especialidad_consultorio]
    where.OR = [
      { type: tipoPrincipal },
      { supportTypes: { contains: tipoPrincipal } },
    ]
  }
  if (activo !== undefined) where.active = activo === 'true'
  if (coordinador_lider_id) where.leadCoordinatorId = coordinador_lider_id

  // Filtrar por sede a través del usuario vinculado al recurso
  if (sede_id) {
    where.user = {
      is: {
        sites: { some: { siteId: sede_id } },
      },
    }
  }

  const recursos = await prisma.resource.findMany({ where, orderBy: { name: 'asc' } })

  // Resolver nombre de cada coordinador-líder en una sola query (evita N+1).
  // Se calcula una sola vez y se usa en ambas ramas (con o sin semana actual).
  const liderIdsTop = [...new Set(recursos.map((r) => r.leadCoordinatorId).filter(Boolean))]
  const lideresTop = liderIdsTop.length
    ? await prisma.user.findMany({
        where: { id: { in: liderIdsTop } },
        select: { id: true, name: true },
      })
    : []
  const liderByIdTop = new Map(lideresTop.map((u) => [u.id, u.name]))

  // Enriquecer con horas de la semana ACTUAL (la que contiene hoy)
  const semana = await getSemanaActual()

  if (!semana) {
    return res.json(recursos.map((r) => ({
      ...r,
      assignedHours: 0,
      currentWeekHours: 0,
      isOvertime: false,
      coordinadorLiderNombre: liderByIdTop.get(r.leadCoordinatorId) ?? null,
    })))
  }

  const asignaciones = await prisma.assignment.findMany({
    where: { weekId: semana.id, status: { not: 'cancelada' } },
    select: { resourceId: true, assistantId: true, startTime: true, endTime: true, status: true },
  })

  // Jornada laboral semanal global (Ley 2101 Colombia). Editable desde "Metas del sistema".
  // Fase actual (15-jul-2025 → 14-jul-2026): 44h. A partir del 15-jul-2026 baja a 42h.
  // Oftalmólogos siempre sin tope (horas_max_semana = null en BD).
  const jornadaParam = await prisma.systemSetting.findUnique({ where: { key: 'jornada_semanal_horas' } })
  const jornadaGlobalHoras = jornadaParam ? Number(jornadaParam.value) : JORNADA_LEGAL_SEMANAL

  // Festivos dentro de la semana actual que caen en día laborable (L-S).
  // Ajustan el tope de horas porque ese día NO se cubre — no se debe penalizar al recurso.
  // Ej: semana con Corpus Christi (lun festivo) → tope efectivo = horasMaxSemana × 5/6.
  const festivosSemana = await prisma.holiday.findMany({
    where: { date: { gte: semana.startDate, lte: semana.endDate } },
    select: { date: true },
  })
  // En JS: 0=Dom, 1=Lun, ..., 6=Sáb. Solo L-S cuentan como laborables (domingo nominalmente off).
  const DIAS_LABORABLES_SEMANA = 6
  const festivosLaborables = festivosSemana.filter((f) => {
    const dow = new Date(f.date).getUTCDay()
    return dow >= 1 && dow <= 6
  }).length
  const factorEfectivo = (DIAS_LABORABLES_SEMANA - festivosLaborables) / DIAS_LABORABLES_SEMANA

  // Auxiliares "liberadas" por RN-24: las que aparecen como auxiliarId
  // en alguna asignación con estado 'sin_cobertura'.
  const liberadas = new Set(
    asignaciones.filter((a) => a.status === 'sin_cobertura' && a.assistantId).map((a) => a.assistantId)
  )

  const enriquecidos = recursos.map((r) => {
    const propias = asignaciones.filter((a) => a.resourceId === r.id || a.assistantId === r.id)
    // Horas EFECTIVAS (descontando almuerzo por franja). Es lo que se compara
    // contra el tope contractual semanal (Ley 2101). Una franja 08:00–17:00
    // son 9h brutas pero 8h efectivas (1h almuerzo) — y son las 8h las que
    // pesan contra el tope.
    const horas = propias.reduce((acc, a) => acc + horasEfectivasFranja(a.startTime, a.endTime, r.type), 0)
    // Horas de PRESENCIA (brutas, sin descontar almuerzo). Se expone al frontend
    // como complemento para el dashboard — el coord ve que Grace hace 6h × 6d
    // = 36h de presencia pero 30h efectivas (comparadas vs. tope Ley 2101).
    // Distinción pedida por el usuario (jul-2026) para evitar confusión entre
    // lo que se ve en el programador (presencia) y lo que cuenta la ley (efectivas).
    const horasPresencia = propias.reduce((acc, a) => acc + horasDeFranja(a.startTime, a.endTime), 0)
    // Tope semanal NOMINAL: oftalmólogos sin tope (null), resto usa jornada global del parámetro.
    // Si en el futuro algún recurso necesita tope personalizado, podríamos respetar r.horasMaxSemana
    // cuando difiera explícitamente — por ahora siempre la jornada global.
    const horasMaxNominal = r.maxHoursPerWeek == null ? null : jornadaGlobalHoras
    // Tope efectivo descontando festivos. Oftalmólogos siguen sin tope.
    const horasMaxEfectivas = horasMaxNominal == null
      ? null
      : Math.round(horasMaxNominal * factorEfectivo * 10) / 10
    return {
      ...r,
      // Sobreescribimos el horasMaxSemana del recurso con la jornada global para que el frontend
      // muestre siempre el valor vigente (ej: 44h hoy, 42h cuando supervisor lo cambie en julio).
      maxHoursPerWeek: horasMaxNominal,
      assignedHours: Math.round(horas * 10) / 10,
      currentWeekHours: Math.round(horas * 10) / 10,
      weeklyPresenceHours: Math.round(horasPresencia * 10) / 10,   // horas brutas (con almuerzo)
      maxEffectiveHours: horasMaxEfectivas,                       // tope ajustado por festivos
      festivosEnSemana: festivosLaborables,    // para que el UI muestre el badge
      isOvertime: horasMaxEfectivas != null && horas > horasMaxEfectivas,
      statusBadge: liberadas.has(r.id) ? 'liberada' : null,
      coordinadorLiderNombre: liderByIdTop.get(r.leadCoordinatorId) ?? null,
    }
  })

  res.json(enriquecidos)
}

export async function getById(req, res) {
  const r = await prisma.resource.findUnique({ where: { id: req.params.id } })
  if (!r) throw errors.notFound()
  res.json(r)
}

export async function create(req, res) {
  const data = recursoSchema.parse(req.body)
  // RN-12: intervalo solo lo modifica supervisor (la ruta ya está protegida por rol)
  const r = await prisma.resource.create({ data: { ...data, name: titleCase(data.name) } })
  res.status(201).json(r)
}

export async function update(req, res) {
  const data = recursoSchema.partial().parse(req.body)
  const anterior = await prisma.resource.findUnique({ where: { id: req.params.id } })
  if (!anterior) throw errors.notFound()

  // RN-14: si se desactiva, las asignaciones futuras se mantienen (el coordinador las resuelve)
  const r = await prisma.resource.update({
    where: { id: req.params.id },
    data: { ...data, ...(data.name ? { name: titleCase(data.name) } : {}) },
  })

  if (anterior.active !== r.active) {
    await registrarAuditoria({
      userId: req.user.id,
      action: r.active ? 'activar_recurso' : 'desactivar_recurso',
      entity: 'recursos',
      entityId: r.id,
      oldValue: { active: anterior.active },
      newValue: { active: r.active },
      reason: data.deactivationReason,
      ipAddress: getIp(req),
    })
  }
  res.json(r)
}

/** GET /recursos/:id/horario?semana_id= — HU-R-02 */
export async function horario(req, res) {
  const { week_id: semana_id } = req.query
  const asignaciones = await prisma.assignment.findMany({
    where: {
      weekId: semana_id || undefined,
      OR: [{ resourceId: req.params.id }, { assistantId: req.params.id }],
      status: { not: 'cancelada' },
    },
    include: {
      room: { include: { site: true } },
      resource: true,
      assistant: true,
      assistant2: true,
    },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  })

  // Hidrata el coordinador líder de cada recurso titular SIN tocar el schema.
  // El campo `coordinadorLiderId` apunta a un Usuario — hacemos una query
  // separada y lo añadimos manualmente (evita tener que declarar la relación
  // en Prisma, que requeriría migración de FK).
  //
  // Fallback: si el TITULAR del turno no tiene líder asignado (caso real:
  // oftalmólogos rotativos sin líder), usamos el líder del AUX (en la vista
  // del recurso, el aux suele ser el usuario logueado y sí tiene líder). Así
  // siempre se muestra un coord útil en vez de "sin coordinador".
  const liderIds = [...new Set([
    ...asignaciones.map((a) => a.resource?.leadCoordinatorId),
    ...asignaciones.map((a) => a.assistant?.leadCoordinatorId),
  ].filter(Boolean))]
  const lideres = liderIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: liderIds } },
        select: { id: true, name: true, email: true },
      })
    : []
  const liderById = new Map(lideres.map((u) => [u.id, u]))

  const out = asignaciones.map((a) => {
    const liderTitular = liderById.get(a.resource?.leadCoordinatorId) ?? null
    const liderAux = liderById.get(a.assistant?.leadCoordinatorId) ?? null
    const coord = liderTitular ?? liderAux ?? null
    return {
      ...a,
      resource: a.resource
        ? { ...a.resource, leadCoordinator: coord }
        : a.resource,
    }
  })
  res.json(out)
}

/** GET /recursos/:id/ausencias — HU-R-06 historial de ausencias del recurso */
export async function ausenciasDelRecurso(req, res) {
  const list = await prisma.absence.findMany({
    where: { resourceId: req.params.id },
    include: { resource: true },
    orderBy: { reportedAt: 'desc' },
  })
  res.json(list)
}

/**
 * GET /recursos/:id/productividad — HU-R-08
 * Estadísticas personales del recurso: horas/pacientes de la semana actual,
 * del mes, promedio de las últimas 4 semanas y serie para los gráficos.
 * El shape coincide exactamente con lo que espera ProductividadRecursoPage.
 */
export async function productividad(req, res) {
  const recursoId = req.params.id
  const recurso = await prisma.resource.findUnique({ where: { id: recursoId } })
  if (!recurso) throw errors.notFound('Recurso no encontrado')

  // Últimas 4 semanas (la más reciente primero) — solo las que ya iniciaron.
  // No incluir semanas futuras: distorsionarían el "promedio últimas 4".
  const semanas = await prisma.week.findMany({
    where: { startDate: { lte: new Date() } },
    orderBy: { startDate: 'desc' },
    take: 4,
  })

  // Horas asignadas + pacientes atendidos del recurso, por semana.
  //
  // Antes esto era un bucle con un findMany por semana (5 consultas para 4
  // semanas). Ahora es UNA consulta con `in` y el agrupado se hace en memoria;
  // además pedimos solo las columnas que se usan en lugar de traer la fila
  // entera con `include`.
  const asigs = semanas.length
    ? await prisma.assignment.findMany({
        where: {
          weekId: { in: semanas.map((s) => s.id) },
          OR: [{ resourceId: recursoId }, { assistantId: recursoId }],
          status: { not: 'cancelada' },
        },
        select: {
          weekId: true,
          startTime: true,
          endTime: true,
          execution: { select: { patientsSeen: true } },
        },
      })
    : []

  const acumulado = new Map(semanas.map((s) => [s.id, { horas: 0, pacientes: 0 }]))
  for (const a of asigs) {
    const acc = acumulado.get(a.weekId)
    if (!acc) continue
    acc.horas += horasEfectivasFranja(a.startTime, a.endTime, recurso.type)
    acc.pacientes += a.execution?.patientsSeen ?? 0
  }

  const porSemana = semanas.map((s) => {
    const acc = acumulado.get(s.id)
    return {
      startDate: s.startDate,
      horas: Math.round(acc.horas * 10) / 10,
      pacientes: acc.pacientes,
    }
  })

  // Rellenar hasta 4 elementos para que los gráficos siempre tengan serie completa
  while (porSemana.length < 4) {
    porSemana.push({ startDate: null, horas: 0, pacientes: 0 })
  }

  // porSemana[0] es la más reciente. Para los gráficos queremos orden cronológico:
  // [Sem -3, Sem -2, Sem -1, Actual]
  const cronologico = [...porSemana].reverse()
  const ultimas4 = cronologico.map((s, i) => ({
    week: i === cronologico.length - 1 ? 'Actual' : `Sem -${cronologico.length - 1 - i}`,
    horas: s.horas,
    pacientes: s.pacientes,
  }))

  const actual = porSemana[0]
  const horasMes = porSemana.reduce((acc, s) => acc + s.horas, 0)
  const pacientesMes = porSemana.reduce((acc, s) => acc + s.pacientes, 0)
  const promedioHoras = Math.round((horasMes / 4) * 10) / 10
  const promedioPacientes = Math.round(pacientesMes / 4)

  // Incentivo: solo aplica a optómetras (esquema mixto) — Levantamiento §3.2
  const incentivoAcumulado = recurso.payScheme === 'mixto'
    ? pacientesMes * 8000 // valor referencial por paciente
    : null

  res.json({
    current_week_hours: actual.horas,
    horas_mes: Math.round(horasMes * 10) / 10,
    pacientes_semana: actual.pacientes,
    pacientes_mes: pacientesMes,
    incentivo_acumulado: incentivoAcumulado,
    promedio_4_semanas: { horas: promedioHoras, pacientes: promedioPacientes },
    ultimas_4_semanas: ultimas4,
  })
}

/** GET /auxiliares/liberadas — auxiliares liberadas por ausencia confirmada de su médico */
export async function liberadas(req, res) {
  // Auxiliares cuyo médico tiene una asignación marcada 'sin_cobertura'
  const asignacionesSinCobertura = await prisma.assignment.findMany({
    where: { status: 'sin_cobertura', assistantId: { not: null } },
    select: { assistantId: true },
  })
  const idsLiberadas = [...new Set(asignacionesSinCobertura.map((a) => a.assistantId))]

  const liberadas = await prisma.resource.findMany({
    where: { id: { in: idsLiberadas }, active: true },
  })
  res.json(liberadas.map((r) => ({ ...r, statusBadge: 'liberada' })))
}
