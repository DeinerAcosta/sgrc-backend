import { PrismaClient } from '@prisma/client'

// Singleton para evitar múltiples conexiones en hot-reload de dev
const globalForPrisma = globalThis

export const prisma = globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV === 'development') {
  globalForPrisma.__prisma__ = prisma
}
