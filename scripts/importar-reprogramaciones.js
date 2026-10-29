/**
 * CARGA DEL HISTÓRICO DE REPROGRAMACIONES (Excel de Agendas, enero-octubre 2026)
 * ============================================================================
 *
 * Cada fila del Excel es una agenda de un profesional que se cayó un día
 * (ausencia, cambio de horario, regional, festivo…) y a quién se le pasó. Se
 * carga como una ausencia CONFIRMADA con origen 'historico', para que el
 * tablero de Reprogramaciones muestre esos meses. Las reglas de traducción
 * (motivos, sedes, nombres) están en src/lib/historicoReprogramaciones.js.
 *
 * Qué NO entra, y queda en el informe:
 *   · filas vacías y "agendas" que son equipos (campo visual, OCT, biometría…)
 *   · las copias: febrero y marzo traen pegado el bloque de enero
 *   · las de fecha futura: se registran en el SGRC para que entren al proceso
 *   · lo que el SGRC ya tiene: si el profesional tiene una ausencia registrada
 *     en el sistema ese día, gana la del sistema
 *   · médicos que no se pudieron emparejar
 *
 * Además, con los datos del Excel:
 *   · completa la subespecialidad de los oftalmólogos y otorrinos que no la
 *     tienen (la más frecuente en sus filas). No cambia las que ya existen.
 *   · crea INACTIVOS a los profesionales que no están en el SGRC (fellows y
 *     médicos que ya no trabajan), para que su historia no se pierda.
 *   · crea, INACTIVOS, los motivos que el tablero necesita para agrupar.
 *
 * USO (por defecto solo muestra el informe; no escribe nada)
 *   npm run importar:reprogramaciones -- --archivo /tmp/ausencias_profesionales.xlsx
 *   npm run importar:reprogramaciones -- --archivo /tmp/ausencias_profesionales.xlsx --aplicar
 *   npm run importar:reprogramaciones -- --deshacer [--aplicar]
 *
 * Se puede volver a correr: cada fila tiene una clave y no entra dos veces.
 */
import ExcelJS from 'exceljs'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { buildCostoResolver } from '../src/services/absenceService.js'
import { esProgramada } from '../src/lib/anticipacion.js'
import { normalizarEsquemaYTope } from '../src/lib/resourceTypes.js'
import {
  normalizar, nombrePropio, motivoDe, MOTIVOS_NUEVOS, tipoLegadoDe, sedeDe, tipoDeEspecialidad, CONSULTA_DE_TIPO,
  subespecialidadDe, emparejar, PROFESIONALES_NUEVOS, NO_SON_PROFESIONALES, claveDeFila, diasEntre,
  fechaDeCelda, numeroDeCelda, siNo,
} from '../src/lib/historicoReprogramaciones.js'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const APLICAR = process.argv.includes('--aplicar')
const DESHACER = process.argv.includes('--deshacer')
const ARCHIVO = arg('--archivo')
const PROFESIONALES = ['oftalmologo', 'otorrino', 'anestesiologo', 'optometra', 'fonoaudiologa']
const MARCA_RECURSO = 'Histórico: creado al cargar el Excel de reprogramaciones 2026'
const REPORTADO_POR = 'Histórico Excel de Agendas'
const linea = (c = '=') => console.log(c.repeat(80))
const mediodia = (iso) => new Date(`${iso}T12:00:00Z`)   // sin corrimiento de día en ninguna zona
const dia = (iso) => new Date(`${iso}T00:00:00Z`)
// Hoy en Colombia (UTC-5), 'AAAA-MM-DD'.
const HOY = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10)

if (DESHACER) await deshacer()
else if (!ARCHIVO) { console.error('Falta --archivo <ruta del Excel>'); process.exit(1) }
else await importar()
await prisma.$disconnect()

// ---------------------------------------------------------------------------
async function leerExcel(ruta) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(ruta)
  const valor = (v) => {
    if (v == null) return null
    if (v instanceof Date) return v
    if (typeof v === 'object') {
      if ('result' in v) return v.result ?? null
      if (v.richText) return v.richText.map((t) => t.text).join('')
      if ('text' in v) return v.text
    }
    return v
  }
  const filas = []
  wb.eachSheet((ws) => {
    const cab = []
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { cab[i] = normalizar(valor(c.value))?.replace(/ /g, '_') ?? null })
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return
      const d = { _hoja: ws.name.trim(), _fila: n }
      row.eachCell({ includeEmpty: false }, (c, i) => { if (cab[i]) d[cab[i]] = valor(c.value) })
      filas.push(d)
    })
  })
  return filas
}

async function importar() {
  linea()
  console.log(APLICAR ? 'CARGA DEL HISTÓRICO · MODO APLICAR (escribe en la base)' : 'CARGA DEL HISTÓRICO · SIMULACIÓN (no escribe nada)')
  linea()
  const filas = await leerExcel(ARCHIVO)

  const recursos = await prisma.resource.findMany({
    where: { type: { in: PROFESIONALES } },
    select: { id: true, name: true, type: true, specialty: true, active: true },
  })
  const sedes = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.name, s.id]))
  const motivosSistema = new Map((await prisma.absenceReason.findMany({ select: { id: true, code: true } })).map((m) => [m.code, m.id]))
  const parametros = await prisma.costSetting.findMany({ orderBy: { effectiveFrom: 'desc' } })
  const yaCargadas = new Set((await prisma.absence.findMany({ where: { source: 'historico' }, select: { importKey: true } })).map((a) => a.importKey))
  const delSgrc = await prisma.absence.findMany({
    where: { source: 'sgrc', status: { not: 'rechazada' }, resource: { type: { in: PROFESIONALES } } },
    select: { resourceId: true, startDate: true, endDate: true },
  })
  const enElSgrc = (rid, f) => delSgrc.some((a) => a.resourceId === rid && a.startDate.toISOString().slice(0, 10) <= f && a.endDate.toISOString().slice(0, 10) >= f)

  // Profesionales nuevos: se crean una vez; mientras tanto, un id provisional.
  const nuevos = new Map()   // nombre del Excel → { name, type, filas, subs }
  const cont = { total: filas.length, vacia: 0, equipo: 0, copia: 0, yaCargada: 0, futura: 0, enSgrc: 0, sinProfesional: 0, cargar: 0 }
  const sinProfesional = new Map()
  const tipoDistinto = new Map()
  const subsPorRecurso = new Map()   // recursoId → Map(sub → filas)
  const vistas = new Set()
  const aCrear = []
  let costoAnticipado = 0
  const futuras = []

  for (const f of filas) {
    const medico = normalizar(f.MEDICO)
    const fecha = fechaDeCelda(f.FECHA_AUSENCIA)
    if (!medico || !fecha) { cont.vacia++; continue }
    if (NO_SON_PROFESIONALES.has(medico)) { cont.equipo++; continue }
    if (fecha > HOY) { cont.futura++; futuras.push(`${medico} · ${fecha}`); continue }
    const reportada = fechaDeCelda(f.FECHA_REPORTADA) ?? fechaDeCelda(f.FECHA_REALIZADA) ?? fecha
    const clave = claveDeFila({ medico, agenda: f.AGENDA, fecha, tipo: f.TIPO_AUSENCIA, reportada })
    if (vistas.has(clave)) { cont.copia++; continue }
    vistas.add(clave)
    if (yaCargadas.has(clave)) { cont.yaCargada++; continue }

    const tipoExcel = tipoDeEspecialidad(f.ESPECIALIDAD)
    let recurso
    if (PROFESIONALES_NUEVOS[medico]) {
      const p = PROFESIONALES_NUEVOS[medico]
      if (!nuevos.has(medico)) nuevos.set(medico, { ...p, filas: 0, subs: new Map(), id: null })
      recurso = { nuevo: medico, type: p.type }
      nuevos.get(medico).filas++
    } else {
      const r = emparejar(medico, tipoExcel, recursos)
      if (r.error) {
        cont.sinProfesional++
        sinProfesional.set(medico, { motivo: r.error, filas: (sinProfesional.get(medico)?.filas ?? 0) + 1 })
        continue
      }
      recurso = r.recurso
      if (tipoExcel && tipoExcel !== recurso.type) tipoDistinto.set(recurso.name, { excel: tipoExcel, sgrc: recurso.type })
      if (enElSgrc(recurso.id, fecha)) { cont.enSgrc++; continue }
    }

    const sub = subespecialidadDe(recurso.type, f.SUBESPECIALIDAD)
    if (sub) {
      const m = recurso.nuevo ? nuevos.get(recurso.nuevo).subs : (subsPorRecurso.get(recurso.id) ?? new Map())
      m.set(sub, (m.get(sub) ?? 0) + 1)
      if (!recurso.nuevo) subsPorRecurso.set(recurso.id, m)
    }

    const pacientes = numeroDeCelda(f.PACIENTES_AFECTADOS) ?? numeroDeCelda(f.PROGRAMACIONES) ?? 0
    const anticipacion = Math.max(0, diasEntre(reportada, fecha))
    const codigo = motivoDe(f.TIPO_AUSENCIA)
    // Los parámetros de costo existen desde el 21-jul-2026. Antes de su primer
    // valor se usa ese primer valor: si no, enero-julio quedaban en $0 y el
    // costo parecía dispararse en julio.
    const consulta = CONSULTA_DE_TIPO[recurso.type]
    let valor = buildCostoResolver(parametros, dia(fecha))(consulta)
    if (!valor) {
      const primero = parametros.filter((p) => p.visitType === consulta).at(-1)   // vienen de la más nueva a la más vieja
      if (primero) { valor = Number(primero.visitCost); costoAnticipado++ }
    }
    const costo = Math.round(pacientes * valor)
    const cobertura = fechaDeCelda(f.FECHA_CUBRE) ?? fechaDeCelda(f.FECHA_REPONE)
    const servicio = normalizar(f.TIPO_SERVICIO)
    cont.cargar++
    aCrear.push({
      _recurso: recurso,
      _codigo: codigo,
      _mes: fecha.slice(0, 7),
      data: {
        startDate: dia(fecha),
        endDate: dia(fecha),
        isPartial: false,
        type: tipoLegadoDe(codigo),
        reason: `Histórico Excel · hoja ${f._hoja}, fila ${f._fila} · Tipo: ${normalizar(f.TIPO_AUSENCIA) ?? '—'}${servicio ? ` · Servicio: ${servicio}` : ''}`,
        isPlanned: esProgramada(anticipacion),
        noticeDays: anticipacion,
        status: 'confirmada',
        patientsAffected: pacientes,
        opportunityCost: costo,
        reportedBy: REPORTADO_POR,
        reportedAt: mediodia(reportada),
        confirmedAt: mediodia(fechaDeCelda(f.FECHA_REALIZADA) ?? reportada),
        source: 'historico',
        importKey: clave,
        siteId: sedes.get(sedeDe(f.SEDE, recurso.type)) ?? null,
        agendaName: f.AGENDA ? String(f.AGENDA).replace(/\s+/g, ' ').trim().slice(0, 150) : null,
        coveredByName: nombrePropio(f.MEDICO_CUBRE)?.slice(0, 150) ?? null,
        coverDate: cobertura ? dia(cobertura) : null,
        selfMakeup: siNo(f.REPONE),
      },
    })
  }

  // Subespecialidad: la más frecuente, solo a quien no tiene.
  const masFrecuente = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const subsACompletar = recursos
    .filter((r) => ['oftalmologo', 'otorrino'].includes(r.type) && !r.specialty?.trim() && subsPorRecurso.has(r.id))
    .map((r) => ({ r, sub: masFrecuente(subsPorRecurso.get(r.id)) }))
    .filter((x) => x.sub)
  const sinSubYSinDatos = recursos.filter((r) => ['oftalmologo', 'otorrino'].includes(r.type) && r.active && !r.specialty?.trim() && !subsACompletar.some((x) => x.r.id === r.id))

  // ---- Informe ----
  console.log(`\nFilas del Excel: ${cont.total}`)
  console.log(`  se cargan .................................. ${cont.cargar}`)
  console.log(`  vacías (sin médico o sin fecha) ............ ${cont.vacia}`)
  console.log(`  equipos, no profesionales .................. ${cont.equipo}`)
  console.log(`  copias pegadas entre hojas ................. ${cont.copia}`)
  console.log(`  con fecha futura (registrar en el SGRC) .... ${cont.futura}`)
  console.log(`  ya cargadas en una corrida anterior ........ ${cont.yaCargada}`)
  console.log(`  el SGRC ya tiene la ausencia ese día ....... ${cont.enSgrc}`)
  console.log(`  sin profesional en el SGRC ................. ${cont.sinProfesional}`)

  const porMes = {}
  for (const a of aCrear) porMes[a._mes] = (porMes[a._mes] ?? 0) + 1
  console.log('\nPor mes de la ausencia:')
  for (const [m, n] of Object.entries(porMes).sort()) console.log(`  ${m}  ${String(n).padStart(4)}`)

  const nombreMotivo = new Map(MOTIVOS_NUEVOS.map((m) => [m.code, `${m.name} (${m.family})`]))
  const porMotivo = {}
  for (const a of aCrear) porMotivo[a._codigo] = (porMotivo[a._codigo] ?? 0) + 1
  console.log('\nPor motivo:')
  for (const [c, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${nombreMotivo.get(c) ?? c + ' (motivo del sistema)'}`)

  const sinSede = aCrear.filter((a) => !a.data.siteId).length
  const conCobertura = aCrear.filter((a) => a.data.coverDate).length
  const pac = aCrear.reduce((s, a) => s + a.data.patientsAffected, 0)
  console.log(`\nPacientes: ${pac} · con fecha de cobertura: ${conCobertura} de ${aCrear.length} · sin sede reconocida: ${sinSede}`)
  const sinCosto = aCrear.filter((a) => !a.data.opportunityCost && a.data.patientsAffected).length
  if (costoAnticipado) console.log(`Costo con el primer valor de Parámetros de costo (fecha anterior a su vigencia): ${costoAnticipado} filas`)
  if (sinCosto) console.log(`Sin valor de consulta para calcular el costo: ${sinCosto} filas (el tipo de consulta no está en Parámetros de costo)`)
  console.log(`Costo de oportunidad total: $ ${aCrear.reduce((t, a) => t + a.data.opportunityCost, 0).toLocaleString('es-CO')}`)

  if (futuras.length) {
    console.log(`
NO SE CARGAN — fecha futura (${futuras.length}); regístrelas en el SGRC si siguen vigentes:`)
    for (const f of futuras.sort()) console.log(`  · ${f}`)
  }
  if (sinProfesional.size) {
    console.log('\nNO SE CARGAN — médico sin pareja en el SGRC:')
    for (const [m, v] of [...sinProfesional.entries()].sort((a, b) => b[1].filas - a[1].filas)) console.log(`  · ${m} (${v.filas} filas): ${v.motivo}`)
  }
  if (nuevos.size) {
    console.log(`\nProfesionales que se crean INACTIVOS (${nuevos.size}):`)
    for (const [, v] of nuevos) console.log(`  · ${v.name} · ${v.type} · ${v.filas} filas${masFrecuente(v.subs) ? ' · ' + masFrecuente(v.subs) : ''}`)
  }
  console.log(`\nSubespecialidad que se completa (${subsACompletar.length}):`)
  for (const { r, sub } of subsACompletar) console.log(`  · ${r.name} (${r.type}) → ${sub}`)
  console.log(`\nSiguen SIN subespecialidad (activos, sin filas en el Excel): ${sinSubYSinDatos.length}`)
  for (const r of sinSubYSinDatos) console.log(`  · ${r.name} (${r.type})`)
  if (tipoDistinto.size) {
    console.log('\nREVISAR — el Excel y el SGRC no coinciden en el tipo (no se cambia nada):')
    for (const [n, t] of tipoDistinto) console.log(`  · ${n}: Excel ${t.excel}, SGRC ${t.sgrc}`)
  }

  if (!APLICAR) {
    console.log('\nNo se escribió nada. Para cargar: agregue --aplicar')
    return
  }

  // ---- Escritura ----
  // 1. Motivos del histórico (inactivos: no aparecen en Registrar ausencia).
  for (const [i, m] of MOTIVOS_NUEVOS.entries()) {
    const r = await prisma.absenceReason.upsert({
      where: { code: m.code },
      update: {},
      create: { code: m.code, name: m.name, family: m.family, active: false, isSystem: false, sortOrder: 900 + i, description: 'Motivo del histórico de reprogramaciones (Excel de Agendas 2026).' },
    })
    motivosSistema.set(m.code, r.id)
  }
  // 2. Profesionales nuevos, inactivos.
  for (const [, v] of nuevos) {
    const existe = await prisma.resource.findFirst({ where: { name: v.name, type: v.type } })
    v.id = existe?.id ?? (await prisma.resource.create({
      data: {
        name: v.name, type: v.type, specialty: masFrecuente(v.subs), active: false, deactivationReason: MARCA_RECURSO,
        ...normalizarEsquemaYTope({ type: v.type }),
      },
    })).id
  }
  // 3. Subespecialidades.
  for (const { r, sub } of subsACompletar) {
    await prisma.resource.update({ where: { id: r.id }, data: { specialty: sub } })
    await registrarAuditoria({ userId: null, action: 'completar_subespecialidad', entity: 'recursos', entityId: r.id, oldValue: { specialty: r.specialty }, newValue: { specialty: sub }, reason: 'Excel de reprogramaciones 2026: la subespecialidad más frecuente en sus filas' })
  }
  // 4. Ausencias, en tandas.
  const datos = aCrear.map((a) => ({
    ...a.data,
    resourceId: a._recurso.nuevo ? nuevos.get(a._recurso.nuevo).id : a._recurso.id,
    reasonId: motivosSistema.get(a._codigo) ?? null,
  }))
  let creadas = 0
  for (let i = 0; i < datos.length; i += 200) {
    creadas += (await prisma.absence.createMany({ data: datos.slice(i, i + 200), skipDuplicates: true })).count
  }
  await registrarAuditoria({
    userId: null, action: 'importar_historico_reprogramaciones', entity: 'ausencias', entityId: 'historico-2026',
    newValue: { ausencias: creadas, profesionalesNuevos: nuevos.size, subespecialidades: subsACompletar.length, porMes },
    reason: `Excel ${ARCHIVO.split(/[\\/]/).pop()}`,
  })
  console.log(`\nCargadas: ${creadas} ausencias · ${nuevos.size} profesionales nuevos · ${subsACompletar.length} subespecialidades`)
}

// ---------------------------------------------------------------------------
async function deshacer() {
  linea()
  console.log(APLICAR ? 'DESHACER LA CARGA · MODO APLICAR' : 'DESHACER LA CARGA · SIMULACIÓN (no escribe nada)')
  linea()
  const n = await prisma.absence.count({ where: { source: 'historico' } })
  const creados = await prisma.resource.findMany({ where: { deactivationReason: MARCA_RECURSO }, select: { id: true, name: true } })
  console.log(`Ausencias del histórico: ${n} · profesionales creados por la carga: ${creados.length}`)
  console.log('Las subespecialidades completadas NO se revierten (quedan en la auditoría con su valor anterior).')
  if (!APLICAR) { console.log('\nNo se escribió nada. Agregue --aplicar para borrar.'); return }
  const borradas = await prisma.absence.deleteMany({ where: { source: 'historico' } })
  let quitados = 0
  for (const r of creados) {
    const usos = await prisma.absence.count({ where: { resourceId: r.id } }) + await prisma.assignment.count({ where: { OR: [{ resourceId: r.id }, { assistantId: r.id }] } })
    if (!usos) { await prisma.resource.delete({ where: { id: r.id } }); quitados++ }
  }
  await registrarAuditoria({ userId: null, action: 'deshacer_historico_reprogramaciones', entity: 'ausencias', entityId: 'historico-2026', newValue: { ausencias: borradas.count, profesionales: quitados } })
  console.log(`Borradas: ${borradas.count} ausencias · ${quitados} profesionales`)
}
