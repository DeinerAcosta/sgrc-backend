// QA · Cada entrada del menu contra la ruta que la protege.
//
// El menu (config/nav.js) y las rutas (App.jsx) viven en archivos distintos y
// nada obliga a que coincidan.
//
// Tres reglas del guardia que hay que respetar para no dar falsos positivos:
//   · <RequireAuth> SIN roles  -> abierta a cualquier autenticado
//   · gerencia                 -> super-usuario, bypasea todo check de roles
//   · path="informes/:tipo"    -> cubre /app/informes/loquesea
import fs from 'node:fs'

const RAIZ = 'C:/Users/Hector/Documents/sgrc-frontend/src/'
const navSrc = fs.readFileSync(RAIZ + 'config/nav.js', 'utf8')
const appSrc = fs.readFileSync(RAIZ + 'App.jsx', 'utf8')

const BYPASS = /user\?\.role === 'gerencia'\) return children/.test(appSrc) ? 'gerencia' : null

// --- rutas ----------------------------------------------------------------
const rutas = []
const reRuta = /<Route\s+path="([^"]+)"\s+element=\{<RequireAuth([^>]*)>/g
let m
while ((m = reRuta.exec(appSrc))) {
  const roles = (m[2].match(/roles=\{\[([^\]]*)\]/) || [])[1]
  rutas.push({
    path: '/app/' + m[1],
    roles: roles ? roles.split(',').map((r) => r.trim().replace(/['"]/g, '')).filter(Boolean) : null, // null = abierta
  })
}
const casa = (destino) => {
  const d = destino.split('?')[0]
  return rutas.find((r) => {
    if (r.path === d) return true
    // Segmento dinamico: /app/informes/:tipo cubre /app/informes/ocupacion
    const pr = r.path.split('/'); const pd = d.split('/')
    return pr.length === pd.length && pr.every((seg, i) => seg.startsWith(':') || seg === pd[i])
  })
}

// --- menu -----------------------------------------------------------------
const bloques = {}
for (const nombre of ['CATALOGOS', 'PRODUCTIVIDAD', 'AUSENTISMO', 'GESTION_AUSENCIAS', 'CONFIGURACION', 'SOLICITUDES']) {
  const i = navSrc.indexOf('const ' + nombre + ' = {')
  if (i < 0) continue
  let d = 0, j = navSrc.indexOf('{', i), k = j
  for (; k < navSrc.length; k++) { if (navSrc[k] === '{') d++; else if (navSrc[k] === '}') { d--; if (d === 0) break } }
  bloques[nombre] = [...navSrc.slice(j, k).matchAll(/to:\s*`?'?([^'`,\s]+)/g)].map((x) => x[1])
}
const raizAus = (navSrc.match(/RAIZ_AUSENCIAS = '([^']+)'/) || [])[1]
if (raizAus) (bloques.GESTION_AUSENCIAS ??= []).push(raizAus)

const ROLES = ['recurso', 'coordinador', 'directivo', 'supervisor', 'gerencia', 'reprogramador']
const destinosDe = (rol) => {
  const i = navSrc.indexOf('\n  ' + rol + ': [')
  if (i < 0) return []
  let d = 0, j = navSrc.indexOf('[', i), k = j
  for (; k < navSrc.length; k++) { if (navSrc[k] === '[') d++; else if (navSrc[k] === ']') { d--; if (d === 0) break } }
  const bloque = navSrc.slice(j, k)
  const directos = [...bloque.matchAll(/to:\s*`?'?([^'`,\s]+)/g)].map((x) => x[1])
  const refs = [...bloque.matchAll(/^\s*([A-Z_]{3,}),?\s*$/gm)].map((x) => x[1])
  const raiz = /raiz:/.test(bloque) && raizAus ? [raizAus] : []
  return [...new Set([...directos, ...refs.flatMap((r) => bloques[r] ?? []), ...raiz])].filter((x) => x.startsWith('/app/'))
}

let fallos = 0
console.log('MENÚ vs RUTAS' + (BYPASS ? `   (${BYPASS} bypasea todo check de roles)` : ''))
console.log('='.repeat(72))
for (const rol of ROLES) {
  const destinos = destinosDe(rol)
  const malos = []
  for (const d of destinos) {
    const r = casa(d)
    if (!r) { malos.push(`${d}  → no hay ruta`); continue }
    if (rol === BYPASS) continue
    if (r.roles && !r.roles.includes(rol)) malos.push(`${d}  → la ruta solo deja: ${r.roles.join(', ')}`)
  }
  if (malos.length === 0) console.log(`  OK    ${rol.padEnd(14)} ${destinos.length} entradas, todas alcanzables`)
  else {
    fallos += malos.length
    console.log(`  FALLA ${rol.padEnd(14)} ${malos.length} de ${destinos.length}:`)
    for (const x of malos) console.log(`           · ${x}`)
  }
}
// --- la casa de cada rol ------------------------------------------------
//
// Oct-2026 · El destino de entrada estaba copiado en TRES archivos y las
// copias se separaron: a dos les faltaba `reprogramador`, que aterrizaba en
// /app/horario sin permiso para abrirlo. El guardia lo devolvia a la misma
// ruta, que se redirigia a si misma, y quedaba una pantalla en blanco.
//
// Aqui se comprueba lo unico que importa: que la casa de cada rol sea una
// ruta que ESE rol pueda abrir. Si no, es un bucle en cuanto alguien entre.
console.log('')
console.log('CASA DE CADA ROL  (a dónde aterriza al entrar)')
console.log('='.repeat(72))
const entrada = {}
const bloqueEntrada = navSrc.match(/RUTA_DE_ENTRADA = \{([\s\S]*?)\n\}/)
if (!bloqueEntrada) {
  console.log('  FALLA  no encontré RUTA_DE_ENTRADA en config/nav.js')
  fallos++
} else {
  for (const m of bloqueEntrada[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) entrada[m[1]] = m[2]
  for (const rol of ROLES) {
    const destino = entrada[rol]
    if (!destino) { console.log(`  FALLA ${rol.padEnd(14)} no tiene casa definida`); fallos++; continue }
    const r = casa(destino)
    if (!r) { console.log(`  FALLA ${rol.padEnd(14)} ${destino}  → no hay ruta`); fallos++; continue }
    const puede = rol === BYPASS || !r.roles || r.roles.includes(rol)
    if (puede) console.log(`  OK    ${rol.padEnd(14)} ${destino}`)
    else {
      fallos++
      console.log(`  FALLA ${rol.padEnd(14)} ${destino}  → esa ruta solo deja: ${r.roles.join(', ')}`)
      console.log('           aterrizaría en una pantalla en blanco que se redirige a sí misma')
    }
  }
}

console.log('')
console.log(fallos === 0 ? 'Sin incoherencias entre menú y rutas.' : fallos + ' INCOHERENCIA(S)')
process.exit(fallos === 0 ? 0 : 1)
