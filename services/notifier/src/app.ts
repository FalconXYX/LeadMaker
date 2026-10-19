import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@leadmaker/db';
import {
  authenticateInternal, canView, isUuid, NOTIFICATION_TYPES, type NotificationPreferences, type NotificationsPage,
  type NotificationsReadResult, type NotificationType, type Viewer,
} from '@leadmaker/shared';
import type { Redis } from 'ioredis';
import type { ConsumerStats } from './consumer.ts';
import type { Logger } from './log.ts';
import type { Data } from './store.ts';

export type AppDeps = {
  db: PrismaClient;
  redis: Redis;
  internalToken: string;
  log: Logger;
  /** The stream consumer; /readyz degrades when it has not read for staleAfterMs. */
  consumer?: { stats: ConsumerStats };
  staleAfterMs?: number;
};

class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);

export const DEFAULT_LIMIT = 30;
const listQuery = z.object({
  unread: z.enum(['1', '0', 'true', 'false']).optional(),
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const uuid = z.uuid();
const readBody = z.union([
  z.object({ ids: z.array(uuid).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
const prefsBody = z.object({
  items: z.array(z.object({ type: z.enum(NOTIFICATION_TYPES), enabled: z.boolean() }).strict()).min(1).max(NOTIFICATION_TYPES.length)
    .refine((items) => new Set(items.map((i) => i.type)).size === items.length, 'each type at most once'),
}).strict();

type Row = {
  id: string; type: NotificationType; title: string; body: string; company_id: string | null; county_fips: string | null;
  data: Data; count: number; created_at: Date; updated_at: Date; read_at: Date | null; cursor_ts: string;
};

// Cursor: the last item's updated_at as Postgres prints it (microseconds kept) and its id.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const encodeCursor = (r: Row) => Buffer.from(JSON.stringify([r.cursor_ts, r.id])).toString('base64url');
function decodeCursor(s: string): { ts: string; id: string } {
  try {
    const [ts, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof ts === 'string' && TIMESTAMP.test(ts) && uuid.safeParse(id).success) {
      return { ts, id };
    }
  } catch {
    // fall through
  }
  throw badRequest('invalid cursor');
}

const viewer = (res: Response) => res.locals.viewer as Viewer;

export function createApp(deps: AppDeps) {
  const { db, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    const [pg, redis] = await Promise.allSettled([db.$queryRaw`SELECT 1`, deps.redis.ping()]);
    const stats = deps.consumer?.stats;
    const stale = deps.staleAfterMs ?? 30_000;
    const consumer = !stats || (stats.lastReadAt !== null && Date.now() - stats.lastReadAt.getTime() < stale);
    const ok = pg.status === 'fulfilled' && redis.status === 'fulfilled' && consumer;
    res.status(ok ? 200 : 503).json({
      ok, postgres: pg.status === 'fulfilled', redis: redis.status === 'fulfilled', consumer: stats ? { ok: consumer, ...stats } : null,
    });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    const auth = authenticateInternal(req.headers, deps.internalToken);
    if (!auth.ok) return void res.status(auth.status).json({ error: auth.error });
    res.locals.viewer = auth.viewer;
    next();
  });
  api.use(express.json({ limit: '64kb' }));

  const unreadCount = async (userId: string) => {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
    return n;
  };

  // Leads the notifications link to that the viewer can still open; one that moved to another rep since is unlinked.
  const viewableLeads = async (v: Viewer, rows: Row[]) => {
    const ids = [...new Set(rows.flatMap((r) => [r.company_id, ...(Array.isArray(r.data.company_ids) ? r.data.company_ids : [])]))]
      .filter(isUuid);
    if (!ids.length) return new Set<string>();
    const leads = await db.$queryRaw<{ id: string; assigned_rep_id: string | null }[]>`
      SELECT id::text, assigned_rep_id::text FROM companies WHERE id = ANY(${ids}::uuid[])`;
    return new Set(leads.filter((c) => canView(v, c.assigned_rep_id)).map((c) => c.id));
  };

  // Newest activity first: a merge moves a notification back to the top.
  api.get('/notifications', async (req, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const me = viewer(res).id;
    const limit = q.data.limit ?? DEFAULT_LIMIT;
    const unread = q.data.unread === '1' || q.data.unread === 'true';
    const cursor = q.data.before ? decodeCursor(q.data.before) : null;
    const rows = await db.$queryRaw<Row[]>`
      SELECT id::text, type, title, body, company_id::text, county_fips::text, data, count, created_at, updated_at, read_at,
             updated_at::text AS cursor_ts
      FROM notifications
      WHERE user_id = ${me}::uuid
        ${unread ? Prisma.sql`AND read_at IS NULL` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (updated_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : Prisma.empty}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const leads = await viewableLeads(viewer(res), page);
    res.json({
      items: page.map((r) => ({
        id: r.id, type: r.type, title: r.title, body: r.body,
        companyId: r.company_id && leads.has(r.company_id) ? r.company_id : null, countyFips: r.county_fips,
        data: Array.isArray(r.data.company_ids) ? { ...r.data, company_ids: r.data.company_ids.filter((id) => leads.has(id)) } : r.data,
        count: r.count, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
        readAt: r.read_at?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      unreadCount: await unreadCount(me),
    } satisfies NotificationsPage);
  });

  // Only the caller's own unread rows change; anyone else's ids are ignored, not reported.
  api.post('/notifications/read', async (req, res) => {
    const body = readBody.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('send {ids: uuid[]} or {all: true}', z.treeifyError(body.error));
    const me = viewer(res).id;
    const updated = await db.$executeRaw`
      UPDATE notifications SET read_at = NOW()
      WHERE user_id = ${me}::uuid AND read_at IS NULL
        ${'ids' in body.data ? Prisma.sql`AND id = ANY(${body.data.ids}::uuid[])` : Prisma.empty}`;
    res.json({ updated, unreadCount: await unreadCount(me) } satisfies NotificationsReadResult);
  });

  const preferences = async (userId: string): Promise<NotificationPreferences> => {
    const rows = await db.$queryRaw<{ type: string; enabled: boolean }[]>`
      SELECT type, enabled FROM notification_preferences WHERE user_id = ${userId}::uuid`;
    const stored = new Map(rows.map((r) => [r.type, r.enabled]));
    return { items: NOTIFICATION_TYPES.map((type) => ({ type, enabled: stored.get(type) ?? true })) };
  };

  api.get('/notifications/preferences', async (_req, res) => {
    res.json(await preferences(viewer(res).id));
  });

  api.put('/notifications/preferences', async (req, res) => {
    const body = prefsBody.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid preferences', z.treeifyError(body.error));
    const me = viewer(res).id;
    await db.$executeRaw`
      INSERT INTO notification_preferences (user_id, type, enabled)
      SELECT ${me}::uuid, p.type, p.enabled
      FROM jsonb_to_recordset(${JSON.stringify(body.data.items)}::jsonb) AS p(type text, enabled boolean)
      ON CONFLICT (user_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`;
    res.json(await preferences(me));
  });

  // Reachable as /notifications... and /api/notifications... (the gateway forwards the path as is).
  app.use('/api', api);
  app.use(api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return void res.status(err.status).json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
    }
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: (err as Error).message });
    log.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
