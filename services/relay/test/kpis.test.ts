import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { InvalidationConsumer } from '../src/invalidation.ts';
import { KpiRefresher } from '../src/kpis.ts';
import { listenForOutbox, OutboxPublisher } from '../src/outbox.ts';
import { company, dbUrl, hasInfra, openDb, openRedis, resetDb, silent, until, users } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opts = { intervalMs: 60_000, debounceMs: 2000 };

/** Counts REFRESH calls and how many overlap; `delayMs` stretches each one, `during`/`after` hook around it. */
function instrument(db: PrismaClient, delayMs = 0, hooks: { during?: () => Promise<unknown>; after?: () => Promise<unknown> } = {}) {
  const probe = { calls: 0, inflight: 0, maxInflight: 0 };
  const wrapped = {
    $executeRawUnsafe: async (query: string) => {
      probe.calls++;
      probe.maxInflight = Math.max(probe.maxInflight, ++probe.inflight);
      try {
        await hooks.during?.();
        await sleep(delayMs);
        const n = await db.$executeRawUnsafe(query);
        await hooks.after?.();
        return n;
      } finally {
        probe.inflight--;
      }
    },
  } as unknown as PrismaClient;
  return { probe, db: wrapped };
}

describe.skipIf(!hasInfra)('team_dashboard_kpis refresh (Postgres + Redis)', () => {
  let db: PrismaClient;
  let redis: Redis;

  const view = () =>
    db.$queryRaw<{ rep: string | null; lead_count: number }[]>`
      SELECT assigned_rep_id::text AS rep, lead_count FROM team_dashboard_kpis ORDER BY rep NULLS FIRST`;

  beforeAll(async () => {
    db = await openDb();
    redis = openRedis();
  });

  beforeEach(async () => {
    await resetDb(db);
    await redis.flushdb();
  });

  afterAll(async () => {
    redis?.disconnect();
    await db?.$disconnect();
  });

  it('refreshes the view and drops kpi:team; rep KPIs (live counts) are left to invalidation', async () => {
    const u = await users(db);
    await company(db, u.rep1.id);
    await company(db, null);
    await redis.set('kpi:team', 'stale');
    await redis.set(`kpi:rep:${u.rep1.id}`, 'live');
    await redis.set('leads:v:all', '3');
    expect(await view()).toEqual([]);
    const refresher = new KpiRefresher(db, redis, opts, silent);
    await refresher.request('test');
    expect(await view()).toEqual([{ rep: null, lead_count: 1 }, { rep: u.rep1.id, lead_count: 1 }]);
    expect(await redis.exists('kpi:team')).toBe(0);
    expect(await redis.get(`kpi:rep:${u.rep1.id}`)).toBe('live');
    expect(await redis.get('leads:v:all')).toBe('3');
    expect(refresher.stats).toMatchObject({ refreshes: 1, lastError: null });
  });

  it('coalesces requests made during a refresh into one more refresh', async () => {
    const refresher = new KpiRefresher(db, redis, opts, silent);
    await Promise.all([refresher.request('a'), refresher.request('b'), refresher.request('c'), refresher.request('d')]);
    expect(refresher.stats.refreshes).toBe(2);
  });

  it('drops kpi:team only after the refresh has committed', async () => {
    const u = await users(db);
    await company(db, u.rep1.id);
    let atCommit: string | null = 'unset';
    const { db: slow } = instrument(db, 100, {
      // a reader rebuilding kpi:team from the old view while the refresh runs
      during: () => redis.set('kpi:team', 'rebuilt from the old view'),
      after: async () => {
        atCommit = await redis.get('kpi:team');
      },
    });
    await redis.set('kpi:team', 'old');
    await new KpiRefresher(slow, redis, opts, silent).request('test');
    expect(atCommit).toBe('rebuilt from the old view');
    expect(await redis.exists('kpi:team')).toBe(0);
    expect(await view()).toEqual([{ rep: u.rep1.id, lead_count: 1 }]);
  });

  it('a bulk allocation of 500 leads (outbox -> stream -> consumer) causes one debounced refresh', async () => {
    const u = await users(db);
    await db.$executeRaw`
      INSERT INTO companies (business_name, latitude, longitude, content_hash)
      SELECT 'Acme ' || g, 40.72, -74, 'h' FROM generate_series(1, 500) g`;
    await db.$executeRawUnsafe('REFRESH MATERIALIZED VIEW team_dashboard_kpis');
    await redis.set('kpi:team', 'cached');

    const { probe, db: counted } = instrument(db);
    const refresher = new KpiRefresher(counted, redis, { ...opts, debounceMs: 1000 }, silent);
    const consumer = new InvalidationConsumer(
      openRedis(),
      { db, redis, versionWindow: 50, onTeamKpiChange: (t) => refresher.schedule(t) },
      { stream: 'events', group: 'cache-invalidation', consumer: 'relay-a', claimIdleMs: 60_000, blockMs: 100 },
      silent,
    );
    const publisher = new OutboxPublisher(db, redis, { stream: 'events', maxLen: 10_000, batchSize: 100, pollIntervalMs: 20 }, silent);
    await consumer.ensureGroup();
    publisher.start();
    try {
      await db.$transaction([
        db.$executeRaw`UPDATE companies SET assigned_rep_id = ${u.rep1.id}::uuid, version = version + 1`,
        db.$executeRaw`
          INSERT INTO outbox_events (event_type, company_id, payload)
          SELECT 'lead.allocated', id, jsonb_build_object('company_id', id, 'assigned_rep_id', assigned_rep_id,
                 'previous_rep_id', NULL, 'actor_type', 'user', 'actor_id', ${u.manager.id}::uuid, 'version', version)
          FROM companies`,
      ]);
      // Consumed only once all of it is on the stream, so the batches arrive well within the debounce
      // however slow the machine is.
      await until(async () => (await redis.xlen('events')) === 500, 15_000);
      consumer.start();
      await until(async () => consumer.stats.processed === 500, 15_000);
      await until(async () => refresher.stats.refreshes === 1, 5000);
      await sleep(1200);
      expect(probe.calls).toBe(1);
      expect(refresher.stats.refreshes).toBe(1);
      expect(await view()).toEqual([{ rep: u.rep1.id, lead_count: 500 }]);
      expect(await redis.exists('kpi:team')).toBe(0);
    } finally {
      await publisher.stop();
      await consumer.stop();
      await refresher.stop();
    }
  });

  it('the three run_completed events of one refresh job (scrape, counties, tag) cause one debounced refresh', async () => {
    const u = await users(db);
    const c = await company(db, u.rep1.id);
    const { probe, db: counted } = instrument(db);
    const refresher = new KpiRefresher(counted, redis, { ...opts, debounceMs: 500 }, silent);
    const consumer = new InvalidationConsumer(
      openRedis(),
      { db, redis, versionWindow: 50, onTeamKpiChange: (t) => refresher.schedule(t) },
      { stream: 'events', group: 'cache-invalidation', consumer: 'relay-a', claimIdleMs: 60_000, blockMs: 50 },
      silent,
    );
    const publisher = new OutboxPublisher(db, redis, { stream: 'events', maxLen: 10_000, batchSize: 100, pollIntervalMs: 20 }, silent);
    await consumer.ensureGroup();
    consumer.start();
    publisher.start();
    try {
      for (const kind of ['scrape', 'counties', 'tag']) {
        await db.$executeRaw`
          INSERT INTO outbox_events (event_type, payload)
          VALUES ('pipeline.run_completed', jsonb_build_object('actor_type', 'pipeline', 'kind', ${kind}::text,
                  'company_ids', jsonb_build_array(${c.id}::text), 'changed_companies', 1, 'company_ids_truncated', false))`;
        await sleep(100);  // separate stream batches
      }
      await until(async () => consumer.stats.processed === 3, 5000);
      expect(probe.calls).toBe(0);
      await until(async () => refresher.stats.refreshes === 1, 3000);
      await sleep(700);
      expect(probe.calls).toBe(1);
    } finally {
      await publisher.stop();
      await consumer.stop();
      await refresher.stop();
    }
  });

  it('never runs two refreshes at once, folding scheduled and immediate requests made meanwhile', async () => {
    const { probe, db: slow } = instrument(db, 250);
    const refresher = new KpiRefresher(slow, redis, { ...opts, debounceMs: 50 }, silent);
    const end = Date.now() + 1200;
    let i = 0;
    while (Date.now() < end) {
      refresher.schedule('change');
      if (i++ % 10 === 0) void refresher.request('run_completed');
      await sleep(10);
    }
    await sleep(700);
    expect(probe.inflight).toBe(0);
    expect(probe.maxInflight).toBe(1);
    // ~100 schedule() and ~12 request() calls: bounded by back-to-back refreshes, not by the calls
    expect(probe.calls).toBeGreaterThanOrEqual(2);
    expect(probe.calls).toBeLessThanOrEqual(8);
    expect(refresher.stats).toMatchObject({ refreshes: probe.calls, lastError: null });
  });

  it('a steady stream of changes cannot postpone the refresh (fixed window, not sliding)', async () => {
    const { probe, db: counted } = instrument(db);
    const refresher = new KpiRefresher(counted, redis, { ...opts, debounceMs: 200 }, silent);
    try {
      const end = Date.now() + 1100;
      while (Date.now() < end) {
        refresher.schedule('change');
        await sleep(20);
      }
      // a sliding window would not refresh at all while the changes keep coming
      expect(probe.calls).toBeGreaterThanOrEqual(2);
      expect(probe.calls).toBeLessThanOrEqual(6);
    } finally {
      await refresher.stop();
    }
  });

  it('a refresh that fails is retried after the debounce', async () => {
    let fail = true;
    const flaky = {
      $executeRawUnsafe: (q: string) => (fail ? ((fail = false), Promise.reject(new Error('lock timeout'))) : db.$executeRawUnsafe(q)),
    } as unknown as PrismaClient;
    const refresher = new KpiRefresher(flaky, redis, { ...opts, debounceMs: 50 }, silent);
    try {
      await refresher.request('test');
      expect(refresher.stats).toMatchObject({ refreshes: 0, lastError: 'lock timeout' });
      await until(async () => refresher.stats.refreshes === 1, 2000);
      expect(refresher.stats.lastError).toBeNull();
    } finally {
      await refresher.stop();
    }
  });

  it('stop() cancels a pending debounced refresh', async () => {
    const { probe, db: counted } = instrument(db);
    const refresher = new KpiRefresher(counted, redis, { ...opts, debounceMs: 50 }, silent);
    refresher.schedule('change');
    await refresher.stop();
    await sleep(150);
    refresher.schedule('change');
    await refresher.request('late');
    expect(probe.calls).toBe(0);
  });

  it('a logged activity reaches team_dashboard_kpis and clears kpi:team within 5 s (default settings)', async () => {
    const u = await users(db);
    const c = await company(db, u.rep1.id);
    const config = loadConfig({});
    const refresher = new KpiRefresher(db, redis, { intervalMs: config.kpiRefreshIntervalMs, debounceMs: config.kpiRefreshDebounceMs }, silent);
    const consumer = new InvalidationConsumer(
      openRedis(),
      { db, redis, versionWindow: 50, onTeamKpiChange: (t) => refresher.schedule(t) },
      { stream: config.stream, group: config.consumerGroup, consumer: 'relay-a', claimIdleMs: config.claimIdleMs },
      silent,
    );
    const publisher = new OutboxPublisher(db, redis, { stream: config.stream, maxLen: 10_000, batchSize: 200, pollIntervalMs: config.pollIntervalMs }, silent);
    const listener = listenForOutbox(dbUrl!, () => publisher.wake(), silent);
    await consumer.ensureGroup();
    consumer.start();
    publisher.start();
    refresher.start();
    const unserviced = async () =>
      (await db.$queryRaw<{ n: number }[]>`
        SELECT unserviced_count AS n FROM team_dashboard_kpis WHERE assigned_rep_id = ${u.rep1.id}::uuid`)[0]?.n;
    try {
      await until(async () => (await unserviced()) === 1);
      await sleep(300);
      await redis.set('kpi:team', 'before the call');
      const other = createPrismaClient(dbUrl);
      try {
        await other.$transaction([
          other.$executeRaw`INSERT INTO lead_rep_state (company_id, user_id, serviced_at) VALUES (${c.id}::uuid, ${u.rep1.id}::uuid, NOW())`,
          other.$executeRaw`UPDATE companies SET team_last_serviced_at = NOW() WHERE id = ${c.id}::uuid`,
          other.$executeRaw`
            INSERT INTO outbox_events (event_type, company_id, payload)
            VALUES ('state.changed', ${c.id}::uuid, jsonb_build_object('company_id', ${c.id}::text, 'actor_type', 'user',
                    'actor_id', ${u.rep1.id}::text, 'activity_type', 'call'))`,
        ]);
      } finally {
        await other.$disconnect();
      }
      const committed = Date.now();
      await until(async () => (await unserviced()) === 0 && (await redis.exists('kpi:team')) === 0, 5000);
      const elapsed = Date.now() - committed;
      expect(elapsed).toBeGreaterThanOrEqual(config.kpiRefreshDebounceMs - 100);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await listener.close();
      await publisher.stop();
      await consumer.stop();
      await refresher.stop();
    }
  });

  it('runs safely next to another relay refreshing at the same time', async () => {
    const other = createPrismaClient(dbUrl);
    try {
      const a = new KpiRefresher(db, redis, opts, silent);
      const b = new KpiRefresher(other, redis, opts, silent);
      await company(db, null);
      await Promise.all([a.request('a'), b.request('b')]);
      expect([a.stats.lastError, b.stats.lastError]).toEqual([null, null]);
      expect(await view()).toEqual([{ rep: null, lead_count: 1 }]);
    } finally {
      await other.$disconnect();
    }
  });
});
