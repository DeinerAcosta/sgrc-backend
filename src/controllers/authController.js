import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js'
import { errors } from '../lib/errors.js'
import { titleCase } from '../lib/strings.js'
import { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/auth.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { notificarSupervisores } from '../services/notificationService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { programacionLibre } from '../lib/schedulingMode.js'

/**
 * POST /auth/login
 * Especificación §3.1: bcrypt compare + JWT 8h + refresh token 7d.
 * Si las credenciales son incorrectas retorna 401 sin revelar cuál campo.
 */
export async function login(req, res) {
  const { email, password } = loginSchema.parse(req.body)

  const usuario = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { sites: { select: { site: true } }, resource: true },
  })

  if (!usuario || !usuario.active) {
    throw errors.unauthorized('Credenciales incorrectas')
  }
  const ok = await bcrypt.compare(password, usuario.passwordHash)
  if (!ok) {
    throw errors.unauthorized('Credenciales incorrectas')
  }

  const sedes = usuario.sites.map((s) => s.site.id)
  const sedesNombres = usuario.sites.map((s) => s.site.name)
  // recursoId en el JWT (ago-2026, Fase 3): permite scoping por recurso en el
  // backend sin tener que hacer lookup en cada request. Antes estaba solo en
  // el user object del response, y controllers que usaban req.user.recursoId
  // (ausenciaController.list, reposicionController) rompían silenciosamente
  // para el rol=recurso.
  const payload = { id: usuario.id, role: usuario.role, sites: sedes, resourceId: usuario.resourceId ?? null }
  const token = signAccessToken(payload)
  const refreshToken = signRefreshToken({ id: usuario.id })

  await prisma.user.update({
    where: { id: usuario.id },
    data: { lastLoginAt: new Date() },
  })

  res.json({
    token,
    refreshToken,
    user: {
      id: usuario.id,
      name: usuario.name,
      email: usuario.email,
      phone: usuario.phone,
      role: usuario.role,
      resource_id: usuario.resourceId,
      type: usuario.resource?.type,
      specialty: usuario.resource?.specialty,
      pay_scheme: usuario.resource?.payScheme,
      max_hours_per_week: usuario.resource?.maxHoursPerWeek,
      must_change_password: usuario.mustChangePassword,
      sites: sedes,
      site_names: sedesNombres,
      // Ver comentario en me(): el frontend espera esta pareja id+nombre.
      sites_info: usuario.sites.map((s) => ({ id: s.site.id, name: s.site.name })),
      free_scheduling: programacionLibre(),
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

  const usuario = await prisma.user.findUnique({
    where: { id: decoded.id },
    include: { sites: { select: { siteId: true } } },
  })
  if (!usuario || !usuario.active) throw errors.unauthorized()

  const sedes = usuario.sites.map((s) => s.siteId)
  const token = signAccessToken({
    id: usuario.id, role: usuario.role, sites: sedes,
    resourceId: usuario.resourceId ?? null,
  })
  res.json({ token })
}

/**
 * POST /auth/forgot-password — HU-R-09
 * Genera un token de recuperación válido por 1 hora y envía el enlace por email.
 * Nunca revela si el correo existe (seguridad).
 */
export async function forgotPassword(req, res) {
  const { email } = forgotPasswordSchema.parse(req.body)
  const usuario = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })

  if (usuario && usuario.active) {
    // Invalidar tokens previos sin usar
    await prisma.passwordReset.updateMany({
      where: { userId: usuario.id, used: false },
      data: { used: true },
    })

    const token = crypto.randomBytes(32).toString('hex')
    const expiraEn = new Date(Date.now() + 60 * 60 * 1000) // 1 hora

    await prisma.passwordReset.create({
      data: { userId: usuario.id, token, expiresAt: expiraEn },
    })

    const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]
    const enlace = `${origin}/reset-password?token=${token}`

    await enviarEmail({
      to: usuario.email,
      subject: '[VIU · FOCA | SGRC] Recuperación de contraseña',
      html: plantillaEmail(
        'Recuperación de contraseña',
        `Hola ${usuario.name},<br><br>Recibimos una solicitud para restablecer tu contraseña. El enlace es válido por <strong>1 hora</strong>. Si no lo solicitaste, ignora este correo.`,
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
    include: { user: true },
  })

  if (!reset || reset.used) {
    throw errors.badRequest('El enlace de recuperación no es válido o ya fue usado')
  }
  if (reset.expiresAt < new Date()) {
    throw errors.badRequest('El enlace de recuperación expiró. Solicita uno nuevo.')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.$transaction([
    prisma.user.update({
      where: { id: reset.userId },
      data: { passwordHash },
    }),
    prisma.passwordReset.update({
      where: { id: reset.id },
      data: { used: true },
    }),
  ])

  await registrarAuditoria({
    userId: reset.userId,
    action: 'reset_password',
    entity: 'usuarios',
    entityId: reset.userId,
    ipAddress: getIp(req),
  })

  res.json({ message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' })
}

/** GET /usuarios/me */
export async function me(req, res) {
  const usuario = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { sites: { select: { site: true } }, resource: true },
  })
  if (!usuario) throw errors.notFound()
  res.json({
    id: usuario.id,
    name: usuario.name,
    email: usuario.email,
    phone: usuario.phone,
    role: usuario.role,
    resource_id: usuario.resourceId,
    type: usuario.resource?.type,
    specialty: usuario.resource?.specialty,
    pay_scheme: usuario.resource?.payScheme,
    max_hours_per_week: usuario.resource?.maxHoursPerWeek,
    must_change_password: usuario.mustChangePassword,
    sites: usuario.sites.map((s) => s.site.id),
    site_names: usuario.sites.map((s) => s.site.name),
    // ProgramadorPage lee `user.sedes_info` para mostrar el nombre de la sede
    // activa, pero nadie la emitía: la expresión caía siempre en el fallback
    // "tu sede". Se envía la pareja id+nombre, que es lo que espera.
    sites_info: usuario.sites.map((s) => ({ id: s.site.id, name: s.site.name })),
    // Modo temporal de programación libre. Viaja en la sesión para que el
    // frontend no deshabilite por su cuenta lo que el backend ya permite: si la
    // restricción solo se levantara en el servidor, el coordinador seguiría
    // viendo los botones apagados y el cambio no serviría de nada.
    free_scheduling: programacionLibre(),
  })
}

// ============ REGISTRO PÚBLICO + CAMBIO DE CONTRASEÑA ============

// Convierte "" → undefined antes de validar (campos opcionales no rompen con string vacía).
const emptyToUndef = (v) => (v === '' ? undefined : v)

const registroSchema = z.object({
  name: z.string().min(3).max(150),
  email: z.string().email().max(200),
  phone: z.preprocess(emptyToUndef, z.string().max(20).optional().nullable()),
  role: z.enum(['recurso', 'coordinador', 'directivo']),
  // Datos opcionales si es recurso (los validamos en el servicio cuando aprueben)
  resourceType: z.preprocess(emptyToUndef, z.enum(['oftalmologo','optometra','anestesiologo','asesor_servicios','auxiliar','tecnico']).optional().nullable()),
  specialty: z.preprocess(emptyToUndef, z.string().max(100).optional().nullable()),
  maxHoursPerWeek: z.preprocess(emptyToUndef, z.number().int().min(1).max(60).optional().nullable()),
  maxHoursPerDay: z.preprocess(emptyToUndef, z.number().int().min(1).max(24).optional().nullable()),
  payScheme: z.preprocess(emptyToUndef, z.enum(['por_paciente','fijo','mixto']).optional().nullable()),
  slotMinutes: z.preprocess(emptyToUndef, z.number().int().min(5).max(60).optional().nullable()),
  requestedSites: z.array(z.string().uuid()).optional().nullable(),
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
  const usuarioYaExiste = await prisma.user.findUnique({ where: { email } })
  if (usuarioYaExiste) {
    return res.status(202).json({ message: 'Si los datos son válidos, recibirás una respuesta por email.' })
  }
  const yaPendiente = await prisma.signupRequest.findFirst({
    where: { email, status: 'pendiente' },
  })
  if (yaPendiente) {
    return res.status(202).json({ message: 'Ya tienes una solicitud pendiente. El supervisor la revisará.' })
  }

  const sol = await prisma.signupRequest.create({
    data: {
      name: titleCase(data.name),
      email,
      phone: data.phone,
      role: data.role,
      resourceType: data.resourceType,
      specialty: data.specialty,
      maxHoursPerWeek: data.maxHoursPerWeek,
      maxHoursPerDay: data.maxHoursPerDay,
      payScheme: data.payScheme,
      slotMinutes: data.slotMinutes,
      requestedSites: data.requestedSites ?? [],
    },
  })

  // Avisar al supervisor (app + email) para que la revise
  const FRONT = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'
  const ROLES_LABEL = { resource: 'Recurso (personal asistencial/administrativo)', coordinador: 'Coordinador de sede', directivo: 'Directivo', supervisor: 'Supervisor' }
  const TIPOS_LABEL = { oftalmologo: 'Oftalmólogo', anestesiologo: 'Anestesiólogo', optometra: 'Optómetra', assistant: 'Auxiliar de enfermería', tecnico: 'Técnico de diagnóstico', asesor_servicios: 'Asesor de servicios' }
  await notificarSupervisores({
    type: 'solicitud_registro',
    title: `Nueva solicitud de registro: ${titleCase(data.name)}`,
    message: `<p>Una persona realizó una solicitud de registro a través del portal público del SGRC y requiere tu aprobación para acceder al sistema. La cuenta queda inactiva hasta que la apruebes o rechaces.</p>
    <p>Al aprobar la solicitud, el sistema generará automáticamente una contraseña provisional y enviará las credenciales por correo al solicitante.</p>`,
    contexto: 'Acción requerida del módulo de Usuarios — Solicitudes pendientes',
    criticidad: 'media',
    referenceId: sol.id,
    detalles: [
      ['Nombre completo',   titleCase(data.name)],
      ['Correo electrónico', data.email],
      ['Celular',           data.phone || '(no informado)'],
      ['Rol solicitado',    ROLES_LABEL[data.role] ?? data.role],
      ...(data.resourceType ? [['Tipo de recurso', TIPOS_LABEL[data.resourceType] ?? data.resourceType]] : []),
      ...(data.specialty ? [['Subespecialidad', data.specialty]] : []),
      ['Fecha de solicitud', new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' })],
      ['Estado',            'Pendiente de revisión'],
    ],
    accionUrl: `${FRONT}/app/admin/solicitudes`,
    accionTexto: 'Revisar solicitud',
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
  const usuario = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!usuario) throw errors.notFound()

  const ok = await bcrypt.compare(passwordActual, usuario.passwordHash)
  if (!ok) throw errors.badRequest('La contraseña actual no coincide')

  const nueva = await bcrypt.hash(passwordNueva, 12)
  await prisma.user.update({
    where: { id: usuario.id },
    data: { passwordHash: nueva, mustChangePassword: false },
  })

  await registrarAuditoria({
    userId: usuario.id,
    action: 'cambiar_password',
    entity: 'usuarios',
    entityId: usuario.id,
    ipAddress: getIp(req),
  })

  res.json({ ok: true, message: 'Contraseña actualizada correctamente.' })
}
