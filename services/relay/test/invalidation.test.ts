import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VersionCoalescer } from '../src/coalesce.ts';
import { invalidate, InvalidationConsumer, type InvalidationDeps } from '../src/invalidation.ts';
import { publishBatch } from '../src/outbox.ts';
import { entryFields, parseEntry, type StreamEvent } from '../src/stream.ts';
import { company, hasInfra, openDb, openRedis, outbox, resetDb, silent, until, users } from './helpers.ts';

describe.skipIf(!hasInfra)('cache invalidation (Postgres + Redis)', () => {
  let db: PrismaClient;
  let redis: Redis;
  let u: Awaited<ReturnType<typeof users>>;
  let teamChanges: string[];
  let deps: InvalidationDeps;

  const event = (type: string, companyId: string | null, payload: Record<string, unknown> = {}): StreamEvent =>
    parseEntry('1-0', entryFields({ id: '1', event_type: type, company_id: companyId, payload: { actor_type: 'user', ...payload }, created_at: new Date() }))!;
  const exists = async (...keys: string[]) => Promise.all(keys.map(async (k) => (await redis.exists(k)) === 1));
  const setAll = (...keys: string[]) => Promise.all(keys.map((k) => redis.set(k, 'cached')));
  const versions = async () => {
    const [all, pool, rep1, rep2] = await redis.mget('leads:v:all', 'leads:v:pool', `leads:v:rep:${u.rep1.id}`, `leads:v:rep:${u.rep2.id}`);
    return { all: Number(all), pool: Number(pool), rep1: Number(rep1), rep2: Number(rep2) };
  };
  const bump = (id: string, times: number) =>
    db.$executeRaw`UPDATE companies SET version = version + ${times} WHERE id = ${id}::uuid`;

  beforeAll(async () => {
    db = await openDb();
    redis = openRedis();
  });

  beforeEach(async () => {
    await resetDb(db);
    await redis.flushdb();
    u = await users(db);
    teamChanges = [];
    deps = { db, redis, versionWindow: 50, onTeamKpiChange: (t) => teamChanges.push(t) };
  });

  afterAll(async () => {
    redis?.disconnect();
    await db?.$disconnect();
  });

  it('lead.updated: bumps the list versions, drops stale profile versions and the affected rep KPIs only', async () => {
    const c = await company(db, u.rep1.id);
    await bump(c.id, 2);
    await redis.set('leads:v:all', 5);
    await setAll(`lead:${c.id}:v1`, `lead:${c.id}:v2`, `lead:${c.id}:v3`, `kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, 'kpi:team');
    await invalidate([event('lead.updated', c.id, { version: 3, actor_type: 'pipeline' })], deps);
    expect(await versions()).toEqual({ all: 6, pool: 0, rep1: 1, rep2: 0 });
    expect(await exists(`lead:${c.id}:v1`, `lead:${c.id}:v2`, `lead:${c.id}:v3`)).toEqual([false, false, true]);
    expect(await exists(`kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, 'kpi:team')).toEqual([false, true, true]);
    expect(teamChanges).toEqual([]);
  });

  it('a batch-insights lead.updated (fields [insights]) touches no cache; one more field does', async () => {
    const c = await company(db, u.rep1.id);
    await redis.set('leads:v:all', 5);
    await setAll(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`);
    const insights = event('lead.updated', c.id, { version: 1, actor_type: 'pipeline', fields: ['insights'], material: false });
    expect(insights.insightsOnly).toBe(true);
    await invalidate([insights], deps);
    expect(await versions()).toEqual({ all: 5, pool: 0, rep1: 0, rep2: 0 });
    expect(await exists(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`)).toEqual([true, true]);

    const mixed = event('lead.updated', c.id, { version: 1, actor_type: 'pipeline', fields: ['insights', 'gaf_rating'] });
    expect(mixed.insightsOnly).toBe(false);
    await invalidate([insights, mixed], deps);
    expect((await versions()).all).toBe(6);
  });

  it('uses the current version even when the payload carries none, and is idempotent', async () => {
    const c = await company(db, null);
    await bump(c.id, 3);
    await setAll(`lead:${c.id}:v2`, `lead:${c.id}:v4`);
    const e = event('override.set', c.id);
    await invalidate([e], deps);
    await invalidate([e], deps);
    expect(await exists(`lead:${c.id}:v2`, `lead:${c.id}:v4`)).toEqual([false, true]);
    expect(await versions()).toEqual({ all: 2, pool: 2, rep1: 0, rep2: 0 });
  });

  it('override.set and tags.changed leave KPI caches alone', async () => {
    const c = await company(db, u.rep1.id);
    await setAll(`kpi:rep:${u.rep1.id}`, 'kpi:team');
    await invalidate([event('override.set', c.id, { version: 2 }), event('tags.changed', c.id, { version: 2 })], deps);
    expect(await exists(`kpi:rep:${u.rep1.id}`, 'kpi:team')).toEqual([true, true]);
  });

  it('note.added and state.changed also drop the current version, which they do not bump', async () => {
    const c = await company(db, u.rep1.id);
    await setAll(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`);
    await invalidate([event('state.changed', c.id, { actor_id: u.rep1.id })], deps);
    expect(await exists(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`)).toEqual([false, false]);
  });

  it('lead.allocated: drops the KPIs of the new and the previous owner, even when the payload names neither', async () => {
    const c = await company(db, u.rep2.id);
    const old = await db.lead_allocations.create({ data: { company_id: c.id, rep_id: u.rep1.id, allocated_by: u.manager.id } });
    await db.lead_allocations.update({ where: { id: old.id }, data: { ended_at: new Date(), ended_by: u.manager.id } });
    await db.lead_allocations.create({ data: { company_id: c.id, rep_id: u.rep2.id, allocated_by: u.manager.id } });
    await setAll(`kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, `kpi:rep:${u.manager.id}`);
    await invalidate([event('lead.allocated', null, { company_ids: [c.id], actor_type: 'system' })], deps);
    expect(await exists(`kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, `kpi:rep:${u.manager.id}`)).toEqual([false, false, true]);
  });

  it('pipeline.run_completed: drops every rep KPI and schedules a view refresh (which drops kpi:team)', async () => {
    await setAll(`kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, 'kpi:team', 'leads:q:x:1:abc');
    await invalidate([event('pipeline.run_completed', null, { actor_type: 'pipeline', company_ids: [], changed_companies: 0 })], deps);
    expect(await exists(`kpi:rep:${u.rep1.id}`, `kpi:rep:${u.rep2.id}`, 'kpi:team', 'leads:q:x:1:abc')).toEqual([false, false, true, true]);
    expect(await versions()).toEqual({ all: 1, pool: 0, rep1: 0, rep2: 0 });
    expect(teamChanges).toEqual(['pipeline.run_completed']);
  });

  it('allocations, state changes (activities) and notes schedule one team KPI refresh per batch', async () => {
    const c = await company(db, u.rep1.id);
    await setAll('kpi:team');
    await invalidate([event('lead.updated', c.id), event('override.set', c.id), event('tags.changed', c.id)], deps);
    expect(teamChanges).toEqual([]);
    const allocations = Array.from({ length: 200 }, () => event('lead.allocated', c.id, { assigned_rep_id: u.rep1.id }));
    await invalidate([event('lead.updated', c.id), ...allocations], deps);
    await invalidate([event('state.changed', c.id, { activity_type: 'call' })], deps);
    await invalidate([event('note.added', c.id)], deps);
    expect(teamChanges).toEqual(['lead.allocated', 'state.changed', 'note.added']);
    expect(await redis.exists('kpi:team')).toBe(1);
  });

  describe('list versions', () => {
    it('a change to a rep\'s lead moves all and that rep; to a pool lead, all and the pool', async () => {
      const mine = await company(db, u.rep1.id);
      const pooled = await company(db, null);
      await invalidate([event('override.set', mine.id, { version: 2 })], deps);
      expect(await versions()).toEqual({ all: 1, pool: 0, rep1: 1, rep2: 0 });
      await invalidate([event('state.changed', pooled.id, { actor_id: u.manager.id })], deps);
      expect(await versions()).toEqual({ all: 2, pool: 1, rep1: 1, rep2: 0 });
      // one INCR per version per batch, however many events touch it
      await invalidate([event('tags.changed', mine.id), event('lead.updated', mine.id), event('lead.updated', pooled.id)], deps);
      expect(await versions()).toEqual({ all: 3, pool: 2, rep1: 2, rep2: 0 });
    });

    it('with a coalescer: rep counters move per batch, all and pool once per window plus one trailing bump', async () => {
      const coalescer = new VersionCoalescer(redis, 1000, silent);
      const held = { ...deps, coalescer };
      const mine = await company(db, u.rep1.id);
      const pooled = await company(db, null);
      try {
        for (let i = 0; i < 3; i++) {
          await invalidate([event('state.changed', mine.id, { actor_id: u.rep1.id })], held);
          await invalidate([event('override.set', pooled.id, { version: 2 + i })], held);
        }
        expect(await versions()).toEqual({ all: 1, pool: 1, rep1: 3, rep2: 0 });
        await until(async () => (await versions()).all === 2);
        expect(await versions()).toEqual({ all: 2, pool: 2, rep1: 3, rep2: 0 });
        expect(coalescer.coalesced).toBe(7);
      } finally {
        await coalescer.stop();
      }
    });

    it('a note moves no list version (lists show nothing of notes) but still drops the profile', async () => {
      const c = await company(db, u.rep1.id);
      await setAll(`lead:${c.id}:v1`);
      await invalidate([event('note.added', c.id, { assigned_rep_id: u.rep1.id, version: 1 })], deps);
      expect(await versions()).toEqual({ all: 0, pool: 0, rep1: 0, rep2: 0 });
      expect(await exists(`lead:${c.id}:v1`)).toEqual([false]);
    });

    it('allocations move the new owner, the previous owner, and the pool when the lead came from or returned to it', async () => {
      const c = await company(db, u.rep1.id);
      await invalidate([event('lead.allocated', c.id, { assigned_rep_id: u.rep1.id, previous_rep_id: null, version: 2 })], deps);
      expect(await versions()).toEqual({ all: 1, pool: 1, rep1: 1, rep2: 0 });
      await db.companies.update({ where: { id: c.id }, data: { assigned_rep_id: u.rep2.id } });
      await invalidate([event('lead.allocated', c.id, { assigned_rep_id: u.rep2.id, previous_rep_id: u.rep1.id, version: 3 })], deps);
      expect(await versions()).toEqual({ all: 2, pool: 1, rep1: 2, rep2: 1 });
      await db.companies.update({ where: { id: c.id }, data: { assigned_rep_id: null } });
      await invalidate([event('lead.allocated', c.id, { assigned_rep_id: null, previous_rep_id: u.rep2.id, version: 4 })], deps);
      expect(await versions()).toEqual({ all: 3, pool: 2, rep1: 2, rep2: 2 });
    });

    it('an allocation whose payload names no previous owner moves the last ended allocation\'s rep and the pool', async () => {
      const c = await company(db, u.rep2.id);
      const old = await db.lead_allocations.create({ data: { company_id: c.id, rep_id: u.rep1.id, allocated_by: u.manager.id } });
      await db.lead_allocations.update({ where: { id: old.id }, data: { ended_at: new Date(), ended_by: u.manager.id } });
      await invalidate([event('lead.allocated', null, { company_ids: [c.id], actor_type: 'system' })], deps);
      expect(await versions()).toEqual({ all: 1, pool: 1, rep1: 1, rep2: 1 });
    });

    it('moves the owner the lead has when the event is read (an allocation in between moves the one before)', async () => {
      const c = await company(db, u.rep2.id);
      await invalidate([event('lead.updated', c.id, { version: 1 })], deps);
      expect(await versions()).toEqual({ all: 1, pool: 0, rep1: 0, rep2: 1 });
      // an allocation to rep1 read after the lead moved on to rep2 still moves rep1, whose lists showed it meanwhile
      await invalidate([event('lead.allocated', c.id, { assigned_rep_id: u.rep1.id, previous_rep_id: null, version: 2 })], deps);
      expect(await versions()).toEqual({ all: 2, pool: 1, rep1: 1, rep2: 2 });
    });

    it('a run_completed lists its leads; a truncated list (or an unknown lead, or no lead at all) moves the pool and every rep with leads', async () => {
      const mine = await company(db, u.rep1.id);
      const pooled = await company(db, null);
      const run = (payload: Record<string, unknown>) => event('pipeline.run_completed', null, { actor_type: 'pipeline', ...payload });
      await invalidate([run({ company_ids: [mine.id], changed_companies: 1, company_ids_truncated: false })], deps);
      expect(await versions()).toEqual({ all: 1, pool: 0, rep1: 1, rep2: 0 });
      await invalidate([run({ company_ids: [pooled.id], changed_companies: 1001, company_ids_truncated: true })], deps);
      expect(await versions()).toEqual({ all: 2, pool: 1, rep1: 2, rep2: 0 });  // rep2 holds no leads
      await invalidate([run({ company_ids: [pooled.id], changed_companies: 5 })], deps);
      expect(await versions()).toEqual({ all: 3, pool: 2, rep1: 3, rep2: 0 });
      await invalidate([event('lead.updated', '3d9f3c1a-0000-4000-8000-000000000000', { version: 1 })], deps);
      expect(await versions()).toEqual({ all: 4, pool: 3, rep1: 4, rep2: 0 });
      await invalidate([event('tags.changed', null, { tag_id: 'x', created: true })], deps);
      expect(await versions()).toEqual({ all: 5, pool: 4, rep1: 5, rep2: 0 });
      await invalidate([parseEntry('1-0', ['id', '9', 'type', 'lead.updated', 'company_id', mine.id, 'payload', '{oops'])!], deps);
      expect(await versions()).toEqual({ all: 6, pool: 5, rep1: 6, rep2: 0 });
    });
  });

  describe('consumer group', () => {
    const opts = { stream: 'events', group: 'cache-invalidation', consumer: 'relay-a', claimIdleMs: 60_000, blockMs: 100 };

    it('applies published events and acks them', async () => {
      const consumer = new InvalidationConsumer(openRedis(), deps, opts, silent);
      try {
        await consumer.ensureGroup();
        await consumer.ensureGroup();
        const c = await company(db, u.rep1.id);
        await bump(c.id, 1);
        await setAll(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`);
        await outbox(db, 'lead.updated', c.id, { version: 2 });
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        expect(await consumer.readOnce('>')).toHaveLength(1);
        expect(await exists(`lead:${c.id}:v1`, `kpi:rep:${u.rep1.id}`)).toEqual([false, false]);
        const [pending] = (await redis.xpending('events', 'cache-invalidation')) as [number];
        expect(pending).toBe(0);
        expect(consumer.stats.processed).toBe(1);
      } finally {
        await consumer.stop();
      }
    });

    it('reclaims entries a crashed consumer read but never acked', async () => {
      const consumer = new InvalidationConsumer(openRedis(), deps, { ...opts, claimIdleMs: 50 }, silent);
      try {
        await consumer.ensureGroup();
        const c = await company(db, u.rep2.id);
        await setAll(`kpi:rep:${u.rep2.id}`);
        await outbox(db, 'state.changed', c.id);
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        await redis.xreadgroup('GROUP', 'cache-invalidation', 'crashed', 'COUNT', 10, 'STREAMS', 'events', '>');
        expect(await consumer.readOnce('>')).toHaveLength(0);
        expect(await exists(`kpi:rep:${u.rep2.id}`)).toEqual([true]);
        await new Promise((r) => setTimeout(r, 80));
        await consumer.claimStale();
        expect(await exists(`kpi:rep:${u.rep2.id}`)).toEqual([false]);
        expect(((await redis.xpending('events', 'cache-invalidation')) as [number])[0]).toBe(0);
      } finally {
        await consumer.stop();
      }
    });

    it('counts a read as progress (for /healthz) only once its effects are applied', async () => {
      const down = () => Promise.reject(new Error('db down'));
      const broken = { ...deps, db: { companies: { findMany: down }, $queryRaw: down } as unknown as PrismaClient };
      const consumer = new InvalidationConsumer(openRedis(), broken, opts, silent);
      try {
        await consumer.ensureGroup();
        expect(await consumer.readOnce('>')).toHaveLength(0);
        expect(consumer.stats.lastReadAt).not.toBeNull();
        consumer.stats.lastReadAt = null;
        const c = await company(db, u.rep1.id);
        await outbox(db, 'lead.updated', c.id, { version: 1 });
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        await expect(consumer.readOnce('>')).rejects.toThrow('db down');
        expect(consumer.stats.lastReadAt).toBeNull();
      } finally {
        await consumer.stop();
      }
    });

    it('after a restart, processes its own pending entries before new ones', async () => {
      const consumer = new InvalidationConsumer(openRedis(), deps, opts, silent);
      try {
        await consumer.ensureGroup();
        const c = await company(db, u.rep1.id);
        await setAll(`kpi:rep:${u.rep1.id}`);
        await outbox(db, 'state.changed', c.id);
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        await redis.xreadgroup('GROUP', 'cache-invalidation', 'relay-a', 'COUNT', 10, 'STREAMS', 'events', '>');
        expect(await consumer.readOnce('0')).toHaveLength(1);
        expect(await exists(`kpi:rep:${u.rep1.id}`)).toEqual([false]);
        expect(await consumer.readOnce('0')).toHaveLength(0);
      } finally {
        await consumer.stop();
      }
    });

    it('start() drains entries it read but never acked before a restart, well before they could be reclaimed', async () => {
      const consumer = new InvalidationConsumer(openRedis(), deps, opts, silent);
      try {
        await consumer.ensureGroup();
        const c = await company(db, u.rep2.id);
        await setAll(`kpi:rep:${u.rep2.id}`);
        await outbox(db, 'state.changed', c.id);
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        await redis.xreadgroup('GROUP', 'cache-invalidation', 'relay-a', 'COUNT', 10, 'STREAMS', 'events', '>');
        consumer.start();
        await until(async () => (await redis.exists(`kpi:rep:${u.rep2.id}`)) === 0, 3000);
        await until(async () => ((await redis.xpending('events', 'cache-invalidation')) as [number])[0] === 0, 3000);
      } finally {
        await consumer.stop();
      }
    });

    it('recreates its group when the group or the whole stream is deleted while it runs, and carries on', async () => {
      const consumer = new InvalidationConsumer(openRedis(), deps, opts, silent);
      const c = await company(db, u.rep1.id);
      const delivered = async () => {
        await setAll(`kpi:rep:${u.rep1.id}`);
        await outbox(db, 'state.changed', c.id);
        await publishBatch(db, redis, { stream: 'events', maxLen: 1000, batchSize: 10 });
        await until(async () => (await redis.exists(`kpi:rep:${u.rep1.id}`)) === 0, 3000);
      };
      const groupExists = async () => {
        const groups = (await redis.xinfo('GROUPS', 'events').catch(() => [])) as string[][];
        return groups.some((g) => g[g.indexOf('name') + 1] === 'cache-invalidation');
      };
      try {
        await consumer.ensureGroup();
        consumer.start();
        await delivered();
        await redis.xgroup('DESTROY', 'events', 'cache-invalidation');
        await until(groupExists, 3000);
        await delivered();
        await redis.del('events');
        await until(groupExists, 3000);
        await delivered();
        await until(async () => consumer.stats.processed === 3);  // counted after the XACK that follows the effects
      } finally {
        await consumer.stop();
      }
    });
  });
});
