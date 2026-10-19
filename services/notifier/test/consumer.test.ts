import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationConsumer, type Processor } from '../src/consumer.ts';
import { processEvents } from '../src/engine.ts';
import { parseEntry } from '../src/stream.ts';
import { company, event, fields, hasInfra, notifications, openDb, openRedis, resetDb, seed, silent, wait } from './helpers.ts';

const STREAM = 'events-notifier-test';
const opts = { stream: STREAM, group: 'notifier', consumer: 'c1', claimIdleMs: 60_000, maxAttempts: 2, blockMs: 100 };

describe('stream entries', () => {
  it('parse relay fields and reject entries without an outbox id or with a bad payload', () => {
    const e = parseEntry('1-0', ['id', '42', 'type', 'lead.allocated', 'company_id', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'payload', '{"actor_type":"user"}']);
    expect(e).toEqual({
      streamId: '1-0', outboxId: '42', type: 'lead.allocated', companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: { actor_type: 'user' },
    });
    expect(parseEntry('1-0', ['type', 'lead.allocated', 'payload', '{}'])).toBeNull();
    expect(parseEntry('1-0', ['id', '1', 'type', 'lead.allocated', 'payload', 'nope'])).toBeNull();
    expect(parseEntry('1-0', ['id', '1', 'payload', '{}'])).toBeNull();
  });
});

describe.skipIf(!hasInfra)('notifier consumer group (Postgres + Redis)', () => {
  let db: PrismaClient;
  let redis: Redis;
  let blocking: Redis;
  let consumer: NotificationConsumer;
  let u: Awaited<ReturnType<typeof seed>>;
  const healthy = async () => true;

  beforeAll(async () => {
    db = await openDb();
    redis = openRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
    await resetDb(db);
    u = await seed(db);
    blocking = openRedis();
  });
  afterEach(async () => {
    await consumer?.stop();
  });
  afterAll(async () => {
    redis?.disconnect();
    await db?.$disconnect();
  });

  const pending = async () => ((await redis.xpending(STREAM, 'notifier')) as [number])[0];

  it('notifies from stream entries, acks them, and ignores a republished outbox row', async () => {
    consumer = new NotificationConsumer(blocking, (events) => processEvents(db, events), healthy, opts, silent);
    await consumer.ensureGroup();
    const lead = await company(db, 'A', u.rep1.id);
    const e = await event(db, 'lead.allocated', lead.id, { assigned_rep_id: u.rep1.id, previous_rep_id: null, actor_id: u.manager.id });
    await redis.xadd(STREAM, '*', ...fields(e));
    await redis.xadd(STREAM, '*', ...fields(e));
    await redis.xadd(STREAM, '*', 'type', 'garbage');
    expect(await consumer.readOnce('>')).toHaveLength(3);
    expect(await pending()).toBe(0);
    const [n] = await notifications(db, u.rep1.id);
    expect(n.count).toBe(1);
    expect(consumer.stats).toMatchObject({ processed: 3, notified: 1 });
  });

  it('recreates its group when the stream disappears', async () => {
    consumer = new NotificationConsumer(blocking, (events) => processEvents(db, events), healthy, opts, silent);
    await consumer.ensureGroup();
    await redis.del(STREAM);
    consumer.start();
    for (let i = 0; i < 50 && !(await redis.exists(STREAM)); i++) await wait(50);
    const lead = await company(db, 'A', u.rep1.id);
    const e = await event(db, 'lead.allocated', lead.id, { assigned_rep_id: u.rep1.id, previous_rep_id: null, actor_id: u.manager.id });
    await redis.xadd(STREAM, '*', ...fields(e));
    for (let i = 0; i < 50 && !(await notifications(db)).length; i++) await wait(50);
    expect(await notifications(db, u.rep1.id)).toHaveLength(1);
  });

  it('retries a failing entry alone, keeps it pending, and drops it after maxAttempts; outages never drop', async () => {
    const lead = await company(db, 'A', u.rep1.id);
    const bad = await event(db, 'lead.allocated', lead.id, { assigned_rep_id: u.rep1.id, actor_id: u.manager.id });
    const good = await event(db, 'lead.allocated', lead.id, { assigned_rep_id: u.rep1.id, actor_id: u.manager.id, version: 9 });
    let up = true;
    const process: Processor = async (events) => {
      if (events.some((x) => x.outboxId === bad.outboxId)) throw new Error('bad event');
      return processEvents(db, events);
    };
    consumer = new NotificationConsumer(blocking, process, async () => up, opts, silent);
    await consumer.ensureGroup();
    const badId = await redis.xadd(STREAM, '*', ...fields(bad));
    await redis.xadd(STREAM, '*', ...fields(good));
    await consumer.readOnce('>');
    expect(await pending()).toBe(1);
    expect(await notifications(db, u.rep1.id)).toHaveLength(1);

    up = false;
    await expect(consumer.handle([[badId!, fields(bad)]])).rejects.toThrow('bad event');
    expect(await pending()).toBe(1);
    up = true;
    await consumer.handle([[badId!, fields(bad)]]);
    expect(await pending()).toBe(0);
    expect(consumer.stats.dropped).toBe(1);
  });

  it('does not count failures toward the drop when the database goes down during the entry-by-entry retry', async () => {
    const lead = await company(db, 'A', u.rep1.id);
    const e = await event(db, 'lead.allocated', lead.id, { assigned_rep_id: u.rep1.id, actor_id: u.manager.id });
    const answers = [true, false, true, false];
    consumer = new NotificationConsumer(blocking, async () => { throw new Error('connection lost'); }, async () => answers.shift() ?? false, opts, silent);
    await consumer.ensureGroup();
    const id = await redis.xadd(STREAM, '*', ...fields(e));
    await expect(consumer.readOnce('>')).rejects.toThrow('connection lost');
    await expect(consumer.handle([[id!, fields(e)]])).rejects.toThrow('connection lost');
    expect(await pending()).toBe(1);
    expect(consumer.stats.dropped).toBe(0);
  });
});
