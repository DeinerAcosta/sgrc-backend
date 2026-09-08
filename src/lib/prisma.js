import { PrismaClient } from '@prisma/client'

// Pool de conexiones: se configura en la DATABASE_URL, NO aquí. Para soportar
// muchos usuarios concurrentes, en producción usar algo como:
//   mysql://user:pass@host:3306/sgrc?connection_limit=20&pool_timeout=20
// Una instancia de PrismaClient por proceso ya mantiene su propio pool; si se
// corren varias réplicas, vigilar que la suma de connection_limit de todas no
// supere el max_connections del servidor MySQL (151 por defecto).
//
// OJO: importar este módulo carga backend/.env por su cuenta — Prisma busca el
// .env junto a schema.prisma, sin depender del directorio de trabajo. Por eso
// las variables ya están disponibles aunque el proceso se lance desde otro sitio.

// Singleton para evitar múltiples conexiones en hot-reload de dev
const globalForPrisma = globalThis

export const prisma = globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV === 'development') {
  globalForPrisma.__prisma__ = prisma
}
