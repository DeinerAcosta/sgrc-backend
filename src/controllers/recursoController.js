import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { getSemanaActual } from '../lib/semana.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

const TIPOS = ['oftalmologo', 'optometra', 'anestesiologo', 'auxiliar', 'tecnico']
const ESQUEMAS = ['por_paciente', 'fijo', 'mixto']

// La especialidad de un consultorio determina qué tipo de recurso lo puede atender
const ESPECIALIDAD_A_TIPO = {
  oftalmologia: 'oftalmologo',
  optometria: 'optometra',
  anestesiologia: 'anestesiologo',
  diagnostico: 'tecnico',
}

const recursoSchema = z.object({
  nombre: z.string().min(1).max(150),
  tipo: z.enum(TIPOS),
  especialidad: z.string().max(100).optional().nullable(),
  intervaloMinutos: z.number().int().min(5).max(60).optional().nullable(),
  esquemaPago: z.enum(ESQUEMAS),
  horasMaxSemana: z.number().int().min(1).max(60).optional(),
  horasMaxDia: z.number().int().min(1).max(24).optional(),
  multiConsultorio: z.boolean().optional(),
  activo: z.boolean().optional(),
  motivoInactivacion: z.string().optional().nullable(),
})

// Helper: horas de una franja "HH:MM"–"HH:MM"
const horasFranja = (hi, hf) => {
  const [h1, m1] = hi.split(':').map(Number)
  const [h2, m2] = hf.split(':').map(Number)
  return ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60
}

/**
 * GET /recursos
 * Filtros: tipo, activo, especialidad_consultorio (→ mapea a tipo).
 * Enriquece cada recurso con horas_asignadas y es_horas_extras de la
 * semana abierta más reciente — esto alimenta el dashboard del coordinador.
 */
export async function list(req, res) {
  const { tipo, activo, especialidad_consultorio } = req.query
  const where = {}
  if (tipo) where.tipo = tipo
  if (especialidad_consultorio && ESPECIALIDAD_A_TIPO[especialidad_consultorio]) {
    where.tipo = ESPECIALIDAD_A_TIPO[especialidad_consultorio]
  }
  if (activo !== undefined) where.activo = activo === 'true'

  const recursos = await prisma.recurso.findMany({ where, orderBy: { nombre: 'asc' } })

  // Enriquecer con horas de la semana ACTUAL (la que contiene hoy)
  const semana = await getSemanaActual()

  if (!semana) {
    return res.json(recursos.map((r) => ({
      ...r,
      horasAsignadas: 0,
      horasSemanaActual: 0,
      esHorasExtras: false,
    })))
  }

  const asignaciones = await prisma.asignacion.findMany({
    where: { semanaId: semana.id, estado: { not: 'cancelada' } },
    select: { recursoId: true, auxiliarId: true, horaInicio: true, horaFin: true, estado: true },
  })

  // Auxiliares "liberadas" por RN-24: las que aparecen como auxiliarId
  // en alguna asignación con estado 'sin_cobertura'.
  const liberadas = new Set(
    asignaciones.filter((a) => a.estado === 'sin_cobertura' && a.auxiliarId).map((a) => a.auxiliarId)
  )

  const enriquecidos = recursos.map((r) => {
    const propias = asignaciones.filter((a) => a.recursoId === r.id || a.auxiliarId === r.id)
    const horas = propias.reduce((acc, a) => acc + horasFranja(a.horaInicio, a.horaFin), 0)
    return {
      ...r,
      horasAsignadas: Math.round(horas * 10) / 10,
      horasSemanaActual: Math.round(horas * 10) / 10,
      esHorasExtras: horas > r.horasMaxSemana,
      estadoBadge: liberadas.has(r.id) ? 'liberada' : null,
    }
  })

  res.json(enriquecidos)
}

export async function getById(req, res) {
  const r = await prisma.recurso.findUnique({ where: { id: req.params.id } })
  if (!r) throw errors.notFound()
  res.json(r)
}

export async function create(req, res) {
  const data = recursoSchema.parse(req.body)
  // RN-12: intervalo solo lo modifica supervisor (la ruta ya está protegida por rol)
  const r = await prisma.recurso.create({ data })
  res.status(201).json(r)
}

export async function update(req, res) {
  const data = recursoSchema.partial().parse(req.body)
  const anterior = await prisma.recurso.findUnique({ where: { id: req.params.id } })
  if (!anterior) throw errors.notFound()

  // RN-14: si se desactiva, las asignaciones futuras se mantienen (el coordinador las resuelve)
  const r = await prisma.recurso.update({ where: { id: req.params.id }, data })

  if (anterior.activo !== r.activo) {
    await registrarAuditoria({
      usuarioId: req.user.id,
      accion: r.activo ? 'activar_recurso' : 'desactivar_recurso',
      entidad: 'recursos',
      entidadId: r.id,
      valorAnterior: { activo: anterior.activo },
      valorNuevo: { activo: r.activo },
      motivo: data.motivoInactivacion,
      ipAddress: getIp(req),
    })
  }
  res.json(r)
}

/** GET /recursos/:id/horario?semana_id= — HU-R-02 */
export async function horario(req, res) {
  const { semana_id } = req.query
  const asignaciones = await prisma.asignacion.findMany({
    where: {
      semanaId: semana_id || undefined,
      OR: [{ recursoId: req.params.id }, { auxiliarId: req.params.id }],
      estado: { not: 'cancelada' },
    },
    include: {
      consultorio: { include: { sede: true } },
      recurso: true,
      auxiliar: true,
    },
    orderBy: [{ diaSemana: 'asc' }, { horaInicio: 'asc' }],
  })
  res.json(asignaciones)
}

/** GET /recursos/:id/ausencias — HU-R-06 historial de ausencias del recurso */
export async function ausenciasDelRecurso(req, res) {
  const list = await prisma.ausencia.findMany({
    where: { recursoId: req.params.id },
    include: { recurso: true },
    orderBy: { reportadoEn: 'desc' },
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
  const recurso = await prisma.recurso.findUnique({ where: { id: recursoId } })
  if (!recurso) throw errors.notFound('Recurso no encontrado')

  // Últimas 4 semanas (la más reciente primero) — solo las que ya iniciaron.
  // No incluir semanas futuras: distorsionarían el "promedio últimas 4".
  const semanas = await prisma.semana.findMany({
    where: { fechaInicio: { lte: new Date() } },
    orderBy: { fechaInicio: 'desc' },
    take: 4,
  })

  // Para cada semana: horas asignadas + pacientes atendidos del recurso
  const porSemana = []
  for (const s of semanas) {
    const asigs = await prisma.asignacion.findMany({
      where: {
        semanaId: s.id,
        OR: [{ recursoId }, { auxiliarId: recursoId }],
        estado: { not: 'cancelada' },
      },
      include: { ejecucion: true },
    })
    const horas = asigs.reduce((acc, a) => acc + horasFranja(a.horaInicio, a.horaFin), 0)
    const pacientes = asigs.reduce((acc, a) => acc + (a.ejecucion?.pacientesAtendidos ?? 0), 0)
    porSemana.push({
      fechaInicio: s.fechaInicio,
      horas: Math.round(horas * 10) / 10,
      pacientes,
    })
  }

  // Rellenar hasta 4 elementos para que los gráficos siempre tengan serie completa
  while (porSemana.length < 4) {
    porSemana.push({ fechaInicio: null, horas: 0, pacientes: 0 })
  }

  // porSemana[0] es la más reciente. Para los gráficos queremos orden cronológico:
  // [Sem -3, Sem -2, Sem -1, Actual]
  const cronologico = [...porSemana].reverse()
  const ultimas4 = cronologico.map((s, i) => ({
    semana: i === cronologico.length - 1 ? 'Actual' : `Sem -${cronologico.length - 1 - i}`,
    horas: s.horas,
    pacientes: s.pacientes,
  }))

  const actual = porSemana[0]
  const horasMes = porSemana.reduce((acc, s) => acc + s.horas, 0)
  const pacientesMes = porSemana.reduce((acc, s) => acc + s.pacientes, 0)
  const promedioHoras = Math.round((horasMes / 4) * 10) / 10
  const promedioPacientes = Math.round(pacientesMes / 4)

  // Incentivo: solo aplica a optómetras (esquema mixto) — Levantamiento §3.2
  const incentivoAcumulado = recurso.esquemaPago === 'mixto'
    ? pacientesMes * 8000 // valor referencial por paciente
    : null

  res.json({
    horas_semana_actual: actual.horas,
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
  const asignacionesSinCobertura = await prisma.asignacion.findMany({
    where: { estado: 'sin_cobertura', auxiliarId: { not: null } },
    select: { auxiliarId: true },
  })
  const idsLiberadas = [...new Set(asignacionesSinCobertura.map((a) => a.auxiliarId))]

  const liberadas = await prisma.recurso.findMany({
    where: { id: { in: idsLiberadas }, activo: true },
  })
  res.json(liberadas.map((r) => ({ ...r, estadoBadge: 'liberada' })))
}
