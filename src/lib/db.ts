import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 7 connects through a driver adapter rather than reading the URL from
 * schema.prisma, so the connection string is supplied here.
 *
 * Next's dev server hot-reloads modules; without the global cache every edit
 * would open another pool until Postgres refused connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const db = globalForPrisma.prisma ?? create();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
