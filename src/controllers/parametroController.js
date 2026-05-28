import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'

// tipoConsulta es un slug libre: minúsculas, letras/dígitos/guion bajo, sin
// espacios. Antes era un enum de 4 valores; ahora el supervisor puede definir
// tipos nuevos (p.ej. "cirugia_general", "examen_oct").
const parametroSchema = z.object({
  tipoConsulta: z.string().min(3).max(40).regex(/^[a-z0-9_]+$/, 'Solo minúsculas, dígitos y guion bajo'),
  costoCita: z.number().min(0),
  costoReprogramacion: z.number().min(0),
  vigenteDesde: z.string(), // YYYY-MM-DD
})

export async function listCosto(req, res) {
  const list = await prisma.parametroCosto.findMany({
    orderBy: [{ tipoConsulta: 'asc' }, { vigenteDesde: 'desc' }],
  })
  res.json(list)
}

export async function createCosto(req, res) {
  const data = parametroSchema.parse(req.body)
  const p = await prisma.parametroCosto.create({
    data: {
      tipoConsulta: data.tipoConsulta,
      costoCita: data.costoCita,
      costoReprogramacion: data.costoReprogramacion,
      vigenteDesde: new Date(data.vigenteDesde),
      configuradoPor: req.user.id,
    },
  })
  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'cambiar_parametro_costo',
    entidad: 'parametros_costo',
    entidadId: p.id,
    valorNuevo: { tipoConsulta: p.tipoConsulta, costoCita: p.costoCita },
    ipAddress: getIp(req),
  })
  res.status(201).json(p)
}

/** Devuelve los parámetros del sistema como objeto plano */
export async function getSistema(req, res) {
  const rows = await prisma.parametroSistema.findMany()
  const obj = Object.fromEntries(rows.map((r) => [r.clave, r.valor]))
  // Defaults si la BD está vacía
  res.json({
    meta_ocupacion_consultorios: obj.meta_ocupacion_consultorios ?? 80,
    meta_utilizacion_th: obj.meta_utilizacion_th ?? 90,
    meta_cumplimiento_ejecucion: obj.meta_cumplimiento_ejecucion ?? 85,
    semaforo_umbral_naranja: obj.semaforo_umbral_naranja ?? 10,
    base_horas_lun_vie_min: obj.base_horas_lun_vie_min ?? 720,
    base_horas_sabado_min: obj.base_horas_sabado_min ?? 240,
  })
}

export async function updateSistema(req, res) {
  const { motivo, ...kv } = req.body
  const entries = Object.entries(kv)
  for (const [clave, valor] of entries) {
    await prisma.parametroSistema.upsert({
      where: { clave },
      update: { valor, motivo, updatedBy: req.user.id },
      create: { clave, valor, motivo, updatedBy: req.user.id },
    })
  }
  await registrarAuditoria({
    usuarioId: req.user.id,
    accion: 'cambiar_parametro_sistema',
    entidad: 'parametros_sistema',
    entidadId: 'sistema',
    valorNuevo: kv,
    motivo,
    ipAddress: getIp(req),
  })
  res.json({ ok: true })
}
