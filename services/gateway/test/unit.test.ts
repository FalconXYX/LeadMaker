import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireAuth, tokens } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { compareIds, parseEntry, project, sseHandler, type EventHub, type SseMessage, type Visibility } from '../src/events.ts';
import { redactUrl, requestId } from '../src/logger.ts';
import { proxy, upstreamFor, upstreamHeaders } from '../src/proxy.ts';
import { requestLogger } from '../src/logger.ts';
import { rateLimit } from '../src/rateLimit.ts';
import { cachedRoles, currentRole } from '../src/roles.ts';
import type { Directory } from '../src/directory.ts';
import type { Redis } from 'ioredis';
import { pino } from 'pino';

const REP = { id: '11111111-1111-4111-8111-111111111111', role: 'rep' as const, name: 'Rep' };
const OTHER = '22222222-2222-4222-8222-222222222222';
const MANAGER = { id: '33333333-3333-4333-8333-333333333333', role: 'manager' as const, name: 'Boss' };
const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POOL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('upstreamFor', () => {
  it.each([
    ['POST', '/api/leads/search', 'query'],
    ['GET', '/api/leads/abc', 'query'],
    ['GET', '/api/leads/map', 'query'],
    ['POST', '/api/leads/facets', 'query'],
    ['POST', '/api/custom-tags/abc/leads', 'crm-write'],
    ['GET', '/api/kpis', 'query'],
    ['GET', '/api/users', 'query'],
    ['GET', '/api/allocations/suggestions', 'query'],
    ['POST', '/api/leads/abc/notes', 'crm-write'],
    ['POST', '/api/leads/abc/state', 'crm-write'],
    ['PUT', '/api/leads/abc/overrides/phone', 'crm-write'],
    ['DELETE', '/api/contacts/abc/overrides/email', 'crm-write'],
    ['POST', '/api/allocations/by-filter', 'crm-write'],
    ['DELETE', '/api/allocations/abc', 'crm-write'],
    ['DELETE', '/api/allocations', 'crm-write'],
    ['PATCH', '/api/custom-tags/abc', 'crm-write'],
    ['DELETE', '/api/custom-tags/abc', 'crm-write'],
    ['GET', '/api/views', 'query'],
    ['POST', '/api/views', 'crm-write'],
    ['PATCH', '/api/views/abc', 'crm-write'],
    ['DELETE', '/api/views/abc', 'crm-write'],
    ['GET', '/api/preferences', 'query'],
    ['PUT', '/api/preferences', 'crm-write'],
    ['POST', '/api/refresh', 'crm-write'],
    ['GET', '/api/tasks', 'query'],
    ['GET', '/api/dashboard', 'query'],
    ['POST', '/api/leads/abc/tasks', 'crm-write'],
    ['PATCH', '/api/tasks/abc', 'crm-write'],
    ['DELETE', '/api/tasks/abc', 'crm-write'],
    ['PUT', '/api/leads/abc/stage', 'crm-write'],
    ['POST', '/api/leads/abc/activities', 'crm-write'],
    ['POST', '/api/tasks', 'crm-write'],
    ['POST', '/api/leads/search/extra', 'crm-write'],
    ['GET', '/api/notifications', 'notifier'],
    ['POST', '/api/notifications/read', 'notifier'],
    ['GET', '/api/notifications/preferences', 'notifier'],
    ['PUT', '/api/notifications/preferences', 'notifier'],
    ['GET', '/api/notificationsx', 'query'],
    ['POST', '/api/assistant/chat', 'assistant'],
    ['GET', '/api/assistant/status', 'assistant'],
    ['HEAD', '/api/assistant/status', 'assistant'],
    ['GET', '/api/assistant', 'assistant'],
    ['PUT', '/api/assistant/chat', null],
    ['DELETE', '/api/assistant/chat', null],
    ['PATCH', '/api/assistant', null],
    ['GET', '/api/assistantx', 'query'],
    ['POST', '/api/assistantx', 'crm-write'],
    ['OPTIONS', '/api/notifications', null],
    ['OPTIONS', '/api/kpis', null],
    ['GET', '/internal/x', null],
  ])('%s %s -> %s', (method, path, want) => {
    expect(upstreamFor(method, path)).toBe(want);
  });
});

describe('upstreamHeaders', () => {
  const identity = { userId: REP.id, role: 'rep', internalToken: 'secret', requestId: 'req-1', clientIp: '10.0.0.9' };

  it('drops every client-supplied identity, routing and credential header', () => {
    const out = upstreamHeaders({
      'x-user-id': OTHER,
      'x-user-role': 'manager',
      'x-user-name': 'Mallory',
      'x-internal-token': 'forged',
      'x-internal-anything': 'x',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-host': 'evil',
      'x-real-ip': '1.2.3.4',
      forwarded: 'for=1.2.3.4',
      'x-request-id': 'client-id',
      authorization: 'Bearer abc',
      cookie: 'a=b',
      host: 'gateway',
      connection: 'keep-alive, x-secret',
      'x-secret': 'hop',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      'content-length': '12',
      accept: 'application/json',
    }, identity, 'query:8081');
    expect(out).toEqual({
      'content-type': 'application/json',
      'content-length': '12',
      accept: 'application/json',
      host: 'query:8081',
      'x-user-id': REP.id,
      'x-user-role': 'rep',
      'x-internal-token': 'secret',
      'x-request-id': 'req-1',
      'x-forwarded-for': '10.0.0.9',
    });
  });

  it('frames a body without Content-Length as chunked upstream, whatever the method', () => {
    expect(upstreamHeaders({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' }, identity, 'crm:8082'))
      .toMatchObject({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' });
    expect(upstreamHeaders({ 'content-length': '2' }, identity, 'crm:8082')['transfer-encoding']).toBeUndefined();
    expect(upstreamHeaders({}, identity, 'crm:8082')['transfer-encoding']).toBeUndefined();
  });
});

describe('tokens', () => {
  const t = tokens('unit-secret-unit-secret-unit-secret', '1h');
  const key = new TextEncoder().encode('unit-secret-unit-secret-unit-secret');
  const forge = (claims: Record<string, unknown>, opts: { alg?: string; exp?: string; secret?: Uint8Array } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
      .setSubject(String(claims.sub ?? REP.id))
      .setIssuer('leadmaker-gateway')
      .setAudience('leadmaker')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(opts.secret ?? key);

  it('round-trips sub, role and name', async () => {
    const v = await t.verify(await t.sign(REP));
    expect(v).toMatchObject(REP);
    expect(v.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects a wrong secret, a tampered payload, an expired token and bad claims', async () => {
    await expect(t.verify(await forge({ role: 'rep', name: 'x' }, { secret: new TextEncoder().encode('other-secret-other-secret') }))).rejects.toThrow();
    const good = await t.sign(REP);
    const [h, , s] = good.split('.');
    const body = Buffer.from(JSON.stringify({ sub: REP.id, role: 'manager', name: 'x', iss: 'leadmaker-gateway', aud: 'leadmaker', exp: 9e9 })).toString('base64url');
    await expect(t.verify(`${h}.${body}.${s}`)).rejects.toThrow();
    await expect(t.verify(await forge({ role: 'rep', name: 'x' }, { exp: '-1m' }))).rejects.toThrow();
    await expect(t.verify(await forge({ role: 'admin', name: 'x' }))).rejects.toThrow();
    await expect(t.verify(await forge({ role: 'rep', name: 'x', sub: 'not-a-uuid' }))).rejects.toThrow();
    await expect(t.verify(await forge({ role: 'rep', name: 'x' }, { alg: 'HS512' }))).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${good.split('.')[1]}.`;
    await expect(t.verify(none)).rejects.toThrow();
  });

  it('requireAuth answers 401 without a valid bearer token and accepts ?access_token only where allowed', async () => {
    const app = express();
    app.use(requireAuth(t, { allowQueryToken: (req) => req.path === '/stream' }));
    app.get('/{*any}', (req, res) => {
      res.json(req.user);
    });
    const token = await t.sign(REP);
    await request(app).get('/x').expect(401).expect('WWW-Authenticate', /Bearer/);
    await request(app).get('/x').set('Authorization', 'Bearer nope').expect(401);
    await request(app).get('/x').set('Authorization', `Basic ${token}`).expect(401);
    await request(app).get(`/x?access_token=${token}`).expect(401);
    await request(app).get(`/stream?access_token=${token}`).expect(200, REP);
    await request(app).get('/x').set('Authorization', `Bearer ${token}`).expect(200, REP);
  });
});

describe('rateLimit middleware', () => {
  const app = (limiter: Parameters<typeof rateLimit>[0]) => {
    const a = express();
    a.use(rateLimit(limiter, () => 'k', pino({ level: 'silent' })));
    a.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    return a;
  };

  it('answers 429 with Retry-After rounded up to whole seconds', async () => {
    const res = await request(app(async () => ({ allowed: false, remaining: 0, retryAfterMs: 1200 }))).get('/').expect(429);
    expect(res.headers['retry-after']).toBe('2');
    await request(app(async () => ({ allowed: true, remaining: 4, retryAfterMs: 0 }))).get('/').expect(200).expect('X-RateLimit-Remaining', '4');
  });

  it('fails open when Redis is unavailable', async () => {
    await request(app(async () => {
      throw new Error('ECONNREFUSED');
    })).get('/').expect(200);
  });
});

describe('current role', () => {
  const directory = (roles: Record<string, 'rep' | 'manager'>, calls: string[]) => ({
    userById: async (id: string) => {
      calls.push(id);
      if (id === 'boom') throw new Error('db down');
      return roles[id] ? { id, name: 'U', email: 'u@x', role: roles[id] } : null;
    },
  }) as unknown as Directory;
  const memory = () => {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), m } as unknown as Redis & { m: Map<string, string> };
  };

  it('caches the role and the absence of a user, and reads the directory when Redis fails', async () => {
    const calls: string[] = [];
    const redis = memory();
    const roles = cachedRoles(redis, directory({ [REP.id]: 'rep' }, calls), 30);
    expect([await roles.current(REP.id), await roles.current(REP.id)]).toEqual(['rep', 'rep']);
    expect([await roles.current(OTHER), await roles.current(OTHER)]).toEqual([null, null]);
    expect(calls).toEqual([REP.id, OTHER]);
    expect(redis.m.get(`user:${OTHER}:role`)).toBe('none');
    const down = { get: async () => { throw new Error('ECONNREFUSED'); }, set: async () => { throw new Error('ECONNREFUSED'); } } as unknown as Redis;
    const uncached = cachedRoles(down, directory({ [REP.id]: 'manager' }, calls), 30);
    expect([await uncached.current(REP.id), await uncached.current(REP.id)]).toEqual(['manager', 'manager']);
    expect(calls.slice(2)).toEqual([REP.id, REP.id]);
  });

  it('replaces the token role, answers 401 for a missing user and 503 when the directory is down', async () => {
    const roles = cachedRoles(memory(), directory({ [REP.id]: 'manager' }, []), 30);
    const app = (id: string) => {
      const a = express();
      a.use((req, _res, next) => {
        req.user = { ...REP, id };
        req.log = pino({ level: 'silent' });
        next();
      }, currentRole(roles));
      a.get('/', (req, res) => {
        res.json(req.user);
      });
      return a;
    };
    expect((await request(app(REP.id)).get('/').expect(200)).body.role).toBe('manager');
    await request(app(OTHER)).get('/').expect(401);
    await request(app('boom')).get('/').expect(503).expect('Retry-After', '1');
  });
});

describe('config', () => {
  it('requires secrets in production only', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', INTERNAL_TOKEN: 'x' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x' })).toThrow(/INTERNAL_TOKEN/);
    const c = loadConfig({ DEMO_MODE: '1', RATE_LIMIT_BURST: '5' });
    expect(c).toMatchObject({ demoMode: true, rateLimitBurst: 5, port: 8080, eventsStream: 'events' });
    expect(loadConfig({}).demoMode).toBe(false);
    expect(() => loadConfig({ RATE_LIMIT_PER_SECOND: '0' })).toThrow();
  });

  it("reads crm-write's request limits and the dashboard's weekly goal from the same variables", () => {
    expect(loadConfig({}).limits).toEqual({
      maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500, refreshPerHour: 20, weeklyActivityGoal: 25,
    });
    expect(loadConfig({ MAX_BULK_ALLOCATION: '300', MAX_BULK_TAG: '50', LEADMAKER_USER_JOBS_PER_HOUR: '0', WEEKLY_ACTIVITY_GOAL: '40' }).limits)
      .toEqual({ maxBulkAllocation: 300, maxBulkTag: 50, maxBulkUnallocate: 300, refreshPerHour: 0, weeklyActivityGoal: 40 });
    expect(() => loadConfig({ MAX_BULK_TAG: 'many' })).toThrow(/MAX_BULK_TAG/);
    expect(() => loadConfig({ WEEKLY_ACTIVITY_GOAL: '0' })).toThrow(/WEEKLY_ACTIVITY_GOAL/);
  });
});

describe('logging helpers', () => {
  it('keeps plain request ids and replaces anything else', () => {
    expect(requestId('abc-123')).toBe('abc-123');
    expect(requestId('bad id\n')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('redacts access tokens from logged URLs', () => {
    expect(redactUrl('/api/events?access_token=abc.def&x=1')).toBe('/api/events?access_token=[redacted]&x=1');
  });
});

describe('SSE projection', () => {
  const entry = (type: string, companyId: string | null, payload: Record<string, unknown>) =>
    parseEntry('1-0', ['id', '7', 'type', type, 'company_id', companyId ?? '', 'payload', JSON.stringify({ actor_type: 'user', ...payload }), 'created_at', 'now'])!;
  const v: Visibility = {
    assigned: new Map<string, string | null>([[OWN, REP.id], [THEIRS, OTHER], [POOL, null]]),
    previous: new Map([[THEIRS, REP.id]]),
  };

  it('parses relay entries and ignores unknown types or bad payloads', () => {
    expect(entry('lead.updated', OWN, { version: 3 })).toMatchObject({
      streamId: '1-0',
      companyIds: [OWN],
      event: { id: '7', type: 'lead.updated', company_id: OWN, payload: { version: 3 } },
    });
    expect(parseEntry('1-0', ['type', 'lead.deleted', 'payload', '{}'])).toBeNull();
    expect(parseEntry('1-0', ['type', 'lead.updated', 'payload', 'not json'])).toBeNull();
    expect(parseEntry('1-0', ['type', 'lead.updated', 'payload', '{"company_ids":"x"}'])).toBeNull();
  });

  it('gives reps their own and pool leads only; managers everything', () => {
    expect(project(entry('lead.updated', OWN, {}), REP, v)).not.toBeNull();
    expect(project(entry('note.added', POOL, {}), REP, v)).not.toBeNull();
    expect(project(entry('note.added', THEIRS, {}), REP, v)).toBeNull();
    expect(project(entry('note.added', THEIRS, {}), MANAGER, v)).not.toBeNull();
    const unknown = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(project(entry('lead.updated', unknown, {}), REP, v)).toBeNull();
    expect(project(entry('lead.updated', unknown, {}), MANAGER, v)).not.toBeNull();
  });

  it('filters multi-lead events down to the visible ids', () => {
    const e = entry('lead.updated', null, { company_ids: [OWN, THEIRS, POOL], versions: { [OWN]: 2, [THEIRS]: 5 } });
    const m = project(e, REP, v)!;
    expect(m.data.payload.company_ids).toEqual([OWN, POOL]);
    expect(m.data.payload.versions).toEqual({ [OWN]: 2 });
    expect(project(e, MANAGER, v)!.data).toBe(e.event);
  });

  it('tells a rep when a lead is allocated away from them', () => {
    expect(project(entry('lead.allocated', THEIRS, {}), REP, v)).not.toBeNull();
    expect(project(entry('lead.updated', THEIRS, {}), REP, v)).toBeNull();
    const noHistory: Visibility = { assigned: v.assigned, previous: new Map() };
    expect(project(entry('lead.allocated', THEIRS, { previous_rep_id: REP.id }), REP, noHistory)).not.toBeNull();
    expect(project(entry('lead.allocated', THEIRS, { previous_rep_id: OTHER }), REP, noHistory)).toBeNull();
  });

  it("trusts the writer's previous_rep_id over older allocation history", () => {
    // THEIRS was REP's long ago, then sat in the pool; a manager now gives it to OTHER: REP only sees it leave the pool.
    expect(project(entry('lead.allocated', THEIRS, { previous_rep_id: null, assigned_rep_id: OTHER }), REP, v)!.data.payload)
      .toEqual({ actor_type: 'user', actor_id: null, company_id: THEIRS, left_pool: true });
    expect(project(entry('lead.allocated', null, { company_ids: [THEIRS] }), REP, v)).not.toBeNull();
  });

  it("passes a pipeline delisting through to whoever can see the lead, flag intact", () => {
    const e = entry('lead.updated', POOL, { actor_type: 'pipeline', actor_id: null, delisted: true, version: 9 });
    expect(project(e, REP, v)!.data.payload).toMatchObject({ actor_type: 'pipeline', delisted: true, version: 9 });
    expect(project(entry('lead.updated', THEIRS, { actor_type: 'pipeline', delisted: true }), REP, v)).toBeNull();
  });

  it('delivers company-less events to everyone', () => {
    expect(project(entry('pipeline.run_completed', null, { run_id: 4 }), REP, v)?.data.payload).toMatchObject({ run_id: 4 });
  });

  it('delivers run completions to everyone, listing only the visible leads', () => {
    const e = entry('pipeline.run_completed', null, { actor_type: 'pipeline', run_id: 5, company_ids: [THEIRS, POOL] });
    expect(project(e, REP, v)!.data.payload).toMatchObject({ run_id: 5, company_ids: [POOL] });
    const others = entry('pipeline.run_completed', null, { actor_type: 'pipeline', run_id: 6, company_ids: [THEIRS] });
    expect(project(others, REP, v)!.data.payload).toMatchObject({ run_id: 6, company_ids: [] });
    expect(project(others, MANAGER, v)!.data.payload.company_ids).toEqual([THEIRS]);
  });

  it("names a job's requester only to that user and managers", () => {
    const e = entry('pipeline.run_completed', null, { actor_type: 'pipeline', run_id: 7, job_id: 3, requested_by: OTHER, company_ids: [POOL] });
    expect(project(e, REP, v)!.data.payload).toEqual({ actor_type: 'pipeline', run_id: 7, job_id: 3, company_ids: [POOL] });
    expect(e.event.payload.requested_by).toBe(OTHER);
    expect(project(e, { ...REP, id: OTHER }, v)!.data.payload.requested_by).toBe(OTHER);
    expect(project(e, MANAGER, v)!.data.payload.requested_by).toBe(OTHER);
  });

  it('tells uninvolved reps a pool lead left the pool, without naming the rep who got it', () => {
    // POOL now belongs to OTHER; the writer recorded that it came from the pool.
    const moved: Visibility = { assigned: new Map([[POOL, OTHER]]), previous: new Map() };
    const e = entry('lead.allocated', POOL, {
      company_id: POOL, assigned_rep_id: OTHER, rep_id: OTHER, previous_rep_id: null, actor_id: MANAGER.id, version: 4,
    });
    const m = project(e, REP, moved)!;
    expect(m.event).toBe('lead.allocated');
    expect(m.data).toEqual({
      id: '7', type: 'lead.allocated', company_id: POOL, created_at: 'now',
      payload: { actor_type: 'user', actor_id: MANAGER.id, company_id: POOL, left_pool: true },
    });
    expect(JSON.stringify(m)).not.toContain(OTHER);
    // The new owner and managers get the full event; a lead taken from another rep tells uninvolved reps nothing.
    expect(project(e, { ...REP, id: OTHER }, moved)!.data).toBe(e.event);
    expect(project(e, MANAGER, moved)!.data).toBe(e.event);
    const fromRep = entry('lead.allocated', POOL, { assigned_rep_id: OTHER, previous_rep_id: MANAGER.id });
    expect(project(fromRep, REP, moved)).toBeNull();
    const both: Visibility = { assigned: new Map([[POOL, OTHER], [THEIRS, OTHER]]), previous: new Map() };
    expect(project(entry('lead.allocated', null, { company_ids: [POOL, THEIRS], previous_rep_id: null, assigned_rep_id: OTHER }), REP, both)).toBeNull();
  });

  it("passes the writer's actor_name through, also when a payload is narrowed", () => {
    const named = { actor_id: MANAGER.id, actor_name: 'Boss' };
    expect(project(entry('note.added', OWN, named), REP, v)!.data.payload.actor_name).toBe('Boss');
    const multi = entry('lead.updated', null, { ...named, company_ids: [OWN, THEIRS] });
    expect(project(multi, REP, v)!.data.payload).toMatchObject({ actor_name: 'Boss', company_ids: [OWN] });
    const moved: Visibility = { assigned: new Map([[POOL, OTHER]]), previous: new Map() };
    const left = entry('lead.allocated', POOL, { ...named, assigned_rep_id: OTHER, previous_rep_id: null });
    expect(project(left, REP, moved)!.data.payload).toEqual({ actor_type: 'user', ...named, company_id: POOL, left_pool: true });
    const job = entry('pipeline.run_completed', null, { actor_type: 'system', actor_name: 'system', requested_by: OTHER });
    expect(project(job, REP, v)!.data.payload).toEqual({ actor_type: 'system', actor_name: 'system' });
  });

  it('delivers a notification\'s title and body with notification.created, to its user only', () => {
    const e = entry('notification.created', null, {
      actor_type: 'system', actor_id: null, actor_name: 'system', user_id: REP.id, notification_id: OWN, type: 'allocated', count: 2,
      title: '2 leads allocated to you', body: 'Acme Roofing and 1 more',
    });
    expect(project(e, REP, v)!.data.payload).toMatchObject({ title: '2 leads allocated to you', body: 'Acme Roofing and 1 more', actor_name: 'system' });
    expect(project(e, MANAGER, v)).toBeNull();
  });

  it('sends notification.created only to the user it is for', () => {
    const e = entry('notification.created', null, { actor_type: 'system', user_id: REP.id, notification_id: OWN, type: 'allocated' });
    expect(e.companyIds).toEqual([]);
    expect(project(e, REP, v)).toMatchObject({ event: 'notification.created', data: { payload: { user_id: REP.id } } });
    expect(project(e, MANAGER, v)).toBeNull();
    expect(project(e, { ...REP, id: OTHER }, v)).toBeNull();
    // A company id smuggled into the entry changes nothing.
    expect(project(entry('notification.created', POOL, { user_id: OTHER }), REP, v)).toBeNull();
  });

  it('sends each event once, in order, when replay and live delivery overlap', async () => {
    const msg = (id: string): SseMessage => ({
      id, event: 'note.added', data: { id, type: 'note.added', company_id: null, payload: { actor_type: 'user', actor_id: null }, created_at: '' },
    });
    let sub: { deliver(m: SseMessage[]): void } | undefined;
    const hub = {
      connectionsFor: () => 0,
      subscribe: (s: typeof sub) => {
        sub = s;
        return () => {};
      },
      // Live events arrive while the replay is still reading the stream.
      replay: async () => {
        sub!.deliver([msg('2-0'), msg('3-0')]);
        return [msg('1-0'), msg('2-0')];
      },
      position: '0-0',
    } as unknown as EventHub;
    const app = express();
    app.get('/e', (req, _res, next) => {
      req.user = REP;
      req.log = pino({ level: 'silent' });
      next();
    }, sseHandler(hub, { maxPerUser: 5, heartbeatMs: 60_000 }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const r = http.get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/e`, { headers: { 'Last-Event-ID': '0-1' } }, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            buf += c;
            if (!buf.includes('event: ready')) return;
            r.destroy();
            resolve(buf);
          });
        });
        r.on('error', reject);
      });
      expect([...body.matchAll(/^id: (.+)$/gm)].map((m) => m[1])).toEqual(['1-0', '2-0', '3-0']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('compares stream ids numerically', () => {
    expect(compareIds('10-0', '9-5')).toBe(1);
    expect(compareIds('5-10', '5-9')).toBe(1);
    expect(compareIds('5-1', '5-1')).toBe(0);
    expect(compareIds('0-0', '1-0')).toBe(-1);
  });
});

describe('proxy cancellation', () => {
  // An upstream that answers /api/fast at once (503 + Retry-After) and never answers anything else.
  async function upstream() {
    const closed: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/api/leads/fast') {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' }).end('{"error":"busy"}');
        return;
      }
      res.on('close', () => closed.push(req.url!));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, closed, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function gateway(target: string, timeoutMs: number) {
    const app = express();
    app.use(requestLogger(pino({ level: 'silent' })));
    app.use((req, _res, next) => {
      req.user = REP;
      next();
    });
    app.all('/api/*splat', proxy({ targets: { query: target, 'crm-write': target, notifier: target, assistant: target }, internalToken: 't', timeoutMs, maxBodyBytes: 1024 }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, port: (server.address() as AddressInfo).port };
  }

  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return pred();
  };

  it('answers 504 at the deadline and aborts the upstream request', async () => {
    const up = await upstream();
    const gw = await gateway(up.url, 150);
    try {
      const t = Date.now();
      const res = await request(gw.server).get('/api/leads/slow');
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({ error: 'upstream_timeout' });
      expect(Date.now() - t).toBeLessThan(1000);
      expect(await waitFor(() => up.closed.includes('/api/leads/slow'))).toBe(true);
    } finally {
      gw.server.close();
      up.server.closeAllConnections();
      up.server.close();
    }
  });

  it('aborts the upstream request when the client disconnects', async () => {
    const up = await upstream();
    const gw = await gateway(up.url, 10_000);
    try {
      const req = http.get({ host: '127.0.0.1', port: gw.port, path: '/api/leads/gone' });
      req.on('error', () => {});
      await new Promise((r) => setTimeout(r, 100));
      expect(up.closed).toEqual([]);
      req.destroy();
      expect(await waitFor(() => up.closed.includes('/api/leads/gone'))).toBe(true);
    } finally {
      gw.server.close();
      up.server.closeAllConnections();
      up.server.close();
    }
  });

  it("passes the service's 503 and Retry-After through", async () => {
    const up = await upstream();
    const gw = await gateway(up.url, 1000);
    try {
      const res = await request(gw.server).get('/api/leads/fast');
      expect([res.status, res.headers['retry-after'], res.body]).toEqual([503, '1', { error: 'busy' }]);
    } finally {
      gw.server.close();
      up.server.closeAllConnections();
      up.server.close();
    }
  });
});
