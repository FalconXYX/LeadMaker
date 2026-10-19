import { prisma } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { createApp } from './app.ts';
import { tokens } from './auth.ts';
import { DEV_JWT_SECRET, loadConfig } from './config.ts';
import { prismaDirectory } from './directory.ts';
import { EventHub } from './events.ts';
import { createLogger } from './logger.ts';
import { tokenBucket } from './rateLimit.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
if (config.jwtSecret === DEV_JWT_SECRET) log.warn('JWT_SECRET is the development default');
if (config.demoMode) log.warn('DEMO_MODE is on: POST /auth/dev-login issues tokens without a password');

// Commands fail fast so the rate limiter can fail open; the hub's blocking reads get their own connection.
const redis = new Redis(config.redisUrl, { commandTimeout: 1000, maxRetriesPerRequest: 1 });
const blocking = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
blocking.on('error', (err) => log.warn({ err: err.message }, 'redis (events) error'));

const directory = prismaDirectory(prisma);
const hub = new EventHub(blocking, redis, directory, config.eventsStream, log);
await hub.start();

const app = createApp({
  config,
  log,
  tokens: tokens(config.jwtSecret, config.jwtTtl),
  directory,
  limiter: tokenBucket(redis, config.rateLimitPerSecond, config.rateLimitBurst),
  hub,
  redis,
});

const server = app.listen(config.port, () => log.info({ port: config.port }, 'gateway listening'));
server.keepAliveTimeout = 65_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  // In-flight requests get a grace period; SSE streams never finish on their own, so they are cut after it.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const force = setTimeout(() => server.closeAllConnections(), 5000);
  await hub.stop();
  await closed;
  clearTimeout(force);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
