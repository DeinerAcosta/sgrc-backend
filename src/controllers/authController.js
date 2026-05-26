import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js'
import { errors } from '../lib/errors.js'
import { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/auth.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

/**
 * POST /auth/login
 * Especificación §3.1: bcrypt compare + JWT 8h + refresh token 7d.
 * Si las credenciales son incorrectas retorna 401 sin revelar cuál campo.
 */
export async function login(req, res) {
  const { email, password } = loginSchema.parse(req.body)

  const usuario = await prisma.usuario.findUnique({
    where: { email: email.toLowerCase() },
    include: { sedes: { select: { sede: true } }, recurso: true },
  })

  if (!usuario || !usuario.activo) {
    throw errors.unauthorized('Credenciales incorrectas')
  }
  const ok = await bcrypt.compare(password, usuario.passwordHash)
  if (!ok) {
    throw errors.unauthorized('Credenciales incorrectas')
  }

  const sedes = usuario.sedes.map((s) => s.sede.id)
  const sedesNombres = usuario.sedes.map((s) => s.sede.nombre)
  const payload = { id: usuario.id, rol: usuario.rol, sedes }
  const token = signAccessToken(payload)
  const refreshToken = signRefreshToken({ id: usuario.id })

  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { ultimoLogin: new Date() },
  })

  res.json({
    token,
    refreshToken,
    user: {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      celular: usuario.celular,
      rol: usuario.rol,
      recurso_id: usuario.recursoId,
      tipo: usuario.recurso?.tipo,
      especialidad: usuario.recurso?.especialidad,
      esquema_pago: usuario.recurso?.esquemaPago,
      horas_max_semana: usuario.recurso?.horasMaxSemana,
      sedes,
      sedes_nombres: sedesNombres,
    },
  })
}

/** POST /auth/refresh — emite un nuevo access token usando el refresh */
export async function refresh(req, res) {
  const { refreshToken } = refreshSchema.parse(req.body)
  let decoded
  try {
    decoded = verifyRefreshToken(refreshToken)
  } catch {
    throw errors.unauthorized('Refresh token inválido o expirado')
  }

  const usuario = await prisma.usuario.findUnique({
    where: { id: decoded.id },
    include: { sedes: { select: { sedeId: true } } },
  })
  if (!usuario || !usuario.activo) throw errors.unauthorized()

  const sedes = usuario.sedes.map((s) => s.sedeId)
  const token = signAccessToken({ id: usuario.id, rol: usuario.rol, sedes })
  res.json({ token })
}

/**
 * POST /auth/forgot-password — HU-R-09
 * Genera un token de recuperación válido por 1 hora y envía el enlace por email.
 * Nunca revela si el correo existe (seguridad).
 */
export async function forgotPassword(req, res) {
  const { email } = forgotPasswordSchema.parse(req.body)
  const usuario = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } })

  if (usuario && usuario.activo) {
    // Invalidar tokens previos sin usar
    await prisma.passwordReset.updateMany({
      where: { usuarioId: usuario.id, usado: false },
      data: { usado: true },
    })

    const token = crypto.randomBytes(32).toString('hex')
    const expiraEn = new Date(Date.now() + 60 * 60 * 1000) // 1 hora

    await prisma.passwordReset.create({
      data: { usuarioId: usuario.id, token, expiraEn },
    })

    const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]
    const enlace = `${origin}/reset-password?token=${token}`

    await enviarEmail({
      to: usuario.email,
      subject: '[SGRC] Recuperación de contraseña',
      html: plantillaEmail(
        'Recuperación de contraseña',
        `Hola ${usuario.nombre},<br><br>Recibimos una solicitud para restablecer tu contraseña. El enlace es válido por <strong>1 hora</strong>. Si no lo solicitaste, ignora este correo.`,
        enlace,
        'Restablecer contraseña'
      ),
      text: `Recupera tu contraseña en: ${enlace} (válido 1 hora)`,
    })
  }

  res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación en breve.' })
}

/**
 * POST /auth/reset-password — HU-R-09
 * Valida el token y establece la nueva contraseña. El token se invalida tras usarse.
 */
export async function resetPassword(req, res) {
  const { token, password } = resetPasswordSchema.parse(req.body)

  const reset = await prisma.passwordReset.findUnique({
    where: { token },
    include: { usuario: true },
  })

  if (!reset || reset.usado) {
    throw errors.badRequest('El enlace de recuperación no es válido o ya fue usado')
  }
  if (reset.expiraEn < new Date()) {
    throw errors.badRequest('El enlace de recuperación expiró. Solicita uno nuevo.')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.$transaction([
    prisma.usuario.update({
      where: { id: reset.usuarioId },
      data: { passwordHash },
    }),
    prisma.passwordReset.update({
      where: { id: reset.id },
      data: { usado: true },
    }),
  ])

  await registrarAuditoria({
    usuarioId: reset.usuarioId,
    accion: 'reset_password',
    entidad: 'usuarios',
    entidadId: reset.usuarioId,
    ipAddress: getIp(req),
  })

  res.json({ message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' })
}

/** GET /usuarios/me */
export async function me(req, res) {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.user.id },
    include: { sedes: { select: { sede: true } }, recurso: true },
  })
  if (!usuario) throw errors.notFound()
  res.json({
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    celular: usuario.celular,
    rol: usuario.rol,
    recurso_id: usuario.recursoId,
    tipo: usuario.recurso?.tipo,
    especialidad: usuario.recurso?.especialidad,
    esquema_pago: usuario.recurso?.esquemaPago,
    horas_max_semana: usuario.recurso?.horasMaxSemana,
    sedes: usuario.sedes.map((s) => s.sede.id),
    sedes_nombres: usuario.sedes.map((s) => s.sede.nombre),
  })
}
