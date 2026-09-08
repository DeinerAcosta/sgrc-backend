/**
 * Cruza los parámetros que DECLARA cada ruta (`/x/:id`) contra los que LEE su
 * handler (`req.params.id`). Un desajuste no da error: `req.params.loQueSea`
 * vale undefined y el fallo aparece más abajo, disfrazado. Así se rompió
 * DELETE /holidays.
 */
const fs=require('fs'), path=require('path');
const src=fs.readFileSync(require('path').join(__dirname,'..','src/routes/index.js'),'utf8');

const alias={};
for(const m of src.matchAll(/import \* as (\w+) from '([^']+)'/g)) alias[m[1]]=m[2];

const ctrl={};
const leer=(f)=>{ if(!(f in ctrl)){ const p=path.join(__dirname,'..','src/routes',f);
  ctrl[f]=fs.existsSync(p)?fs.readFileSync(p,'utf8'):null; } return ctrl[f]; };

let revisadas=0; const fallos=[];
for(const linea of src.split('\n')){
  const m=/^r\.(get|post|put|patch|delete)\(\s*'([^']+)'.*?wrap\((\w+)\.(\w+)\)/.exec(linea.trim());
  if(!m) continue;
  const [,metodo,ruta,ns,fn]=m;
  const declarados=[...ruta.matchAll(/:(\w+)/g)].map(x=>x[1]);
  if(!declarados.length) continue;
  const codigo=leer(alias[ns]); if(!codigo) continue;
  // aislar el cuerpo de la función exportada
  const i=codigo.indexOf(`export async function ${fn}(`)>=0
    ? codigo.indexOf(`export async function ${fn}(`)
    : codigo.indexOf(`export function ${fn}(`);
  if(i<0) continue;
  const sig=codigo.slice(i);
  const j=sig.indexOf('\nexport ');
  const cuerpo=j>0?sig.slice(0,j):sig;
  revisadas++;
  const leidos=new Set([...cuerpo.matchAll(/req\.params\.(\w+)/g)].map(x=>x[1]));
  for(const m2 of cuerpo.matchAll(/const\s*\{([^}]+)\}\s*=\s*req\.params/g))
    for(const p of m2[1].split(',')) leidos.add(p.split(':')[0].trim());
  for(const d of leidos)
    if(!declarados.includes(d))
      fallos.push(`${metodo.toUpperCase()} ${ruta}  →  ${ns}.${fn} lee req.params.${d}, pero la ruta declara :${declarados.join(', :')}`);
}
console.log(`rutas con parámetros revisadas: ${revisadas}`);
if(fallos.length){ console.log('\n❌ DESAJUSTES:'); fallos.forEach(f=>console.log('  '+f)); process.exit(1); }
console.log('✅ todo parámetro leído está declarado en su ruta');
