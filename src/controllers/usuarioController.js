import { z } from 'zod'
import bcrypt from 'bcrypt'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
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
