// QA · El flujo completo de ausencias y reprogramacion, por API.
// Cada caso dice que se esperaba y que paso. No escribe nada que no limpie.
//
// Oct-2026 · Esa última frase no era cierta: la prueba de "la líder puede
// repartir" asignaba el caso de verdad y nunca lo deshacía, así que cada
// corrida dejaba un caso repartido en los datos. Ahora se guarda el estado
// antes y se devuelve contra la base al terminar.
import { PrismaClient, Prisma } from '@prisma/client'
import { horaDeCorte } from '../../src/lib/tramos.js'
const prisma = new PrismaClient()
const API = 'http://localhost:3001/api'
let ok = 0, mal = 0
const avisos = []

const prueba = (nombre, cond, detalle = '') => {
  if (cond) { ok++; console.log('  PASA  ' + nombre) }
  else { mal++; console.log('  FALLA ' + nombre + (detalle ? '\n          ' + detalle : '')) }
}
const aviso = (t) => { avisos.push(t); console.log('  ojo   ' + t) }

async function login(email) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin123' }),
  })
  if (!r.ok) return null
  return (await r.json()).token
}
const get = async (t, p) => {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const put = async (t, p, body) => {
  const r = await fetch(API + p, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const post = async (t, p, body) => {
  const r = await fetch(API + p, {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const del = async (t, p) => {
  const r = await fetch(API + p, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } })
  return { status: r.status }
}

async function main() {
  console.log('QA · FLUJO DE AUSENCIAS Y REPROGRAMACIÓN')
  console.log('='.repeat(72))

  // ---------------------------------------------------------------- acceso
  console.log('\n1 · ACCESO')
  const tok = {}
  for (const [rol, mail] of Object.entries({
    gerencia: 'gerencia@cofca.co', coordinador: 'maria.lopez@cofca.co',
    // María Duarte es la líder y entra como supervisor desde oct-2026; el rol
    // reprogramador es el de quien recibe el encargo y llama.
    supervisor: 'supervisor@cofca.co', lider: 'duarte@cofca.co',
    reprogramador: 'repro1@prueba.local', recurso: 'angela.sarmiento@cofca.co',
  })) {
    tok[rol] = await login(mail)
    prueba(`entra ${rol}`, !!tok[rol])
  }

  // -------------------------------------------------------- datos de base
  console.log('\n2 · DATOS DE LA SEMANA EN CURSO')
  const semanas = (await get(tok.gerencia, '/weeks')).body
  const lista = Array.isArray(semanas) ? semanas : (semanas?.data ?? [])
  const hoy = new Date()
  const semana = lista.find((w) => new Date(w.start_date) <= hoy && hoy <= new Date(w.end_date))
  prueba('existe la semana en curso', !!semana, 'sin ella el Programador abre vacío')
  if (!semana) return

  const aus = (await get(tok.gerencia, `/weeks/${semana.id}/absences`)).body
  prueba('hay ausencias en la semana', (aus?.ausencias ?? []).length > 0)
  const conDias = (aus?.ausencias ?? []).every((a) => Array.isArray(a.dias) && a.dias.length > 0)
  prueba('cada ausencia trae los días que cubre', conDias, 'sin esto no se pintan las casillas rojas')

  // ------------------------------------------------------- lista y estados
  console.log('\n3 · LOS DOS ESTADOS (ausencia vs gestión)')
  const todas = (await get(tok.gerencia, '/absences')).body
  const arr = Array.isArray(todas) ? todas : (todas?.data ?? [])
  prueba('el listado trae reschedule_status', arr.some((a) => 'reschedule_status' in a),
    'la pestaña "Por gestionar" lo necesita')
  const confirmadasSinGestionar = arr.filter(
    (a) => a.status === 'confirmada' && (a.patients_affected ?? 0) > 0 && a.reschedule_status !== 'resuelta')
  prueba('hay confirmadas que siguen por gestionar', confirmadasSinGestionar.length > 0,
    'es el caso que antes se escondía')

  // --------------------------------------------------------- el caso
  console.log('\n4 · LA PANTALLA DEL CASO')
  // Un caso de PROFESIONAL, a propósito. Con datos variados, "la primera
  // confirmada" podía ser un técnico, y entonces la prueba de permisos de abajo
  // ("un coordinador no puede cerrar el caso") fallaba con razón —el técnico
  // SÍ es del coordinador— y encima lo cerraba de verdad en la base.
  const PROFESIONALES = new Set(['oftalmologo', 'optometra', 'anestesiologo', 'otorrino', 'fonoaudiologa'])
  const caso = (aus.ausencias ?? []).find((a) =>
    a.dias?.length && a.status === 'confirmada' && PROFESIONALES.has(a.resource?.type) && (a.patients_affected ?? 0) > 0)
  const ctx = (await get(tok.gerencia, `/absences/${caso.id}/replacement-context`)).body
  prueba('devuelve la cuenta del caso', !!ctx?.cuenta)
  prueba('devuelve la fecha exacta, no solo el día', (ctx?.ausencia?.fechas ?? []).length > 0)
  prueba('las franjas traen sede y consultorio',
    (ctx?.franjas ?? []).every((f) => f.site?.name && f.room?.name))
  prueba('las franjas traen los coordinadores de la sede',
    (ctx?.franjas ?? []).every((f) => Array.isArray(f.coordinadores)))
  if ((ctx?.franjas ?? []).some((f) => (f.coordinadores ?? []).length === 0)) {
    aviso('alguna sede no tiene coordinador asignado (dato real, no bug)')
  }

  // ------------------------------------------------------- candidatos
  console.log('\n5 · CANDIDATOS')
  const f0 = ctx.franjas[0]
  const q = new URLSearchParams({
    type: ctx.ausencia.resource.type, day: f0.weekday, start_time: f0.start_time,
    end_time: f0.end_time, city: f0.site.city, week_id: f0.week_id, room_id: f0.room_id,
  })
  const cand = (await get(tok.gerencia, '/resources/suggested?' + q)).body
  prueba('hay candidatos para la franja', (cand ?? []).length > 0,
    'con 0 la pantalla parece rota aunque esté bien')
  prueba('cada candidato dice dónde está ese día',
    (cand ?? []).every((c) => Array.isArray(c.ocupacion_ese_dia)))
  if (!(cand ?? []).some((c) => c.misma_sede)) aviso('ningún candidato es de la misma sede: el grupo verde sale vacío')

  // -------------------------------------------- permisos de reprogramacion
  console.log('\n6 · PERMISOS')
  const repros = (await get(tok.gerencia, '/users/reschedulers')).body
  prueba('hay reprogramadores para asignar', (repros ?? []).length > 0)

  // PRIMERO CUBRIR, DESPUÉS REPARTIR (decisión de Hector). Se buscan dos
  // casos sin repartir: uno con nada cubierto y otro con algo cubierto.
  const sinRepartir = arr.filter((x) => x.status === 'confirmada' && PROFESIONALES.has(x.resource?.type) &&
    (x.patients_affected ?? 0) > 0 && !x.rescheduler_id && x.reschedule_status !== 'resuelta')
  const sinCubrir = sinRepartir.find((x) => (x.patients_covered ?? 0) === 0)
  const conCubierto = sinRepartir.find((x) => (x.patients_covered ?? 0) > 0)

  if (sinCubrir) {
    const r = await put(tok.lider, `/absences/${sinCubrir.id}/rescheduler`,
      { rescheduler_id: repros[0].id, notes: 'QA' })
    prueba('NO deja repartir un caso sin nada cubierto', r.status >= 400 && /Primero cubre/.test(r.body?.message ?? ''),
      `HTTP ${r.status} · ${r.body?.message ?? ''}`)
  } else {
    aviso('no hay un caso sin cubrir para probar que no se pueda repartir')
  }

  if (conCubierto) {
    // Se guarda tal cual para devolverlo después: esta prueba SÍ escribe.
    const antes = await prisma.absence.findUnique({
      where: { id: conCubierto.id },
      select: { reschedulerId: true, assignedBy: true, assignedAt: true, rescheduleStatus: true, rescheduleNotes: true },
    })
    const malDestinatario = await put(tok.gerencia, `/absences/${conCubierto.id}/rescheduler`,
      { rescheduler_id: '00000000-0000-0000-0000-000000000000' })
    prueba('rechaza asignar a alguien que no existe', malDestinatario.status >= 400)

    const r = await put(tok.lider, `/absences/${conCubierto.id}/rescheduler`,
      { rescheduler_id: repros[0].id, notes: 'QA' })
    prueba('la líder reparte un caso que ya tiene algo cubierto', r.status < 400,
      `HTTP ${r.status} · ${r.body?.message ?? ''}`)
    await prisma.absence.update({ where: { id: conCubierto.id }, data: antes })
  } else {
    aviso('no hay un caso con algo cubierto y sin repartir para probar el reparto')
  }

  const cerrarAjeno = await put(tok.coordinador, `/absences/${caso.id}/rescheduler/done`)
  prueba('un coordinador no puede cerrar el caso de un profesional', cerrarAjeno.status >= 400)

  // ------------------------------------------------------ RN-08 y excepcion
  console.log('\n7 · RN-08 Y SU EXCEPCIÓN')
  const asigs = (await get(tok.gerencia, `/assignments?week_id=${semana.id}`)).body
  // En la MISMA CIUDAD que la franja que se cayó, y no el propio ausente.
  //
  // Sin lo de la ciudad el guión elegía a alguien de Barranquilla para cubrir
  // en Santa Marta, y lo que rebotaba no era RN-08 sino RN-09 (nadie está en
  // dos ciudades el mismo día). Daba un falso negativo que parecía un fallo
  // de la excepción: asumir la agenda de un colega es dentro de la ciudad.
  //
  // Se recorren TODAS las franjas del caso, no solo la primera: con una sola
  // el guión se quedaba sin pareja válida y saltaba la prueba entera, que es
  // peor que fallar — deja de mirar la regla sin decirlo.
  //
  // Y se recorren TODOS los casos, no solo el primero. Con datos regenerados
  // el primer caso cayó en una ciudad sin otro médico de su tipo ese día, y la
  // prueba de RN-08 entera se saltó: 31 comprobaciones en vez de 34, en verde.
  let ocupado = null
  let fRN08 = f0
  let casoRN08 = caso
  const confirmadasProf = (aus.ausencias ?? []).filter((x) =>
    x.status === 'confirmada' && PROFESIONALES.has(x.resource?.type))
  for (const cx of confirmadasProf) {
    const ctxx = cx.id === caso.id ? ctx : (await get(tok.gerencia, `/absences/${cx.id}/replacement-context`)).body
    for (const f of (ctxx?.franjas ?? [])) {
      const cand = (asigs ?? []).find((a) =>
        a.weekday === f.weekday &&
        a.resource?.type === ctxx.ausencia.resource.type &&
        a.resource?.id !== ctxx.ausencia.resource.id &&
        a.room?.site?.city === f.site?.city
      )
      if (cand) { ocupado = cand; fRN08 = f; casoRN08 = cx; break }
    }
    if (ocupado) break
  }
  if (ocupado) {
    const base = {
      week_id: fRN08.week_id, room_id: fRN08.room_id, resource_id: ocupado.resource.id,
      weekday: fRN08.weekday, start_time: ocupado.start_time, end_time: ocupado.end_time,
      is_replacement: true, covered_absence_id: casoRN08.id,
    }
    const sinFlag = await post(tok.gerencia, '/assignments', base)
    prueba('sin la confirmación, RN-08 bloquea el doble turno', sinFlag.status >= 400)

    const conFlag = await post(tok.gerencia, '/assignments', { ...base, assume_overlap: true })
    prueba('con la confirmación, lo permite', conFlag.status < 400)
    if (conFlag.status < 400) {
      const tras = (await get(tok.gerencia, `/absences/${casoRN08.id}/replacement-context`)).body
      prueba('la cuenta sube al asignar', (tras?.cuenta?.pacientes_cubiertos ?? 0) > 0)
      await del(tok.gerencia, `/assignments/${conFlag.body.id}`)   // se deja como estaba
    }
  } else {
    aviso('no encontré un profesional ocupado ese día para probar RN-08')
  }

  // ------------------------------------------ cambiar de médico, de verdad
  // Oct-2026 · Esta sección existe porque la de arriba pasaba en verde
  // mientras la pantalla fallaba con TODOS los candidatos. La diferencia: la
  // pantalla manda la AUXILIAR de la franja (`assistant_id`) y la prueba no.
  // La validación de auxiliar comparaba contra el turno del ausente —el mismo
  // que se cayó— y lo daba por "auxiliar en dos sitios a la vez".
  //
  // Aquí se manda exactamente lo que manda Candidatos en ReplacementPage.
  console.log('\n7b · CAMBIAR DE MÉDICO CON LA MISMA AUXILIAR (como la pantalla)')
  const comoLista = (b) => (Array.isArray(b) ? b : (b?.data ?? []))
  const ciudadDe = new Map(comoLista((await get(tok.gerencia, '/sites')).body).map((s) => [s.id, s.city]))
  const salasAux = comoLista((await get(tok.gerencia, '/rooms')).body)
    .filter((r) => r.requires_assistant && r.active !== false)
  // Se prefiere una franja en una ciudad con OTRO consultorio con auxiliar:
  // sin él no se puede hacer el control de abajo, y una prueba que se salta
  // su propio control mide la mitad.
  const hayOtraSala = (fr) => salasAux.some((r) => r.id !== fr.room_id && ciudadDe.get(r.site_id) === fr.site?.city)
  let conAux = null
  let sinControl = null
  for (const a of (aus.ausencias ?? [])) {
    if (a.status !== 'confirmada' || !PROFESIONALES.has(a.resource?.type)) continue
    const c = (await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body
    // Y con sus pacientes todavía por reprogramar. Un caso puede tener la
    // franja sin cubrir y los pacientes ya movidos a otro horario: ahí el tope
    // de pacientes deja el tramo en 0, con razón, y 7c mediría otra cosa.
    const pendientes = c?.cuenta?.pacientes_pendientes ?? 0
    for (const fr of (c?.franjas ?? []).filter((x) => x.assistant_id && !x.reemplazo && pendientes >= (x.patient_capacity ?? 0))) {
      if (hayOtraSala(fr)) { conAux = { a, c, fr }; break }
      sinControl ??= { a, c, fr }
    }
    if (conAux) break
  }
  conAux ??= sinControl
  if (!conAux) {
    aviso('no encontré una franja caída con auxiliar para probar el reemplazo')
  } else {
    const { a, c, fr } = conAux
    const qa = new URLSearchParams({
      type: c.ausencia.resource.type, day: fr.weekday, start_time: fr.start_time,
      end_time: fr.end_time, city: fr.site.city, week_id: fr.week_id, room_id: fr.room_id,
    })
    const cands = (await get(tok.gerencia, '/resources/suggested?' + qa)).body ?? []
    if (cands.length < 2) {
      aviso('esa franja no tiene dos candidatos para probar')
    } else {
      const reemplazo = await post(tok.gerencia, '/assignments', {
        week_id: fr.week_id, room_id: fr.room_id, resource_id: cands[0].id,
        assistant_id: fr.assistant_id,
        weekday: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
        is_replacement: true, covered_absence_id: a.id,
      })
      prueba('asigna el reemplazo con la auxiliar que ya estaba', reemplazo.status < 400,
        `HTTP ${reemplazo.status} · ${JSON.stringify(reemplazo.body ?? '').slice(0, 160)}`)
      if (reemplazo.status < 400) await del(tok.gerencia, `/assignments/${reemplazo.body.id}`)

      // Oct-2026 · RN-24 y 3583: el turno de un oftalmólogo, anestesiólogo u
      // otorrino ausente no se atiende, así que su auxiliar queda LIBRE para
      // otra sala (es la prioridad 1 para cubrir a otra auxiliar). Antes esta
      // prueba esperaba lo contrario. Con otro tipo de médico, sigue ocupada.
      // Otro consultorio con auxiliar en la MISMA CIUDAD: así lo único que
      // puede decidirlo es el doble turno de la auxiliar, no RN-09.
      const LIBERAN = ['oftalmologo', 'anestesiologo', 'otorrino']
      const otra = salasAux.find((r) => r.id !== fr.room_id && ciudadDe.get(r.site_id) === fr.site.city)
      if (otra) {
        const libera = LIBERAN.includes(c.ausencia.resource.type)
        const otraSala = await post(tok.gerencia, '/assignments', {
          week_id: fr.week_id, room_id: otra.id, resource_id: cands[1].id,
          assistant_id: fr.assistant_id,
          weekday: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
        })
        prueba(libera
          ? 'la auxiliar del médico ausente queda libre para otra sala (RN-24)'
          : 'la auxiliar de este tipo de médico sigue ocupada aunque él falte',
        libera ? otraSala.status < 400 : otraSala.status >= 400,
        `HTTP ${otraSala.status} · ${JSON.stringify(otraSala.body ?? '').slice(0, 160)}`)
        if (otraSala.status < 400) await del(tok.gerencia, `/assignments/${otraSala.body.id}`)
      } else {
        aviso('no hay otro consultorio con auxiliar en esa sede para el control')
      }
    }
  }

  // ---------------------------------------- partir la franja por horas
  // Oct-2026 · Hector: "si ese no puede reprogramar todos, sino dividirlo
  // dentro de más de un médico, ¿cómo sería?". Eligió partir la franja POR
  // HORAS: cada médico toma un tramo en el mismo consultorio y cada paciente
  // conserva su hora. Antes, con el primer médico la franja ya salía
  // "cubierta" aunque tomara solo una parte, y no había forma de poner a otro.
  console.log('\n7c · PARTIR LA FRANJA POR HORAS ENTRE DOS MÉDICOS')
  const aMin = (h) => { const [x, y] = h.split(':').map(Number); return x * 60 + y }
  const aHH = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  if (!conAux || aMin(conAux.fr.end_time) - aMin(conAux.fr.start_time) < 60) {
    aviso('no hay una franja de al menos una hora para partir')
  } else {
    const { a, c, fr } = conAux
    const mitad = aHH(Math.round((aMin(fr.start_time) + aMin(fr.end_time)) / 2 / 15) * 15)
    const libres = async (ini, fin) => (await get(tok.gerencia, '/resources/suggested?' + new URLSearchParams({
      type: c.ausencia.resource.type, day: fr.weekday, start_time: ini, end_time: fin,
      city: fr.site.city, week_id: fr.week_id, room_id: fr.room_id,
    }))).body ?? []
    const tramo = (rid, ini, fin) => post(tok.gerencia, '/assignments', {
      week_id: fr.week_id, room_id: fr.room_id, resource_id: rid, assistant_id: fr.assistant_id,
      weekday: fr.weekday, start_time: ini, end_time: fin, is_replacement: true, covered_absence_id: a.id,
    })
    const creados = []
    const estado = async () => ((await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body?.franjas ?? [])
      .find((x) => x.assignment_id === fr.assignment_id)

    const A = (await libres(fr.start_time, mitad))[0]
    const r1 = A ? await tramo(A.id, fr.start_time, mitad) : { status: 0 }
    if (r1.status < 400 && r1.body?.id) creados.push(r1.body.id)
    prueba(`primer tramo ${fr.start_time}-${mitad}`, r1.status === 201, `HTTP ${r1.status} · ${JSON.stringify(r1.body ?? '').slice(0, 140)}`)

    let e = await estado()
    prueba('con un solo tramo la franja NO sale cubierta', e?.cubierta === false && !e?.reemplazo)
    prueba(`queda pendiente ${mitad}-${fr.end_time}`,
      e?.huecos?.length === 1 && e.huecos[0].start_time === mitad && e.huecos[0].end_time === fr.end_time,
      JSON.stringify(e?.huecos))

    const B = (await libres(mitad, fr.end_time)).find((x) => x.id !== A?.id)
    const pisa = B ? await tramo(B.id, fr.start_time, fr.end_time) : { status: 0 }
    if (pisa.status < 400 && pisa.body?.id) creados.push(pisa.body.id)
    prueba('rechaza un tramo que pisa al primero, y dice por qué', pisa.status === 409 && /ya lo cubre/.test(pisa.body?.message ?? ''),
      `HTTP ${pisa.status} · ${pisa.body?.message ?? ''}`)

    const r2 = B ? await tramo(B.id, mitad, fr.end_time) : { status: 0 }
    if (r2.status < 400 && r2.body?.id) creados.push(r2.body.id)
    prueba(`segundo tramo ${mitad}-${fr.end_time}`, r2.status === 201, `HTTP ${r2.status} · ${JSON.stringify(r2.body ?? '').slice(0, 140)}`)

    e = await estado()
    const suma = (e?.tramos ?? []).reduce((n, t) => n + (t.patient_capacity ?? 0), 0)
    prueba('con los dos tramos la franja queda cubierta', e?.cubierta === true && (e?.huecos?.length ?? 1) === 0)
    prueba('los tramos suman exactamente los pacientes de la franja', suma === fr.patient_capacity,
      `${suma} de ${fr.patient_capacity}`)

    for (const id of creados) await del(tok.gerencia, `/assignments/${id}`)   // se deja como estaba
  }

  // ---------------------------- repartir la jornada por pacientes (ventana)
  // Oct-2026 · Hector: "cuando presiono Asignar me debe salir un modal
  // diciendo cuántos pacientes puede, y así poder seleccionar a más de uno".
  // Aquí se manda exactamente lo que manda esa ventana: desde el inicio de lo
  // que falta, hasta la hora que da horaDeCorte, con los pacientes elegidos.
  console.log('\n7c2 · REPARTIR LA JORNADA POR PACIENTES (como la ventana de Asignar)')
  if (!conAux || (conAux.fr.patient_capacity ?? 0) < 3) {
    aviso('no hay una jornada con al menos 3 pacientes para repartir')
  } else {
    const { a, c, fr } = conAux
    const P = fr.patient_capacity
    const franjaH = { desde: fr.start_time, hasta: fr.end_time }
    const libres = async (ini, fin) => (await get(tok.gerencia, '/resources/suggested?' + new URLSearchParams({
      type: c.ausencia.resource.type, day: fr.weekday, start_time: ini, end_time: fin,
      city: fr.site.city, week_id: fr.week_id, room_id: fr.room_id,
    }))).body ?? []
    const asignarN = (rid, desde, n, hasta) => post(tok.lider, '/assignments', {
      week_id: fr.week_id, room_id: fr.room_id, resource_id: rid, assistant_id: fr.assistant_id,
      weekday: fr.weekday, start_time: desde, end_time: hasta, expected_patients: n,
      is_replacement: true, covered_absence_id: a.id,
    })
    const estado = async () => ((await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body?.franjas ?? [])
      .find((x) => x.assignment_id === fr.assignment_id)
    const creados = []

    const n1 = Math.max(1, Math.floor(P * 0.6))
    const corte = horaDeCorte(P, franjaH, fr.start_time, n1)
    const A = (await libres(fr.start_time, fr.end_time))[0]
    const r1 = A ? await asignarN(A.id, fr.start_time, n1, corte) : { status: 0 }
    if (r1.body?.id) creados.push(r1.body.id)
    prueba(`el primer médico toma ${n1} de ${P} (${fr.start_time}–${corte})`,
      r1.status === 201 && r1.body?.patient_capacity === n1,
      `HTTP ${r1.status} · ${r1.body?.message ?? 'guardó ' + r1.body?.patient_capacity}`)

    let e = await estado()
    prueba(`quedan ${P - n1} pacientes para otro médico`,
      e?.cubierta === false && e?.huecos?.length === 1 && e.huecos[0].pacientes === P - n1 && e.huecos[0].start_time === corte,
      JSON.stringify(e?.huecos))

    const B = (await libres(corte, fr.end_time)).find((x) => x.id !== A?.id)
    const r2 = B ? await asignarN(B.id, corte, P - n1, fr.end_time) : { status: 0 }
    if (r2.body?.id) creados.push(r2.body.id)
    prueba(`un segundo médico toma los ${P - n1} restantes`, r2.status === 201,
      `HTTP ${r2.status} · ${r2.body?.message ?? ''}`)

    e = await estado()
    const suma = (e?.tramos ?? []).reduce((n, t) => n + (t.patient_capacity ?? 0), 0)
    prueba('con los dos la jornada queda cubierta y suman todos los pacientes',
      e?.cubierta === true && suma === P, `${suma} de ${P} · cubierta ${e?.cubierta}`)

    for (const id of creados) await del(tok.gerencia, `/assignments/${id}`)   // se deja como estaba
  }

  // ------------------------------------- tope de pacientes al reprogramar
  // Oct-2026 · Hector: "en pacientes reales no aceptar una cantidad mayor a
  // la que debe ser repro: si son 20, bloquear 21 en adelante". La ventana lo
  // bloquea; esto comprueba que el servidor también, al crear y al editar.
  console.log('\n7d · TOPE DE PACIENTES AL REPROGRAMAR')
  if (!conAux) {
    aviso('sin franja caída no hay con qué probar el tope')
  } else {
    const { a, c, fr } = conAux
    const pend = (await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body?.cuenta?.pacientes_pendientes ?? 0
    const [cand] = (await get(tok.gerencia, '/resources/suggested?' + new URLSearchParams({
      type: c.ausencia.resource.type, day: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
      city: fr.site.city, week_id: fr.week_id, room_id: fr.room_id,
    }))).body ?? []
    if (pend < 2 || !cand) {
      aviso(`no hay caso con pacientes pendientes y candidato libre (pendientes ${pend})`)
    } else {
      const cuerpo = (n) => ({
        week_id: fr.week_id, room_id: fr.room_id, resource_id: cand.id, assistant_id: fr.assistant_id,
        weekday: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
        is_replacement: true, covered_absence_id: a.id, expected_patients: n,
      })
      const deMas = await post(tok.gerencia, '/assignments', cuerpo(pend + 1))
      if (deMas.status < 400 && deMas.body?.id) await del(tok.gerencia, `/assignments/${deMas.body.id}`)
      prueba(`con ${pend} por reprogramar rechaza ${pend + 1}, y dice por qué`,
        deMas.status === 400 && /por reprogramar/.test(deMas.body?.message ?? ''),
        `HTTP ${deMas.status} · ${deMas.body?.message ?? ''}`)

      const uno = await post(tok.gerencia, '/assignments', cuerpo(1))
      prueba('acepta una cantidad dentro del tope', uno.status === 201,
        `HTTP ${uno.status} · ${JSON.stringify(uno.body ?? '').slice(0, 140)}`)
      if (uno.status === 201) {
        // Al editar, el turno no cuenta contra sí mismo: puede subir hasta el
        // total que faltaba, no hasta "lo que falta menos lo que ya tiene".
        const alTope = await put(tok.gerencia, `/assignments/${uno.body.id}`, cuerpo(pend))
        prueba(`al editar deja subir hasta ${pend}`, alTope.status < 400,
          `HTTP ${alTope.status} · ${alTope.body?.message ?? ''}`)
        const editaDeMas = await put(tok.gerencia, `/assignments/${uno.body.id}`, cuerpo(pend + 1))
        prueba(`al editar no deja pasar de ${pend}`, editaDeMas.status === 400,
          `HTTP ${editaDeMas.status} · ${editaDeMas.body?.message ?? ''}`)
        await del(tok.gerencia, `/assignments/${uno.body.id}`)   // se deja como estaba
      }

      // Con el campo vacío tampoco se pasa: antes guardaba la capacidad entera
      // del médico que cubre aunque faltaran menos pacientes.
      const vacio = await post(tok.gerencia, '/assignments', { ...cuerpo(null), expected_patients: undefined })
      prueba(`con el campo vacío no pasa de ${pend}`, vacio.status === 201 && (vacio.body?.patient_capacity ?? 0) <= pend,
        `HTTP ${vacio.status} · guardó ${vacio.body?.patient_capacity}`)
      if (vacio.status < 400 && vacio.body?.id) await del(tok.gerencia, `/assignments/${vacio.body.id}`)
    }
  }

  // ------------------------------------------- pacientes reales de la líder
  // Oct-2026 · Hector: "en el momento del proceso de repro, en líder es donde
  // pone los datos de los pacientes reales afectados". Desde que los pone,
  // mandan en la cuenta del caso y en el tope.
  console.log('\n7e · PACIENTES REALES QUE PONE LA LÍDER')
  if (!conAux) {
    aviso('sin caso de profesional no hay con qué probar los pacientes reales')
  } else {
    const { a } = conAux
    const original = await prisma.absence.findUnique({ where: { id: a.id }, select: { patientsConfirmed: true } })
    const antes = (await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body?.cuenta
    const real = (antes?.pacientes_impactados ?? 0) + 7

    const coord = await put(tok.coordinador, `/absences/${a.id}/patients`, { patients_confirmed: real })
    prueba('el coordinador no pone los de un profesional (son de la líder)', coord.status === 403, `HTTP ${coord.status}`)

    const lider = await put(tok.lider, `/absences/${a.id}/patients`, { patients_confirmed: real })
    prueba('la líder pone los pacientes reales', lider.status === 200, `HTTP ${lider.status} · ${lider.body?.message ?? ''}`)
    const tras = (await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body
    prueba('la cuenta del caso pasa a usar el real',
      tras?.cuenta?.pacientes_impactados === real && tras?.cuenta?.pacientes_corregidos === true &&
      tras?.cuenta?.pacientes_pendientes === (antes?.pacientes_pendientes ?? 0) + 7,
      JSON.stringify({ impactados: tras?.cuenta?.pacientes_impactados, pendientes: tras?.cuenta?.pacientes_pendientes }))
    prueba('el estimado del sistema no se pierde', tras?.cuenta?.pacientes_estimados === (tras?.ausencia?.patients_affected ?? -1))

    if ((antes?.pacientes_cubiertos ?? 0) > 0) {
      const bajo = await put(tok.lider, `/absences/${a.id}/patients`, { patients_confirmed: antes.pacientes_cubiertos - 1 })
      prueba('no deja poner menos de los ya reprogramados', bajo.status === 400, `HTTP ${bajo.status} · ${bajo.body?.message ?? ''}`)
    }
    await prisma.absence.update({ where: { id: a.id }, data: { patientsConfirmed: original.patientsConfirmed } })
  }

  // ---------------------------------------- sin confirmar no se cubre nada
  // Oct-2026 · El orden que fijó Hector: por confirmar → por cubrir → por
  // repartir. No había botón para confirmar en ninguna pantalla y se podía
  // cubrir una ausencia "Sin confirmar". Ahora el caso tiene su botón y el
  // servidor rechaza cubrir o repartir antes.
  //
  // Confirmar escribe bastante (estado, impacto, ejecuciones no ejecutadas,
  // un aviso al profesional): se guarda todo antes y se devuelve después.
  // En local no hay SMTP, así que no sale ningún correo.
  console.log('\n7f · SIN CONFIRMAR NO SE CUBRE NI SE REPARTE')
  let sinConf = null
  for (const a of (aus.ausencias ?? [])) {
    if (a.status !== 'pendiente') continue
    const c = (await get(tok.gerencia, `/absences/${a.id}/replacement-context`)).body
    if (c?.franjas?.length) { sinConf = { a, c, fr: c.franjas[0] }; break }
  }
  if (!sinConf) {
    aviso('no hay una ausencia sin confirmar con agenda caída en la semana')
  } else {
    const { a, c, fr } = sinConf
    const inicio = new Date()
    const cuerpo = (rid) => ({
      week_id: fr.week_id, room_id: fr.room_id, resource_id: rid, assistant_id: fr.assistant_id,
      weekday: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
      is_replacement: true, covered_absence_id: a.id,
    })
    const [cand] = (await get(tok.gerencia, '/resources/suggested?' + new URLSearchParams({
      type: c.ausencia.resource.type, day: fr.weekday, start_time: fr.start_time, end_time: fr.end_time,
      city: fr.site.city, week_id: fr.week_id, room_id: fr.room_id,
    }))).body ?? []

    const cubre = await post(tok.lider, '/assignments', cuerpo(cand?.id ?? c.ausencia.resource.id))
    if (cubre.status < 400 && cubre.body?.id) await del(tok.gerencia, `/assignments/${cubre.body.id}`)
    prueba('sin confirmar, el servidor no deja cubrir', cubre.status === 400 && /confirma/i.test(cubre.body?.message ?? ''),
      `HTTP ${cubre.status} · ${cubre.body?.message ?? ''}`)

    const repartir = await put(tok.lider, `/absences/${a.id}/rescheduler`, { rescheduler_id: repros[0].id, notes: 'QA' })
    prueba('sin confirmar, el servidor no deja repartir', repartir.status === 400 && /confirma/i.test(repartir.body?.message ?? ''),
      `HTTP ${repartir.status} · ${repartir.body?.message ?? ''}`)

    // Lo que confirmar va a tocar, para devolverlo.
    const original = await prisma.absence.findUnique({ where: { id: a.id } })
    const turnosDia = await prisma.assignment.findMany({
      where: { weekId: fr.week_id, OR: [{ resourceId: original.resourceId }, { assistantId: original.resourceId }] },
      select: { id: true, status: true },
    })
    const ejecAntes = await prisma.execution.findMany({ where: { assignmentId: { in: turnosDia.map((t) => t.id) } } })

    const conf = await put(tok.lider, `/absences/${a.id}/confirm`, {})
    prueba('la líder confirma la ausencia desde el caso', conf.status === 200 && conf.body?.status === 'confirmada',
      `HTTP ${conf.status} · ${conf.body?.message ?? conf.body?.status ?? ''}`)

    if (conf.status === 200 && cand) {
      const ahora = await post(tok.lider, '/assignments', cuerpo(cand.id))
      prueba('ya confirmada, se puede cubrir', ahora.status === 201,
        `HTTP ${ahora.status} · ${ahora.body?.message ?? ''}`)
      if (ahora.status < 400 && ahora.body?.id) await del(tok.gerencia, `/assignments/${ahora.body.id}`)
    } else if (!cand) {
      aviso('esa franja no tiene candidato libre para probar que ya se puede cubrir')
    }

    // Se deja como estaba.
    // Un Json vacío no se devuelve con null a secas: Prisma pide DbNull.
    const { id: _id, ...campos } = original
    await prisma.absence.update({
      where: { id: a.id },
      data: { ...campos, dailyImpact: campos.dailyImpact ?? Prisma.DbNull },
    })
    const antesIds = new Set(ejecAntes.map((e) => e.id))
    await prisma.execution.deleteMany({
      where: { assignmentId: { in: turnosDia.map((t) => t.id) }, id: { notIn: [...antesIds] } },
    })
    for (const e of ejecAntes) {
      const { id, ...resto } = e
      await prisma.execution.update({ where: { id }, data: resto })
    }
    await prisma.notification.deleteMany({ where: { type: 'ausencia_confirmada', createdAt: { gte: inicio } } })
    // Confirmar también deja "sin_cobertura" los turnos con auxiliar (RN-24).
    for (const t of turnosDia) await prisma.assignment.update({ where: { id: t.id }, data: { status: t.status } })
    const vuelta = await prisma.absence.findUnique({ where: { id: a.id }, select: { status: true } })
    prueba('la ausencia vuelve a quedar sin confirmar', vuelta?.status === 'pendiente', vuelta?.status)
  }

  // ------------------------------------------------------------- bordes
  console.log('\n8 · CASOS BORDE')
  const inexistente = await get(tok.gerencia, '/absences/00000000-0000-0000-0000-000000000000/replacement-context')
  prueba('una ausencia inexistente da 404, no 500', inexistente.status === 404)

  const sinPermiso = await get(tok.recurso, `/absences/${caso.id}/replacement-context`)
  prueba('el rol recurso no rompe el endpoint del caso', sinPermiso.status < 500,
    `devolvió ${sinPermiso.status}`)

  console.log('\n' + '='.repeat(72))
  console.log(`PASAN ${ok} · FALLAN ${mal}` + (avisos.length ? ` · ${avisos.length} aviso(s)` : ''))
  process.exit(mal === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR DEL GUIÓN:', e.message); process.exit(1) })
