import express, { type Express, Router } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Prisma, type PrismaClient } from '@leadmaker/db';
import { authenticate } from './auth.ts';
import type { Config } from './config.ts';
import { errorHandler } from './http.ts';
import { allocationRoutes } from './routes/allocations.ts';
import { contactRoutes } from './routes/contacts.ts';
import { customRoutes } from './routes/custom.ts';
import { insightsRoutes } from './routes/insights.ts';
import { leadRoutes } from './routes/leads.ts';
import { overrideRoutes } from './routes/overrides.ts';
import { preferenceRoutes } from './routes/preferences.ts';
import { refreshRoutes } from './routes/refresh.ts';
import { taskRoutes } from './routes/tasks.ts';
import { viewRoutes } from './routes/views.ts';
import { configureInsightsHook, writer } from './tx.ts';

export type Deps = {
  db: PrismaClient;
  config: Config;
  write: ReturnType<typeof writer>;
};

export type AppOptions = {
  db: PrismaClient;
  redis: Redis | null;
  config: Config;
  log: Logger;
};

export function createApp({ db, redis, config, log }: AppOptions): Express {
  const deps: Deps = { db, config, write: writer(db, redis, log) };
  if (config.insightsOnEdit) configureInsightsHook(config.insightsOnEdit);
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_req, res) => {
    try {
      await db.$queryRaw(Prisma.sql`SELECT 1`);
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(authenticate(db, config.internalToken));
  app.use(express.json({ limit: '256kb' }));

  const api = Router();
  api.use(
    leadRoutes(deps), overrideRoutes(deps), contactRoutes(deps), customRoutes(deps), allocationRoutes(deps), refreshRoutes(deps),
    viewRoutes(deps), preferenceRoutes(deps), taskRoutes(deps), insightsRoutes(deps),
  );
  // The gateway forwards /api/* unchanged; the bare paths are accepted too.
  app.use('/api', api);
  app.use(api);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(log));
  return app;
}
