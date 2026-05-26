import { format } from 'date-fns'

/**
 * Lógica de cálculo de impacto de ausencias y liberación de auxiliares.
 * Extraído del controller para mantener `confirmar()` delgado y permitir reuso/tests.
 *
 * Reglas implementadas:
 *  - RN-18: impacto día a día (pacientes y costo de oportunidad)
 *  - RN-19: factor parcial cuando la ausencia es de horas y no del día completo
 *  - RN-24: liberación automática de auxiliar cuando el ausente es oftalmólogo/anestesiólogo
 */

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const TIPOS_QUE_LIBERAN_AUXILIAR = ['oftalmologo', 'anestesiologo']

const hhmmAMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * RN-19: factor parcial. Si la ausencia es de día completo → 1.
 * Si es parcial con horas, se prorratea contra una jornada estándar de 10h (600 min).
 * El min(1, ...) protege contra horas malformadas que excedan el día.
 */
export function calcularFactorParcial(ausencia) {
  if (!ausencia.esParcial || !ausencia.horaInicioAusencia || !ausencia.horaFinAusencia) {
    return 1
  }
  const minAus = hhmmAMin(ausencia.horaFinAusencia) - hhmmAMin(ausencia.horaInicioAusencia)
  if (minAus <= 0) return 0
  return Math.min(1, minAus / 600)
}

/**
 * Genera el listado de días que cubre la ausencia.
 * Retorna [{ fecha: 'YYYY-MM-DD', dia: 'lunes' }, ...].
 */
export function diasDeAusencia(ausencia) {
  const fechas = []
  const cursor = new Date(ausencia.fechaInicio)
  while (cursor <= ausencia.fechaFin) {
    fechas.push({ fecha: format(cursor, 'yyyy-MM-dd'), dia: DIAS[cursor.getDay()] })
    cursor.setDate(cursor.getDate() + 1)
  }
  return fechas
}

/**
 * Construye un resolver de costo por especialidad: dada una lista de parámetros
 * ordenados por `vigenteDesde DESC`, devuelve una función que retorna el costo
 * vigente al inicio de la ausencia para cada especialidad.
 */
export function buildCostoResolver(parametros, fechaRef) {
  return (especialidad) => {
    const aplicables = parametros.filter(
      (p) => p.tipoConsulta === especialidad && p.vigenteDesde <= fechaRef,
    )
    return Number(aplicables[0]?.costoCita ?? 0)
  }
}

/**
 * RN-18: calcula el impacto total de una ausencia. Itera día a día, suma
 * pacientes y costo de oportunidad, y deja el breakdown en `impactoPorDia`.
 *
 * Requiere `tx` para correr dentro de la misma transacción del caller (consistencia
 * con la actualización de la ausencia y la liberación de auxiliares).
 */
export async function calcularImpacto(tx, ausencia) {
  const fechas = diasDeAusencia(ausencia)
  const factorParcial = calcularFactorParcial(ausencia)

  const parametros = await tx.parametroCosto.findMany({
    orderBy: { vigenteDesde: 'desc' },
  })
  const costoVigente = buildCostoResolver(parametros, ausencia.fechaInicio)

  let pacImpactados = 0
  let costoOportunidad = 0
  const impactoPorDia = []

  for (const { fecha, dia } of fechas) {
    // El recurso ausente puede aparecer como titular O como auxiliar
    // (RN-18: cuenta TODAS sus asignaciones del día, no solo las titulares).
    const asigsDia = await tx.asignacion.findMany({
      where: {
        OR: [{ recursoId: ausencia.recursoId }, { auxiliarId: ausencia.recursoId }],
        diaSemana: dia,
        estado: { not: 'cancelada' },
      },
      include: { consultorio: true },
    })

    let pacDia = 0
    let costoDia = 0
    for (const a of asigsDia) {
      const p = Math.round((a.pacientesCapacidad ?? 0) * factorParcial)
      pacDia += p
      costoDia += Math.round(p * costoVigente(a.consultorio.especialidad))
    }
    pacImpactados += pacDia
    costoOportunidad += costoDia
    impactoPorDia.push({ fecha, dia, pacientes: pacDia, costo: costoDia, parcial: ausencia.esParcial })
  }

  return { fechas, pacImpactados, costoOportunidad, impactoPorDia }
}

/**
 * RN-24: si el ausente es oftalmólogo o anestesiólogo, las asignaciones que
 * tenían auxiliar pasan a estado 'sin_cobertura' — la auxiliar queda "liberada"
 * para que el coordinador la reasigne.
 *
 * No-op para otros tipos de recurso.
 */
export async function liberarAuxiliaresSiAplica(tx, ausencia, fechas) {
  if (!TIPOS_QUE_LIBERAN_AUXILIAR.includes(ausencia.recurso.tipo)) {
    return { liberadas: 0 }
  }

  const asignacionesConAux = await tx.asignacion.findMany({
    where: {
      recursoId: ausencia.recursoId,
      auxiliarId: { not: null },
      diaSemana: { in: fechas.map((f) => f.dia) },
      estado: 'activa',
    },
  })

  for (const a of asignacionesConAux) {
    await tx.asignacion.update({
      where: { id: a.id },
      data: { estado: 'sin_cobertura' },
    })
  }

  return { liberadas: asignacionesConAux.length }
}
