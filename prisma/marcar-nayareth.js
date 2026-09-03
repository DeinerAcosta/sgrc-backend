import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const r = await p.resource.findFirst({
  where: { name: { contains: 'Nayareth' } },
})
if (!r) { console.log('No encontrada'); process.exit(0) }

console.log(`Encontrada: ${r.name} (tipo=${r.type}, tiposApoyo actual="${r.supportTypes ?? ''}")`)
await p.resource.update({
  where: { id: r.id },
  data: { supportTypes: 'auxiliar' },
})
console.log(`✅ Marcada con tiposApoyo='auxiliar'. Ahora aparece tanto en el pool de técnicos (diagnóstico) como en el de auxiliares (oftalmología/anestesiología).`)

await p.$disconnect()
