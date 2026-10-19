import { Redis } from 'ioredis';
import { pino } from 'pino';
import { prisma } from '@leadmaker/db';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: 'crm-write' } });
const redis = config.redisUrl
  ? new Redis(config.redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 1000 })
  : null;
redis?.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
if (!redis) log.warn('REDIS_URL is not set: read-your-writes markers are disabled');

const app = createApp({ db: prisma, redis, config, log });
const server = app.listen(config.port, () => log.info({ port: config.port }, 'crm-write listening'));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  // Let in-flight writes commit (and set their read-your-writes marker) before closing the pools.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 10_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await Promise.allSettled([prisma.$disconnect(), redis?.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
