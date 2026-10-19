import { databaseUrl, prisma } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { VersionCoalescer } from './coalesce.ts';
import { loadConfig } from './config.ts';
import { healthServer } from './health.ts';
import { InvalidationConsumer } from './invalidation.ts';
import { KpiRefresher } from './kpis.ts';
import { listenForOutbox, OutboxPublisher } from './outbox.ts';

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  base: { service: 'relay' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});

// Bounded commands: the publisher holds an outbox transaction open across its XADDs.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, commandTimeout: 5000 });
const blocking = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
blocking.on('error', (err) => log.warn({ err: err.message }, 'redis (consumer) error'));

const kpis = new KpiRefresher(
  prisma, redis, { intervalMs: config.kpiRefreshIntervalMs, debounceMs: config.kpiRefreshDebounceMs }, log,
);
const coalescer = new VersionCoalescer(redis, config.listVersionCoalesceMs, log);
const consumer = new InvalidationConsumer(
  blocking,
  {
    db: prisma,
    redis,
    versionWindow: config.profileVersionWindow,
    onTeamKpiChange: (type) => kpis.schedule(type),
    coalescer,
  },
  { stream: config.stream, group: config.consumerGroup, consumer: config.consumerName, claimIdleMs: config.claimIdleMs },
  log,
);
const publisher = new OutboxPublisher(
  prisma,
  redis,
  { stream: config.stream, maxLen: config.streamMaxLen, batchSize: config.batchSize, pollIntervalMs: config.pollIntervalMs },
  log,
);

// The group must exist before the first publish, or a fresh stream's first events would be skipped.
await consumer.ensureGroup();
await coalescer.bumpAll().catch((err: unknown) => log.warn({ err }, 'startup list version bump failed'));
consumer.start();
publisher.start();
const listener = listenForOutbox(databaseUrl(), () => publisher.wake(), log);
kpis.start();

const startedAt = new Date();
const health = healthServer({
  publisher: publisher.stats,
  consumer: consumer.stats,
  kpis: kpis.stats,
  startedAt,
  staleAfterMs: Math.max(30_000, config.pollIntervalMs * 10),
});
health.listen(config.port, () => log.info({ port: config.port, consumer: config.consumerName }, 'relay running'));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  health.close();
  await listener.close();
  await Promise.all([publisher.stop(), consumer.stop(), kpis.stop()]);
  await coalescer.stop();
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
