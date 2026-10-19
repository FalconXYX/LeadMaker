import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness, url, type Fixture, type User } from './harness.ts';

const h = new Harness();

describe.skipIf(!url)('saved views and preferences', () => {
  let f: Fixture;
  let manager2: User;

  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(async () => {
    f = await h.reset();
    manager2 = await h.one<User>(`INSERT INTO users (name, email, role) VALUES ('Casey Boss', 'casey@test', 'manager') RETURNING id, role, name`);
  });

  const filter = { scope: 'mine', segment: ['growth'], minPriority: 70, counties: ['36061'] };

  describe('views', () => {
    it('creates a view from a validated LeadFilter, splitting off its sort and dropping the cursor', async () => {
      const res = await h.as(f.rep1).post('/api/views', {
        name: ' Hot growth ', filter: { ...filter, cursor: 'abc', limit: 25, sort: { by: 'rating', dir: 'desc' } },
      });
      expect(res.status).toBe(201);
      expect(res.body.view).toMatchObject({
        name: 'Hot growth', filter: { ...filter, limit: 25 }, sort: { by: 'rating', dir: 'desc' }, isShared: false,
        owner: { id: f.rep1.id, name: 'Jordan Rep' }, mine: true, canEdit: true,
      });
      expect(Object.keys(res.body.view.filter)).not.toContain('cursor');
      expect(Date.parse(res.body.view.createdAt)).not.toBeNaN();
      const row = await h.one<{ filter: unknown; sort: unknown }>('SELECT filter, sort FROM saved_views WHERE id = $1::uuid', res.body.view.id);
      expect(row).toEqual({ filter: { ...filter, limit: 25 }, sort: { by: 'rating', dir: 'desc' } });
      // An explicit sort wins over filter.sort; null means the default order.
      const explicit = await h.as(f.rep1).post('/api/views', { name: 'B', filter: { sort: { by: 'rating', dir: 'asc' } }, sort: null });
      expect(explicit.body.view.sort).toBeNull();
      if (h.redis) expect(await h.redis.exists(`rw:${f.rep1.id}`)).toBe(1);
      expect((await h.counts()).outbox).toBe(0);
    });

    it.each([
      [{ name: 'x', filter: { scope: 'everything' } }],
      [{ name: 'x', filter: { minPriority: 101 } }],
      [{ name: 'x', filter: { counties: ['NY'] } }],
      [{ name: 'x', filter: {}, sort: { by: 'distance', dir: 'asc' } }],
      [{ name: 'x', filter: { sort: { by: 'distance', dir: 'asc' } } }],
      [{ name: 'x', filter: {}, sort: { by: 'nope', dir: 'asc' } }],
      [{ name: '', filter: {} }],
      [{ name: 'x'.repeat(101), filter: {} }],
      [{ name: 'x' }],
      [{ name: 'x', filter: {}, extra: 1 }],
    ])('rejects %j', async (body) => {
      expect((await h.as(f.rep1).post('/api/views', body)).status).toBe(400);
      expect(await h.all('SELECT 1 FROM saved_views')).toEqual([]);
    });

    it('keeps names unique per owner (409), lets only managers share, and caps views per user', async () => {
      expect((await h.as(f.rep1).post('/api/views', { name: 'Mine', filter: {} })).status).toBe(201);
      const clash = await h.as(f.rep1).post('/api/views', { name: 'Mine', filter: { segment: ['growth'] } });
      expect([clash.status, clash.body]).toEqual([409, { error: 'name_taken', details: { name: 'Mine' } }]);
      expect((await h.as(f.rep2).post('/api/views', { name: 'Mine', filter: {} })).status).toBe(201);
      expect((await h.as(f.rep1).post('/api/views', { name: 'Team', filter: {}, isShared: true })).status).toBe(403);
      expect((await h.as(f.manager).post('/api/views', { name: 'Team', filter: {}, isShared: true })).body.view.isShared).toBe(true);
      await h.db.$executeRawUnsafe(`INSERT INTO saved_views (user_id, name) SELECT $1::uuid, 'v' || i FROM generate_series(1, 199) i`, f.rep1.id);
      const full = await h.as(f.rep1).post('/api/views', { name: 'One more', filter: {} });
      expect([full.status, full.body]).toEqual([400, { error: 'too_many_views', details: { max: 200 } }]);
    });

    it("lets owners change and delete their views and managers the team's shared ones", async () => {
      const own = (await h.as(f.rep1).post('/api/views', { name: 'Own', filter })).body.view;
      const priv = (await h.as(f.rep2).post('/api/views', { name: 'Private', filter: {} })).body.view;
      const team = (await h.as(f.manager).post('/api/views', { name: 'Team', filter: {}, isShared: true })).body.view;

      const changed = await h.as(f.rep1).patch(`/api/views/${own.id}`, { name: 'Own 2', sort: { by: 'last_change', dir: 'desc' } });
      expect(changed.status).toBe(200);
      expect(changed.body.view).toMatchObject({ name: 'Own 2', filter, sort: { by: 'last_change', dir: 'desc' } });
      // A new filter keeps the stored sort unless it brings its own; distance needs near in the result.
      const refiltered = await h.as(f.rep1).patch(`/api/views/${own.id}`, { filter: { segment: ['emerging'] } });
      expect(refiltered.body.view).toMatchObject({ filter: { segment: ['emerging'] }, sort: { by: 'last_change', dir: 'desc' } });
      expect((await h.as(f.rep1).patch(`/api/views/${own.id}`, { sort: { by: 'distance', dir: 'asc' } })).status).toBe(400);
      expect((await h.as(f.rep1).patch(`/api/views/${own.id}`, {})).status).toBe(400);
      expect((await h.as(f.rep1).patch(`/api/views/${own.id}`, { isShared: true })).status).toBe(403);

      expect((await h.as(f.rep1).patch(`/api/views/${priv.id}`, { name: 'Taken' })).status).toBe(404);
      expect((await h.as(f.manager).patch(`/api/views/${priv.id}`, { name: 'Taken' })).status).toBe(404);
      expect((await h.as(f.rep1).delete(`/api/views/${priv.id}`)).status).toBe(404);
      expect((await h.as(f.rep1).patch(`/api/views/${team.id}`, { name: 'Hijack' })).status).toBe(403);
      expect((await h.as(f.rep1).delete(`/api/views/${team.id}`)).status).toBe(403);

      const byOtherManager = await h.as(manager2).patch(`/api/views/${team.id}`, { name: 'Team (edited)' });
      expect(byOtherManager.body.view).toMatchObject({ name: 'Team (edited)', owner: { id: f.manager.id }, mine: false, canEdit: true });
      await h.as(f.rep1).post('/api/views', { name: 'Other', filter: {} });
      expect((await h.as(f.rep1).patch(`/api/views/${own.id}`, { name: 'Other' })).status).toBe(409);
      expect((await h.as(f.rep1).patch('/api/views/nope', { name: 'x' })).status).toBe(400);

      expect((await h.as(f.rep1).delete(`/api/views/${own.id}`)).body).toEqual({ deleted: true, id: own.id });
      expect((await h.as(f.rep1).delete(`/api/views/${own.id}`)).status).toBe(404);
      expect((await h.as(manager2).delete(`/api/views/${team.id}`)).status).toBe(200);
      expect((await h.all<{ name: string }>('SELECT name FROM saved_views ORDER BY name')).map((r) => r.name)).toEqual(['Other', 'Private']);
    });
  });

  describe('preferences', () => {
    const put = (u: User, body: object) => h.as(u).put('/api/preferences', body);

    it('saves the document with optimistic locking: version 0 creates it, a stale version is 409 with the current one', async () => {
      const first = await put(f.rep1, { prefs: { density: 'compact', hiddenColumns: ['gaf'] }, version: 0 });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ prefs: { density: 'compact', hiddenColumns: ['gaf'] }, version: 1 });
      const second = await put(f.rep1, { prefs: { density: 'comfortable' }, version: 1 });
      expect(second.body).toMatchObject({ prefs: { density: 'comfortable' }, version: 2 });

      for (const stale of [0, 1, 7]) {
        const res = await put(f.rep1, { prefs: { density: 'compact' }, version: stale });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          error: 'version_conflict', current: { version: 2, prefs: { density: 'comfortable' } },
          changedBy: { id: f.rep1.id, name: 'Jordan Rep' }, changedAt: second.body.updatedAt,
        });
      }
      const none = await put(f.rep2, { prefs: {}, version: 3 });
      expect([none.status, none.body.current, none.body.changedBy]).toEqual([409, { version: 0, prefs: {} }, null]);
      expect((await h.counts()).outbox).toBe(0);
    });

    it('lets one of two concurrent saves of the same version win', async () => {
      const results = await Promise.all([1, 2, 3, 4].map((i) => put(f.rep1, { prefs: { i }, version: 0 })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(await h.one('SELECT version FROM user_preferences WHERE user_id = $1::uuid', f.rep1.id)).toEqual({ version: 1 });
    });

    it.each([
      [{ prefs: [], version: 0 }], [{ prefs: 'x', version: 0 }], [{ prefs: {}, version: -1 }], [{ prefs: {}, version: 1.5 }],
      [{ prefs: {} }], [{ prefs: { big: 'x'.repeat(70_000) }, version: 0 }], [{ prefs: {}, version: 0, extra: true }],
    ])('rejects %j', async (body) => {
      expect((await put(f.rep1, body)).status).toBe(400);
    });
  });
});
