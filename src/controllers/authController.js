import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js'
import { errors } from '../lib/errors.js'
import { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/auth.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { notificarSupervisores } from '../services/notificacionService.js'
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
      debe_cambiar_password: usuario.debeCambiarPassword,
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
    debe_cambiar_password: usuario.debeCambiarPassword,
    sedes: usuario.sedes.map((s) => s.sede.id),
    sedes_nombres: usuario.sedes.map((s) => s.sede.nombre),
  })
}

// ============ REGISTRO PÚBLICO + CAMBIO DE CONTRASEÑA ============

const registroSchema = z.object({
  nombre: z.string().min(3).max(150),
  email: z.string().email().max(200),
  celular: z.string().max(20).optional().nullable(),
  rol: z.enum(['recurso', 'coordinador', 'directivo']),
  // Datos opcionales si es recurso (los validamos en el servicio cuando aprueben)
  tipoRecurso: z.enum(['oftalmologo','optometra','anestesiologo','auxiliar','tecnico']).optional().nullable(),
  especialidad: z.string().max(100).optional().nullable(),
  horasMaxSemana: z.number().int().min(1).max(60).optional().nullable(),
  horasMaxDia: z.number().int().min(1).max(24).optional().nullable(),
  esquemaPago: z.enum(['por_paciente','fijo','mixto']).optional().nullable(),
  intervaloMinutos: z.number().int().min(5).max(60).optional().nullable(),
  sedesSolicitadas: z.array(z.string().uuid()).optional().nullable(),
})

/**
 * POST /auth/registro (PÚBLICO) — el empleado se autorregistra; queda en
 * estado 'pendiente' hasta que el supervisor lo apruebe. No crea el Usuario
 * todavía, solo una SolicitudRegistro. Notifica a los supervisores.
 */
export async function registro(req, res) {
  const data = registroSchema.parse(req.body)
  const email = data.email.toLowerCase()

  // Evitar registros duplicados (email ya en uso o solicitud pendiente)
  const usuarioYaExiste = await prisma.usuario.findUnique({ where: { email } })
  if (usuarioYaExiste) {
    return res.status(202).json({ message: 'Si los datos son válidos, recibirás una respuesta por email.' })
  }
  const yaPendiente = await prisma.solicitudRegistro.findFirst({
    where: { email, estado: 'pendiente' },
  })
  if (yaPendiente) {
    return res.status(202).json({ message: 'Ya tienes una solicitud pendiente. El supervisor la revisará.' })
  }

  const sol = await prisma.solicitudRegistro.create({
    data: {
      nombre: data.nombre,
      email,
      celular: data.celular,
      rol: data.rol,
      tipoRecurso: data.tipoRecurso,
      especialidad: data.especialidad,
      horasMaxSemana: data.horasMaxSemana,
      horasMaxDia: data.horasMaxDia,
      esquemaPago: data.esquemaPago,
      intervaloMinutos: data.intervaloMinutos,
      sedesSolicitadas: data.sedesSolicitadas ?? [],
    },
  })

  // Avisar al supervisor (app + email) para que la revise
  await notificarSupervisores({
    tipo: 'solicitud_registro',
    titulo: 'Nueva solicitud de registro',
    mensaje: `${data.nombre} (${data.email}) solicita registrarse como ${data.rol}. Revísala en Usuarios → Solicitudes pendientes.`,
    criticidad: 'media',
    referenciaId: sol.id,
  })

  res.status(201).json({ ok: true, id: sol.id, message: 'Solicitud enviada. Recibirás un email cuando el supervisor la apruebe.' })
}

const cambiarPasswordSchema = z.object({
  passwordActual: z.string().min(1),
  passwordNueva: z.string().min(8).max(80),
})

/**
 * POST /auth/cambiar-password (autenticado) — usado por el flujo de "cambio
 * obligatorio al primer ingreso" (debeCambiarPassword=true). También sirve
 * para cambios voluntarios.
 */
export async function cambiarPassword(req, res) {
  const { passwordActual, passwordNueva } = cambiarPasswordSchema.parse(req.body)
  const usuario = await prisma.usuario.findUnique({ where: { id: req.user.id } })
  if (!usuario) throw errors.notFound()

  const ok = await bcrypt.compare(passwordActual, usuario.passwordHash)
  if (!ok) throw errors.badRequest('La contraseña actual no coincide')

  const nueva = await bcrypt.hash(passwordNueva, 12)
  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { passwordHash: nueva, debeCambiarPassword: false },
  })

  await registrarAuditoria({
    usuarioId: usuario.id,
    accion: 'cambiar_password',
    entidad: 'usuarios',
    entidadId: usuario.id,
    ipAddress: getIp(req),
  })

  res.json({ ok: true, message: 'Contraseña actualizada correctamente.' })
}
