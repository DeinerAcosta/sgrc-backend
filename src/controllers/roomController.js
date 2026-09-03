import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { errors } from '../lib/errors.js'
import { ordenConsultorios } from './siteController.js'
import { assertSedePermitida } from '../lib/siteScope.js'

// Mantener sincronizado con enum `Especialidad` en prisma/schema.prisma:43-50
// y con `ESPECIALIDADES` en frontend/src/utils/helpers.js.
// Fix jul-2026: faltaba 'fonoaudiologia' — el frontend la ofrecía en el select
// pero Zod aquí la rechazaba con "Datos inválidos" al editar consultorio.
// Jul-2026: agregado 'otorrinolaringologia' (con auxiliar, rotativo).
const ESPECIALIDADES = ['oftalmologia', 'optometria', 'anestesiologia', 'diagnostico', 'asesoria', 'fonoaudiologia', 'otorrinolaringologia']
const REQUIEREN_AUX = new Set(['oftalmologia', 'anestesiologia', 'otorrinolaringologia'])

const emptyToNull = (v) => (v === '' || v === undefined ? null : v)

const consSchema = z.object({
  siteId: z.preprocess(emptyToNull, z.string().uuid().optional()),
  name: z.string().min(1).max(100),
  specialty: z.enum(ESPECIALIDADES),
  // Servicio secundario opcional (siempre cubierto por un AUXILIAR).
  // Caso típico: anestesiología principal + electrocardiograma alternativo.
  altSpecialty: z.preprocess(emptyToNull, z.enum(ESPECIALIDADES).nullable().optional()),
  active: z.boolean().optional(),
})

export async function list(req, res) {
  const { site_id: sede_id, active: activo } = req.query
  const where = {}
  if (sede_id) where.siteId = sede_id
  if (activo !== undefined) where.active = activo === 'true'
  const list = await prisma.room.findMany({ where })
  // 1) ÁREA ASESORES siempre arriba.  2) Resto: orden natural (2 < 19A < 20 < 20A).
  list.sort(ordenConsultorios)
  res.json(list)
}

export async function create(req, res) {
  const data = consSchema.parse(req.body)
  if (!data.siteId) throw errors.badRequest('sedeId requerido')
  if (data.altSpecialty === data.specialty) data.altSpecialty = null
  const cons = await prisma.room.create({
    data: {
      siteId: data.siteId,
      name: data.name,
      specialty: data.specialty,
      altSpecialty: data.altSpecialty ?? null,
      requiresAssistant: REQUIEREN_AUX.has(data.specialty),
      active: data.active ?? true,
    },
  })
  res.status(201).json(cons)
}

export async function update(req, res) {
  const data = consSchema.partial().parse(req.body)

  // AISLAMIENTO POR SEDE (S-2): esta ruta está abierta a coordinador, y hasta
  // ahora no filtraba nada — se podía renombrar, cambiar de especialidad o
  // desactivar el consultorio de otra sede. Crear y borrar ya eran solo de
  // supervisor; era la edición la que se había quedado abierta.
  const actual = await prisma.room.findUnique({
    where: { id: req.params.id },
    select: { siteId: true, site: { select: { name: true } } },
  })
  if (!actual) throw errors.notFound('Consultorio no encontrado')
  assertSedePermitida(req.user, actual.siteId, actual.site?.name)

  // Y tampoco puede MOVERLO a una sede ajena: sin esto, bastaba con editar
  // sedeId para sacar un consultorio de su sede.
  if (data.siteId && data.siteId !== actual.siteId) {
    assertSedePermitida(req.user, data.siteId)
  }

  if (data.specialty) {
    data.requiresAssistant = REQUIEREN_AUX.has(data.specialty)
  }
  // Evitar guardar la misma especialidad como alternativa (no aporta nada).
  if (data.altSpecialty && data.specialty && data.altSpecialty === data.specialty) {
    data.altSpecialty = null
  }
  const cons = await prisma.room.update({ where: { id: req.params.id }, data })
  res.json(cons)
}

export async function remove(req, res) {
  // Eliminación segura: si tiene asignaciones (histórico o vigente), preferimos
  // desactivar (soft-delete) para preservar trazabilidad de los informes.
  // Solo se borra físicamente si NUNCA tuvo asignaciones.
  const count = await prisma.assignment.count({ where: { roomId: req.params.id } })
  if (count > 0) {
    const cons = await prisma.room.update({
      where: { id: req.params.id },
      data: { active: false },
    })
    return res.json({ ok: true, soft: true, assignments: count, room: cons })
  }
  await prisma.room.delete({ where: { id: req.params.id } })
  res.json({ ok: true, soft: false })
}
