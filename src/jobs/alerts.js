import { prisma } from '../lib/prisma.js'
import { notificar } from '../services/notificationService.js'
import { getSemanaActual } from '../lib/week.js'
import { horasEfectivasFranja } from '../lib/workHours.js'
import { fechaSolo } from '../lib/fechas.js'
import { huellaResumen } from '../lib/resumenHuella.js'
import { etiquetaTipoRecurso } from '../lib/resourceTypes.js'

/**
 * RESUMEN DIARIO PARA EL COORDINADOR (RN-25)
 * ==========================================
 *
 * Un solo correo por coordinador con todo lo que tiene pendiente de programar,
 * en vez de un correo por recurso.
 *
 * POR QUE SE REESCRIBIO (sep-2026). Medido contra produccion:
 *
 *   · 1.530 correos en 7 dias. Un coordinador recibia entre 19 y 31 DIARIOS.
 *   · La alerta de ociosos se disparaba en el 76% de los recursos evaluados
 *     (211 de 277): con tope de 44 h, el umbral de "mas de 4 h libres" marcaba
 *     a todo el que no estuviera al 91% de ocupacion.
 *   · La alerta de consultorios vacios se disparaba en el 56% de los
 *     consultorios activos (131 de 232).
 *
 * Una alerta que se cumple en la mayoria de los casos no avisa de nada: es un
 * censo diario. Y 31 correos al dia del mismo sistema terminan en spam, con lo
 * que tampoco se leen los que si importan.
 *
 * QUE CAMBIO
 *
 * 1. UN correo por coordinador, no uno por recurso.
 * 2. Dos bloques separados, porque son problemas distintos:
 *      - SIN PROGRAMACION (0 h): no es un recurso ocioso, es alguien que no
 *        esta en la agenda. Suele ser dato malo — ya no trabaja ahi, quedo mal
 *        vinculado de sede, o esa sede todavia no programo. Se corrige en el
 *        catalogo, no en el Programador.
 *      - POR COMPLETAR (algo de agenda, por debajo del umbral): ese si es el
 *        caso real de capacidad sin usar.
 * 3. El umbral deja de ser "4 horas" y pasa a ser un PORCENTAJE de utilizacion
 *    configurable desde Metas del sistema (`alerta_utilizacion_min_pct`,
 *    defecto 60), alineado con el KPI "Recursos con tiempo ocioso" del informe
 *    de Tiempos ociosos, que ya usaba < 60%.
 * 4. Solo se manda si la lista CAMBIO respecto al ultimo resumen enviado. La
 *    programacion es semanal y casi no se mueve entre lunes y domingo: antes
 *    el coordinador recibia siete veces la misma lista. La huella se guarda en
 *    `referenceId` de la propia notificacion, asi que no hace falta tabla nueva.
 *
 * Se elimino `jobConsultoriosSinAsignar`. Con 56% de consultorios vacios no
 * informaba nada, y que un consultorio no se use una semana es normal: depende
 * de si el especialista rota o de si la sede tiene agenda esa semana. La
 * ocupacion ya se vigila con un indicador que tiene meta del 80% y que si
 * compara contra algo.
 */

const UMBRAL_PCT_DEFECTO = 60

// Oct-2026 · El mapa se mudó a lib/resourceTypes.js. Esta copia estaba
// completa, pero la de authController.js no — y por eso había que unificarlas.

/** Umbral de utilizacion por debajo del cual se avisa. Editable en Metas del sistema. */
async function umbralPct() {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'alerta_utilizacion_min_pct' } })
    const v = Number(row?.value)
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : UMBRAL_PCT_DEFECTO
  } catch {
    return UMBRAL_PCT_DEFECTO
  }
}

function tabla(filas, columnas) {
  const th = columnas
    .map((c) => `<th align="left" style="padding:6px 10px;border-bottom:2px solid #1B2A6C;font-size:12px">${c}</th>`)
    .join('')
  const tr = filas
    .map((f) => `<tr>${f.map((v) => `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px">${v}</td>`).join('')}</tr>`)
    .join('')
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 16px"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

export async function jobResumenCoordinador() {
  const semana = await getSemanaActual()
  if (!semana) return { ok: true, week: null, correos_enviados: 0, message: 'No hay semana actual' }

  const UMBRAL = await umbralPct()

  const recursos = await prisma.resource.findMany({
    where: { active: true, payScheme: { in: ['fijo', 'mixto'] } },
    select: {
      id: true, name: true, type: true, maxHoursPerWeek: true, leadCoordinatorId: true,
    },
  })

  const asignaciones = await prisma.assignment.findMany({
    where: { weekId: semana.id, status: { not: 'cancelada' } },
    select: {
      resourceId: true, assistantId: true, startTime: true, endTime: true,
      room: { select: { siteId: true } },
    },
  })

  // Ausencia confirmada que solapa la semana → no se reporta: es esperado que
  // no tenga agenda. Antes esto genero friccion real con los coordinadores.
  const conAusencia = new Set((await prisma.absence.findMany({
    where: {
      status: 'confirmada',
      startDate: { lte: semana.endDate },
      endDate: { gte: semana.startDate },
    },
    select: { resourceId: true },
  })).map((a) => a.resourceId))

  const coordinadores = await prisma.user.findMany({
    where: { role: 'coordinador', active: true },
    select: { id: true, name: true, sites: { select: { siteId: true } } },
  })
  const sedesDeCoord = new Map(coordinadores.map((c) => [c.id, new Set(c.sites.map((s) => s.siteId))]))
  const porCoordinador = new Map(coordinadores.map((c) => [c.id, { sinProgramar: [], porCompletar: [] }]))

  let evaluados = 0, saltadosAusencia = 0, saltadosSinTope = 0, sinDestinatario = 0

  for (const r of recursos) {
    if (conAusencia.has(r.id)) { saltadosAusencia++; continue }
    // Sin tope semanal no hay porcentaje que comparar.
    if (!(r.maxHoursPerWeek > 0)) { saltadosSinTope++; continue }
    evaluados++

    const propias = asignaciones.filter((a) => a.resourceId === r.id || a.assistantId === r.id)
    const horas = propias.reduce((acc, a) => acc + horasEfectivasFranja(a.startTime, a.endTime, r.type), 0)
    const pct = Math.round((horas / r.maxHoursPerWeek) * 100)
    if (horas > 0 && pct >= UMBRAL) continue

    // A quien le toca:
    //   1. su coordinador lider, si lo tiene
    //   2. si no, los coordinadores de las sedes donde TIENE asignaciones
    //   3. si no tiene ni lider ni asignaciones, nadie — el supervisor lo ve en
    //      el catalogo. Mandarselo a todos los coordinadores de la sede era
    //      spam de personal ajeno, reportado por un coordinador en su momento.
    let destinos
    if (r.leadCoordinatorId && porCoordinador.has(r.leadCoordinatorId)) {
      destinos = [r.leadCoordinatorId]
    } else {
      const sedesConAsig = new Set(propias.map((a) => a.room.siteId))
      destinos = coordinadores
        .filter((c) => [...sedesDeCoord.get(c.id)].some((s) => sedesConAsig.has(s)))
        .map((c) => c.id)
    }
    if (destinos.length === 0) { sinDestinatario++; continue }

    const fila = {
      id: r.id,
      nombre: r.name,
      tipo: etiquetaTipoRecurso(r.type),
      horas: Math.round(horas * 10) / 10,
      tope: r.maxHoursPerWeek,
      pct,
    }
    for (const d of destinos) {
      porCoordinador.get(d)[horas === 0 ? 'sinProgramar' : 'porCompletar'].push(fila)
    }
  }

  const periodo = `${fechaSolo(semana.startDate)} — ${fechaSolo(semana.endDate)}`
  const FRONT = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'https://gestionderecursos.ttncompany.com'

  let correos = 0, sinCambios = 0, sinPendientes = 0

  for (const coord of coordinadores) {
    const { sinProgramar, porCompletar } = porCoordinador.get(coord.id)
    if (sinProgramar.length === 0 && porCompletar.length === 0) { sinPendientes++; continue }

    sinProgramar.sort((a, b) => a.nombre.localeCompare(b.nombre))
    porCompletar.sort((a, b) => a.pct - b.pct)

    const firma = huellaResumen(semana.id, sinProgramar, porCompletar)
    const ultimo = await prisma.notification.findFirst({
      where: { userId: coord.id, type: 'resumen_coordinador' },
      orderBy: { createdAt: 'desc' },
      select: { referenceId: true },
    })
    if (ultimo?.referenceId === firma) { sinCambios++; continue }

    const total = sinProgramar.length + porCompletar.length
    let cuerpo = `<p>Resumen de tu equipo para la semana <strong>${periodo}</strong>. Tienes <strong>${total} recurso(s)</strong> con capacidad sin usar.</p>`

    if (sinProgramar.length) {
      cuerpo += `<p style="margin-top:18px"><strong>Sin programación (${sinProgramar.length})</strong> — no tienen ninguna asignación esta semana. Si alguno ya no trabaja contigo o quedó mal vinculado de sede, corrígelo en el catálogo de recursos.</p>`
      cuerpo += tabla(
        sinProgramar.map((r) => [r.nombre, r.tipo, `${r.tope} h`]),
        ['Recurso', 'Tipo', 'Tope semanal'],
      )
    }
    if (porCompletar.length) {
      cuerpo += `<p style="margin-top:18px"><strong>Por completar (${porCompletar.length})</strong> — están programados por debajo del ${UMBRAL}% de su tope semanal.</p>`
      cuerpo += tabla(
        porCompletar.map((r) => [
          r.nombre, r.tipo, `${r.horas} h de ${r.tope} h`,
          `<strong style="color:${r.pct < UMBRAL / 2 ? '#dc2626' : '#b45309'}">${r.pct}%</strong>`,
        ]),
        ['Recurso', 'Tipo', 'Horas asignadas', 'Utilización'],
      )
    }

    await notificar({
      userId: coord.id,
      type: 'resumen_coordinador',
      title: `Tu equipo: ${total} recurso(s) por programar — semana ${periodo}`,
      message: cuerpo,
      contexto: 'Resumen diario del módulo de Productividad — Regla de Negocio RN-25',
      criticidad: sinProgramar.length > 0 ? 'alta' : 'media',
      // La huella viaja en referenceId: es lo que compara la proxima corrida
      // para no repetir la misma lista todos los dias.
      referenceId: firma,
      accionUrl: `${FRONT}/app/programador`,
      accionTexto: 'Abrir el Programador',
    })
    correos++
  }

  return {
    ok: true,
    week: semana.id,
    umbral_pct: UMBRAL,
    recursos_evaluados: evaluados,
    saltados_por_ausencia: saltadosAusencia,
    saltados_sin_tope: saltadosSinTope,
    sin_destinatario: sinDestinatario,
    coordinadores: coordinadores.length,
    correos_enviados: correos,
    sin_cambios_desde_ayer: sinCambios,
    sin_pendientes: sinPendientes,
  }
}
