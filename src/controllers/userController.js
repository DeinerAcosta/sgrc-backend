import { z } from 'zod'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { titleCase } from '../lib/strings.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { invalidarUsuarioEnCache } from '../middleware/auth.js'

const ROLES = ['recurso', 'coordinador', 'directivo', 'supervisor', 'gerencia']
const TIPOS_RECURSO_VALIDOS = ['oftalmologo', 'optometra', 'anestesiologo', 'asesor_servicios', 'auxiliar', 'tecnico', 'fonoaudiologa']
// Tipos cuyo esquema de pago es "por paciente": sin tope semanal contractual,
// sin subespecialidad ni multi-consultorio. Hoy son oftalmólogo y fonoaudióloga.
const TIPOS_POR_PACIENTE = new Set(['oftalmologo', 'fonoaudiologa'])

// Contraseña por defecto cuando se crea desde el formulario admin (sin pedirla).
// Igual que el resto de usuarios cargados en lote para evitar inconsistencias.
const DEFAULT_PASSWORD = 'SGRC2026!'

// Convierte strings vacías ("") a undefined ANTES de validar.
// Sin esto, un campo opcional que llega como "" rompe los validadores .email(), .uuid(), etc.
const emptyToUndef = (v) => (v === '' ? undefined : v)

const crearUsuarioSchema = z.object({
  name: z.string().min(1).max(150),
  email: z.string().email().max(200),
  phone: z.preprocess(emptyToUndef, z.string().max(20).optional().nullable()),
  password: z.preprocess(emptyToUndef, z.string().min(8).optional()),
  role: z.enum(ROLES),
  resourceId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  active: z.boolean().optional(),
  sites: z.array(z.string().uuid()).optional(),
  // Datos del recurso vinculado (cuando rol = 'recurso'): tipo, especialidad,
  // líder. Sin esto Zod estripa los campos y create() no puede crear el recurso.
  resourceType: z.preprocess(emptyToUndef, z.enum(TIPOS_RECURSO_VALIDOS).optional()),
  leadCoordinatorId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  specialty: z.preprocess(emptyToUndef, z.string().max(100).optional().nullable()),
  reason: z.preprocess(emptyToUndef, z.string().optional()),
})

const editarUsuarioSchema = z.object({
  name: z.preprocess(emptyToUndef, z.string().min(1).max(150).optional()),
  email: z.preprocess(emptyToUndef, z.string().email().optional()),
  phone: z.preprocess(emptyToUndef, z.string().max(20).optional().nullable()),
  password: z.preprocess(emptyToUndef, z.string().min(8).optional()),
  role: z.preprocess(emptyToUndef, z.enum(ROLES).optional()),
  resourceId: z.preprocess(emptyToUndef, z.string().uuid().optional().nullable()),
  active: z.boolean().optional(),
  sites: z.array(z.string().uuid()).optional(),
  leadCoordinatorId: z.preprocess(emptyToUndef, z.string().uuid().nullable().optional()),
  // Tipo del recurso vinculado — supervisor lo puede corregir si el usuario se equivocó
  // (ej. registró como auxiliar pero realmente es técnico)
  resourceType: z.preprocess(emptyToUndef, z.enum(TIPOS_RECURSO_VALIDOS).optional()),
  reason: z.preprocess(emptyToUndef, z.string().optional()),
})

const SELECT_PUBLIC = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  resourceId: true,
  active: true,
  lastLoginAt: true,
  lastSeenAt: true,
  credentialsResentAt: true,
  createdAt: true,
  sites: { select: { siteId: true } },
}

/** Genera contraseña provisional alfanumérica de 12 caracteres. */
function generarPasswordProvisional() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12)
}

// El schema es laxo en email/rol/tipo para que UNA fila mala no rebote todo el
// batch. La validación específica de cada fila vive dentro del loop, así
// reportamos error por fila y seguimos con las demás.
const bulkSchema = z.object({
  users: z.array(z.object({
    name: z.preprocess(emptyToUndef, z.string().optional().nullable()),
    email: z.preprocess(emptyToUndef, z.string().optional().nullable()),
    phone: z.preprocess(emptyToUndef, z.string().max(20).optional().nullable()),
    role: z.preprocess(emptyToUndef, z.string().optional().nullable()),
    resourceType: z.preprocess(emptyToUndef, z.string().optional().nullable()),
    specialty: z.preprocess(emptyToUndef, z.string().max(100).optional().nullable()),
    maxHoursPerWeek: z.preprocess(emptyToUndef, z.number().int().min(1).max(60).optional().nullable()),
    maxHoursPerDay: z.preprocess(emptyToUndef, z.number().int().min(1).max(24).optional().nullable()),
    payScheme: z.preprocess(emptyToUndef, z.string().optional().nullable()),
    slotMinutes: z.preprocess(emptyToUndef, z.number().int().min(5).max(60).optional().nullable()),
    sites: z.array(z.string()).optional().nullable(),
  })).min(1).max(500),
})

const ROLES_VALIDOS = new Set(['recurso', 'coordinador', 'directivo', 'supervisor', 'gerencia'])
const TIPOS_VALIDOS = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'asesor_servicios', 'auxiliar', 'tecnico', 'fonoaudiologa'])
const ESQUEMAS_VALIDOS = new Set(['por_paciente', 'fijo', 'mixto'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * POST /usuarios/bulk — carga masiva en una sola request.
 *
 * Por cada fila del array:
 *   - Valida que el email no exista (sino devuelve error en esa fila, sigue con las demás).
 *   - Si rol=recurso crea también el Recurso.
 *   - Genera contraseña provisional aleatoria (12 chars).
 *   - Crea el Usuario con debeCambiarPassword=true.
 *   - Resuelve los nombres de sedes contra la BD (case-insensitive) y crea los vínculos.
 *   - Envía email con la contraseña provisional y un link al sistema.
 *
 * No usa transacción global: si una fila falla, las demás se siguen procesando.
 * Devuelve un resumen por fila para que el frontend muestre el resultado.
 */
export async function bulkCreate(req, res) {
  const { users: usuarios } = bulkSchema.parse(req.body)
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]

  // Mapa de sedes para resolver por nombre (case-insensitive)
  const sedesTodas = await prisma.site.findMany({ where: { active: true }, select: { id: true, name: true } })
  const sedeByNombre = new Map(sedesTodas.map((s) => [s.name.trim().toLowerCase(), s.id]))

  const resultados = []
  for (const u of usuarios) {
    const emailRaw = (u.email ?? '').trim().toLowerCase()
    try {
      // Validaciones por fila — no rompen el batch
      if (!u.name || u.name.trim().length < 3) {
        resultados.push({ email: emailRaw || '(sin email)', ok: false, error: 'nombre requerido (mín 3 caracteres)' })
        continue
      }
      if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
        resultados.push({ email: emailRaw || '(sin email)', ok: false, error: 'email inválido o vacío' })
        continue
      }
      if (!u.role || !ROLES_VALIDOS.has(u.role)) {
        resultados.push({ email: emailRaw, ok: false, error: `rol inválido (debe ser ${[...ROLES_VALIDOS].join(', ')})` })
        continue
      }
      if (u.role === 'recurso' && (!u.resourceType || !TIPOS_VALIDOS.has(u.resourceType))) {
        resultados.push({ email: emailRaw, ok: false, error: `tipoRecurso requerido y debe ser ${[...TIPOS_VALIDOS].join(', ')}` })
        continue
      }
      if (u.payScheme && !ESQUEMAS_VALIDOS.has(u.payScheme)) {
        resultados.push({ email: emailRaw, ok: false, error: `esquemaPago inválido (debe ser ${[...ESQUEMAS_VALIDOS].join(', ')})` })
        continue
      }
      const email = emailRaw
      const yaExiste = await prisma.user.findUnique({ where: { email } })
      if (yaExiste) {
        resultados.push({ email, ok: false, error: 'Email ya registrado' })
        continue
      }

      const passProv = generarPasswordProvisional()
      const passHash = await bcrypt.hash(passProv, 12)

      let recursoId = null
      if (u.role === 'recurso') {
        // Solo los oftalmólogos rotan entre varios consultorios en paralelo
        // (cada uno con su propia auxiliar dedicada). RN-08 los exenta del
        // conflicto de horario al mismo tiempo en distintos consultorios.
        // Optómetras y anestesiólogos físicamente están en una sala por vez.
        // Especialidad: solo aplica a oftalmólogos (sub-especialidad médica).
        const recursoId_ = await prisma.resource.create({
          data: {
            name: titleCase(u.name),
            type: u.resourceType,
            specialty: u.resourceType === 'oftalmologo' ? (u.specialty || null) : null,
            // Tipos por_paciente (oftalmólogo, fonoaudióloga): sin tope semanal contractual.
            // Resto: usa el valor pasado o default 44h (Ley 2101 vigente).
            maxHoursPerWeek: TIPOS_POR_PACIENTE.has(u.resourceType) ? null : (u.maxHoursPerWeek ?? 44),
            maxHoursPerDay: u.maxHoursPerDay ?? 10,
            payScheme: u.payScheme ?? (TIPOS_POR_PACIENTE.has(u.resourceType) ? 'por_paciente' : 'fijo'),
            slotMinutes: u.slotMinutes,
            // multi_consultorio aplica solo a oftalmólogos (rotan entre salas en paralelo).
            multiRoom: u.resourceType === 'oftalmologo',
          },
        })
        recursoId = recursoId_.id
      }

      const usuario = await prisma.user.create({
        data: {
          name: titleCase(u.name),
          email,
          phone: u.phone,
          passwordHash: passHash,
          role: u.role,
          resourceId: recursoId,
          active: true,
          mustChangePassword: true,
        },
      })

      // Vincular sedes
      const sedesNoEncontradas = []
      if (Array.isArray(u.sites) && u.sites.length > 0) {
        const sedeIds = []
        for (const nombre of u.sites) {
          const id = sedeByNombre.get(String(nombre).trim().toLowerCase())
          if (id) sedeIds.push(id); else sedesNoEncontradas.push(nombre)
        }
        if (sedeIds.length > 0) {
          await prisma.userSite.createMany({
            data: sedeIds.map((sedeId) => ({ userId: usuario.id, siteId: sedeId })),
          })
        }
      }

      // Email (modo log si no hay SMTP)
      await enviarEmail({
        to: usuario.email,
        subject: '[VIU · FOCA | SGRC] Bienvenido(a) al sistema · Credenciales de acceso',
        html: plantillaEmail(
          `Bienvenido(a), ${usuario.name.split(' ')[0]}`,
          `Te damos la bienvenida al <strong>Sistema de Gestión de Recursos Clínicos (SGRC)</strong> de la Fundación Oftalmológica del Caribe.<br><br>
          Tu cuenta ya está activa. Usa las siguientes credenciales para iniciar sesión:<br><br>
          <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0">
            <tr>
              <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px 8px 0 0;font-size:13px;color:#475569;width:130px">📧 Usuario / Email</td>
              <td style="padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb;border-left:none;border-radius:0 8px 0 0;font-family:monospace;font-size:14px;color:#0f172a">${usuario.email}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 0 8px;font-size:13px;color:#475569">🔑 Contraseña provisional</td>
              <td style="padding:10px 14px;background:#fff7ed;border:1px solid #fed7aa;border-top:none;border-left:none;border-radius:0 0 8px 0;font-family:monospace;font-weight:600;font-size:15px;color:#9a3412;letter-spacing:1px">${passProv}</td>
            </tr>
          </table>
          <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 12px;margin:14px 0;border-radius:0 6px 6px 0;font-size:13px;color:#78350f">
            ⚠️ <strong>Importante:</strong> esta contraseña es <strong>provisional</strong>. En tu primer ingreso el sistema te pedirá cambiarla por una propia que solo tú conozcas.
          </div>
          Si tienes problemas para acceder, contacta a tu coordinador o al supervisor del sistema.<br><br>
          ¡Gracias por ser parte del equipo COFCA!`,
          origin,
          'Iniciar sesión ahora'
        ),
        text: `Bienvenido a SGRC — Fundación Oftalmológica del Caribe

Tu cuenta ya está activa. Credenciales:

  Usuario / Email:         ${usuario.email}
  Contraseña provisional:  ${passProv}

⚠️ IMPORTANTE: esta contraseña es PROVISIONAL. En tu primer ingreso el sistema te pedirá cambiarla por una propia.

Ingresa en: ${origin}

Si tienes problemas para acceder, contacta a tu coordinador o supervisor.`,
      })

      await registrarAuditoria({
        userId: req.user.id,
        action: 'crear_usuario_bulk',
        entity: 'usuarios',
        entityId: usuario.id,
        newValue: { role: u.role, email: usuario.email },
        ipAddress: getIp(req),
      })

      resultados.push({
        email,
        ok: true,
        userId: usuario.id,
        sitesNotFound: sedesNoEncontradas.length > 0 ? sedesNoEncontradas : undefined,
      })
    } catch (e) {
      resultados.push({ email: emailRaw || u.email || '(sin email)', ok: false, error: e.message?.slice(0, 200) ?? 'Error desconocido' })
    }
  }

  const ok = resultados.filter((r) => r.ok).length
  const fallidos = resultados.filter((r) => !r.ok).length
  res.status(201).json({ totals: { ok, failed: fallidos, total: resultados.length }, results: resultados })
}

/**
 * PUT /usuarios/me/heartbeat — el cliente lo llama cada ~30s mientras hay
 * sesión activa. Se usa para mostrar presencia "en línea" estilo redes
 * sociales (long-polling). El frontend marca verde si la última actividad
 * está dentro de los últimos 60s.
 */
export async function heartbeat(req, res) {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { lastSeenAt: new Date() },
  })
  res.json({ ok: true, ts: new Date().toISOString() })
}

export async function list(req, res) {
  const { role: rol, active: activo } = req.query
  const where = {}
  if (rol) where.role = rol
  if (activo !== undefined) where.active = activo === 'true'
  const usuarios = await prisma.user.findMany({
    where,
    select: {
      ...SELECT_PUBLIC,
      mustChangePassword: true,
      // Sedes con nombre resuelto para el modal de detalle
      sites: { select: { siteId: true, site: { select: { name: true } } } },
      // Datos del recurso flattened (cuando rol=recurso)
      resource: {
        select: {
          type: true,
          specialty: true,
          maxHoursPerWeek: true,
          maxHoursPerDay: true,
          slotMinutes: true,
          payScheme: true,
          multiRoom: true,
          leadCoordinatorId: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  // Resolver nombre del coordinador-líder para cada recurso (1 query extra)
  const lideresIds = [...new Set(usuarios.map((u) => u.resource?.leadCoordinatorId).filter(Boolean))]
  const lideres = lideresIds.length
    ? await prisma.user.findMany({ where: { id: { in: lideresIds } }, select: { id: true, name: true } })
    : []
  const liderById = new Map(lideres.map((l) => [l.id, l.name]))

  res.json(usuarios.map((u) => ({
    ...u,
    sites: u.sites.map((s) => s.siteId),
    siteNames: u.sites.map((s) => s.site?.name).filter(Boolean),
    // Datos del recurso al nivel del usuario para el modal de detalle
    type: u.resource?.type ?? null,
    specialty: u.resource?.specialty ?? null,
    maxHoursPerWeek: u.resource?.maxHoursPerWeek ?? null,
    maxHoursPerDay: u.resource?.maxHoursPerDay ?? null,
    slotMinutes: u.resource?.slotMinutes ?? null,
    payScheme: u.resource?.payScheme ?? null,
    multiRoom: u.resource?.multiRoom ?? false,
    leadCoordinatorId: u.resource?.leadCoordinatorId ?? null,
    coordinadorLiderNombre: liderById.get(u.resource?.leadCoordinatorId) ?? null,
    resource: undefined,
  })))
}

export async function create(req, res) {
  const data = crearUsuarioSchema.parse(req.body)
  if (data.role === 'recurso' && !data.resourceType) {
    throw errors.badRequest('Para rol "recurso" debes indicar el tipo (auxiliar, técnico, optómetra, oftalmólogo, anestesiólogo, asesor_servicios).')
  }
  // Si no envían password (creación rápida desde admin), usar la provisional fija.
  const passwordPlano = data.password ?? DEFAULT_PASSWORD
  const passwordHash = await bcrypt.hash(passwordPlano, 12)

  // Si es recurso, crear primero el registro en `recursos` y vincularlo al usuario.
  // Mismas reglas que la carga masiva: oftalmólogos son multi-consultorio sin tope semanal.
  let recursoId = data.resourceId ?? null
  if (data.role === 'recurso' && !recursoId) {
    const esPorPaciente = TIPOS_POR_PACIENTE.has(data.resourceType)
    const r = await prisma.resource.create({
      data: {
        name: titleCase(data.name),
        type: data.resourceType,
        specialty: data.resourceType === 'oftalmologo' ? (data.specialty || null) : null,
        // Tipos por_paciente (oftalmólogo, fonoaudióloga): sin tope semanal.
        // Resto: jornada Ley 2101 vigente (44h).
        maxHoursPerWeek: esPorPaciente ? null : 44,
        maxHoursPerDay: 10,
        payScheme: esPorPaciente ? 'por_paciente' : 'fijo',
        multiRoom: data.resourceType === 'oftalmologo',
        // Oftalmólogos y anestesiólogos rotan entre sedes — sin líder fijo.
        // Fonoaudiólogas sí quedan con líder (trabajan estables en su sede).
        leadCoordinatorId: ['oftalmologo', 'anestesiologo'].includes(data.resourceType)
          ? null
          : (data.leadCoordinatorId ?? null),
      },
    })
    recursoId = r.id
  }

  const u = await prisma.user.create({
    data: {
      name: titleCase(data.name),
      email: data.email.toLowerCase(),
      phone: data.phone,
      passwordHash,
      role: data.role,
      resourceId: recursoId,
      active: data.active ?? true,
      sites: data.sites?.length
        ? { create: data.sites.map((sedeId) => ({ siteId: sedeId })) }
        : undefined,
    },
    select: SELECT_PUBLIC,
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'crear_usuario',
    entity: 'usuarios',
    entityId: u.id,
    newValue: { name: u.name, role: u.role },
    ipAddress: getIp(req),
  })
  res.status(201).json({ ...u, sites: u.sites.map((s) => s.siteId) })
}

export async function update(req, res) {
  const data = editarUsuarioSchema.parse(req.body)
  const anterior = await prisma.user.findUnique({ where: { id: req.params.id }, include: { sites: true } })
  if (!anterior) throw errors.notFound()

  const updateData = {}
  if (data.name) updateData.name = titleCase(data.name)
  if (data.email) updateData.email = data.email.toLowerCase()
  if (data.phone !== undefined) updateData.phone = data.phone
  if (data.role) updateData.role = data.role
  if (data.resourceId !== undefined) updateData.resourceId = data.resourceId
  if (data.active !== undefined) updateData.active = data.active
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12)

  const u = await prisma.user.update({
    where: { id: req.params.id },
    data: updateData,
    select: SELECT_PUBLIC,
  })

  // requireAuth cachea rol y estado 60s. Si aquí se ha desactivado al usuario o
  // se le ha cambiado el rol, se olvida ya para que el cambio surta efecto en la
  // siguiente petición y no dentro de un minuto.
  invalidarUsuarioEnCache(req.params.id)

  // Sincronizar el nombre en el recurso vinculado (si lo hay) — evita que el
  // recurso quede con el nombre viejo cuando el supervisor corrige el del usuario.
  if (updateData.name && anterior.resourceId) {
    await prisma.resource.update({
      where: { id: anterior.resourceId },
      data: { name: updateData.name },
    })
  }

  // Cascade del flag activo al recurso vinculado: si el supervisor desactiva
  // el usuario, el recurso debe desaparecer también del programador y catálogo
  // (lo mismo en sentido inverso al reactivarlo). Sin esto el recurso queda
  // huérfano-visible: usuario inactivo pero recurso.activo=true.
  if (data.active !== undefined && anterior.resourceId && anterior.active !== data.active) {
    await prisma.resource.update({
      where: { id: anterior.resourceId },
      data: { active: data.active },
    })
  }

  // Si vienen sedes, reemplaza el set completo (idempotente)
  if (data.sites) {
    await prisma.userSite.deleteMany({ where: { userId: req.params.id } })
    if (data.sites.length > 0) {
      await prisma.userSite.createMany({
        data: data.sites.map((sedeId) => ({ userId: req.params.id, siteId: sedeId })),
      })
    }
  }

  // Coordinador-líder del recurso: actualiza en la tabla recursos
  if (data.leadCoordinatorId !== undefined && anterior.resourceId) {
    await prisma.resource.update({
      where: { id: anterior.resourceId },
      data: { leadCoordinatorId: data.leadCoordinatorId },
    })
  }

  // Cambio de tipo del recurso (corrección por el supervisor)
  if (data.resourceType && anterior.resourceId) {
    const recursoAnt = await prisma.resource.findUnique({ where: { id: anterior.resourceId } })
    if (recursoAnt && recursoAnt.type !== data.resourceType) {
      const esOftalm = data.resourceType === 'oftalmologo'
      await prisma.resource.update({
        where: { id: anterior.resourceId },
        data: {
          type: data.resourceType,
          // Recalcular flags que dependen del tipo
          maxHoursPerWeek: esOftalm ? null : (recursoAnt.maxHoursPerWeek ?? 42),
          multiRoom: esOftalm,
        },
      })
      await registrarAuditoria({
        userId: req.user.id,
        action: 'cambiar_tipo_recurso',
        entity: 'recursos',
        entityId: anterior.resourceId,
        oldValue: { type: recursoAnt.type },
        newValue: { type: data.resourceType },
        ipAddress: getIp(req),
      })
    }
  }

  // Auditoría de cambios significativos
  if (anterior.active !== u.active) {
    await registrarAuditoria({
      userId: req.user.id,
      action: u.active ? 'activar_usuario' : 'desactivar_usuario',
      entity: 'usuarios',
      entityId: u.id,
      reason: data.reason,
      ipAddress: getIp(req),
    })
  }

  res.json({ ...u, sites: u.sites.map((s) => s.siteId) })
}

/**
 * DELETE /usuarios/:id
 * Por defecto hace SOFT delete (activo=false) — preserva la historia y
 * auditorías. Con ?hard=true intenta hard delete (borra fila + recurso),
 * pero falla si tiene asignaciones, ausencias o auditorías referenciándolo.
 */
export async function remove(req, res) {
  const { id } = req.params
  const hard = req.query.hard === 'true'

  const usuario = await prisma.user.findUnique({
    where: { id },
    include: { resource: true },
  })
  if (!usuario) throw errors.notFound('Usuario no encontrado')

  if (usuario.id === req.user.id) {
    throw errors.badRequest('No puedes eliminar tu propia cuenta')
  }

  if (hard) {
    // Hard delete: intentar borrar usuario + recurso (si lo tiene).
    // Si tiene FK constraints (asignaciones/ausencias) Prisma lanza error.
    try {
      // Borrar password resets + sedes + acciones referenciadas
      await prisma.passwordReset.deleteMany({ where: { userId: id } })
      await prisma.userSite.deleteMany({ where: { userId: id } })
      await prisma.notification.deleteMany({ where: { userId: id } })

      const recursoId = usuario.resourceId
      await prisma.user.delete({ where: { id } })
      invalidarUsuarioEnCache(id)

      if (recursoId) {
        // Borrar recurso solo si no tiene asignaciones/ausencias
        const tieneAsig = await prisma.assignment.count({
          where: { OR: [{ resourceId: recursoId }, { assistantId: recursoId }] },
        })
        const tieneAus = await prisma.absence.count({ where: { resourceId: recursoId } })
        if (tieneAsig === 0 && tieneAus === 0) {
          await prisma.resource.delete({ where: { id: recursoId } })
        }
      }

      await registrarAuditoria({
        userId: req.user.id,
        action: 'eliminar_usuario_hard',
        entity: 'usuarios',
        entityId: id,
        oldValue: { name: usuario.name, email: usuario.email, role: usuario.role },
        ipAddress: getIp(req),
      })

      return res.json({ ok: true, modo: 'hard', message: 'Usuario eliminado completamente' })
    } catch (e) {
      // Si hay restricciones FK, hacer soft delete
      console.error('Hard delete falló, haciendo soft delete:', e.message)
    }
  }

  // Soft delete: desactivar (preserva historia y FK)
  await prisma.user.update({
    where: { id },
    data: { active: false },
  })
  // Caso principal de la revalidación: desactivar a alguien debe echarlo del
  // sistema en la siguiente petición, no cuando caduque su token dentro de 8h.
  invalidarUsuarioEnCache(id)

  await registrarAuditoria({
    userId: req.user.id,
    action: 'eliminar_usuario_soft',
    entity: 'usuarios',
    entityId: id,
    oldValue: { name: usuario.name, email: usuario.email, role: usuario.role },
    ipAddress: getIp(req),
  })

  res.json({ ok: true, modo: 'soft', message: 'Usuario desactivado (preservó historial)' })
}

/**
 * POST /usuarios/:id/reenviar-credenciales
 * Resetea la contraseña del usuario a la contraseña común provisional
 * (SGRC2026!), fuerza el cambio en el primer login y reenvía el email
 * de bienvenida. Útil cuando un usuario no recibió el email original o
 * lo perdió.
 */
const PASSWORD_PROVISIONAL_COMUN = 'SGRC2026!'

export async function reenviarCredenciales(req, res) {
  const { id } = req.params

  const usuario = await prisma.user.findUnique({ where: { id } })
  if (!usuario) throw errors.notFound('Usuario no encontrado')

  if (usuario.id === req.user.id) {
    throw errors.badRequest('Usa "Mi perfil → Cambiar contraseña" para tu propia cuenta')
  }

  if (usuario.role === 'supervisor' && req.user.id !== usuario.id) {
    // Un supervisor puede resetear a otro supervisor (no es bloqueante pero
    // queda en auditoría más prominente)
  }

  const passwordHash = await bcrypt.hash(PASSWORD_PROVISIONAL_COMUN, 12)
  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      mustChangePassword: true,
      credentialsResentAt: new Date(),  // marca el reenvío para evitar duplicados
    },
  })

  // Reenviar email de bienvenida — si SMTP está activo, llega real;
  // si no, queda en el log para referencia del supervisor.
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]
  await enviarEmail({
    to: usuario.email,
    subject: '[VIU · FOCA | SGRC] Reenvío de credenciales de acceso',
    html: plantillaEmail(
      `¡Hola de nuevo, ${usuario.name.split(' ')[0]}!`,
      `El supervisor reenvió tus credenciales del <strong>Sistema de Gestión de Recursos Clínicos (SGRC)</strong>.<br><br>
      Tu acceso fue reestablecido. Usa estas credenciales para iniciar sesión:<br><br>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0">
        <tr>
          <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px 8px 0 0;font-size:13px;color:#475569;width:130px">📧 Usuario / Email</td>
          <td style="padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb;border-left:none;border-radius:0 8px 0 0;font-family:monospace;font-size:14px;color:#0f172a">${usuario.email}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 0 8px;font-size:13px;color:#475569">🔑 Contraseña provisional</td>
          <td style="padding:10px 14px;background:#fff7ed;border:1px solid #fed7aa;border-top:none;border-left:none;border-radius:0 0 8px 0;font-family:monospace;font-weight:600;font-size:15px;color:#9a3412;letter-spacing:1px">${PASSWORD_PROVISIONAL_COMUN}</td>
        </tr>
      </table>
      <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 12px;margin:14px 0;border-radius:0 6px 6px 0;font-size:13px;color:#78350f">
        ⚠️ <strong>Importante:</strong> esta contraseña es <strong>provisional</strong>. En tu primer ingreso el sistema te pedirá cambiarla por una propia.
      </div>`,
      origin,
      'Iniciar sesión ahora'
    ),
    text: `SGRC — Reenvío de credenciales

Hola ${usuario.name},

El supervisor reenvió tus credenciales:

  Usuario / Email:         ${usuario.email}
  Contraseña provisional:  ${PASSWORD_PROVISIONAL_COMUN}

⚠️ Esta contraseña es PROVISIONAL. En tu primer ingreso te pedirá cambiarla.

Ingresa en: ${origin}`,
  })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'reenviar_credenciales',
    entity: 'usuarios',
    entityId: usuario.id,
    newValue: { email: usuario.email, role: usuario.role },
    ipAddress: getIp(req),
  })

  res.json({
    ok: true,
    email: usuario.email,
    password: PASSWORD_PROVISIONAL_COMUN,
    smtpActivo: !!process.env.SMTP_HOST,
  })
}

/** PUT /usuarios/me — el usuario logueado actualiza sus datos (HU-R-10) */
export async function updateMe(req, res) {
  const data = editarUsuarioSchema.pick({ phone: true, email: true, password: true }).parse(req.body)
  const updateData = {}
  if (data.phone !== undefined) updateData.phone = data.phone
  if (data.email) updateData.email = data.email.toLowerCase()
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12)
  const u = await prisma.user.update({
    where: { id: req.user.id },
    data: updateData,
    select: SELECT_PUBLIC,
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'actualizar_perfil',
    entity: 'usuarios',
    entityId: req.user.id,
    newValue: { campos: Object.keys(updateData) },
    ipAddress: getIp(req),
  })
  res.json({ ...u, sites: u.sites.map((s) => s.siteId) })
}
