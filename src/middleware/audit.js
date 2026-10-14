import { prisma } from '../lib/prisma.js'

/**
 * Registra una entrada en el log de auditoría (HU-S-05, RN-05, RN-34).
 * Se llama desde los controllers cuando hay cambios críticos.
 *
 * Devuelve la entrada creada, o `null` si no se pudo guardar.
 *
 * El catch sigue ahí a propósito: dentro de una request, la auditoría no debe
 * tumbar la operación. Pero quien BORRA datos tiene que mirar el valor que
 * devuelve — si es null, el registro no quedó y no hay a qué volver. Oct-2026:
 * se eliminaron 6 ausencias de producción creyendo que la auditoría estaba, y
 * no estaba; el error salía por consola enterrado entre la salida del script.
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
    return await prisma.auditEntry.create({
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
    return null
  }
}

/** Helper para extraer IP de la request */
export const getIp = (req) =>
  req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? req.socket.remoteAddress
