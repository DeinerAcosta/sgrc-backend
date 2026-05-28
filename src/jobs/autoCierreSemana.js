import { prisma } from '../lib/prisma.js'
import { notificar, notificarSupervisores } from '../services/notificacionService.js'

/**
 * Cierre automático de semanas vencidas.
 *
 * Regla: si una semana lleva >= GRACE_DIAS días pasada su fecha_fin y sigue
 * abierta, el sistema la cierra automáticamente. El campo `cerrada_por` se
 * guarda como NULL (interpretado como "Sistema") y `cerrada_en` se llena.
 *
 * Se notifica:
 *   - A los supervisores (alerta de gestión).
 *   - A los coordinadores de las sedes con asignaciones en esa semana, para
 *     que estén al tanto del cierre automático.
 *
 * Se ejecuta todos los días a las 02:00 America/Bogota (job programado).
 */

// Cantidad de días de gracia tras el fin de la semana antes de cerrar automáticamente.
// El cierre del registro de ejecución ya ocurre el viernes 23:59 (RN). Esta gracia da
// margen al coordinador para cerrar manualmente antes de que entre el sistema.
const GRACE_DIAS = 3

export async function jobAutoCierreSemana(ahoraOverride = null) {
  const ahora = ahoraOverride ?? new Date()
  const limiteFin = new Date(ahora)
  limiteFin.setDate(limiteFin.getDate() - GRACE_DIAS)

  const candidatas = await prisma.semana.findMany({
    where: { estado: 'abierta', fechaFin: { lte: limiteFin } },
    orderBy: { fechaInicio: 'asc' },
  })

  let cerradas = 0
  for (const sem of candidatas) {
    try {
      // cerradaPor = NULL → el frontend lo interpreta como "Sistema"
      await prisma.semana.update({
        where: { id: sem.id },
        data: { estado: 'cerrada', cerradaPor: null, cerradaEn: ahora },
      })
      cerradas++

      const rango = `${sem.fechaInicio.toISOString().slice(0, 10)} → ${sem.fechaFin.toISOString().slice(0, 10)}`

      // Notificar a supervisores
      await notificarSupervisores({
        tipo: 'cierre_automatico_semana',
        titulo: 'Cierre automático de semana',
        mensaje: `El sistema cerró automáticamente la semana ${rango} (sin cierre manual del coordinador tras ${GRACE_DIAS} días de gracia). Responsable: Sistema.`,
        criticidad: 'media',
        referenciaId: sem.id,
      })

      // Notificar a coordinadores de las sedes que tenían asignaciones esa semana
      const asigs = await prisma.asignacion.findMany({
        where: { semanaId: sem.id },
        include: { consultorio: { select: { sedeId: true } } },
      })
      const sedeIds = [...new Set(asigs.map((a) => a.consultorio.sedeId))]
      const vinculos = await prisma.usuarioSede.findMany({
        where: { sedeId: { in: sedeIds } },
        include: { usuario: true },
      })
      const coordinadoresIds = [...new Set(vinculos.filter((v) => v.usuario.rol === 'coordinador' && v.usuario.activo).map((v) => v.usuarioId))]
      for (const usuarioId of coordinadoresIds) {
        await notificar({
          usuarioId,
          tipo: 'cierre_automatico_semana',
          titulo: 'Tu semana fue cerrada automáticamente',
          mensaje: `La semana ${rango} se cerró automáticamente porque no la cerraste a tiempo. Si necesitas modificarla solicita al supervisor.`,
          criticidad: 'alta',
          referenciaId: sem.id,
        })
      }
    } catch (e) {
      console.error('[AUTO-CIERRE] Error con semana', sem.id, e.message)
    }
  }

  return { candidatas: candidatas.length, cerradas }
}
