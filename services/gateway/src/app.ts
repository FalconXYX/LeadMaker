import express, { type NextFunction, type Request, type Response } from 'express';
import type { ConfigResponse } from '@leadmaker/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { requireAuth, type Tokens } from './auth.ts';
import type { Config } from './config.ts';
import type { Directory } from './directory.ts';
import { sseHandler, type EventHub } from './events.ts';
import { requestLogger } from './logger.ts';
import { proxy } from './proxy.ts';
import { rateLimit, type RateLimiter } from './rateLimit.ts';
import { cachedRoles, currentRole, type Roles } from './roles.ts';

export type Deps = {
  config: Config;
  log: Logger;
  tokens: Tokens;
  directory: Directory;
  limiter: RateLimiter;
  hub: EventHub;
  redis: Redis;
  /** Defaults to users.role cached in Redis for config.roleTtlSeconds. */
  roles?: Roles;
};

export function createApp({ config, log, tokens, directory, limiter, hub, redis, ...deps }: Deps) {
  const roles = deps.roles ?? cachedRoles(redis, directory, config.roleTtlSeconds);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(requestLogger(log));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch {
        return 'down';
      }
    };
    const [db, cache] = await Promise.all([check(() => directory.ping()), check(() => redis.ping())]);
    res.status(db === 'ok' && cache === 'ok' ? 200 : 503).json({ status: db === 'ok' && cache === 'ok' ? 'ok' : 'degraded', db, redis: cache });
  });

  if (config.demoMode) {
    app.post(
      '/auth/dev-login',
      rateLimit(limiter, (req) => `rl:ip:${req.ip}`, log),
      express.json({ limit: '4kb' }),
      async (req, res) => {
        const email = req.body?.email;
        if (typeof email !== 'string' || !email.includes('@') || email.length > 255) {
          res.status(400).json({ error: 'invalid_request', message: 'email is required' });
          return;
        }
        const user = await directory.userByEmail(email.trim());
        if (!user) {
          res.status(401).json({ error: 'unknown_user' });
          return;
        }
        res.json({ token: await tokens.sign(user), user });
      },
    );
  }

  app.use(
    '/api',
    requireAuth(tokens, { allowQueryToken: (req) => req.method === 'GET' && req.path === '/events' }),
    rateLimit(limiter, (req) => `rl:user:${req.user!.id}`, log),
    currentRole(roles),
  );

  app.get('/api/me', async (req, res) => {
    const user = await directory.userById(req.user!.id);
    if (!user) {
      res.status(401).json({ error: 'invalid_token', message: 'user no longer exists' });
      return;
    }
    res.json(user);
  });

  app.get('/api/config', (_req, res) => {
    res.json({ ...config.limits, userRoleTtlSeconds: config.roleTtlSeconds } satisfies ConfigResponse);
  });

  app.get('/api/events', sseHandler(hub, {
    maxPerUser: config.sseMaxPerUser, heartbeatMs: config.sseHeartbeatMs, roles, roleCheckMs: config.sseRoleCheckMs,
  }));

  app.all(
    '/api/*splat',
    proxy({
      targets: {
        query: config.queryUrl, 'crm-write': config.crmWriteUrl, notifier: config.notifierUrl, assistant: config.assistantUrl,
      },
      internalToken: config.internalToken,
      timeoutMs: config.upstreamTimeoutMs,
      timeouts: { assistant: config.assistantTimeoutMs },
      maxBodyBytes: config.maxBodyBytes,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).json({ error: status === 500 ? 'internal_error' : err.type ?? 'bad_request' });
  });

  return app;
}
