import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { titleCase } from '../lib/strings.js'
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
  const { status: estado } = req.query
  const where = estado ? { status: estado } : {}
  const list = await prisma.signupRequest.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  })
  res.json(list)
}

const rechazarSchema = z.object({
  reason: z.string().min(5, 'El motivo es obligatorio (mínimo 5 caracteres)'),
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
  const sol = await prisma.signupRequest.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound('Solicitud no encontrada')
  if (sol.status !== 'pendiente') throw errors.badRequest(`Esta solicitud ya está ${sol.status}`)

  // Validar que el email no haya sido tomado entre tanto
  const yaUsado = await prisma.user.findUnique({ where: { email: sol.email } })
  if (yaUsado) throw errors.conflict('Ese email ya fue registrado por otro flujo. Rechaza la solicitud.')

  const passwordProv = generarPasswordProvisional()
  const passwordHash = await bcrypt.hash(passwordProv, 12)

  // Si rol = recurso, crear el Recurso (datos opcionales: si faltan, defaults razonables)
  let recursoId = null
  if (sol.role === 'recurso') {
    if (!sol.resourceType) throw errors.badRequest('La solicitud no especificó el tipo de recurso')
    // Tipos por_paciente (oftalmólogo, fonoaudióloga): sin tope semanal por defecto.
    const TIPOS_POR_PACIENTE = new Set(['oftalmologo', 'fonoaudiologa'])
    const esPorPaciente = TIPOS_POR_PACIENTE.has(sol.resourceType)
    const recurso = await prisma.resource.create({
      data: {
        name: titleCase(sol.name),
        type: sol.resourceType,
        specialty: sol.specialty,
        maxHoursPerWeek: esPorPaciente ? null : (sol.maxHoursPerWeek ?? 44),
        maxHoursPerDay: sol.maxHoursPerDay ?? 10,
        payScheme: sol.payScheme ?? (esPorPaciente ? 'por_paciente' : 'fijo'),
        slotMinutes: sol.slotMinutes,
      },
    })
    recursoId = recurso.id
  }

  // Crear Usuario
  const usuario = await prisma.user.create({
    data: {
      name: titleCase(sol.name),
      email: sol.email,
      phone: sol.phone,
      passwordHash,
      role: sol.role,
      resourceId: recursoId,
      active: true,
      mustChangePassword: true,
    },
  })

  // Vincular sedes solicitadas (solo si las hay y son válidas)
  const sedesSol = Array.isArray(sol.requestedSites) ? sol.requestedSites : []
  if (sedesSol.length > 0) {
    const sedesValidas = await prisma.site.findMany({ where: { id: { in: sedesSol } }, select: { id: true } })
    if (sedesValidas.length > 0) {
      await prisma.userSite.createMany({
        data: sedesValidas.map((s) => ({ userId: usuario.id, siteId: s.id })),
      })
    }
  }

  // Marcar la solicitud como aprobada
  await prisma.signupRequest.update({
    where: { id: sol.id },
    data: {
      status: 'aprobada',
      processedBy: req.user.id,
      processedAt: new Date(),
      createdUserId: usuario.id,
    },
  })

  // Email con la contraseña provisional + link al sistema
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]
  await enviarEmail({
    to: usuario.email,
    subject: '[VIU · FOCA | SGRC] Tu solicitud de registro fue aprobada',
    html: plantillaEmail(
      `¡Bienvenido(a), ${usuario.name.split(' ')[0]}!`,
      `Tu solicitud de registro al <strong>Sistema de Gestión de Recursos Clínicos (SGRC)</strong> fue <strong>aprobada</strong> por el supervisor.<br><br>
      Usa las siguientes credenciales para iniciar sesión:<br><br>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0">
        <tr>
          <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px 8px 0 0;font-size:13px;color:#475569;width:130px">📧 Usuario / Email</td>
          <td style="padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb;border-left:none;border-radius:0 8px 0 0;font-family:monospace;font-size:14px;color:#0f172a">${usuario.email}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 0 8px;font-size:13px;color:#475569">🔑 Contraseña provisional</td>
          <td style="padding:10px 14px;background:#fff7ed;border:1px solid #fed7aa;border-top:none;border-left:none;border-radius:0 0 8px 0;font-family:monospace;font-weight:600;font-size:15px;color:#9a3412;letter-spacing:1px">${passwordProv}</td>
        </tr>
      </table>
      <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 12px;margin:14px 0;border-radius:0 6px 6px 0;font-size:13px;color:#78350f">
        ⚠️ <strong>Importante:</strong> esta contraseña es <strong>provisional</strong>. En tu primer ingreso el sistema te pedirá cambiarla por una propia.
      </div>
      ¡Gracias por ser parte del equipo COFCA!`,
      origin,
      'Iniciar sesión ahora'
    ),
    text: `SGRC — Tu solicitud fue aprobada

Credenciales:
  Usuario / Email:         ${usuario.email}
  Contraseña provisional:  ${passwordProv}

⚠️ IMPORTANTE: esta contraseña es PROVISIONAL. En tu primer ingreso el sistema te pedirá cambiarla.

Ingresa en: ${origin}`,
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'aprobar_solicitud_registro',
    entity: 'solicitudes_registro',
    entityId: sol.id,
    newValue: { usuarioCreado: usuario.id, role: sol.role },
    ipAddress: getIp(req),
  })

  res.status(200).json({ ok: true, userId: usuario.id, message: 'Solicitud aprobada y email enviado con la contraseña provisional.' })
}

/**
 * POST /usuarios/solicitudes/:id/rechazar — Supervisor rechaza con motivo obligatorio.
 * Notifica por email al solicitante.
 */
export async function rechazar(req, res) {
  const { reason: motivo } = rechazarSchema.parse(req.body)
  const sol = await prisma.signupRequest.findUnique({ where: { id: req.params.id } })
  if (!sol) throw errors.notFound()
  if (sol.status !== 'pendiente') throw errors.badRequest(`Esta solicitud ya está ${sol.status}`)

  await prisma.signupRequest.update({
    where: { id: sol.id },
    data: {
      status: 'rechazada',
      rejectionReason: motivo,
      processedBy: req.user.id,
      processedAt: new Date(),
    },
  })

  await enviarEmail({
    to: sol.email,
    subject: '[VIU · FOCA | SGRC] Tu solicitud de registro fue rechazada',
    html: plantillaEmail(
      'Solicitud de registro rechazada',
      `Hola ${sol.name},<br><br>Lamentamos informarte que tu solicitud no fue aprobada.<br><br><strong>Motivo:</strong><br><em>${motivo}</em><br><br>Si crees que se trata de un error, comunícate con el área de tecnología.`,
    ),
    text: `Tu solicitud SGRC fue rechazada. Motivo: ${motivo}`,
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'rechazar_solicitud_registro',
    entity: 'solicitudes_registro',
    entityId: sol.id,
    newValue: { reason: motivo },
    ipAddress: getIp(req),
  })

  res.json({ ok: true })
}
