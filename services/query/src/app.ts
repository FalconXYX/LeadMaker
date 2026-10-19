import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ACTIVITY_TYPES, authenticateInternal, DEFAULT_WEEKLY_ACTIVITY_GOAL, isManager, leadFilterSchema, TASK_DUE, type Viewer,
} from '@leadmaker/shared';
import { allocationSuggestions, DEFAULT_SUGGESTION_LIMIT, listUsers } from './admin.ts';
import { getAiContext } from './ai-context.ts';
import { getTerritoryBrief } from './brief.ts';
import type { Cache } from './cache.ts';
import { getDashboard } from './dashboard.ts';
import { ClientClosedError, guarded, pgCode, type Db } from './db.ts';
import { badRequest, busy, forbidden, HttpError } from './errors.ts';
import { listCustomFieldKeys, listCustomTags } from './catalog.ts';
import { getFacets } from './facets.ts';
import { getKpis } from './kpis.ts';
import { Limiter } from './limiter.ts';
import type { Logger } from './log.ts';
import { CountySignals } from './lead-timing.ts';
import { getMap } from './map.ts';
import { ACTIVITY_LIMIT, getActivity, getProfile } from './profile.ts';
import { searchLeads } from './search.ts';
import { defaultScope, getSignals } from './signals.ts';
import { DEFAULT_TASK_LIMIT, listTasks, MAX_TASK_LIMIT, salesScope } from './tasks.ts';
import { getPreferences, listViews } from './views.ts';
import { getFilterVocabulary } from './vocabulary.ts';

export interface AppDeps {
  /** Fast pool: profile, KPIs, users, suggestions. */
  db: Db;
  /** Search pool (defaults to db) and the admission limiter in front of it. */
  searchDb?: Db;
  searchLimiter?: Limiter;
  cache: Cache;
  log: Logger;
  internalToken: string;
  leadListTtlSeconds: number;
  /** Counties' signals for list pages' timing badges (one per process). */
  countySignals?: CountySignals;
  /** Calls, emails and visits per rep per week: the dashboard's goal (ConfigResponse.weeklyActivityGoal). */
  weeklyActivityGoal?: number;
}

const searchBody = z.object({ filter: leadFilterSchema.optional() }).strict();
const usersQuery = z.object({ role: z.enum(['rep', 'manager']).optional() });
const suggestionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(5000).optional() });
const KNOWN_ACTIVITY_TYPES = new Set<string>(ACTIVITY_TYPES);
// ?type=call,email,visit: any of these action types.
const activityTypes = z.string().max(500).transform((value, ctx) => {
  const types = [...new Set(value.split(',').map((t) => t.trim()))];
  const unknown = types.filter((t) => !KNOWN_ACTIVITY_TYPES.has(t));
  if (!unknown.length) return types;
  ctx.addIssue({ code: 'custom', message: `unknown activity type ${JSON.stringify(unknown[0])}; expected any of ${ACTIVITY_TYPES.join(', ')}` });
  return z.NEVER;
});
const activityQuery = z.object({
  before: z.string().max(64).optional(),
  type: activityTypes.optional(),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_LIMIT).optional(),
});
const signalsQueryParams = z.object({ scope: z.enum(['mine', 'pool', 'all']).optional() });
const mapQueryParams = z.object({ scope: z.string().max(100).optional() });
const salesScopeParam = z.string().max(100).optional();
const tasksQueryParams = z.object({
  scope: salesScopeParam,
  due: z.enum(TASK_DUE).optional(),
  status: z.enum(['open', 'done']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TASK_LIMIT).optional(),
  cursor: z.string().max(500).optional(),
});
const dashboardQueryParams = z.object({ scope: salesScopeParam });
const briefQueryParams = z.object({ scope: z.string().max(100).optional() });

function viewer(res: Response): Viewer {
  return res.locals.viewer as Viewer;
}

/** Aborted when the caller goes away before the response is sent (gateway timeout or client disconnect). */
function signal(res: Response): AbortSignal {
  return (res.locals.abort as AbortController).signal;
}

function managersOnly(_req: Request, res: Response, next: NextFunction) {
  next(isManager(viewer(res)) ? undefined : forbidden('managers only'));
}

export function createApp(deps: AppDeps) {
  const { cache, log } = deps;
  const searchDb = deps.searchDb ?? deps.db;
  const limiter = deps.searchLimiter ?? new Limiter({ concurrency: 8, maxQueue: 32, maxWaitMs: 1000 });
  const countySignals = deps.countySignals ?? new CountySignals();
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    const [pg, redis] = await Promise.allSettled([deps.db.replica.$queryRaw`SELECT 1`, cache.redis.ping()]);
    const ok = pg.status === 'fulfilled' && redis.status === 'fulfilled';
    res.status(ok ? 200 : 503).json({ ok, postgres: pg.status === 'fulfilled', redis: redis.status === 'fulfilled' });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    const auth = authenticateInternal(req.headers, deps.internalToken);
    if (!auth.ok) return void res.status(auth.status).json({ error: auth.error });
    res.locals.viewer = auth.viewer;
    const abort = new AbortController();
    res.locals.abort = abort;
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    next();
  });
  // Per request: queries are skipped once the caller has gone; searches also wait for a limiter slot.
  const fast = (res: Response) => guarded(deps.db, signal(res));
  api.use(express.json({ limit: '64kb' }));

  api.post('/leads/search', async (req, res) => {
    const body = searchBody.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid filter', z.treeifyError(body.error));
    const db = guarded(searchDb, signal(res), limiter);
    const { result, cache: state } = await searchLeads(
      db, cache, body.data.filter ?? {}, viewer(res), deps.leadListTtlSeconds, countySignals, fast(res));
    res.set('X-Cache', state).json(result);
  });

  // A scan over the scope's leads, so it takes a search slot. Registered before /leads/:id.
  api.get('/leads/map', async (req, res) => {
    const q = mapQueryParams.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const db = guarded(searchDb, signal(res), limiter);
    const { result, cache: state } = await getMap(db, cache, viewer(res), q.data.scope, deps.leadListTtlSeconds);
    res.set('X-Cache', state).json(result);
  });

  api.post('/leads/facets', async (req, res) => {
    const body = searchBody.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid filter', z.treeifyError(body.error));
    const db = guarded(searchDb, signal(res), limiter);
    const { result, cache: state } = await getFacets(db, cache, body.data.filter ?? {}, viewer(res), deps.leadListTtlSeconds);
    res.set('X-Cache', state).json(result);
  });

  api.get('/leads/:id', async (req, res) => {
    const { profile, cache: state } = await getProfile(fast(res), cache, req.params.id, viewer(res));
    res.set('X-Cache', state).json(profile);
  });

  // The assistant's view of one lead (LeadAiContext): the profile's visibility and 404, no contact emails or phones.
  api.get('/leads/:id/ai-context', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await getAiContext(fast(res), cache, req.params.id, viewer(res)));
  });

  api.get('/leads/:id/activity', async (req, res) => {
    const q = activityQuery.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const { before, type: types, limit } = q.data;
    res.json(await getActivity(fast(res), cache, req.params.id, viewer(res), { before, types, limit: limit ?? ACTIVITY_LIMIT }));
  });

  api.get('/signals', async (req, res) => {
    const q = signalsQueryParams.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const { result, cache: state } = await getSignals(fast(res), cache, viewer(res), q.data.scope ?? defaultScope(viewer(res)));
    res.set('X-Cache', state).json(result);
  });

  api.get('/custom-tags', async (_req, res) => {
    const primary = await cache.recentlyWrote(viewer(res).id);
    res.json({ items: await listCustomTags(fast(res), viewer(res), primary) });
  });

  // A scan over the visible leads' custom_fields, so it takes a search slot.
  api.get('/custom-fields/keys', async (_req, res) => {
    const primary = await cache.recentlyWrote(viewer(res).id);
    res.json({ items: await listCustomFieldKeys(guarded(searchDb, signal(res), limiter), viewer(res), primary) });
  });

  api.get('/views', async (_req, res) => {
    const primary = await cache.recentlyWrote(viewer(res).id);
    res.json({ items: await listViews(fast(res), viewer(res), primary) });
  });

  api.get('/preferences', async (_req, res) => {
    const primary = await cache.recentlyWrote(viewer(res).id);
    res.json(await getPreferences(fast(res), viewer(res), primary));
  });

  api.get('/kpis', async (_req, res) => {
    res.json(await getKpis(fast(res), cache, viewer(res)));
  });

  api.get('/tasks', async (req, res) => {
    const q = tasksQueryParams.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const scope = salesScope(viewer(res), q.data.scope ?? 'mine');
    const primary = await cache.recentlyWrote(viewer(res).id);
    res.json(await listTasks(fast(res), viewer(res), {
      scope, due: q.data.due ?? 'all', status: q.data.status ?? 'open', limit: q.data.limit ?? DEFAULT_TASK_LIMIT, cursor: q.data.cursor,
    }, primary));
  });

  api.get('/dashboard', async (req, res) => {
    const q = dashboardQueryParams.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    // The team's coverage and top tags scan every allocated lead: a search slot, also for a background refresh.
    const { result, cache: state } = await getDashboard(
      fast(res), cache, viewer(res), q.data.scope, deps.weeklyActivityGoal ?? DEFAULT_WEEKLY_ACTIVITY_GOAL,
      { scan: guarded(searchDb, signal(res), limiter), background: guarded(searchDb, new AbortController().signal, limiter) });
    res.set('X-Cache', state).json(result);
  });

  // Values the AI filter tool may use for this viewer; the counties and custom-field-key scans take a search slot.
  api.get('/filter-vocabulary', async (_req, res) => {
    const { result, cache: state } = await getFilterVocabulary(
      { fast: fast(res), scan: guarded(searchDb, signal(res), limiter) }, cache, viewer(res));
    res.set('X-Cache', state).json(result);
  });

  api.get('/territory-brief', async (req, res) => {
    const q = briefQueryParams.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    const { result, cache: state } = await getTerritoryBrief(fast(res), cache, viewer(res), q.data.scope);
    res.set('X-Cache', state).json(result);
  });

  api.get('/users', managersOnly, async (req, res) => {
    const q = usersQuery.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    res.json({ items: await listUsers(fast(res), q.data.role) });
  });

  api.get('/allocations/suggestions', managersOnly, async (req, res) => {
    const q = suggestionsQuery.safeParse(req.query);
    if (!q.success) throw badRequest('invalid query', z.treeifyError(q.error));
    res.json(await allocationSuggestions(fast(res), q.data.limit ?? DEFAULT_SUGGESTION_LIMIT));
  });

  // Reachable as /leads/... (gateway strips /api) and /api/leads/... (gateway forwards the path as is).
  app.use('/api', api);
  app.use(api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ClientClosedError || res.destroyed) return void res.end();
    // 57014: statement_timeout (or a cancel) stopped the query. Class 53: Postgres ran out of a resource
    // (shared memory, connections), which passes.
    const code = pgCode(err);
    if (code?.startsWith('53')) log.warn({ code, err: (err as Error).message, url: req.originalUrl }, 'postgres out of resources');
    if (code === '57014' || code?.startsWith('53')) err = busy();
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      return void res.status(err.status).json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
    }
    const status = (err as { status?: number; type?: string }).status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: (err as Error).message });
    log.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

