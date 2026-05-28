import { z } from 'zod'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { enviarEmail, plantillaEmail } from '../services/emailService.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

const ROLES = ['recurso', 'coordinador', 'directivo', 'supervisor']

const crearUsuarioSchema = z.object({
  nombre: z.string().min(1).max(150),
  email: z.string().email().max(200),
  celular: z.string().max(20).optional().nullable(),
  password: z.string().min(8),
  rol: z.enum(ROLES),
  recursoId: z.string().uuid().optional().nullable(),
  activo: z.boolean().optional(),
  sedes: z.array(z.string().uuid()).optional(),
})

const editarUsuarioSchema = z.object({
  nombre: z.string().min(1).max(150).optional(),
  email: z.string().email().optional(),
  celular: z.string().max(20).optional().nullable(),
  password: z.string().min(8).optional(),
  rol: z.enum(ROLES).optional(),
  recursoId: z.string().uuid().optional().nullable(),
  activo: z.boolean().optional(),
  sedes: z.array(z.string().uuid()).optional(),
  motivo: z.string().optional(),
})

const SELECT_PUBLIC = {
  id: true,
  nombre: true,
  email: true,
  celular: true,
  rol: true,
  recursoId: true,
  activo: true,
  ultimoLogin: true,
  ultimaActividad: true,
  createdAt: true,
  sedes: { select: { sedeId: true } },
}

/** Genera contraseña provisional alfanumérica de 12 caracteres. */
function generarPasswordProvisional() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12)
}

// El schema es laxo en email/rol/tipo para que UNA fila mala no rebote todo el
// batch. La validación específica de cada fila vive dentro del loop, así
// reportamos error por fila y seguimos con las demás.
const bulkSchema = z.object({
  usuarios: z.array(z.object({
    nombre: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    celular: z.string().max(20).optional().nullable(),
    rol: z.string().optional().nullable(),
    tipoRecurso: z.string().optional().nullable(),
    especialidad: z.string().max(100).optional().nullable(),
    horasMaxSemana: z.number().int().min(1).max(60).optional().nullable(),
    horasMaxDia: z.number().int().min(1).max(24).optional().nullable(),
    esquemaPago: z.string().optional().nullable(),
    intervaloMinutos: z.number().int().min(5).max(60).optional().nullable(),
    sedes: z.array(z.string()).optional().nullable(),
  })).min(1).max(500),
})

const ROLES_VALIDOS = new Set(['recurso', 'coordinador', 'directivo'])
const TIPOS_VALIDOS = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'auxiliar', 'tecnico'])
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
  const { usuarios } = bulkSchema.parse(req.body)
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0]

  // Mapa de sedes para resolver por nombre (case-insensitive)
  const sedesTodas = await prisma.sede.findMany({ where: { activa: true }, select: { id: true, nombre: true } })
  const sedeByNombre = new Map(sedesTodas.map((s) => [s.nombre.trim().toLowerCase(), s.id]))

  const resultados = []
  for (const u of usuarios) {
    const emailRaw = (u.email ?? '').trim().toLowerCase()
    try {
      // Validaciones por fila — no rompen el batch
      if (!u.nombre || u.nombre.trim().length < 3) {
        resultados.push({ email: emailRaw || '(sin email)', ok: false, error: 'nombre requerido (mín 3 caracteres)' })
        continue
      }
      if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
        resultados.push({ email: emailRaw || '(sin email)', ok: false, error: 'email inválido o vacío' })
        continue
      }
      if (!u.rol || !ROLES_VALIDOS.has(u.rol)) {
        resultados.push({ email: emailRaw, ok: false, error: `rol inválido (debe ser ${[...ROLES_VALIDOS].join(', ')})` })
        continue
      }
      if (u.rol === 'recurso' && (!u.tipoRecurso || !TIPOS_VALIDOS.has(u.tipoRecurso))) {
        resultados.push({ email: emailRaw, ok: false, error: `tipoRecurso requerido y debe ser ${[...TIPOS_VALIDOS].join(', ')}` })
        continue
      }
      if (u.esquemaPago && !ESQUEMAS_VALIDOS.has(u.esquemaPago)) {
        resultados.push({ email: emailRaw, ok: false, error: `esquemaPago inválido (debe ser ${[...ESQUEMAS_VALIDOS].join(', ')})` })
        continue
      }
      const email = emailRaw
      const yaExiste = await prisma.usuario.findUnique({ where: { email } })
      if (yaExiste) {
        resultados.push({ email, ok: false, error: 'Email ya registrado' })
        continue
      }

      const passProv = generarPasswordProvisional()
      const passHash = await bcrypt.hash(passProv, 12)

      let recursoId = null
      if (u.rol === 'recurso') {
        const r = await prisma.recurso.create({
          data: {
            nombre: u.nombre,
            tipo: u.tipoRecurso,
            especialidad: u.especialidad,
            horasMaxSemana: u.horasMaxSemana ?? 42,
            horasMaxDia: u.horasMaxDia ?? 10,
            esquemaPago: u.esquemaPago ?? 'fijo',
            intervaloMinutos: u.intervaloMinutos,
          },
        })
        recursoId = r.id
      }

      const usuario = await prisma.usuario.create({
        data: {
          nombre: u.nombre,
          email,
          celular: u.celular,
          passwordHash: passHash,
          rol: u.rol,
          recursoId,
          activo: true,
          debeCambiarPassword: true,
        },
      })

      // Vincular sedes
      const sedesNoEncontradas = []
      if (Array.isArray(u.sedes) && u.sedes.length > 0) {
        const sedeIds = []
        for (const nombre of u.sedes) {
          const id = sedeByNombre.get(String(nombre).trim().toLowerCase())
          if (id) sedeIds.push(id); else sedesNoEncontradas.push(nombre)
        }
        if (sedeIds.length > 0) {
          await prisma.usuarioSede.createMany({
            data: sedeIds.map((sedeId) => ({ usuarioId: usuario.id, sedeId })),
          })
        }
      }

      // Email (modo log si no hay SMTP)
      await enviarEmail({
        to: usuario.email,
        subject: '[SGRC] Tu cuenta fue creada — contraseña provisional',
        html: plantillaEmail(
          'Bienvenido a SGRC',
          `Hola ${usuario.nombre},<br><br>El supervisor creó tu cuenta. Ingresa con tu email y la siguiente <strong>contraseña provisional</strong>:<br><br>
          <div style="font-size:18px;font-weight:600;padding:12px;background:#f4f4f5;border-radius:8px;letter-spacing:1px;text-align:center;font-family:monospace">${passProv}</div><br>
          <strong>Importante:</strong> al primer ingreso el sistema te pedirá que la cambies por una propia.`,
          origin,
          'Iniciar sesión'
        ),
        text: `Tu cuenta SGRC fue creada. Email: ${usuario.email} · Contraseña provisional: ${passProv}\nIngresa en ${origin} — al primer login te pedirá cambiarla.`,
      })

      await registrarAuditoria({
        usuarioId: req.user.id,
        accion: 'crear_usuario_bulk',
        entidad: 'usuarios',
        entidadId: usuario.id,
        valorNuevo: { rol: u.rol, email: usuario.email },
        ipAddress: getIp(req),
      })

      resultados.push({
        email,
        ok: true,
        usuarioId: usuario.id,
        sedesNoEncontradas: sedesNoEncontradas.length > 0 ? sedesNoEncontradas : undefined,
      })
    } catch (e) {
      resultados.push({ email: emailRaw || u.email || '(sin email)', ok: false, error: e.message?.slice(0, 200) ?? 'Error desconocido' })
    }
  }

  const ok = resultados.filter((r) => r.ok).length
  const fallidos = resultados.filter((r) => !r.ok).length
  res.status(201).json({ totales: { ok, fallidos, total: resultados.length }, resultados })
}

/**
 * PUT /usuarios/me/heartbeat — el cliente lo llama cada ~30s mientras hay
 * sesión activa. Se usa para mostrar presencia "en línea" estilo redes
 * sociales (long-polling). El frontend marca verde si la última actividad
 * está dentro de los últimos 60s.
 */
export async function heartbeat(req, res) {
  await prisma.usuario.update({
    where: { id: req.user.id },
    data: { ultimaActividad: new Date() },
  })
  res.json({ ok: true, ts: new Date().toISOString() })
}

export async function list(req, res) {
  const { rol, activo } = req.query
  const where = {}
  if (rol) where.rol = rol
  if (activo !== undefined) where.activo = activo === 'true'
  const usuarios = await prisma.usuario.findMany({
    where,
    select: SELECT_PUBLIC,
    orderBy: { nombre: 'asc' },
  })
  res.json(usuarios.map((u) => ({ ...u, sedes: u.sedes.map((s) => s.sedeId) })))
}

export async function create(req, res) {
  const data = crearUsuarioSchema.parse(req.body)
  const passwordHash = await bcrypt.hash(data.password, 12)
  const u = await prisma.usuario.create({
    data: {
      nombre: data.nombre,
      email: data.email.toLowerCase(),
      celular: data.celular,
      passwordHash,
      rol: data.rol,
      recursoId: data.recursoId,
      activo: data.activo ?? true,
      sedes: data.sedes?.length
        ? { create: data.sedes.map((sedeId) => ({ sedeId })) }
        : undefined,
    },
    select: SELECT_PUBLIC,
  })
  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'crear_usuario',
    entidad: 'usuarios',
    entidadId: u.id,
    valorNuevo: { nombre: u.nombre, rol: u.rol },
    ipAddress: getIp(req),
  })
  res.status(201).json({ ...u, sedes: u.sedes.map((s) => s.sedeId) })
}

export async function update(req, res) {
  const data = editarUsuarioSchema.parse(req.body)
  const anterior = await prisma.usuario.findUnique({ where: { id: req.params.id }, include: { sedes: true } })
  if (!anterior) throw errors.notFound()

  const updateData = {}
  if (data.nombre) updateData.nombre = data.nombre
  if (data.email) updateData.email = data.email.toLowerCase()
  if (data.celular !== undefined) updateData.celular = data.celular
  if (data.rol) updateData.rol = data.rol
  if (data.recursoId !== undefined) updateData.recursoId = data.recursoId
  if (data.activo !== undefined) updateData.activo = data.activo
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12)

  const u = await prisma.usuario.update({
    where: { id: req.params.id },
    data: updateData,
    select: SELECT_PUBLIC,
  })

  // Si vienen sedes, reemplaza el set completo (idempotente)
  if (data.sedes) {
    await prisma.usuarioSede.deleteMany({ where: { usuarioId: req.params.id } })
    if (data.sedes.length > 0) {
      await prisma.usuarioSede.createMany({
        data: data.sedes.map((sedeId) => ({ usuarioId: req.params.id, sedeId })),
      })
    }
  }

  // Auditoría de cambios significativos
  if (anterior.activo !== u.activo) {
    await registrarAuditoria({
      usuarioId: req.user.id,
      accion: u.activo ? 'activar_usuario' : 'desactivar_usuario',
      entidad: 'usuarios',
      entidadId: u.id,
      motivo: data.motivo,
      ipAddress: getIp(req),
    })
  }

  res.json({ ...u, sedes: u.sedes.map((s) => s.sedeId) })
}

/** PUT /usuarios/me — el usuario logueado actualiza sus datos (HU-R-10) */
export async function updateMe(req, res) {
  const data = editarUsuarioSchema.pick({ celular: true, email: true, password: true }).parse(req.body)
  const updateData = {}
  if (data.celular !== undefined) updateData.celular = data.celular
  if (data.email) updateData.email = data.email.toLowerCase()
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12)
  const u = await prisma.usuario.update({
    where: { id: req.user.id },
    data: updateData,
    select: SELECT_PUBLIC,
  })
  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'actualizar_perfil',
    entidad: 'usuarios',
    entidadId: req.user.id,
    valorNuevo: { campos: Object.keys(updateData) },
    ipAddress: getIp(req),
  })
  res.json({ ...u, sedes: u.sedes.map((s) => s.sedeId) })
}
