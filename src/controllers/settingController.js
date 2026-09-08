import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { registrarAuditoria, getIp } from '../middleware/audit.js'
import { errors } from '../lib/errors.js'

// tipoConsulta es un slug libre: minúsculas, letras/dígitos/guion bajo, sin
// espacios. Antes era un enum de 4 valores; ahora el supervisor puede definir
// tipos nuevos (p.ej. "cirugia_general", "examen_oct").
//
// costoCita quedó OPCIONAL (jul-2026): la UI solo pide el "costo por caso"
// (unificado con costoReprogramacion), y ambos campos internos se guardan
// con el mismo valor. Se conserva el campo en BD (NOT NULL) porque
// ausenciaService lo lee para calcular costoOportunidad — al inyectarlo con
// el mismo monto, los informes de impacto económico siguen funcionando sin
// cambios ni migración.
const parametroSchema = z.object({
  visitType: z.string().min(3).max(40).regex(/^[a-z0-9_]+$/, 'Solo minúsculas, dígitos y guion bajo'),
  visitCost: z.number().min(0).optional(),
  rescheduleCost: z.number().min(0),
  effectiveFrom: z.string(), // YYYY-MM-DD
})

export async function listCosto(req, res) {
  const list = await prisma.costSetting.findMany({
    orderBy: [{ visitType: 'asc' }, { effectiveFrom: 'desc' }],
  })
  res.json(list)
}

/**
 * PUT /cost-settings/:id — edita un parámetro de costo.
 *
 * El frontend lo llamaba (`parametroService.update`) y el backend nunca lo
 * registró: devolvía 404 y el supervisor no podía corregir un costo mal puesto
 * sin crear otro encima. Se destapó al cruzar las rutas de los dos lados.
 *
 * Se audita igual que la creación (RN-34): un cambio de costo mueve las cifras
 * de todos los informes de impacto económico, así que debe quedar registrado
 * quién lo tocó y qué valor había antes.
 */
export async function updateCosto(req, res) {
  const data = parametroSchema.partial().parse(req.body)

  const anterior = await prisma.costSetting.findUnique({ where: { id: req.params.id } })
  if (!anterior) throw errors.notFound('Parámetro de costo no encontrado')

  const cambios = {}
  if (data.visitType !== undefined) cambios.visitType = data.visitType
  if (data.visitCost !== undefined) cambios.visitCost = data.visitCost
  if (data.rescheduleCost !== undefined) cambios.rescheduleCost = data.rescheduleCost
  if (data.effectiveFrom !== undefined) cambios.effectiveFrom = new Date(data.effectiveFrom)

  const p = await prisma.costSetting.update({ where: { id: req.params.id }, data: cambios })

  await registrarAuditoria({
    userId: req.user.id,
    action: 'cambiar_parametro_costo',
    entity: 'parametros_costo',
    entityId: p.id,
    oldValue: {
      visitType: anterior.visitType,
      visitCost: anterior.visitCost,
      rescheduleCost: anterior.rescheduleCost,
    },
    newValue: {
      visitType: p.visitType,
      visitCost: p.visitCost,
      rescheduleCost: p.rescheduleCost,
    },
    ipAddress: getIp(req),
  })
  res.json(p)
}

export async function createCosto(req, res) {
  const data = parametroSchema.parse(req.body)
  // Auto-fill (jul-2026): si el frontend no manda costoCita, usamos el mismo
  // costoReprogramacion. Es el "costo por caso todo incluido" acordado con
  // gerencia — quejas + jurídicos + logística ya están dentro del monto.
  const costoCitaFinal = data.visitCost ?? data.rescheduleCost
  const p = await prisma.costSetting.create({
    data: {
      visitType: data.visitType,
      visitCost: costoCitaFinal,
      rescheduleCost: data.rescheduleCost,
      effectiveFrom: new Date(data.effectiveFrom),
      setBy: req.user.id,
    },
  })
  await registrarAuditoria({
    userId: req.user.id,
    action: 'cambiar_parametro_costo',
    entity: 'parametros_costo',
    entityId: p.id,
    newValue: {
      visitType: p.visitType,
      costoPorCaso: costoCitaFinal,
      rescheduleCost: p.rescheduleCost,
    },
    ipAddress: getIp(req),
  })
  res.status(201).json(p)
}

/** Devuelve los parámetros del sistema como objeto plano */
export async function getSistema(req, res) {
  const rows = await prisma.systemSetting.findMany()
  const obj = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  // Defaults si la BD está vacía
  res.json({
    meta_ocupacion_consultorios: obj.meta_ocupacion_consultorios ?? 80,
    meta_utilizacion_th: obj.meta_utilizacion_th ?? 90,
    meta_cumplimiento_ejecucion: obj.meta_cumplimiento_ejecucion ?? 85,
    semaforo_umbral_naranja: obj.semaforo_umbral_naranja ?? 10,
    base_horas_lun_vie_min: obj.base_horas_lun_vie_min ?? 720,
    base_horas_sabado_min: obj.base_horas_sabado_min ?? 240,
    // Ley 2101 (Colombia): jornada laboral semanal vigente.
    // 15-jul-2023 → 14-jul-2024: 47h · 15-jul-2024 → 14-jul-2025: 46h
    // 15-jul-2025 → 14-jul-2026: 44h ← VIGENTE · desde 15-jul-2026: 42h
    // Configurable porque la fecha de transición depende de la empresa.
    jornada_semanal_horas: Number(obj.jornada_semanal_horas ?? 44),
  })
}

// El middleware caseConverter convierte el body de snake → camel antes de llegar acá.
// Como la BD guarda las claves en snake_case (convención SGRC), las devolvemos a snake.
const camelToSnake = (str) => str.replace(/([A-Z])/g, (l) => `_${l.toLowerCase()}`)

export async function updateSistema(req, res) {
  const { reason: motivo, ...kv } = req.body
  const entries = Object.entries(kv)
  for (const [claveCamel, valor] of entries) {
    const clave = camelToSnake(claveCamel)
    await prisma.systemSetting.upsert({
      where: { key: clave },
      update: { value: valor, reason: motivo, updatedBy: req.user.id },
      create: { key: clave, value: valor, reason: motivo, updatedBy: req.user.id },
    })
  }
  await registrarAuditoria({
    userId: req.user.id,
    action: 'cambiar_parametro_sistema',
    entity: 'parametros_sistema',
    entityId: 'sistema',
    newValue: kv,
    reason: motivo,
    ipAddress: getIp(req),
  })
  res.json({ ok: true })
}
