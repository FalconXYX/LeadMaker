import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listenForOutbox, OutboxPublisher, publishBatch } from '../src/outbox.ts';
import { dbUrl, hasInfra, openDb, openRedis, outbox, resetDb, silent, until } from './helpers.ts';

describe.skipIf(!hasInfra)('outbox relay (Postgres + Redis)', () => {
  let db: PrismaClient;
  let redis: Redis;
  const opts = { stream: 'events', maxLen: 100_000, batchSize: 50 };

  const streamIds = async () => (await redis.xrange('events', '-', '+')).map(([, f]) => f[f.indexOf('id') + 1]);
  const unpublished = async () =>
    Number((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`)[0].n);

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

  it('writes one stream entry per row with the LeadEvent fields, in id order', async () => {
    const company = '11111111-1111-4111-8111-111111111111';
    const first = await outbox(db, 'note.added', null, { company_id: company, actor_id: company });
    const second = await outbox(db, 'pipeline.run_completed', null, { actor_type: 'pipeline', run_id: 3 });
    expect(await publishBatch(db, redis, opts)).toBe(2);
    const entries = await redis.xrange('events', '-', '+');
    expect(entries.map(([, f]) => f.filter((_, i) => i % 2 === 0))).toEqual([
      ['id', 'type', 'company_id', 'payload', 'created_at'],
      ['id', 'type', 'company_id', 'payload', 'created_at'],
    ]);
    const [, f] = entries[1];
    expect(f).toEqual(expect.arrayContaining(['id', second, 'type', 'pipeline.run_completed', 'company_id', '']));
    expect(JSON.parse(f[7])).toEqual({ actor_type: 'pipeline', run_id: 3 });
    expect(await streamIds()).toEqual([first, second]);
    expect(await unpublished()).toBe(0);
    expect(await publishBatch(db, redis, opts)).toBe(0);
  });

  it('publishes every row exactly once with several relays draining concurrently while writers insert', async () => {
    const clients = Array.from({ length: 4 }, () => createPrismaClient(dbUrl));
    try {
      for (let i = 0; i < 300; i++) await outbox(db, 'lead.updated', null, { n: i });
      const relays = clients.map((c) => new OutboxPublisher(c, redis, { ...opts, batchSize: 7, pollIntervalMs: 5 }, silent));
      relays.forEach((r) => r.start());
      for (let i = 300; i < 400; i++) await outbox(db, 'lead.updated', null, { n: i });
      await until(async () => (await unpublished()) === 0 && (await redis.xlen('events')) >= 400, 15_000);
      await Promise.all(relays.map((r) => r.stop()));
      const ids = await streamIds();
      expect(ids).toHaveLength(400);
      expect(new Set(ids).size).toBe(400);
      expect(relays.filter((r) => r.stats.published > 0).length).toBeGreaterThan(1);
      expect(relays.reduce((n, r) => n + r.stats.published, 0)).toBe(400);
    } finally {
      await Promise.all(clients.map((c) => c.$disconnect()));
    }
  });

  it('leaves rows unpublished when Redis fails, and publishes them once it is back', async () => {
    await outbox(db, 'lead.updated', null);
    await outbox(db, 'lead.updated', null);
    const broken = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    broken.on('error', () => {});
    await expect(publishBatch(db, broken, opts)).rejects.toThrow();
    broken.disconnect();
    expect(await unpublished()).toBe(2);
    expect(await redis.exists('events')).toBe(0);
    expect(await publishBatch(db, redis, opts)).toBe(2);
    expect(await streamIds()).toHaveLength(2);
  });

  it('a row that was rolled back is never published; a row committed late still is', async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO outbox_events (event_type, payload) VALUES ('lead.updated', '{"actor_type":"user"}')`;
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const late = db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO outbox_events (event_type, payload) VALUES ('note.added', '{"actor_type":"user"}')`;
      await held;
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    const after = await outbox(db, 'lead.updated', null);
    expect(await publishBatch(db, redis, opts)).toBe(1);
    expect(await streamIds()).toEqual([after]);
    release();
    await late;
    expect(await publishBatch(db, redis, opts)).toBe(1);
    expect(await streamIds()).toHaveLength(2);
  });

  it('wakes on NOTIFY instead of waiting for the poll', async () => {
    const publisher = new OutboxPublisher(db, redis, { ...opts, pollIntervalMs: 60_000 }, silent);
    publisher.start();
    await until(async () => publisher.stats.lastSuccessAt !== null);
    const listener = listenForOutbox(dbUrl!, () => publisher.wake(), silent);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const id = await outbox(db, 'lead.updated', null);
      await until(async () => (await streamIds()).includes(id), 3000);
    } finally {
      await listener.close();
      await publisher.stop();
    }
  });
});
