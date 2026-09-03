import { prisma } from '../lib/prisma.js'
import { notificar, notificarSupervisores } from '../services/notificationService.js'
import { registrarAuditoria } from '../middleware/audit.js'
import { programacionLibre } from '../lib/schedulingMode.js'

// Cache del ID del usuario "Sistema" — se resuelve/crea la primera vez que corre
// el job (get-or-create idempotente por email). Se usa como usuarioId en las
// entradas de auditoría de eventos automáticos, dado que la FK Auditoria.usuarioId
// es NOT NULL. El usuario queda inactivo para no aparecer en listados normales.
let _sistemaUserIdCache = null
async function getSistemaUserId() {
  if (_sistemaUserIdCache) return _sistemaUserIdCache
  const EMAIL = 'sistema@sgrc.internal'
  let u = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  if (!u) {
    u = await prisma.user.create({
      data: {
        name: 'Sistema',
        email: EMAIL,
        passwordHash: '$disabled$',   // login bloqueado — nadie puede autenticarse como Sistema
        role: 'supervisor',            // rol técnico para pasar la FK; nunca hace login
        active: false,                // no aparece en listados de usuarios
      },
      select: { id: true },
    })
  }
  _sistemaUserIdCache = u.id
  return u.id
}

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

// Cantidad de días de gracia tras el fin de la semana (sábado) antes de cerrar
// automáticamente. El registro de ejecución cierra el lunes 23:59 siguiente
// (o el siguiente día hábil si el lunes es festivo); esta gracia de 4 días deja
// MARGEN: sábado (día 0) + dom + lun (cierre registro) + mar (gracia) = 4 días.
// Si el lunes es festivo el cierre se corre al martes, y el sistema entraría
// el miércoles (todavía respeta el flujo del coordinador).
const GRACE_DIAS = 4

export async function jobAutoCierreSemana(ahoraOverride = null) {
  // Con programación libre el job se salta por completo. Si no, cada noche a
  // las 2am volvería a cerrar justo las semanas que se abrieron para el cuadre
  // retroactivo, y a la mañana siguiente los coordinadores se encontrarían todo
  // cerrado otra vez sin entender por qué.
  //
  // Al desactivar el modo, la siguiente pasada del job cierra de golpe todas las
  // semanas vencidas que quedaron abiertas — que es el comportamiento correcto.
  if (programacionLibre()) {
    return { cerradas: 0, omitido: 'programación libre activa (PROGRAMACION_LIBRE=true)' }
  }

  const ahora = ahoraOverride ?? new Date()
  const limiteFin = new Date(ahora)
  limiteFin.setDate(limiteFin.getDate() - GRACE_DIAS)

  const candidatas = await prisma.week.findMany({
    where: { status: 'abierta', endDate: { lte: limiteFin } },
    orderBy: { startDate: 'asc' },
  })

  // Resolver una sola vez el usuario "Sistema" para todas las auditorías
  // del run. Si falla, seguimos sin auditar (mejor cerrar sin log que no cerrar).
  let sistemaUserId = null
  try { sistemaUserId = await getSistemaUserId() } catch (e) {
    console.error('[AUTO-CIERRE] No se pudo resolver usuario Sistema:', e.message)
  }

  let cerradas = 0
  const errores = []
  for (const sem of candidatas) {
    try {
      // Cierre POR SEDE: para cada sede con asignaciones en esa semana, crear
      // su CierreSemanaSede con cerradaPor=null (Sistema) — solo si la sede
      // todavía no había sido cerrada manualmente por su coord.
      const sedesConAsigs = await prisma.assignment.findMany({
        where: { weekId: sem.id, status: { not: 'cancelada' } },
        select: { room: { select: { siteId: true } } },
      }).then((rows) => [...new Set(rows.map((r) => r.room.siteId))])
      const yaCerradas = new Set(
        (await prisma.weekSiteClosure.findMany({
          where: { weekId: sem.id }, select: { siteId: true },
        })).map((c) => c.siteId)
      )
      const sedesAcerrar = sedesConAsigs.filter((sid) => !yaCerradas.has(sid))
      for (const sedeId of sedesAcerrar) {
        const cierre = await prisma.weekSiteClosure.create({
          data: { weekId: sem.id, siteId: sedeId, closedBy: null, closedAt: ahora, reason: 'Cierre automático tras período de gracia' },
        })
        // Auditoría por cada sede cerrada por el sistema (fix jul-2026).
        if (sistemaUserId) {
          await registrarAuditoria({
            userId: sistemaUserId,
            action: 'cierre_semana_sede_automatico',
            entity: 'cierre_semana_sede',
            entityId: cierre.id,
            newValue: {
              weekId: sem.id,
              siteId: sedeId,
              startWeek: sem.startDate,
              endWeek: sem.endDate,
              closedAt: ahora,
              graceDias: GRACE_DIAS,
            },
            reason: 'Cierre automático tras período de gracia',
          })
        }
      }
      // Consolidar la semana: una vez que TODAS las sedes con asignaciones tienen
      // cierre, la semana queda en estado='cerrada'.
      await prisma.week.update({
        where: { id: sem.id },
        data: { status: 'cerrada', closedBy: null, closedAt: ahora },
      })
      if (sistemaUserId) {
        await registrarAuditoria({
          userId: sistemaUserId,
          action: 'cierre_semana_consolidada_automatico',
          entity: 'semanas',
          entityId: sem.id,
          oldValue: { status: 'abierta' },
          newValue: { status: 'cerrada', sedesCerradas: sedesAcerrar.length },
          reason: 'Consolidación automática tras cierre de todas las sedes por el sistema',
        })
      }
      cerradas++

      const fmt = (d) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
      const rangoBonito = `${fmt(sem.startDate)} — ${fmt(sem.endDate)}`
      const totalAsigs = await prisma.assignment.count({ where: { weekId: sem.id, status: { not: 'cancelada' } } })

      // Notificar a supervisores con detalle completo
      await notificarSupervisores({
        type: 'cierre_automatico_semana',
        title: `Cierre automático de semana: ${rangoBonito}`,
        message: `<p>El sistema realizó el <strong>cierre automático</strong> de una semana operativa que no fue cerrada manualmente por el coordinador responsable dentro del período de gracia establecido.</p>
        <p>Este cierre garantiza la integridad del registro de ejecución y permite que los informes consolidados de productividad y ausentismo reflejen información definitiva. La semana queda en estado <strong>cerrada</strong> y solo el supervisor podrá modificarla si fuera necesario, dejando registro en auditoría.</p>`,
        contexto: `Notificación del módulo de Cierre de Semana — Política RN-29: Cierre automático tras período de gracia`,
        criticidad: 'media',
        referenceId: sem.id,
        detalles: [
          ['Semana cerrada',         rangoBonito],
          ['Estado anterior',        'Abierta'],
          ['Estado actual',          'Cerrada por el sistema'],
          ['Asignaciones incluidas', `${totalAsigs} asignaciones registradas`],
          ['Días de gracia',         `${GRACE_DIAS} días después del fin de la semana`],
          ['Cerrada por',            'Sistema (cierre automático)'],
          ['Fecha y hora de cierre', new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' })],
        ],
        accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/admin/cierre-semanas`,
        accionTexto: 'Ver detalle del cierre',
      })

      // Notificar a coordinadores de las sedes que tenían asignaciones esa semana
      const asigs = await prisma.assignment.findMany({
        where: { weekId: sem.id },
        include: { room: { select: { siteId: true, site: { select: { name: true } } } } },
      })
      const sedeIds = [...new Set(asigs.map((a) => a.room.siteId))]
      const sedesNombres = [...new Set(asigs.map((a) => a.room.site?.name).filter(Boolean))].join(', ') || '—'
      const vinculos = await prisma.userSite.findMany({
        where: { siteId: { in: sedeIds } },
        include: { user: true },
      })
      const coordinadoresIds = [...new Set(vinculos.filter((v) => v.user.role === 'coordinador' && v.user.active).map((v) => v.userId))]
      for (const usuarioId of coordinadoresIds) {
        await notificar({
          userId: usuarioId,
          type: 'cierre_automatico_semana',
          title: `Tu semana operativa fue cerrada automáticamente: ${rangoBonito}`,
          message: `<p>La semana operativa que tenías asignada fue <strong>cerrada automáticamente</strong> por el sistema, ya que no se realizó el cierre manual dentro del período de gracia establecido (${GRACE_DIAS} días después del fin de la semana).</p>
          <p>A partir de este momento, las asignaciones, ejecuciones y ausencias de esta semana quedan registradas como <strong>definitivas</strong>. Si requieres ajustar algún registro, debes solicitarlo formalmente al supervisor, quien tiene la facultad de reabrir la semana dejando constancia en el log de auditoría.</p>`,
          contexto: `Notificación del módulo de Cierre de Semana — Política RN-29`,
          criticidad: 'alta',
          referenceId: sem.id,
          detalles: [
            ['Semana cerrada',         rangoBonito],
            ['Sede(s) afectadas',      sedesNombres],
            ['Asignaciones de la semana', `${asigs.length}`],
            ['Días de gracia transcurridos', `${GRACE_DIAS}`],
            ['Estado actual',          'Cerrada por el sistema'],
            ['Acción posible',         'Solicitar reapertura al supervisor si requiere ajustes'],
          ],
          accionUrl: `${process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'}/app/programador`,
          accionTexto: 'Abrir el Programador',
        })
      }
    } catch (e) {
      console.error('[AUTO-CIERRE] Error con semana', sem.id, e.message)
      errores.push({ weekId: sem.id, startWeek: sem.startDate, message: e.message })
    }
  }

  // Notificación de fallo (fix jul-2026): antes los errores se comían en
  // console.error sin alertar a nadie. Ahora, si al menos una semana falló su
  // cierre, notificamos a supervisores para que puedan investigar/re-lanzar.
  if (errores.length > 0) {
    try {
      await notificarSupervisores({
        type: 'error_cierre_automatico',
        title: `⚠️ Cierre automático: ${errores.length} semana(s) fallaron`,
        message: `<p>El job de cierre automático de semanas encontró errores procesando ${errores.length} semana(s). Estas semanas <strong>quedan abiertas</strong> hasta que un supervisor las cierre manualmente o el error se resuelva en el próximo run del job (mañana 02:00).</p>
        <p>Revisa los detalles a continuación y contacta al equipo técnico si el error persiste.</p>`,
        contexto: 'Notificación del módulo de Cierre de Semana — el job diario detectó errores',
        criticidad: 'alta',
        detalles: errores.slice(0, 10).map((e) => [
          new Date(e.startWeek).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }),
          e.message,
        ]),
      })
    } catch (notifErr) {
      console.error('[AUTO-CIERRE] Además no se pudo notificar el error:', notifErr.message)
    }
  }

  return { candidatas: candidatas.length, cerradas, errors: errores.length }
}
