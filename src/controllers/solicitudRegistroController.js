import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

/** Genera una contraseña provisional alfanumérica de 12 caracteres. */
function generarPasswordProvisional() {
  // 9 bytes base64 → ~12 chars seguros; sustituimos +/= para evitar confusión.
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12)
}

/**
 * GET /usuarios/solicitudes — Supervisor lista las solicitudes pendientes.
 * Filtros: estado (pendiente|aprobada|rechazada).
 */
export async function list(req, res) {
  const { estado } = req.query
  const where = estado ? { estado } : {}
  const list = await prisma.solicitudRegistro.findMany({
    where,
    orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  })
  res.json(list)
}

const rechazarSchema = z.object({
  motivo: z.string().min(5, 'El motivo es obligatorio (mínimo 5 caracteres)'),
})

/**
 * POST /usuarios/solicitudes/:id/aprobar — Supervisor aprueba:
 *   1) Crea Usuario con contraseña provisional aleatoria.
 *   2) Marca debeCambiarPassword=true para forzar cambio al 1er login.
 *   3) Si rol=recurso, crea también el Recurso con los datos solicitados.
 *   4) Vincula sedes solicitadas (UsuarioSede).
 *   5) Envía email al solicitante con la contraseña provisional y el link.
 */
export async function aprobar(req, res) {
  const sol = await prisma.solicitudRegistro.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.estado !== 'pendiente') throw errors.badRequest(`Esta solicitud ya está ${sol.estado}`)

  // Validar que el email no haya sido tomado entre tanto
  const yaUsado = await prisma.usuario.findUnique({ where: { email: sol.email } })
  if (yaUsado) throw errors.conflict('Ese email ya fue registrado por otro flujo. Rechaza la solicitud.')

  const passwordProv = generarPasswordProvisional()
  const passwordHash = await bcrypt.hash(passwordProv, 12)

  // Si rol = recurso, crear el Recurso (datos opcionales: si faltan, defaults razonables)
  let recursoId = null
  if (sol.rol === 'recurso') {
    if (!sol.tipoRecurso) throw errors.badRequest('La solicitud no especificó el tipo de recurso')
    const recurso = await prisma.recurso.create({
      data: {
        nombre: sol.nombre,
        tipo: sol.tipoRecurso,
        especialidad: sol.especialidad,
        horasMaxSemana: sol.horasMaxSemana ?? 42,
        horasMaxDia: sol.horasMaxDia ?? 10,
        esquemaPago: sol.esquemaPago ?? 'fijo',
        intervaloMinutos: sol.intervaloMinutos,
      },
    })
    recursoId = recurso.id
  }

  // Crear Usuario
  const usuario = await prisma.usuario.create({
    data: {
      nombre: sol.nombre,
      email: sol.email,
      celular: sol.celular,
      passwordHash,
      rol: sol.rol,
      recursoId,
      activo: true,
      debeCambiarPassword: true,
    },
  })

  // Vincular sedes solicitadas (solo si las hay y son válidas)
  const sedesSol = Array.isArray(sol.sedesSolicitadas) ? sol.sedesSolicitadas : []
  if (sedesSol.length > 0) {
    const sedesValidas = await prisma.sede.findMany({ where: { id: { in: sedesSol } }, select: { id: true } })
    if (sedesValidas.length > 0) {
      await prisma.usuarioSede.createMany({
        data: sedesValidas.map((s) => ({ usuarioId: usuario.id, sedeId: s.id })),
      })
    }
  }

  // Marcar la solicitud como aprobada
  await prisma.solicitudRegistro.update({
    where: { id: sol.id },
    data: {
      estado: 'aprobada',
      procesadoPor: req.user.id,
      procesadoEn: new Date(),
      usuarioCreadoId: usuario.id,
    },
  })

  // Email con la contraseña provisional + link al sistema
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]
  await enviarEmail({
    to: usuario.email,
    subject: '[SGRC] Tu cuenta fue aprobada',
    html: plantillaEmail(
      'Tu cuenta fue aprobada',
      `Hola ${usuario.nombre},<br><br>Tu solicitud de registro fue aprobada por el supervisor. Ingresa con tu email y la siguiente <strong>contraseña provisional</strong>:<br><br>
      <div style="font-size:18px;font-weight:600;padding:12px;background:#f4f4f5;border-radius:8px;letter-spacing:1px;text-align:center;font-family:monospace">${passwordProv}</div><br>
      <strong>Importante:</strong> al primer ingreso el sistema te pedirá que la cambies por una propia.`,
      origin,
      'Iniciar sesión'
    ),
    text: `Tu cuenta SGRC fue aprobada. Email: ${usuario.email} · Contraseña provisional: ${passwordProv}\nIngresa en ${origin} — al primer login te pedirá cambiarla.`,
  })

  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'aprobar_solicitud_registro',
    entidad: 'solicitudes_registro',
    entidadId: sol.id,
    valorNuevo: { usuarioCreado: usuario.id, rol: sol.rol },
    ipAddress: getIp(req),
  })

  res.status(200).json({ ok: true, usuarioId: usuario.id, message: 'Solicitud aprobada y email enviado con la contraseña provisional.' })
}

/**
 * POST /usuarios/solicitudes/:id/rechazar — Supervisor rechaza con motivo obligatorio.
 * Notifica por email al solicitante.
 */
export async function rechazar(req, res) {
  const { motivo } = rechazarSchema.parse(req.body)
  const sol = await prisma.solicitudRegistro.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound()
  if (sol.estado !== 'pendiente') throw errors.badRequest(`Esta solicitud ya está ${sol.estado}`)

  await prisma.solicitudRegistro.update({
    where: { id: sol.id },
    data: {
      estado: 'rechazada',
      motivoRechazo: motivo,
      procesadoPor: req.user.id,
      procesadoEn: new Date(),
    },
  })

  await enviarEmail({
    to: sol.email,
    subject: '[SGRC] Tu solicitud de registro fue rechazada',
    html: plantillaEmail(
      'Solicitud de registro rechazada',
      `Hola ${sol.nombre},<br><br>Lamentamos informarte que tu solicitud no fue aprobada.<br><br><strong>Motivo:</strong><br><em>${motivo}</em><br><br>Si crees que se trata de un error, comunícate con el área de tecnología.`,
    ),
    text: `Tu solicitud SGRC fue rechazada. Motivo: ${motivo}`,
  })

  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'rechazar_solicitud_registro',
    entidad: 'solicitudes_registro',
    entidadId: sol.id,
    valorNuevo: { motivo },
    ipAddress: getIp(req),
  })

  res.json({ ok: true })
}
