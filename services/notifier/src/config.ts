import { hostname } from 'node:os';
import { databaseUrl } from '@leadmaker/db';
import { EVENTS_STREAM, internalToken } from '@leadmaker/shared';

export type Config = {
  port: number;
  internalToken: string;
  databaseUrl: string;
  redisUrl: string;
  stream: string;
  consumerGroup: string;
  consumerName: string;
  claimIdleMs: number;
  /** A stream entry that keeps failing is logged and acked after this many attempts. */
  maxAttempts: number;
  /** notifier_processed_events rows older than this are pruned. */
  processedRetentionDays: number;
  /** How often open tasks are checked for task_due notifications. */
  taskDueIntervalMs: number;
  logLevel: string;
};

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid positive integer: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8084),
    internalToken: internalToken(env),
    databaseUrl: databaseUrl(env),
    redisUrl: env.REDIS_URL || 'redis://localhost:56379',
    stream: env.EVENTS_STREAM || EVENTS_STREAM,
    consumerGroup: env.NOTIFIER_CONSUMER_GROUP || 'notifier',
    consumerName: env.NOTIFIER_CONSUMER_NAME || hostname(),
    claimIdleMs: num(env.NOTIFIER_CLAIM_IDLE_MS, 60_000),
    maxAttempts: num(env.NOTIFIER_MAX_ATTEMPTS, 5),
    processedRetentionDays: num(env.NOTIFIER_PROCESSED_RETENTION_DAYS, 14),
    taskDueIntervalMs: num(env.NOTIFIER_TASK_DUE_INTERVAL_MS, 300_000),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
