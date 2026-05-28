import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { differenceInDays, parseISO, format } from 'date-fns'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { notificar, notificarCoordinadoresDeSede, notificarSupervisores, notificarDirectivos } from '../services/notificacionService.js'
import { calcularImpacto, liberarAuxiliaresSiAplica } from '../services/ausenciaService.js'

const TIPOS = ['enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion', 'licencia_remunerada', 'licencia_no_remunerada', 'otra']

const crearSchema = z.object({
  recursoId: z.string().uuid(),
  fechaInicio: z.string(),
  fechaFin: z.string().optional(),
  esParcial: z.boolean().optional(),
  horaInicioAusencia: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  horaFinAusencia: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tipo: z.enum(TIPOS),
  motivo: z.string().optional(),
  registradoPorCoordinador: z.boolean().optional(),
})

const confirmarSchema = z.object({
  notaCoordinador: z.string().optional(),
})

const rechazarSchema = z.object({
  motivo: z.string().min(5, 'El motivo es obligatorio (mín 5 caracteres)'),
})

export async function list(req, res) {
  const { estado, recurso_id, sede_id } = req.query
  const where = {}
  if (estado) where.estado = estado
  if (recurso_id) where.recursoId = recurso_id

  const list = await prisma.ausencia.findMany({
    where,
    include: { recurso: true },
    orderBy: { reportadoEn: 'desc' },
  })
  res.json(list)
}

export async function create(req, res) {
  const data = crearSchema.parse(req.body)
  const fechaInicio = parseISO(data.fechaInicio)
  const fechaFin = data.fechaFin ? parseISO(data.fechaFin) : fechaInicio
  const anticipacionDias = differenceInDays(fechaInicio, new Date())

  const ausencia = await prisma.ausencia.create({
    data: {
      recursoId: data.recursoId,
      fechaInicio,
      fechaFin,
      esParcial: data.esParcial ?? false,
      horaInicioAusencia: data.horaInicioAusencia,
      horaFinAusencia: data.horaFinAusencia,
      tipo: data.tipo,
      motivo: data.motivo,
      esProgramada: anticipacionDias >= 2,
      anticipacionDias: Math.max(0, anticipacionDias),
      registradoPorCoordinador: data.registradoPorCoordinador ?? false,
      reportadoPor: req.user.id,
    },
    include: { recurso: true },
  })

  if (data.registradoPorCoordinador) {
    await registrarAuditoria({
      usuarioId: req.user.id,
      accion: 'registrar_ausencia_por_recurso',
      entidad: 'ausencias',
      entidadId: ausencia.id,
      valorNuevo: { recursoId: data.recursoId, tipo: data.tipo },
      ipAddress: getIp(req),
    })
  }

  // Levantamiento §9: al registrar una ausencia notificamos por App + Email
  // (y WhatsApp para los coordinadores, criticidad alta) a TRES destinatarios:
  //   1) Al recurso mismo: confirmación de que su ausencia quedó registrada.
  //   2) A los coordinadores de las sedes donde tiene asignaciones.
  //   3) A los supervisores activos (para visibilidad de gestión).
  const asigsRecurso = await prisma.asignacion.findMany({
    where: {
      OR: [{ recursoId: data.recursoId }, { auxiliarId: data.recursoId }],
      estado: { not: 'cancelada' },
    },
    include: { consultorio: { select: { sedeId: true } } },
  })
  const sedeIds = [...new Set(asigsRecurso.map((a) => a.consultorio.sedeId))]
  const fechaTxt = format(fechaInicio, 'd MMM yyyy')

  // 1) Al recurso (si está vinculado a un usuario)
  const usuarioRecurso = await prisma.usuario.findUnique({
    where: { recursoId: data.recursoId },
  })
  if (usuarioRecurso) {
    await notificar({
      usuarioId: usuarioRecurso.id,
      tipo: 'ausencia_reportada',
      titulo: 'Se registró tu ausencia',
      mensaje: `Quedó registrada una ausencia (${data.tipo}) para el ${fechaTxt}. Te avisaremos por correo cuando el coordinador la confirme.`,
      criticidad: 'media',
      referenciaId: ausencia.id,
    })
  }

  // 2) Coordinadores de cada sede afectada (crit. alta → app + email + whatsapp)
  for (const sedeId of sedeIds) {
    await notificarCoordinadoresDeSede(sedeId, {
      tipo: 'ausencia_reportada',
      titulo: `Ausencia reportada — ${ausencia.recurso.nombre}`,
      mensaje: `${ausencia.recurso.nombre} reportó una ausencia (${data.tipo}) para el ${fechaTxt}. Revísala y confírmala para registrar el impacto.`,
      criticidad: 'alta',
      referenciaId: ausencia.id,
    })
  }

  // 3) Supervisores activos (crit. media → app + email)
  await notificarSupervisores({
    tipo: 'ausencia_reportada',
    titulo: `Ausencia registrada — ${ausencia.recurso.nombre}`,
    mensaje: `Se registró una ausencia (${data.tipo}) para ${ausencia.recurso.nombre} el ${fechaTxt}. Está en revisión por el coordinador.`,
    criticidad: 'media',
    referenciaId: ausencia.id,
  })

  // 4) Directivos activos (crit. media → app + email; no WhatsApp para directivos)
  await notificarDirectivos({
    tipo: 'ausencia_reportada',
    titulo: `Ausencia — ${ausencia.recurso.nombre}`,
    mensaje: `Se registró una ausencia (${data.tipo}) para ${ausencia.recurso.nombre} (${ausencia.recurso.tipo}) el ${fechaTxt}.`,
    criticidad: 'media',
    referenciaId: ausencia.id,
  })

  res.status(201).json(ausencia)
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
  return prisma.$transaction(async (tx) => {
    const ausencia = await tx.ausencia.findUnique({
      where: { id: req.params.id },
      include: { recurso: true },
    })
    if (!ausencia) throw errors.notFound()
    if (ausencia.estado !== 'pendiente') throw errors.badRequest('La ausencia ya fue procesada')

    const { fechas, pacImpactados, costoOportunidad, impactoPorDia } = await calcularImpacto(tx, ausencia)
    await liberarAuxiliaresSiAplica(tx, ausencia, fechas)

    const actualizada = await tx.ausencia.update({
      where: { id: req.params.id },
      data: {
        estado: 'confirmada',
        pacientesImpactados: pacImpactados,
        costoOportunidad,
        impactoPorDia,
        accionTomada: notaCoordinador,
        confirmadoPor: req.user.id,
        confirmadoEn: new Date(),
      },
      include: { recurso: true },
    })

    // HU-C-05: notificación al recurso fuera de la tx (usa su propia conexión)
    const usuarioRecurso = await tx.usuario.findUnique({
      where: { recursoId: ausencia.recursoId },
    })
    if (usuarioRecurso) {
      setImmediate(() =>
        notificar({
          usuarioId: usuarioRecurso.id,
          tipo: 'ausencia_confirmada',
          titulo: 'Tu ausencia fue confirmada',
          mensaje: `El coordinador confirmó tu ausencia. Impacto registrado: ${pacImpactados} pacientes afectados.`,
          criticidad: 'media',
          referenciaId: actualizada.id,
        }),
      )
    }

    return res.json(actualizada)
  })
}

/** RN-20: motivo obligatorio */
export async function rechazar(req, res) {
  const { motivo } = rechazarSchema.parse(req.body)
  const actualizada = await prisma.ausencia.update({
    where: { id: req.params.id },
    data: { estado: 'rechazada', motivoRechazo: motivo },
    include: { recurso: true },
  })
  res.json(actualizada)
}
