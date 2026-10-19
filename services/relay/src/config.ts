import { hostname } from 'node:os';
import { EVENTS_STREAM } from '@leadmaker/shared';

export type Config = {
  port: number;
  redisUrl: string;
  stream: string;
  streamMaxLen: number;
  batchSize: number;
  pollIntervalMs: number;
  consumerGroup: string;
  consumerName: string;
  claimIdleMs: number;
  profileVersionWindow: number;
  kpiRefreshIntervalMs: number;
  kpiRefreshDebounceMs: number;
  /** Longest a bump of leads:v:all / leads:v:pool is held so a burst moves them once; 0 bumps at once. */
  listVersionCoalesceMs: number;
  logLevel: string;
};

const num = (v: string | undefined, fallback: number, min = 1): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`invalid integer >= ${min}: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8083),
    redisUrl: env.REDIS_URL || 'redis://localhost:56379',
    stream: env.EVENTS_STREAM || EVENTS_STREAM,
    streamMaxLen: num(env.EVENTS_STREAM_MAXLEN, 100_000),
    batchSize: num(env.OUTBOX_BATCH_SIZE, 200),
    pollIntervalMs: num(env.OUTBOX_POLL_INTERVAL_MS, 1000),
    consumerGroup: env.CACHE_CONSUMER_GROUP || 'cache-invalidation',
    consumerName: env.CACHE_CONSUMER_NAME || hostname(),
    claimIdleMs: num(env.CACHE_CLAIM_IDLE_MS, 60_000),
    profileVersionWindow: num(env.PROFILE_VERSION_WINDOW, 50),
    kpiRefreshIntervalMs: num(env.KPI_REFRESH_INTERVAL_MS, 300_000),
    kpiRefreshDebounceMs: num(env.KPI_REFRESH_DEBOUNCE_MS, 2000),
    listVersionCoalesceMs: num(env.LIST_VERSION_COALESCE_MS, 1000, 0),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
