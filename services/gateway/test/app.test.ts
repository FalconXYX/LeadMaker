import { once } from 'node:events';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type Deps } from '../src/app.ts';
import { tokens as makeTokens } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { prismaDirectory } from '../src/directory.ts';
import { EventHub } from '../src/events.ts';
import { tokenBucket, type RateLimiter } from '../src/rateLimit.ts';
import type { AuthUser } from '../src/types.ts';
import { fakeUpstream, hasInfra, openDb, openRedis, openSse, resetDb, seed, silent, testConfig } from './helpers.ts';

describe.skipIf(!hasInfra)('gateway (Postgres + Redis)', () => {
  let db: PrismaClient;
  let redis: Redis;
  let blocking: Redis;
  let hub: EventHub;
  let query: Awaited<ReturnType<typeof fakeUpstream>>;
  let crm: Awaited<ReturnType<typeof fakeUpstream>>;
  let notifier: Awaited<ReturnType<typeof fakeUpstream>>;
  let fixtures: Awaited<ReturnType<typeof seed>>;
  let config: Config;
  let deps: Deps;
  let server: Server;
  let base: string;
  const streams: { close(): void }[] = [];

  const app = (over: Partial<Config> = {}) => {
    const c = { ...config, ...over };
    return createApp({ ...deps, config: c, limiter: tokenBucket(redis, c.rateLimitPerSecond, c.rateLimitBurst) });
  };
  const tokenFor = (u: { id: string; role: string; name: string }) => deps.tokens.sign(u as AuthUser);
  const xadd = (type: string, companyId: string | null, payload: Record<string, unknown> = {}) =>
    redis.xadd('events', '*', 'id', String(Math.floor(Math.random() * 1e9)), 'type', type, 'company_id', companyId ?? '',
      'payload', JSON.stringify({ actor_type: 'user', ...payload }), 'created_at', new Date().toISOString());
  const sse = async (u: { id: string; role: string; name: string }, headers: Record<string, string> = {}) => {
    const s = openSse(base, '/api/events', { Authorization: `Bearer ${await tokenFor(u)}`, ...headers });
    streams.push(s);
    expect(await s.opened).toBe(200);
    await s.waitFor((m) => m.event === 'ready');
    return s;
  };

  beforeAll(async () => {
    db = await openDb();
    redis = openRedis();
    blocking = openRedis();
    await redis.flushdb();
    await resetDb(db);
    fixtures = await seed(db);
    [query, crm, notifier] = await Promise.all([fakeUpstream('query'), fakeUpstream('crm-write'), fakeUpstream('notifier')]);
    config = testConfig({
      queryUrl: query.url, crmWriteUrl: crm.url, notifierUrl: notifier.url, rateLimitPerSecond: 100, rateLimitBurst: 1000,
    });
    const directory = prismaDirectory(db);
    hub = new EventHub(blocking, redis, directory, 'events', silent);
    await hub.start();
    deps = {
      config,
      log: silent,
      tokens: makeTokens(config.jwtSecret, config.jwtTtl),
      directory,
      limiter: tokenBucket(redis, 100, 1000),
      hub,
      redis,
    };
    server = app().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    streams.splice(0).forEach((s) => s.close());
    query.calls.length = 0;
    crm.calls.length = 0;
    notifier.calls.length = 0;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await hub?.stop();
    await Promise.all([query?.close(), crm?.close(), notifier?.close()]);
    redis?.disconnect();
    await db?.$disconnect();
  });

  describe('health', () => {
    it('reports liveness and readiness', async () => {
      await request(base).get('/healthz').expect(200, { status: 'ok' });
      await request(base).get('/readyz').expect(200, { status: 'ok', db: 'ok', redis: 'ok' });
    });
  });

  describe('dev login', () => {
    it('issues a token for a seeded user (case-insensitive email) that /api/me accepts', async () => {
      const res = await request(base).post('/auth/dev-login').send({ email: 'REP1@test.local' }).expect(200);
      expect(res.body.user).toEqual({ id: fixtures.rep1.id, name: 'Rep1', email: 'rep1@test.local', role: 'rep' });
      const me = await request(base).get('/api/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
      expect(me.body).toEqual(res.body.user);
      expect(me.headers['x-request-id']).toBeTruthy();
    });

    it('rejects unknown and malformed emails', async () => {
      await request(base).post('/auth/dev-login').send({ email: 'nobody@test.local' }).expect(401);
      await request(base).post('/auth/dev-login').send({ email: '%@test.local' }).expect(401);
      await request(base).post('/auth/dev-login').send({ email: 'rep_@test.local' }).expect(401);
      await request(base).post('/auth/dev-login').send({}).expect(400);
      await request(base).post('/auth/dev-login').set('Content-Type', 'application/json').send('{bad').expect(400);
    });

    it('does not exist unless DEMO_MODE is on', async () => {
      await request(app({ demoMode: false })).post('/auth/dev-login').send({ email: 'rep1@test.local' }).expect(404);
    });
  });

  describe('authentication', () => {
    it('requires a valid token on every /api route and never reaches a service without one', async () => {
      await request(base).get('/api/me').expect(401);
      await request(base).post('/api/leads/search').send({ filter: {} }).expect(401);
      await request(base).post('/api/leads/x/notes').set('Authorization', 'Bearer garbage').send({ text: 'hi' }).expect(401);
      const foreign = await makeTokens('another-secret-another-secret-xx', '1h').sign(fixtures.manager as AuthUser);
      await request(base).get('/api/kpis').set('Authorization', `Bearer ${foreign}`).expect(401);
      await request(base).get(`/api/me?access_token=${await tokenFor(fixtures.rep1)}`).expect(401);
      expect(query.calls).toHaveLength(0);
      expect(crm.calls).toHaveLength(0);
    });

    it('answers 401 for a token whose user was deleted', async () => {
      const ghost = { id: '99999999-9999-4999-8999-999999999999', role: 'manager', name: 'Ghost' };
      await request(base).get('/api/me').set('Authorization', `Bearer ${await tokenFor(ghost)}`).expect(401);
      await request(base).get('/api/kpis').set('Authorization', `Bearer ${await tokenFor(ghost)}`).expect(401);
      expect(query.calls).toHaveLength(0);
    });
  });

  describe('admin routes', () => {
    const as = async (u: { id: string; role: string; name: string }) => ({ Authorization: `Bearer ${await tokenFor(u)}` });

    it('answer 403 to a rep before any service sees the request', async () => {
      const auth = await as(fixtures.rep1);
      for (const [method, path] of [
        ['get', '/api/admin/territories'], ['get', '/api/admin/runs?limit=5'], ['post', '/api/admin/territories'],
        ['patch', '/api/admin/territories/1'], ['delete', '/api/admin/territories/1'], ['post', '/api/admin/territories/1/run'],
        ['get', '/api/ADMIN/territories'], ['get', '/api/admin'],
      ] as const) {
        const res = await request(base)[method](path).set(auth).send(method === 'get' ? undefined : {});
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden', message: 'managers only' });
      }
      expect(query.calls).toHaveLength(0);
      expect(crm.calls).toHaveLength(0);
    });

    it('checks the role users has now: a token minted as manager for a rep is still a rep', async () => {
      await request(base).get('/api/admin/territories').set(await as({ ...fixtures.rep2, role: 'manager' })).expect(403);
      expect(query.calls).toHaveLength(0);
    });

    it('route a manager\'s reads to query and writes to crm-write', async () => {
      const auth = await as(fixtures.manager);
      await request(base).get('/api/admin/territories').set(auth).expect(201);
      await request(base).get('/api/admin/runs?limit=5').set(auth).expect(201);
      expect(query.calls.map((c) => [c.method, c.url])).toEqual([['GET', '/api/admin/territories'], ['GET', '/api/admin/runs?limit=5']]);
      expect(query.calls[0].headers['x-user-role']).toBe('manager');
      await request(base).post('/api/admin/territories').set(auth).send({ zip: '10013', radiusMiles: 25 }).expect(201);
      await request(base).patch('/api/admin/territories/1').set(auth).send({ enabled: false }).expect(201);
      await request(base).delete('/api/admin/territories/1').set(auth).expect(201);
      await request(base).post('/api/admin/territories/1/run').set(auth).expect(201);
      expect(crm.calls.map((c) => [c.method, c.url])).toEqual([
        ['POST', '/api/admin/territories'], ['PATCH', '/api/admin/territories/1'], ['DELETE', '/api/admin/territories/1'],
        ['POST', '/api/admin/territories/1/run'],
      ]);
    });
  });

  describe('role freshness', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const listen = async (over: Partial<Config>) => {
      const s = app(over).listen(0, '127.0.0.1');
      await once(s, 'listening');
      return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    const roleSent = () => query.calls.at(-1)?.headers['x-user-role'];

    it('forwards the role users has now, not the one the token was minted with', async () => {
      const token = await tokenFor({ ...fixtures.rep2, role: 'manager' });
      await request(base).get('/api/kpis').set('Authorization', `Bearer ${token}`).expect(201);
      expect(roleSent()).toBe('rep');
    });

    it('takes a demotion away within the role cache TTL', async () => {
      const boss = await db.users.create({ data: { name: 'Demoted', email: 'demoted@test.local', role: 'manager' } });
      const auth = { Authorization: `Bearer ${await tokenFor(boss)}` };
      const short = app({ roleTtlSeconds: 1 });
      await request(short).get('/api/kpis').set(auth).expect(201);
      expect(roleSent()).toBe('manager');
      await db.users.update({ where: { id: boss.id }, data: { role: 'rep' } });
      // Cached: still a manager until the entry expires.
      await request(short).get('/api/kpis').set(auth).expect(201);
      expect(roleSent()).toBe('manager');
      expect(await redis.ttl(`user:${boss.id}:role`)).toBeLessThanOrEqual(1);
      await wait(1100);
      await request(short).get('/api/kpis').set(auth).expect(201);
      expect(roleSent()).toBe('rep');
      await request(short).post('/api/allocations').set(auth).send({}).expect(201);
      expect(crm.calls.at(-1)?.headers['x-user-role']).toBe('rep');
    });

    it('answers 401 everywhere once a deleted user\'s cached role expires, and ends their streams', async () => {
      const gone = await db.users.create({ data: { name: 'Leaving', email: 'leaving@test.local', role: 'rep' } });
      const auth = { Authorization: `Bearer ${await tokenFor(gone)}` };
      const { server: s, url } = await listen({ roleTtlSeconds: 1, sseRoleCheckMs: 100 });
      try {
        await request(url).get('/api/kpis').set(auth).expect(201);
        const stream = openSse(url, '/api/events', auth);
        streams.push(stream);
        expect(await stream.opened).toBe(200);
        await stream.waitFor((m) => m.event === 'ready');
        await db.users.delete({ where: { id: gone.id } });
        await wait(1100);
        const before = query.calls.length + crm.calls.length;
        await request(url).get('/api/kpis').set(auth).expect(401);
        await request(url).post(`/api/leads/${fixtures.pool.id}/notes`).set(auth).send({ text: 'hi' }).expect(401);
        await request(url).get('/api/events').set(auth).expect(401);
        expect(query.calls.length + crm.calls.length).toBe(before);
        await xadd('note.added', fixtures.pool.id);
        await wait(300);
        expect(stream.messages.filter((m) => m.event === 'note.added')).toHaveLength(0);
      } finally {
        s.closeAllConnections();
        s.close();
      }
    });

    it("narrows a demoted manager's open SSE stream to rep visibility", async () => {
      const boss = await db.users.create({ data: { name: 'Streamer', email: 'streamer@test.local', role: 'manager' } });
      const { server: s, url } = await listen({ roleTtlSeconds: 1, sseRoleCheckMs: 100 });
      try {
        const stream = openSse(url, '/api/events', { Authorization: `Bearer ${await tokenFor(boss)}` });
        streams.push(stream);
        expect(await stream.opened).toBe(200);
        await stream.waitFor((m) => m.event === 'ready');
        const before = await xadd('lead.updated', fixtures.other.id, { version: 10 });
        await stream.waitFor((m) => m.id === before);
        await db.users.update({ where: { id: boss.id }, data: { role: 'rep' } });
        await wait(1300);
        const hidden = await xadd('lead.updated', fixtures.other.id, { version: 11 });
        const visible = await xadd('lead.updated', fixtures.pool.id, { version: 12 });
        await stream.waitFor((m) => m.id === visible);
        expect(stream.messages.some((m) => m.id === hidden)).toBe(false);
      } finally {
        s.closeAllConnections();
        s.close();
      }
    });
  });

  describe('proxy', () => {
    it('replaces spoofed identity headers with the verified user and the internal token', async () => {
      const token = await tokenFor(fixtures.rep1);
      const res = await request(base)
        .post('/api/leads/search?debug=1')
        .set('Authorization', `Bearer ${token}`)
        .set('X-User-Id', fixtures.manager.id)
        .set('X-User-Role', 'manager')
        .set('X-Internal-Token', 'forged')
        .set('X-Forwarded-For', '6.6.6.6')
        .set('X-Request-Id', 'client-req-1')
        .send({ filter: { scope: 'all' } })
        .expect(201);
      expect(res.body).toEqual({ upstream: 'query', url: '/api/leads/search?debug=1' });
      expect(res.headers['x-upstream']).toBe('query');
      expect(res.headers['content-type']).toBe('application/json');
      expect(res.headers['x-request-id']).toBe('client-req-1');
      const [call] = query.calls;
      expect(call.headers).toMatchObject({
        'x-user-id': fixtures.rep1.id,
        'x-user-role': 'rep',
        'x-internal-token': 'test-internal-token',
        'x-request-id': 'client-req-1',
        'content-type': 'application/json',
      });
      expect(call.headers['x-forwarded-for']).not.toContain('6.6.6.6');
      expect(call.headers.authorization).toBeUndefined();
      expect(JSON.parse(call.body)).toEqual({ filter: { scope: 'all' } });
    });

    it('routes reads to query and writes to crm-write', async () => {
      const auth = { Authorization: `Bearer ${await tokenFor(fixtures.manager)}` };
      await request(base).get('/api/kpis').set(auth).expect(201);
      await request(base).get(`/api/leads/${fixtures.own.id}`).set(auth).expect(201);
      await request(base).post(`/api/leads/${fixtures.own.id}/notes`).set(auth).send({ text: 'called' }).expect(201);
      await request(base).put(`/api/leads/${fixtures.own.id}/overrides/phone`).set(auth).send({ value: '1', version: 1 }).expect(201);
      await request(base).delete(`/api/allocations/${fixtures.own.id}`).set(auth).expect(201);
      expect(query.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/kpis', `GET /api/leads/${fixtures.own.id}`]);
      expect(crm.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST /api/leads/${fixtures.own.id}/notes`,
        `PUT /api/leads/${fixtures.own.id}/overrides/phone`,
        `DELETE /api/allocations/${fixtures.own.id}`,
      ]);
      expect(crm.calls.every((c) => c.headers['x-user-role'] === 'manager')).toBe(true);
    });

    it('routes the sales reads (tasks, dashboard) to query and task and stage writes to crm-write, query strings intact', async () => {
      const auth = { Authorization: `Bearer ${await tokenFor(fixtures.rep1)}` };
      const lead = fixtures.own.id;
      const task = '44444444-4444-4444-8444-444444444444';
      await request(base).get('/api/tasks?scope=mine&due=overdue&status=open&limit=20').set(auth).expect(201);
      await request(base).get(`/api/dashboard?scope=rep:${fixtures.rep1.id}`).set(auth).expect(201);
      await request(base).post(`/api/leads/${lead}/tasks`).set(auth).send({ title: 'Call back', type: 'call', dueAt: '2026-10-20T14:00:00Z' }).expect(201);
      await request(base).patch(`/api/tasks/${task}`).set(auth).send({ done: true, version: 1 }).expect(201);
      await request(base).delete(`/api/tasks/${task}?version=2`).set(auth).expect(201);
      await request(base).put(`/api/leads/${lead}/stage`).set(auth).send({ stage: 'quoting', version: 3 }).expect(201);
      await request(base).post(`/api/leads/${lead}/activities`).set(auth).send({ type: 'call' }).expect(201);
      expect(query.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /api/tasks?scope=mine&due=overdue&status=open&limit=20', `GET /api/dashboard?scope=rep:${fixtures.rep1.id}`,
      ]);
      expect(crm.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST /api/leads/${lead}/tasks`, `PATCH /api/tasks/${task}`, `DELETE /api/tasks/${task}?version=2`,
        `PUT /api/leads/${lead}/stage`, `POST /api/leads/${lead}/activities`,
      ]);
      expect(JSON.parse(crm.calls[0].body)).toEqual({ title: 'Call back', type: 'call', dueAt: '2026-10-20T14:00:00Z' });
      expect([...query.calls, ...crm.calls].every((c) => c.headers['x-user-id'] === fixtures.rep1.id && c.headers['x-user-role'] === 'rep'))
        .toBe(true);
      expect(notifier.calls).toEqual([]);
    });

    it("routes the profile's insights Refresh (no body) to crm-write with the caller's identity", async () => {
      const auth = { Authorization: `Bearer ${await tokenFor(fixtures.rep1)}` };
      const lead = fixtures.own.id;
      await request(base).post(`/api/leads/${lead}/insights/refresh`).set(auth).expect(201);
      expect(query.calls).toEqual([]);
      expect(crm.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/leads/${lead}/insights/refresh`]);
      expect(crm.calls[0].headers['x-user-id']).toBe(fixtures.rep1.id);
      expect(crm.calls[0].headers['x-internal-token']).toBeTruthy();
    });

    it('routes /api/notifications* to the notifier whatever the method, with the caller\'s identity', async () => {
      const auth = { Authorization: `Bearer ${await tokenFor(fixtures.rep1)}` };
      await request(base).get('/api/notifications?unread=1').set(auth).expect(201);
      await request(base).post('/api/notifications/read').set(auth).send({ all: true }).expect(201);
      await request(base).put('/api/notifications/preferences').set(auth).send({ items: [] }).expect(201);
      expect(notifier.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /api/notifications?unread=1', 'POST /api/notifications/read', 'PUT /api/notifications/preferences',
      ]);
      expect(notifier.calls.every((c) => c.headers['x-user-id'] === fixtures.rep1.id && c.headers['x-internal-token'] === 'test-internal-token')).toBe(true);
      expect([...query.calls, ...crm.calls]).toEqual([]);
      await request(base).get('/api/notifications').expect(401);
    });

    it('forwards a DELETE body to crm-write intact, with a Content-Length or chunked, keeping the connection usable', async () => {
      const token = await tokenFor(fixtures.manager);
      const body = { companyIds: [fixtures.own.id, fixtures.other.id] };
      await request(base).delete('/api/allocations').set('Authorization', `Bearer ${token}`).send(body).expect(201);
      const chunked = await new Promise<number>((resolve, reject) => {
        const r = http.request(`${base}/api/allocations`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        r.on('error', reject);
        const text = JSON.stringify(body);
        r.write(text.slice(0, 10));
        r.end(text.slice(10));
      });
      expect(chunked).toBe(201);
      // The next requests reuse the upstream keep-alive sockets: they must not see leftovers of the bodies above.
      await request(base).get('/api/kpis').set('Authorization', `Bearer ${token}`).expect(201);
      await request(base).delete(`/api/allocations/${fixtures.own.id}`).set('Authorization', `Bearer ${token}`).expect(201);
      expect(crm.calls.map((c) => [c.method, c.url, c.body ? JSON.parse(c.body) : null])).toEqual([
        ['DELETE', '/api/allocations', body], ['DELETE', '/api/allocations', body], ['DELETE', `/api/allocations/${fixtures.own.id}`, null],
      ]);
      expect(crm.calls[0].headers['content-length']).toBe(String(JSON.stringify(body).length));
      expect(query.calls.map((c) => c.url)).toEqual(['/api/kpis']);
    });

    it('answers 502 when a service is down and 413 for oversized bodies', async () => {
      const auth = { Authorization: `Bearer ${await tokenFor(fixtures.rep1)}` };
      const down = app({ queryUrl: 'http://127.0.0.1:9' });
      const res = await request(down).get('/api/kpis').set(auth).expect(502);
      expect(res.body).toEqual({ error: 'upstream_unavailable', upstream: 'query' });
      await request(app({ maxBodyBytes: 10 })).post('/api/leads/x/notes').set(auth).send({ text: 'far too long a note' }).expect(413);
    });

    it('answers 413 for an oversized chunked body (no Content-Length) and never completes it upstream', async () => {
      const limited = app({ maxBodyBytes: 1024 }).listen(0, '127.0.0.1');
      await once(limited, 'listening');
      try {
        const token = await tokenFor(fixtures.rep1);
        const status = await new Promise<number>((resolve, reject) => {
          const r = http.request(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/leads/x/notes`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          });
          r.on('error', reject);
          r.write('{"text":"');
          r.write('x'.repeat(8192));
          r.end('"}');
        });
        expect(status).toBe(413);
        await new Promise((r) => setTimeout(r, 100));
        expect(crm.calls).toHaveLength(0);
      } finally {
        limited.closeAllConnections();
        limited.close();
      }
    });
  });

  describe('GET /api/config', () => {
    it("gives any signed-in user crm-write's limits and the role cache TTL, without calling a service", async () => {
      await request(base).get('/api/config').expect(401);
      const res = await request(base).get('/api/config').set('Authorization', `Bearer ${await tokenFor(fixtures.rep1)}`).expect(200);
      expect(res.body).toEqual({ ...config.limits, userRoleTtlSeconds: config.roleTtlSeconds });
      expect(res.body).toMatchObject({
        maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500, refreshPerHour: 20, weeklyActivityGoal: 25,
      });
      const custom = app({
        limits: { maxBulkAllocation: 100, maxBulkTag: 20, maxBulkUnallocate: 100, refreshPerHour: 3, weeklyActivityGoal: 12 }, roleTtlSeconds: 7,
      });
      expect((await request(custom).get('/api/config').set('Authorization', `Bearer ${await tokenFor(fixtures.manager)}`)).body)
        .toEqual({ maxBulkAllocation: 100, maxBulkTag: 20, maxBulkUnallocate: 100, refreshPerHour: 3, weeklyActivityGoal: 12, userRoleTtlSeconds: 7 });
      expect([...query.calls, ...crm.calls, ...notifier.calls]).toEqual([]);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with Retry-After once the user bucket is empty, per user', async () => {
      const limited = app({ rateLimitPerSecond: 0.2, rateLimitBurst: 3 });
      const rep = { Authorization: `Bearer ${await tokenFor(fixtures.rep2)}` };
      for (let i = 0; i < 3; i++) await request(limited).get('/api/kpis').set(rep).expect(201);
      const res = await request(limited).get('/api/kpis').set(rep).expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(5);
      expect(res.body.error).toBe('rate_limited');
      await request(limited).get('/api/kpis').set({ Authorization: `Bearer ${await tokenFor(fixtures.rep3)}` }).expect(201);
      expect(query.calls).toHaveLength(4);
    });

    it('limits dev-login per client address', async () => {
      const limited = app({ rateLimitPerSecond: 0.2, rateLimitBurst: 2 });
      await redis.del('rl:ip:::ffff:127.0.0.1', 'rl:ip:127.0.0.1', 'rl:ip:::1');
      for (let i = 0; i < 2; i++) await request(limited).post('/auth/dev-login').send({ email: 'rep1@test.local' }).expect(200);
      await request(limited).post('/auth/dev-login').send({ email: 'rep1@test.local' }).expect(429);
    });
  });

  describe('SSE /api/events', () => {
    it('forwards only events for leads the user can see', async () => {
      const { rep1, manager, own, other, pool } = fixtures;
      const repStream = await sse(rep1);
      const mgrStream = await sse(manager);
      await xadd('lead.updated', other.id, { version: 2 });
      await xadd('lead.updated', own.id, { version: 3 });
      await xadd('note.added', pool.id);
      await xadd('lead.allocated', null, { company_ids: [own.id, other.id] });
      // The pipeline lists the companies a run touched; the completion still reaches every user.
      await xadd('pipeline.run_completed', null, { actor_type: 'pipeline', run_id: 12, company_ids: [other.id] });

      await repStream.waitFor((m) => m.event === 'pipeline.run_completed');
      await mgrStream.waitFor((m) => m.event === 'pipeline.run_completed');
      const seen = (s: typeof repStream) =>
        s.messages.filter((m) => m.event !== 'ready').map((m) => {
          const d = m.data as { type: string; company_id: string | null; payload: { company_ids?: string[] } };
          return [d.type, d.company_id ?? d.payload.company_ids ?? null];
        });
      expect(seen(repStream)).toEqual([
        ['lead.updated', own.id],
        ['note.added', pool.id],
        ['lead.allocated', [own.id]],
        ['pipeline.run_completed', []],
      ]);
      expect(seen(mgrStream)).toEqual([
        ['lead.updated', other.id],
        ['lead.updated', own.id],
        ['note.added', pool.id],
        ['lead.allocated', [own.id, other.id]],
        ['pipeline.run_completed', [other.id]],
      ]);
      const first = repStream.messages.find((m) => m.event === 'lead.updated')!;
      expect(first.id).toMatch(/^\d+-\d+$/);
      expect(first.data).toMatchObject({ type: 'lead.updated', payload: { version: 3, actor_type: 'user' } });
    });

    it('tells the previous owner when a lead is reassigned away from them', async () => {
      const { rep1, rep2, rep3, manager } = fixtures;
      const lead = await db.companies.create({
        data: { business_name: 'Moved', latitude: 40.7, longitude: -74, content_hash: 'h', assigned_rep_id: rep1.id },
      });
      const first = await db.lead_allocations.create({ data: { company_id: lead.id, rep_id: rep1.id, allocated_by: manager.id } });
      const [s1, s2, s3] = [await sse(rep1), await sse(rep2), await sse(rep3)];
      await db.$transaction([
        db.lead_allocations.update({ where: { id: first.id }, data: { ended_at: new Date(), ended_by: manager.id } }),
        db.lead_allocations.create({ data: { company_id: lead.id, rep_id: rep2.id, allocated_by: manager.id } }),
        db.companies.update({ where: { id: lead.id }, data: { assigned_rep_id: rep2.id } }),
      ]);
      await xadd('lead.allocated', lead.id, { assigned_rep_id: rep2.id });
      await xadd('pipeline.run_completed', null);
      await Promise.all([s1, s2, s3].map((s) => s.waitFor((m) => m.event === 'pipeline.run_completed')));
      const got = (s: typeof s1) => s.messages.some((m) => m.event === 'lead.allocated');
      expect([got(s1), got(s2), got(s3)]).toEqual([true, true, false]);
    });

    it('delivers notification.created only to the user it is for', async () => {
      const { rep1, rep2, manager } = fixtures;
      const [s1, s2, m] = [await sse(rep1), await sse(rep2), await sse(manager)];
      await xadd('notification.created', null, { actor_type: 'system', user_id: rep1.id, notification_id: rep2.id, type: 'allocated' });
      await xadd('pipeline.run_completed', null, { actor_type: 'pipeline' });
      await Promise.all([s1, s2, m].map((s) => s.waitFor((x) => x.event === 'pipeline.run_completed')));
      const got = (s: typeof s1) => s.messages.filter((x) => x.event === 'notification.created');
      expect(got(s1)).toHaveLength(1);
      expect(got(s1)[0].data).toMatchObject({ type: 'notification.created', payload: { user_id: rep1.id, type: 'allocated' } });
      expect([got(s2).length, got(m).length]).toEqual([0, 0]);
    });

    it('tells every rep who could see a pool lead that it left the pool, without naming its new rep', async () => {
      const { rep1, rep2, rep3, manager } = fixtures;
      const lead = await db.companies.create({ data: { business_name: 'Taken', latitude: 40.7, longitude: -74, content_hash: 'h' } });
      const [s1, s2, s3, m] = [await sse(rep1), await sse(rep2), await sse(rep3), await sse(manager)];
      await db.$transaction([
        db.lead_allocations.create({ data: { company_id: lead.id, rep_id: rep2.id, allocated_by: manager.id } }),
        db.companies.update({ where: { id: lead.id }, data: { assigned_rep_id: rep2.id } }),
      ]);
      await xadd('lead.allocated', lead.id, {
        company_id: lead.id, assigned_rep_id: rep2.id, rep_id: rep2.id, previous_rep_id: null, actor_id: manager.id, version: 2,
      });
      const [a1, a2, a3, am] = await Promise.all([s1, s2, s3, m].map((s) => s.waitFor((x) => x.event === 'lead.allocated')));
      for (const left of [a1, a3]) {
        expect(left.data).toMatchObject({ type: 'lead.allocated', company_id: lead.id, payload: { company_id: lead.id, left_pool: true } });
        expect(JSON.stringify(left.data)).not.toContain(rep2.id);
      }
      expect(a2.data).toMatchObject({ payload: { assigned_rep_id: rep2.id, version: 2 } });
      expect(am.data).toMatchObject({ payload: { assigned_rep_id: rep2.id } });
    });

    it('replays visible events after Last-Event-ID, then continues live', async () => {
      const { rep1, own, other, pool } = fixtures;
      const start = await xadd('note.added', own.id);
      await xadd('note.added', other.id);
      const replayed = await xadd('note.added', pool.id);
      const s = await sse(rep1, { 'Last-Event-ID': start! });
      expect(s.messages.filter((m) => m.event !== 'ready').map((m) => m.id)).toEqual([replayed]);
      expect(s.messages.at(-1)).toMatchObject({ event: 'ready', data: { lastEventId: replayed } });
      const live = await xadd('lead.updated', own.id);
      await s.waitFor((m) => m.id === live);
    });

    it('accepts ?access_token= (EventSource cannot set headers) and caps streams per user', async () => {
      const token = await tokenFor(fixtures.rep3);
      const opened: ReturnType<typeof openSse>[] = [];
      for (let i = 0; i < config.sseMaxPerUser; i++) {
        const s = openSse(base, `/api/events?access_token=${token}`);
        streams.push(s);
        opened.push(s);
        expect(await s.opened).toBe(200);
        await s.waitFor((m) => m.event === 'ready');
      }
      const extra = openSse(base, `/api/events?access_token=${token}`);
      streams.push(extra);
      expect(await extra.opened).toBe(429);
      opened[0].close();
      await new Promise((r) => setTimeout(r, 100));
      const again = openSse(base, `/api/events?access_token=${token}`);
      streams.push(again);
      expect(await again.opened).toBe(200);
      await request(base).get('/api/events').expect(401);
    });

    it('keeps no subscription for a client that hung up before its stream opened', async () => {
      const slow: RateLimiter = async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { allowed: true, remaining: 1, retryAfterMs: 0 };
      };
      const leaky = await db.users.create({ data: { name: 'Leaky', email: 'leaky@test.local', role: 'rep' } });
      const token = await tokenFor(leaky);
      const s = createApp({ ...deps, limiter: slow }).listen(0, '127.0.0.1');
      await once(s, 'listening');
      try {
        const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
        for (let i = 0; i <= config.sseMaxPerUser; i++) {
          const c = openSse(url, '/api/events', { Authorization: `Bearer ${token}` });
          c.opened.catch(() => {});
          await new Promise((r) => setTimeout(r, 20));
          c.close();
        }
        await new Promise((r) => setTimeout(r, 300));
        expect(hub.connectionsFor(leaky.id)).toBe(0);
      } finally {
        s.closeAllConnections();
        s.close();
      }
    });
  });
});
