import { PrismaClient } from '@prisma/client'

// Pool de conexiones: se configura en la DATABASE_URL, NO aquí. Para soportar
// muchos usuarios concurrentes, en producción usar algo como:
//   postgresql://user:pass@host:5432/sgrc?schema=public&connection_limit=20&pool_timeout=20
// Una instancia de PrismaClient por proceso ya mantiene su propio pool; si se
// corren varias réplicas, considerar PgBouncer delante de PostgreSQL.

// Singleton para evitar múltiples conexiones en hot-reload de dev
const globalForPrisma = globalThis

export const prisma = globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV === 'development') {
  globalForPrisma.__prisma__ = prisma
}
