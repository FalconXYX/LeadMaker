import { createApp } from './app.ts';
import { Cache, createRedis } from './cache.ts';
import { loadConfig } from './config.ts';
import { createPools } from './db.ts';
import { Limiter } from './limiter.ts';
import { createLogger } from './log.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
const pools = createPools(
  { primary: config.databaseUrl, replica: config.replicaUrl },
  { max: config.poolMax, statementTimeoutMs: config.statementTimeoutMs },
  { max: config.searchPoolMax, statementTimeoutMs: config.searchStatementTimeoutMs },
);
const redis = createRedis(config.redisUrl, config.redisCommandTimeoutMs);
redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));

const app = createApp({
  db: pools.fast,
  searchDb: pools.search,
  searchLimiter: new Limiter({
    concurrency: config.searchConcurrency, maxQueue: config.searchQueueMax, maxWaitMs: config.searchQueueWaitMs,
  }),
  cache: new Cache(redis, log, { cooldownMs: config.redisCooldownMs }),
  log,
  internalToken: config.internalToken,
  leadListTtlSeconds: config.leadListTtlSeconds,
  weeklyActivityGoal: config.weeklyActivityGoal,
});

const server = app.listen(config.port, () => log.info({ port: config.port }, 'query service listening'));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([pools.close(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
