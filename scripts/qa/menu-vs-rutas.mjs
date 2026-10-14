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
console.log('')
console.log(fallos === 0 ? 'Sin incoherencias entre menú y rutas.' : fallos + ' INCOHERENCIA(S)')
process.exit(fallos === 0 ? 0 : 1)
