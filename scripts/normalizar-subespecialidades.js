/**
 * NORMALIZAR LAS SUBESPECIALIDADES AL CATÁLOGO (PROYECTOS-3800)
 *
 *   npm run normalizar:subespecialidades              solo muestra qué cambiaría
 *   npm run normalizar:subespecialidades -- --aplicar  escribe
 *
 * Desde el 27-oct-2026 la subespecialidad de oftalmólogos y otorrinos sale de
 * la tabla `subespecialidades`. Los recursos que ya existían la tenían escrita
 * a mano y de varias formas ("SEGMENTO ANTERIOR", "Segmento", "Segamento"),
 * así que el tablero de Reprogramaciones las contaba como subespecialidades
 * distintas. Este guion lleva cada valor viejo al nombre del catálogo.
 *
 * NO toca, y los lista para revisión a mano:
 *   · los que no tienen subespecialidad (alguien de la clínica debe decir cuál);
 *   · los que no se reconocen;
 *   · los oftalmólogos con una de otorrino ("OTORRINOLARINGOLOGIA",
 *     "otologia"): casi seguro son otorrinos con el tipo mal puesto.
 *
 * Deja una entrada de auditoría ANTES de escribir y aborta si no quedó.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { registrarAuditoria } from '../src/middleware/audit.js'
import { TIPOS_CON_SUBESPECIALIDAD } from '../src/lib/resourceTypes.js'
import { nombresDelCatalogo, normalizarAntigua, claveSubespecialidad, DE_OTRO_TIPO } from '../src/lib/subespecialidades.js'

const aplicar = process.argv.includes('--aplicar')
const estado = (r) => (r.active ? '' : ' (inactivo)')

try {
  const cambios = []
  const sinSub = []
  const otroTipo = []
  const noReconocidos = []
  let yaBien = 0

  for (const tipo of TIPOS_CON_SUBESPECIALIDAD) {
    const catalogo = await nombresDelCatalogo(prisma, tipo)
    const recursos = await prisma.resource.findMany({
      where: { type: tipo },
      select: { id: true, name: true, type: true, specialty: true, active: true },
      orderBy: { name: 'asc' },
    })
    for (const r of recursos) {
      if (!claveSubespecialidad(r.specialty)) { sinSub.push(r); continue }
      if (DE_OTRO_TIPO[tipo]?.includes(claveSubespecialidad(r.specialty))) { otroTipo.push(r); continue }
      const nuevo = normalizarAntigua(tipo, r.specialty, catalogo)
      if (!nuevo) { noReconocidos.push(r); continue }
      if (nuevo === r.specialty) { yaBien++; continue }
      cambios.push({ ...r, nuevo })
    }
  }

  console.log('NORMALIZAR SUBESPECIALIDADES AL CATÁLOGO · PROYECTOS-3800')
  console.log('==========================================================')
  console.log(`Ya correctas: ${yaBien}`)
  console.log(`\nSe corrigen: ${cambios.length}`)
  const resumen = new Map()
  for (const c of cambios) {
    const k = `${c.type} · "${c.specialty}" → ${c.nuevo}`
    resumen.set(k, (resumen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...resumen].sort()) console.log(`  · ${k}  (${n})`)

  console.log(`\nREVISAR A MANO — sin subespecialidad: ${sinSub.length}`)
  for (const r of sinSub) console.log(`  · ${r.type.padEnd(12)} ${r.name}${estado(r)}`)
  console.log(`\nREVISAR A MANO — oftalmólogo con subespecialidad de otorrino (¿tipo equivocado?): ${otroTipo.length}`)
  for (const r of otroTipo) console.log(`  · ${r.name}${estado(r)} · "${r.specialty}"`)
  console.log(`\nREVISAR A MANO — no reconocidas: ${noReconocidos.length}`)
  for (const r of noReconocidos) console.log(`  · ${r.type.padEnd(12)} ${r.name}${estado(r)} · "${r.specialty}"`)

  if (!aplicar) {
    console.log('\nNo se escribió nada. Para aplicar: npm run normalizar:subespecialidades -- --aplicar')
  } else if (cambios.length) {
    const auditoria = await registrarAuditoria({
      userId: null,
      action: 'normalizar_subespecialidades',
      entity: 'recursos',
      entityId: 'lote',
      oldValue: { cambios: cambios.map((c) => ({ id: c.id, especialidad: c.specialty })) },
      newValue: { cambios: cambios.map((c) => ({ id: c.id, especialidad: c.nuevo })) },
      reason: 'PROYECTOS-3800 · subespecialidad al nombre del catálogo',
    })
    if (!auditoria) throw new Error('No quedó la auditoría: no se escribe nada.')
    await prisma.$transaction(cambios.map((c) => prisma.resource.update({
      where: { id: c.id },
      data: { specialty: c.nuevo },
    })))
    console.log(`\nAPLICADO · ${cambios.length} recursos corregidos.`)
  } else {
    console.log('\nNada que aplicar.')
  }
} finally {
  await prisma.$disconnect()
}
