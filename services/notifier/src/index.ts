import { createPrismaClient } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { NotificationConsumer } from './consumer.ts';
import { processDueTasks, processEvents, prune } from './engine.ts';
import { createLogger } from './log.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = createPrismaClient(config.databaseUrl);

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, commandTimeout: 5000 });
const blocking = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
blocking.on('error', (err) => log.warn({ err: err.message }, 'redis (consumer) error'));

const consumer = new NotificationConsumer(
  blocking,
  (events) => processEvents(db, events),
  () => db.$queryRaw`SELECT 1`.then(() => true, () => false),
  {
    stream: config.stream,
    group: config.consumerGroup,
    consumer: config.consumerName,
    claimIdleMs: config.claimIdleMs,
    maxAttempts: config.maxAttempts,
  },
  log,
);
await consumer.ensureGroup();
consumer.start();

const pruneTimer = setInterval(() => {
  prune(db, config.processedRetentionDays).then(
    (n) => n && log.info({ deleted: n }, 'notifier pruned'),
    (err) => log.warn({ err }, 'notifier prune failed'),
  );
}, 3_600_000);

const checkDueTasks = () => processDueTasks(db).then(
  (written) => written.length && log.info({ notified: written.length }, 'task_due notifications written'),
  (err) => log.warn({ err }, 'task_due pass failed'),
);
const dueTimer = setInterval(() => void checkDueTasks(), config.taskDueIntervalMs);
void checkDueTasks();

const app = createApp({ db, redis, internalToken: config.internalToken, log, consumer, staleAfterMs: 30_000 });
const server = app.listen(config.port, () => log.info({ port: config.port, consumer: config.consumerName }, 'notifier listening'));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  clearInterval(dueTimer);
  server.close();
  await consumer.stop();
  redis.disconnect();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
