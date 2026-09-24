/**
 * LIMPIEZA DE AUSENCIAS DUPLICADAS Y CON FECHAS IMPOSIBLES
 * =======================================================
 *
 *   node scripts/limpiar-ausencias.js            # simulacion, no borra nada
 *   node scripts/limpiar-ausencias.js --aplicar  # borra de verdad
 *
 * Por defecto NO borra: lista que haria. Saca respaldo antes de aplicar:
 *   mysqldump ... sgrc ausencias > ~/respaldo-ausencias-$(date +%F).sql
 *
 * ---------------------------------------------------------------------------
 * QUE BORRA
 * ---------------------------------------------------------------------------
 * 1. DUPLICADAS — misma persona, mismas fechas exactas, varios registros.
 *    Se CONSERVA una y se borran las copias. La que se conserva es la mas
 *    antigua por `reportado_en`, salvo que una copia mas nueva tenga registros
 *    que dependan de ella; en ese caso se conserva esa (ver abajo).
 *
 * 2. FECHAS IMPOSIBLES — fin anterior al inicio, o año fuera de 2020-2100.
 *    No son ausencias reales, son errores de digitacion.
 *
 * ---------------------------------------------------------------------------
 * SEGURIDAD: DEPENDENCIAS
 * ---------------------------------------------------------------------------
 * Tres tablas apuntan a `ausencias`:
 *   · asignaciones.ausencia_cubierta_id   (reemplazos)     -> NO borra en cascada
 *   · asignaciones_backoffice.ausencia_origen_id           -> NO borra en cascada
 *   · reposiciones.ausencia_id                             -> SI borra en cascada
 *
 * Borrar una ausencia referenciada por las dos primeras falla por clave foranea,
 * y borrarla arrastraria reposiciones asociadas. Por eso el script NUNCA borra
 * una fila con dependencias: la reporta y la deja para revision manual.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APLICAR = process.argv.includes('--aplicar')

const fmt = (d) => new Date(d).toISOString().slice(0, 10)
const linea = (c = '=') => console.log(c.repeat(92))

/** Cuenta los registros que dependen de una ausencia. */
async function dependencias(id) {
  const [reemplazos, backoffice, reposiciones] = await Promise.all([
    prisma.assignment.count({ where: { coveredAbsenceId: id } }),
    prisma.backofficeAssignment.count({ where: { sourceAbsenceId: id } }),
    prisma.absenceMakeup.count({ where: { absenceId: id } }),
  ])
  return { reemplazos, backoffice, reposiciones, bloquea: reemplazos + backoffice + reposiciones }
}

async function main() {
  linea()
  console.log(APLICAR
    ? 'LIMPIEZA DE AUSENCIAS · MODO APLICAR (borra registros)'
    : 'LIMPIEZA DE AUSENCIAS · SIMULACION (no borra nada)')
  linea()
  if (!APLICAR) console.log('Para borrar de verdad: node scripts/limpiar-ausencias.js --aplicar\n')

  const todas = await prisma.absence.findMany({
    include: { resource: { select: { name: true, type: true } } },
    orderBy: { reportedAt: 'asc' },
  })
  console.log(`Ausencias en la base: ${todas.length}\n`)

  const aBorrar = []
  const conservadas = []
  const bloqueadas = []

  // ------------------------------------------------------------- 1. dupes ----
  linea('-')
  console.log('1 · DUPLICADAS')
  linea('-')
  const grupos = new Map()
  for (const a of todas) {
    const k = `${a.resourceId}|${fmt(a.startDate)}|${fmt(a.endDate)}`
    if (!grupos.has(k)) grupos.set(k, [])
    grupos.get(k).push(a)
  }
  const dupes = [...grupos.values()].filter((g) => g.length > 1)

  if (dupes.length === 0) {
    console.log('  No hay duplicadas.')
  } else {
    for (const g of dupes) {
      // Preferimos conservar la que tenga dependencias; si ninguna o varias las
      // tienen, la mas antigua (el grupo ya viene ordenado por reportado_en).
      const deps = await Promise.all(g.map((a) => dependencias(a.id)))
      const idxConDeps = deps.findIndex((d) => d.bloquea > 0)
      const idxConservar = idxConDeps >= 0 ? idxConDeps : 0
      const keep = g[idxConservar]
      conservadas.push(keep)

      console.log(`  ${keep.resource.name.slice(0, 30).padEnd(31)} ${fmt(keep.startDate)} a ${fmt(keep.endDate)}  x${g.length}`)
      console.log(`    conservar : ${keep.id}  (reportada ${fmt(keep.reportedAt)})`)
      for (let i = 0; i < g.length; i++) {
        if (i === idxConservar) continue
        const a = g[i]
        const d = deps[i]
        if (d.bloquea > 0) {
          bloqueadas.push({ a, d })
          console.log(`    NO BORRA  : ${a.id}  ← tiene ${d.reemplazos} reemplazo(s), ${d.backoffice} backoffice, ${d.reposiciones} reposicion(es)`)
        } else {
          aBorrar.push(a)
          console.log(`    borrar    : ${a.id}`)
        }
      }
    }
  }

  // --------------------------------------------------------- 2. corruptas ----
  console.log('')
  linea('-')
  console.log('2 · FECHAS IMPOSIBLES')
  linea('-')
  const yaMarcada = new Set(aBorrar.map((a) => a.id))
  const malas = todas.filter((a) => {
    if (yaMarcada.has(a.id)) return false
    const ini = new Date(a.startDate)
    const fin = new Date(a.endDate)
    const anioMal = [ini, fin].some((d) => d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100)
    return fin < ini || anioMal
  })

  if (malas.length === 0) {
    console.log('  No hay fechas imposibles.')
  } else {
    for (const a of malas) {
      const d = await dependencias(a.id)
      const motivo = new Date(a.endDate) < new Date(a.startDate) ? 'termina antes de empezar' : 'año fuera de rango'
      if (d.bloquea > 0) {
        bloqueadas.push({ a, d })
        console.log(`  NO BORRA : ${a.resource.name.slice(0, 28).padEnd(29)} ${fmt(a.startDate)} a ${fmt(a.endDate)}  ${motivo}`)
        console.log(`             ← tiene ${d.reemplazos} reemplazo(s), ${d.backoffice} backoffice, ${d.reposiciones} reposicion(es)`)
      } else {
        aBorrar.push(a)
        console.log(`  borrar   : ${a.resource.name.slice(0, 28).padEnd(29)} ${fmt(a.startDate)} a ${fmt(a.endDate)}  ${motivo}`)
      }
    }
  }

  // ------------------------------------------------------------- aplicar ----
  console.log('')
  linea()
  console.log('RESUMEN')
  linea()
  console.log(`  A borrar               : ${aBorrar.length}`)
  console.log(`  Copias que se conservan: ${conservadas.length}`)
  console.log(`  Bloqueadas por deps    : ${bloqueadas.length}`)
  console.log('')

  if (!APLICAR) {
    console.log('  Nada se borro. Revisa la lista y vuelve a correrlo con --aplicar.')
    console.log('')
    return
  }

  if (aBorrar.length === 0) {
    console.log('  Nada que borrar.')
    console.log('')
    return
  }

  const res = await prisma.absence.deleteMany({ where: { id: { in: aBorrar.map((a) => a.id) } } })
  console.log(`  ✔ ${res.count} ausencia(s) borradas.`)
  if (bloqueadas.length > 0) {
    console.log(`  ⚠ ${bloqueadas.length} quedaron sin borrar por tener registros dependientes.`)
    console.log('    Hay que revisarlas a mano: o se desvincula el reemplazo/reposicion, o se dejan.')
  }
  console.log('')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
