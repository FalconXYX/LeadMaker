import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export * from './generated/prisma/client.ts';

export const LOCAL_DATABASE_URL = 'postgres://leadmaker:leadmaker@localhost:55432/leadmaker';

/** DATABASE_URL, falling back to the local compose database outside production. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is not set');
  return LOCAL_DATABASE_URL;
}

export function createPrismaClient(url: string = databaseUrl()): PrismaClient {
  const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
}

// One client (and pool) per process, also across hot reloads and duplicate module copies.
// Connections open lazily on the first query, so importing this needs no database.
const globalForPrisma = globalThis as typeof globalThis & { __leadmakerPrisma?: PrismaClient };

export const prisma: PrismaClient = (globalForPrisma.__leadmakerPrisma ??= createPrismaClient());
