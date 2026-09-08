import { prisma } from '../lib/prisma.js'

/**
 * Registra una entrada en el log de auditoría (HU-S-05, RN-05, RN-34).
 * Se llama desde los controllers cuando hay cambios críticos.
 */
export async function registrarAuditoria({
  userId: usuarioId,
  action: accion,
  entity: entidad,
  entityId: entidadId,
  oldValue: valorAnterior = null,
  newValue: valorNuevo = null,
  reason: motivo = null,
  ipAddress = null,
}) {
  try {
    await prisma.auditEntry.create({
      data: {
        userId: usuarioId,
        action: accion,
        entity: entidad,
        entityId: String(entidadId),
        oldValue: valorAnterior,
        newValue: valorNuevo,
        reason: motivo,
        ipAddress,
      },
    })
  } catch (e) {
    // La auditoría nunca debe tumbar la operación principal
    console.error('[AUDITORIA] No se pudo registrar:', e.message)
  }
}

/** Helper para extraer IP de la request */
export const getIp = (req) =>
  req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? req.socket.remoteAddress
