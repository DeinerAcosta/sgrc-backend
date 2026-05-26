import { prisma } from '../lib/prisma.js'

/**
 * Registra una entrada en el log de auditoría (HU-S-05, RN-05, RN-34).
 * Se llama desde los controllers cuando hay cambios críticos.
 */
export async function registrarAuditoria({
  usuarioId,
  accion,
  entidad,
  entidadId,
  valorAnterior = null,
  valorNuevo = null,
  motivo = null,
  ipAddress = null,
}) {
  try {
    await prisma.auditoria.create({
      data: {
        usuarioId,
        accion,
        entidad,
        entidadId: String(entidadId),
        valorAnterior,
        valorNuevo,
        motivo,
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
