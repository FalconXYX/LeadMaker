import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@leadmaker/db';
import type { Sql } from '@leadmaker/shared';
import type { Limiter } from './limiter.ts';

/** Reads go to the replica, except a user's own reads for a few seconds after their write (read-your-writes). */
export interface Db {
  primary: PrismaClient;
  replica: PrismaClient;
}

export interface PoolOptions {
  max: number;
  /** Sent as a startup parameter, so every statement on these connections is cancelled (57014) after it. */
  statementTimeoutMs: number;
}

export function createClient(url: string, { max, statementTimeoutMs }: PoolOptions): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max, statement_timeout: statementTimeoutMs }) });
}

/**
 * Two pools per database: search (slow, variable statements) and fast (profile, KPIs, users, suggestions),
 * so a burst of searches never queues a 1 ms profile read behind it.
 */
export interface Pools {
  fast: Db;
  search: Db;
  close(): Promise<void>;
}

export function createPools(urls: { primary: string; replica?: string }, fast: PoolOptions, search: PoolOptions): Pools {
  const db = (opts: PoolOptions): Db => {
    const primary = createClient(urls.primary, opts);
    return { primary, replica: urls.replica ? createClient(urls.replica, opts) : primary };
  };
  const pools = { fast: db(fast), search: db(search) };
  const clients = new Set([pools.fast.primary, pools.fast.replica, pools.search.primary, pools.search.replica]);
  return { ...pools, close: async () => void (await Promise.allSettled([...clients].map((c) => c.$disconnect()))) };
}

export class ClientClosedError extends Error {
  constructor() {
    super('client closed request');
  }
}

/**
 * The same Db for one request: a raw query is skipped once the caller has gone away and, with a limiter,
 * waits for one of its slots first. Only $queryRaw is guarded (every read goes through rows()).
 */
export function guarded(db: Db, signal: AbortSignal, limiter?: Limiter): Db {
  const wrap = (client: PrismaClient): PrismaClient => new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== '$queryRaw') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: Parameters<PrismaClient['$queryRaw']>) => {
        const run = () => {
          if (signal.aborted) throw new ClientClosedError();
          return target.$queryRaw(...args);
        };
        return limiter ? limiter.run(signal, run) : Promise.resolve().then(run);
      };
    },
  });
  const primary = wrap(db.primary);
  return { primary, replica: db.replica === db.primary ? primary : wrap(db.replica) };
}

export function pick(db: Db, primary: boolean): PrismaClient {
  return primary ? db.primary : db.replica;
}

export function rows<T>(client: PrismaClient, q: Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(new Prisma.Sql(q.strings, q.values));
}

export async function one<T>(client: PrismaClient, q: Sql): Promise<T | undefined> {
  return (await rows<T>(client, q))[0];
}

/** The Postgres SQLSTATE behind a failed raw query (driver adapter error), if any. */
export function pgCode(err: unknown): string | undefined {
  return (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } })
    ?.meta?.driverAdapterError?.cause?.originalCode;
}
