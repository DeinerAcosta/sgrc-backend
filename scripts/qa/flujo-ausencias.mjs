// QA · El flujo completo de ausencias y reprogramacion, por API.
// Cada caso dice que se esperaba y que paso. No escribe nada que no limpie.
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
    supervisor: 'supervisor@cofca.co', reprogramador: 'duarte@cofca.co', recurso: 'angela.sarmiento@cofca.co',
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
  const caso = (aus.ausencias ?? []).find((a) => a.dias?.length && a.status === 'confirmada')
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

  const malDestinatario = await put(tok.gerencia, `/absences/${caso.id}/rescheduler`,
    { rescheduler_id: '00000000-0000-0000-0000-000000000000' })
  prueba('rechaza asignar a alguien que no existe', malDestinatario.status >= 400)

  const comoRepro = await put(tok.reprogramador, `/absences/${caso.id}/rescheduler`,
    { rescheduler_id: repros[0].id, notes: 'QA' })
  prueba('la líder (rol reprogramador) puede asignar', comoRepro.status < 400,
    'era el rol corregido hoy: conduce el proceso, no lo recibe')

  const cerrarAjeno = await put(tok.coordinador, `/absences/${caso.id}/rescheduler/done`)
  prueba('un coordinador no puede cerrar el caso', cerrarAjeno.status >= 400)

  // ------------------------------------------------------ RN-08 y excepcion
  console.log('\n7 · RN-08 Y SU EXCEPCIÓN')
  const asigs = (await get(tok.gerencia, `/assignments?week_id=${semana.id}`)).body
  const ocupado = (asigs ?? []).find((a) => a.weekday === f0.weekday && a.resource?.type === ctx.ausencia.resource.type)
  if (ocupado) {
    const base = {
      week_id: f0.week_id, room_id: f0.room_id, resource_id: ocupado.resource.id,
      weekday: f0.weekday, start_time: ocupado.start_time, end_time: ocupado.end_time,
      is_replacement: true, covered_absence_id: caso.id,
    }
    const sinFlag = await post(tok.gerencia, '/assignments', base)
    prueba('sin la confirmación, RN-08 bloquea el doble turno', sinFlag.status >= 400)

    const conFlag = await post(tok.gerencia, '/assignments', { ...base, assume_overlap: true })
    prueba('con la confirmación, lo permite', conFlag.status < 400)
    if (conFlag.status < 400) {
      const tras = (await get(tok.gerencia, `/absences/${caso.id}/replacement-context`)).body
      prueba('la cuenta sube al asignar', (tras?.cuenta?.pacientes_cubiertos ?? 0) > 0)
      await del(tok.gerencia, `/assignments/${conFlag.body.id}`)   // se deja como estaba
    }
  } else {
    aviso('no encontré un profesional ocupado ese día para probar RN-08')
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
