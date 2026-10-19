import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@leadmaker/db';
import { Cache } from '../src/cache.ts';
import { loadConfig } from '../src/config.ts';
import { ClientClosedError, createPools, type Db, type Pools } from '../src/db.ts';
import { HttpError } from '../src/errors.ts';
import { Limiter } from '../src/limiter.ts';
import { zipCentroid } from '../src/zip.ts';
import { as, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

const silent = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = new AbortController().signal;

describe('Limiter', () => {
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it('runs up to its concurrency, queues up to maxQueue and refuses the rest with 503 + Retry-After', async () => {
    const l = new Limiter({ concurrency: 1, maxQueue: 1, maxWaitMs: 5000 });
    const g = gate();
    const first = l.run(never, () => g.p.then(() => 'a'));
    const second = l.run(never, async () => 'b');
    const third = l.run(never, async () => 'c');
    await expect(third).rejects.toMatchObject({ status: 503, message: 'busy', headers: { 'Retry-After': '1' } });
    expect([l.running, l.waiting, l.rejected]).toEqual([1, 1, 1]);
    g.open();
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect([l.running, l.waiting]).toEqual([0, 0]);
  });

  it('gives up on a queued call after maxWaitMs', async () => {
    const l = new Limiter({ concurrency: 1, maxQueue: 5, maxWaitMs: 30 });
    const g = gate();
    const first = l.run(never, () => g.p);
    await expect(l.run(never, async () => 1)).rejects.toBeInstanceOf(HttpError);
    expect(l.waiting).toBe(0);
    g.open();
    await first;
  });

  it('drops a queued call whose caller went away, and never starts an aborted one', async () => {
    const l = new Limiter({ concurrency: 1, maxQueue: 5, maxWaitMs: 5000 });
    const g = gate();
    const first = l.run(never, () => g.p);
    const ac = new AbortController();
    let ran = false;
    const queued = l.run(ac.signal, async () => void (ran = true));
    expect(l.waiting).toBe(1);
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(ClientClosedError);
    expect(l.waiting).toBe(0);
    await expect(l.run(ac.signal, async () => void (ran = true))).rejects.toBeInstanceOf(ClientClosedError);
    g.open();
    await first;
    expect([ran, l.running]).toEqual([false, 0]);
  });
});

describe('Cache when Redis misbehaves', () => {
  it('treats a failed read-your-writes check as "no recent write" and skips Redis during the cooldown', async () => {
    // A server that accepts connections and never answers: every command hits the command timeout.
    const hole = net.createServer(() => {});
    await new Promise<void>((r) => hole.listen(0, '127.0.0.1', r));
    const redis = new Redis({
      port: (hole.address() as AddressInfo).port, host: '127.0.0.1', commandTimeout: 100, enableReadyCheck: false,
      enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    await new Promise((r) => redis.once('ready', r));
    const cache = new Cache(redis, silent, { cooldownMs: 10_000 });
    try {
      let t = Date.now();
      expect(await cache.recentlyWrote('u')).toBe(false);
      expect(Date.now() - t).toBeLessThan(400);
      t = Date.now();
      expect(await Promise.all([cache.listVersion({ id: 'u', role: 'rep' }), cache.getJson('k'), cache.recentlyWrote('u')])).toEqual([null, undefined, false]);
      await cache.setJson('k', { a: 1 }, 60);
      expect(Date.now() - t).toBeLessThan(50);
      expect(cache.degraded).toBe(5);
    } finally {
      redis.disconnect();
      hole.close();
    }
  });
});

describe('config', () => {
  it('caps search concurrency at the search pool size', () => {
    const c = loadConfig({ DATABASE_SEARCH_POOL_MAX: '4', SEARCH_CONCURRENCY: '20', SEARCH_QUEUE_MAX: '0' });
    expect([c.searchPoolMax, c.searchConcurrency, c.searchQueueMax, c.poolMax, c.searchStatementTimeoutMs]).toEqual([4, 4, 0, 10, 2000]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('runtime (Postgres)', () => {
  let h: Harness;
  let f: Fixture;
  let pools: Pools;
  const opened: { close(): Promise<void> }[] = [];
  const app = async (over: Parameters<typeof harness>[0]) => {
    const extra = await harness(over);
    opened.push(extra);
    return extra.app;
  };

  /** A Db whose every raw query first sleeps `ms` in Postgres (so it holds a connection), counting calls. */
  const slow = (db: Db, ms: number) => {
    const calls = { n: 0 };
    const wrap = (client: PrismaClient) => new Proxy(client, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== '$queryRaw') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<PrismaClient['$queryRaw']>) => {
          calls.n++;
          await target.$queryRawUnsafe(`SELECT pg_sleep(${ms / 1000})::text`);
          return target.$queryRaw(...args);
        };
      },
    });
    return { db: { primary: wrap(db.primary), replica: wrap(db.replica) }, calls };
  };
  const search = (target: Harness['app'], filter: object = {}) =>
    request(target).post('/leads/search').set(as(f.users.manager, 'manager')).send({ filter });

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    pools = createPools({ primary: TEST_DATABASE_URL! }, { max: 2, statementTimeoutMs: 1500 }, { max: 2, statementTimeoutMs: 250 });
  });
  afterAll(async () => {
    await Promise.all(opened.map((o) => o.close()));
    await pools?.close();
    await h?.close();
  });

  it('sends each pool its statement_timeout as a connection parameter', async () => {
    const show = async (c: PrismaClient) => (await c.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`)[0].statement_timeout;
    expect(await show(pools.fast.replica)).toBe('1500ms');
    expect(await show(pools.search.replica)).toBe('250ms');
  });

  it('answers 503 busy with Retry-After when a search hits its statement timeout', async () => {
    const res = await search(await app({ db: pools.fast, searchDb: slow(pools.search, 2000).db }), { text: 'statement timeout' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'busy' });
    expect(res.headers['retry-after']).toBe('1');
  });

  it('answers 503 busy when Postgres runs out of a resource (SQLSTATE class 53)', async () => {
    const failing = (client: PrismaClient) => new Proxy(client, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== '$queryRaw') return typeof value === 'function' ? value.bind(target) : value;
        return () => target.$queryRawUnsafe(
          `DO $$ BEGIN RAISE EXCEPTION 'could not resize shared memory segment' USING ERRCODE = '53100'; END $$`);
      },
    });
    const searchDb = { primary: failing(pools.search.primary), replica: failing(pools.search.replica) };
    const res = await search(await app({ db: pools.fast, searchDb }), { text: 'out of shared memory' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'busy' });
    expect(res.headers['retry-after']).toBe('1');
  });

  it('keeps profile and KPI reads fast while every search slot is busy, and sheds searches past the queue', async () => {
    const one = createPools({ primary: TEST_DATABASE_URL! }, { max: 1, statementTimeoutMs: 5000 }, { max: 1, statementTimeoutMs: 5000 });
    opened.push(one);
    const limiter = new Limiter({ concurrency: 1, maxQueue: 1, maxWaitMs: 5000 });
    const target = await app({ db: pools.fast, searchDb: slow(one.search, 800).db, searchLimiter: limiter });
    const running = search(target, { text: 'slow one' }).then((r) => r);
    await sleep(100);
    const queued = search(target, { text: 'slow two' }).then((r) => r);
    await sleep(50);
    expect([limiter.running, limiter.waiting]).toEqual([1, 1]);
    const shed = await search(target, { text: 'slow three' });
    expect([shed.status, shed.headers['retry-after']]).toEqual([503, '1']);

    const t = Date.now();
    const [profile, kpis] = await Promise.all([
      request(target).get(`/leads/${f.ids.acme}`).set(as(f.users.rep1, 'rep')),
      request(target).get('/kpis').set(as(f.users.manager, 'manager')),
    ]);
    expect([profile.status, kpis.status]).toEqual([200, 200]);
    expect(Date.now() - t).toBeLessThan(400);
    expect(limiter.running).toBe(1);
    expect([(await running).status, (await queued).status]).toEqual([200, 200]);
  });

  it('drops a queued search when its caller disconnects, without running its query', async () => {
    const searchDb = slow(pools.search, 0);
    const limiter = new Limiter({ concurrency: 1, maxQueue: 5, maxWaitMs: 5000 });
    const target = await app({ db: pools.fast, searchDb: searchDb.db, searchLimiter: limiter });
    let release!: () => void;
    const held = limiter.run(never, () => new Promise<void>((r) => (release = r)));
    const server = target.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({ port, method: 'POST', path: '/leads/search', headers: { ...as(f.users.manager, 'manager'), 'content-type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ filter: { text: 'abandoned' } }));
      await sleep(150);
      expect(limiter.waiting).toBe(1);
      req.destroy();
      await sleep(100);
      expect(limiter.waiting).toBe(0);
      release();
      await held;
      expect([searchDb.calls.n, limiter.running]).toEqual([0, 0]);
    } finally {
      server.close();
    }
  });

  it('serves search, profile and KPIs uncached from the replica when Redis is down', async () => {
    const down = new Redis({ port: 1, host: '127.0.0.1', enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
    down.on('error', () => {});
    const primary = new Proxy(pools.fast.primary, { get: () => { throw new Error('primary used'); } });
    const cache = new Cache(down, silent);
    const target = await app({ db: { primary, replica: pools.fast.replica }, searchDb: { primary, replica: pools.search.replica }, cache });
    const s = await search(target, { text: 'Roof' });
    expect([s.status, s.headers['x-cache']]).toEqual([200, 'miss']);
    expect(s.body.items.length).toBeGreaterThan(0);
    expect((await request(target).get(`/leads/${f.ids.acme}`).set(as(f.users.rep1, 'rep'))).status).toBe(200);
    expect((await request(target).get('/kpis').set(as(f.users.manager, 'manager'))).status).toBe(200);
    expect(cache.degraded).toBeGreaterThan(0);
  });

  it("averages only the companies the viewer may see for a ZIP outside the Census table", async () => {
    const insert = async (lat: number, rep: string | null) => (await h.query<{ id: string }>(
      `INSERT INTO companies (business_name, latitude, longitude, postal_code, content_hash, assigned_rep_id)
       VALUES ('Zip Test', $1, -150, '99950', 'h', $2::uuid) RETURNING id`, lat, rep))[0].id;
    await insert(60, f.users.rep2);
    const rep1 = { id: f.users.rep1, role: 'rep' as const };
    expect(await zipCentroid(pools.fast, '99950', rep1)).toBeUndefined();
    expect(await zipCentroid(pools.fast, '99950', { id: f.users.rep2, role: 'rep' })).toEqual({ lat: 60, lng: -150 });
    await insert(62, null);
    expect(await zipCentroid(pools.fast, '99950', rep1)).toEqual({ lat: 62, lng: -150 });
    expect(await zipCentroid(pools.fast, '99950')).toEqual({ lat: 62, lng: -150 });
    expect(await zipCentroid(pools.fast, '99950', { id: f.users.manager, role: 'manager' })).toEqual({ lat: 61, lng: -150 });
  });
});
