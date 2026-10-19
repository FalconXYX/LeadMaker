import { databaseUrl } from '@leadmaker/db';
import { internalToken, LEAD_LIST_TTL_SECONDS, weeklyActivityGoal } from '@leadmaker/shared';

export interface Config {
  port: number;
  internalToken: string;
  databaseUrl: string;
  /** Read replica; unset locally, where the primary serves reads too. */
  replicaUrl: string | undefined;
  redisUrl: string;
  /** Upper bound for one Redis command; on a failure the cache is skipped for redisCooldownMs. */
  redisCommandTimeoutMs: number;
  redisCooldownMs: number;
  leadListTtlSeconds: number;
  logLevel: string;
  /** Fast pool (profile, KPIs, users, suggestions), per database. */
  poolMax: number;
  statementTimeoutMs: number;
  /** Search pool, per database, and the admission limiter in front of it. */
  searchPoolMax: number;
  searchStatementTimeoutMs: number;
  searchConcurrency: number;
  searchQueueMax: number;
  searchQueueWaitMs: number;
  /** WEEKLY_ACTIVITY_GOAL, as the gateway reports it on GET /api/config. */
  weeklyActivityGoal: number;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return n;
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  return value === '0' ? 0 : positiveInt(value, fallback, name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) throw new Error('REDIS_URL is not set');
  const poolMax = positiveInt(env.DATABASE_POOL_MAX, 10, 'DATABASE_POOL_MAX');
  const searchPoolMax = positiveInt(env.DATABASE_SEARCH_POOL_MAX, 8, 'DATABASE_SEARCH_POOL_MAX');
  return {
    port: positiveInt(env.PORT, 8081, 'PORT'),
    internalToken: internalToken(env),
    databaseUrl: databaseUrl(env),
    replicaUrl: env.DATABASE_REPLICA_URL || undefined,
    redisUrl: env.REDIS_URL || 'redis://localhost:56379',
    redisCommandTimeoutMs: positiveInt(env.REDIS_COMMAND_TIMEOUT_MS, 250, 'REDIS_COMMAND_TIMEOUT_MS'),
    redisCooldownMs: positiveInt(env.REDIS_COOLDOWN_MS, 1000, 'REDIS_COOLDOWN_MS'),
    leadListTtlSeconds: positiveInt(env.LEAD_LIST_CACHE_TTL_SECONDS, LEAD_LIST_TTL_SECONDS, 'LEAD_LIST_CACHE_TTL_SECONDS'),
    logLevel: env.LOG_LEVEL || 'info',
    poolMax,
    statementTimeoutMs: positiveInt(env.STATEMENT_TIMEOUT_MS, 1000, 'STATEMENT_TIMEOUT_MS'),
    searchPoolMax,
    searchStatementTimeoutMs: positiveInt(env.SEARCH_STATEMENT_TIMEOUT_MS, 2000, 'SEARCH_STATEMENT_TIMEOUT_MS'),
    // More running searches than connections would only wait inside the pool, where nothing can drop them.
    searchConcurrency: Math.min(positiveInt(env.SEARCH_CONCURRENCY, searchPoolMax, 'SEARCH_CONCURRENCY'), searchPoolMax),
    searchQueueMax: nonNegativeInt(env.SEARCH_QUEUE_MAX, 4 * searchPoolMax, 'SEARCH_QUEUE_MAX'),
    searchQueueWaitMs: positiveInt(env.SEARCH_QUEUE_WAIT_MS, 1000, 'SEARCH_QUEUE_WAIT_MS'),
    weeklyActivityGoal: weeklyActivityGoal(env),
  };
}
