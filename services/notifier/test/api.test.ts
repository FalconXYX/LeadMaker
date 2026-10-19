import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '@leadmaker/shared';
import { createApp } from '../src/app.ts';
import { company, hasInfra, notifications, openDb, openRedis, resetDb, seed, silent, TOKEN } from './helpers.ts';

describe.skipIf(!hasInfra)('notifications API (Postgres)', () => {
  let db: PrismaClient;
  let redis: Redis;
  let app: ReturnType<typeof createApp>;
  let u: Awaited<ReturnType<typeof seed>>;

  const as = (user: { id: string; role: string }) => ({ 'x-internal-token': TOKEN, 'x-user-id': user.id, 'x-user-role': user.role });
  const insert = (userId: string, title: string, minutesAgo: number, read = false) => db.$queryRaw<{ id: string }[]>`
    INSERT INTO notifications (user_id, type, title, dedupe_key, created_at, updated_at, read_at)
    VALUES (${userId}::uuid, 'allocated', ${title}, ${`k:${title}`}, NOW() - make_interval(mins => ${minutesAgo}),
            NOW() - make_interval(mins => ${minutesAgo}), ${read ? new Date() : null})
    RETURNING id::text`.then(([r]) => r.id);

  beforeAll(async () => {
    db = await openDb();
    redis = openRedis();
    app = createApp({ db, redis, internalToken: TOKEN, log: silent });
  });
  beforeEach(async () => {
    await resetDb(db);
    u = await seed(db);
  });
  afterAll(async () => {
    redis?.disconnect();
    await db?.$disconnect();
  });

  it('requires the internal token and a valid identity', async () => {
    await request(app).get('/api/notifications').expect(401);
    await request(app).get('/api/notifications').set({ ...as(u.rep1), 'x-internal-token': 'forged' }).expect(401);
    await request(app).get('/api/notifications').set({ ...as(u.rep1), 'x-user-id': 'nope' }).expect(401);
    await request(app).get('/healthz').expect(200);
    await request(app).get('/readyz').expect(200);
  });

  it("lists only the caller's notifications, newest activity first, with a cursor and the unread count", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await insert(u.rep1.id, `n${i}`, 10 - i, i === 0));
    await insert(u.rep2.id, 'theirs', 0);
    const first = await request(app).get('/api/notifications?limit=2').set(as(u.rep1)).expect(200);
    expect(first.body.items.map((i: { title: string }) => i.title)).toEqual(['n4', 'n3']);
    expect(first.body.unreadCount).toBe(4);
    expect(first.body.items[0]).toMatchObject({ id: ids[4], type: 'allocated', count: 1, readAt: null, companyId: null, data: {} });
    const second = await request(app).get(`/api/notifications?limit=2&before=${first.body.nextCursor}`).set(as(u.rep1)).expect(200);
    expect(second.body.items.map((i: { title: string }) => i.title)).toEqual(['n2', 'n1']);
    const last = await request(app).get(`/notifications?limit=2&before=${second.body.nextCursor}`).set(as(u.rep1)).expect(200);
    expect(last.body.items.map((i: { title: string }) => i.title)).toEqual(['n0']);
    expect(last.body.nextCursor).toBeNull();
    const unread = await request(app).get('/api/notifications?unread=1').set(as(u.rep1)).expect(200);
    expect(unread.body.items).toHaveLength(4);
    await request(app).get('/api/notifications?before=garbage').set(as(u.rep1)).expect(400);
    await request(app).get('/api/notifications?limit=0').set(as(u.rep1)).expect(400);
  });

  it('no longer links leads that moved to another rep since the notification was written', async () => {
    const [mine, pool, moved] = await Promise.all([company(db, 'Mine', u.rep1.id), company(db, 'Pool'), company(db, 'Moved', u.rep2.id)]);
    const data = JSON.stringify({ company_ids: [mine.id, moved.id, pool.id], latest: 'Pool' });
    await db.$executeRaw`
      INSERT INTO notifications (user_id, type, title, dedupe_key, company_id, data)
      VALUES (${u.rep1.id}::uuid, 'allocated', 'bulk', 'allocated', ${moved.id}::uuid, ${data}::jsonb),
             (${u.rep1.id}::uuid, 'reassigned_away', 'away', 'reassigned_away', ${pool.id}::uuid, '{}'),
             (${u.manager.id}::uuid, 'allocated', 'm', 'allocated', ${moved.id}::uuid, ${data}::jsonb)`;
    const res = await request(app).get('/api/notifications').set(as(u.rep1)).expect(200);
    const byTitle = Object.fromEntries(res.body.items.map((i: { title: string }) => [i.title, i]));
    expect(byTitle.bulk).toMatchObject({ companyId: null, data: { company_ids: [mine.id, pool.id], latest: 'Pool' } });
    expect(byTitle.away.companyId).toBe(pool.id);
    const manager = await request(app).get('/api/notifications').set(as(u.manager)).expect(200);
    expect(manager.body.items[0]).toMatchObject({ companyId: moved.id, data: { company_ids: [mine.id, moved.id, pool.id] } });
  });

  it('marks own notifications read by id or all at once, ignoring anyone else\'s ids', async () => {
    const [a, b, c] = [await insert(u.rep1.id, 'a', 3), await insert(u.rep1.id, 'b', 2), await insert(u.rep1.id, 'c', 1)];
    const theirs = await insert(u.rep2.id, 'theirs', 1);
    const res = await request(app).post('/api/notifications/read').set(as(u.rep1)).send({ ids: [a, theirs] }).expect(200);
    expect(res.body).toEqual({ updated: 1, unreadCount: 2 });
    expect((await notifications(db, u.rep2.id))[0].read_at).toBeNull();
    const all = await request(app).post('/api/notifications/read').set(as(u.rep1)).send({ all: true }).expect(200);
    expect(all.body).toEqual({ updated: 2, unreadCount: 0 });
    expect((await notifications(db, u.rep1.id)).every((n) => n.read_at)).toBe(true);
    expect([b, c]).toHaveLength(2);
    await request(app).post('/api/notifications/read').set(as(u.rep1)).send({}).expect(400);
    await request(app).post('/api/notifications/read').set(as(u.rep1)).send({ ids: ['x'] }).expect(400);
    await request(app).post('/api/notifications/read').set(as(u.rep1)).send({ all: true, ids: [a] }).expect(400);
  });

  it('reads and writes per-user preferences, enabled by default', async () => {
    const res = await request(app).get('/api/notifications/preferences').set(as(u.rep1)).expect(200);
    expect(res.body.items).toContainEqual({ type: 'allocated', enabled: true });
    expect(res.body.items.map((i: { type: string }) => i.type)).toEqual([...NOTIFICATION_TYPES]);
    expect(NOTIFICATION_TYPES).toContain('refresh_failed');
    expect(res.body.items.every((i: { enabled: boolean }) => i.enabled)).toBe(true);
    const put = await request(app).put('/api/notifications/preferences').set(as(u.rep1))
      .send({ items: [{ type: 'storm_alert', enabled: false }, { type: 'allocated', enabled: false }] }).expect(200);
    expect(put.body.items.filter((i: { enabled: boolean }) => !i.enabled).map((i: { type: string }) => i.type).sort()).toEqual(['allocated', 'storm_alert']);
    await request(app).put('/api/notifications/preferences').set(as(u.rep1)).send({ items: [{ type: 'allocated', enabled: true }] }).expect(200);
    const after = await request(app).get('/api/notifications/preferences').set(as(u.rep1)).expect(200);
    expect(after.body.items.filter((i: { enabled: boolean }) => !i.enabled)).toEqual([{ type: 'storm_alert', enabled: false }]);
    const other = await request(app).get('/api/notifications/preferences').set(as(u.rep2)).expect(200);
    expect(other.body.items.every((i: { enabled: boolean }) => i.enabled)).toBe(true);
    await request(app).put('/api/notifications/preferences').set(as(u.rep1)).send({ items: [{ type: 'nope', enabled: false }] }).expect(400);
    await request(app).put('/api/notifications/preferences').set(as(u.rep1))
      .send({ items: [{ type: 'allocated', enabled: false }, { type: 'allocated', enabled: true }] }).expect(400);
  });
});
