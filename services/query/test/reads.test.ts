import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActivityEntry, ActivityPage, CustomFieldKeysResponse, CustomTagsResponse, LeadMapResponse, LeadProfile, LeadSummary,
  SavedViewsResponse, SignalsResponse,
} from '@leadmaker/shared';
import { pino } from 'pino';
import { createApp } from '../src/app.ts';
import { Cache } from '../src/cache.ts';
import { valueType } from '../src/catalog.ts';
import { Limiter } from '../src/limiter.ts';
import { as, clearCache, harness, seed, TEST_DATABASE_URL, TOKEN, type Fixture, type Harness } from './helpers.ts';

describe('custom field value types', () => {
  it('names one type, treats dates among strings as strings, and calls anything else mixed', () => {
    expect(valueType(['number'])).toBe('number');
    expect(valueType(['date'])).toBe('date');
    expect(valueType(['date', 'string'])).toBe('string');
    expect(valueType(['number', 'string'])).toBe('mixed');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('dashboard and filter reads', () => {
  let h: Harness;
  let f: Fixture;
  const sig: Record<string, string> = {};

  const get = (path: string, user: string, role: 'rep' | 'manager' = 'rep') => request(h.app).get(path).set(as(user, role));
  const rep1 = (path: string) => get(path, f.users.rep1);
  const manager = (path: string) => get(path, f.users.manager, 'manager');

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    const signal = async (name: string, county: string, kind: string, payload: object, from: string | null, to: string | null) => {
      sig[name] = (await h.query<{ id: string }>(`INSERT INTO regional_signals (county_fips, kind, source, external_id, payload, valid_from, valid_to)
        VALUES ($1, $2, 'test', $3, $4::jsonb, now() + $5::interval, now() + $6::interval) RETURNING id`,
        county, kind, name, JSON.stringify(payload), from, to))[0].id;
    };
    // rep1 works 36061 (acme) and 36047 (brooklyn); 34003 and 36085 are rep2's only; 34017 is pool only.
    await signal('manhattan_warning', '36061', 'active_alert', { event: 'Severe Thunderstorm Warning' }, '-1 hour', '2 hours');
    await signal('manhattan_ended', '36061', 'active_alert', { event: 'Wind Advisory' }, '-3 days', '-2 days');
    await signal('manhattan_old', '36061', 'active_alert', { event: 'High Wind Warning' }, '-20 days', '-19 days');
    await signal('bergen_tornado', '34003', 'active_alert', { event: 'Tornado Warning' }, '-30 minutes', '1 hour');
    await signal('brooklyn_storms', '36047', 'storm_history', { events_12m: 4, last_event_at: '2026-09-30' }, '-2 years', '0 seconds');
    await signal('staten_storms', '36085', 'storm_history', { events_12m: 9, last_event_at: '2026-10-01' }, '-2 years', '0 seconds');
    await signal('manhattan_news', '36061', 'news', { title: 'Roofers busy after storm' }, '-2 days', '12 days');
    await signal('manhattan_stale_news', '36061', 'news', { title: 'Older story' }, '-20 days', '-6 days');
    await signal('manhattan_ancient_news', '36061', 'news', { title: 'Ancient story' }, '-40 days', '-26 days');
    await signal('hudson_news', '34017', 'news', { title: 'Jersey City permits' }, '-1 day', '13 days');
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  describe('GET /signals', () => {
    const names = (items: { id: string }[]) => items.map((s) => Object.keys(sig).find((k) => sig[k] === s.id));

    it("gives a rep their own leads' counties by default, newest first, with active/expired flags", async () => {
      const res = await rep1('/signals');
      expect(res.status).toBe(200);
      const body = res.body as SignalsResponse;
      expect(body.scope).toBe('mine');
      expect(body.counties).toEqual([
        { countyFips: '36047', leadCount: 1, name: 'Kings County, NY' }, { countyFips: '36061', leadCount: 1, name: 'New York County, NY' },
      ]);
      expect(names(body.alerts)).toEqual(['manhattan_warning', 'manhattan_ended']);
      expect(body.alerts.map((a) => [a.active, a.expired])).toEqual([[true, false], [false, true]]);
      expect(body.alerts[0]).toMatchObject({ countyFips: '36061', kind: 'active_alert', payload: { event: 'Severe Thunderstorm Warning' } });
      expect(names(body.stormHistory)).toEqual(['brooklyn_storms']);
      expect(body.stormHistory[0]).toMatchObject({ active: true, expired: false, payload: { events_12m: 4 } });
      expect(names(body.news)).toEqual(['manhattan_news', 'manhattan_stale_news']);
      expect(body.news.map((n) => n.expired)).toEqual([false, true]);
    });

    it('shows a rep the pool on ?scope=pool and both on ?scope=all, never another rep\'s counties', async () => {
      const pool = (await rep1('/signals?scope=pool')).body as SignalsResponse;
      expect(pool.counties.map((c) => c.countyFips)).toEqual(['12086', '34017', '36001', '36047', '36061', '36081', '36103']);
      // Names ship for the Northeast only (as the ZIP centroids).
      expect(pool.counties.map((c) => c.name).slice(0, 3)).toEqual([null, 'Hudson County, NJ', 'Albany County, NY']);
      expect(names(pool.news)).toEqual(['hudson_news', 'manhattan_news', 'manhattan_stale_news']);
      const all = (await rep1('/signals?scope=all')).body as SignalsResponse;
      for (const body of [pool, all]) {
        expect(body.counties.map((c) => c.countyFips)).not.toContain('34003');
        expect(names(body.alerts)).not.toContain('bergen_tornado');
        expect(names(body.stormHistory)).not.toContain('staten_storms');
      }
      expect(all.counties.find((c) => c.countyFips === '36061')).toEqual({ countyFips: '36061', leadCount: 2, name: 'New York County, NY' });
    });

    it('shows a manager every county', async () => {
      const body = (await manager('/signals')).body as SignalsResponse;
      expect(body.scope).toBe('all');
      expect(names(body.alerts)).toEqual(['bergen_tornado', 'manhattan_warning', 'manhattan_ended']);
      expect(names(body.stormHistory)).toEqual(['staten_storms', 'brooklyn_storms']);
    });

    it('caches briefly, per user except for the pool and managers, and rejects unknown scopes', async () => {
      expect((await rep1('/signals')).headers['x-cache']).toBe('miss');
      expect((await rep1('/signals')).headers['x-cache']).toBe('hit');
      const ttl = await h.redis.ttl(`signals:${f.users.rep1}:mine`);
      expect(ttl > 0 && ttl <= 60).toBe(true);
      const rep2 = (await get('/signals', f.users.rep2)).body as SignalsResponse;
      expect(names(rep2.alerts)).toEqual(['bergen_tornado']);
      await rep1('/signals?scope=pool');
      expect((await get('/signals?scope=pool', f.users.rep2)).headers['x-cache']).toBe('hit');
      await manager('/signals');
      const repAll = await rep1('/signals?scope=all');
      expect(repAll.headers['x-cache']).toBe('miss');
      expect((repAll.body as SignalsResponse).counties.map((c) => c.countyFips)).not.toContain('34003');
      expect((await rep1('/signals?scope=everything')).status).toBe(400);
    });
  });

  describe('timing on list pages and GET /leads/map', () => {
    const post = (filter: object, user: string, role: 'rep' | 'manager' = 'rep') =>
      request(h.app).post('/leads/search').set(as(user, role)).send({ filter });
    const map = (query: string, user: string, role: 'rep' | 'manager' = 'rep') => get(`/leads/map${query}`, user, role);

    it("gives every list item the profile's timing badges (county signals read once per page)", async () => {
      const items = (await post({ limit: 200 }, f.users.rep1)).body.items as LeadSummary[];
      expect(items.length).toBeGreaterThan(10);
      for (const item of items) {
        const profile = (await rep1(`/leads/${item.id}`)).body as LeadProfile;
        expect(item.timing, item.businessName).toEqual(profile.timing);
      }
      const acme = items.find((i) => i.id === f.ids.acme)!;
      expect(acme.timing?.map((b) => b.key)).toEqual(['storm_response', 'season']);
      expect(items.find((i) => i.id === f.ids.longisland)?.timing?.map((b) => b.key)).toEqual(['season']);
    });

    it('returns one point per visible lead with its top timing level, scoped like the list', async () => {
      const res = await map('', f.users.rep1);
      expect(res.status).toBe(200);
      const body = res.body as LeadMapResponse;
      const listed = (await post({ limit: 200 }, f.users.rep1)).body as { items: LeadSummary[] };
      expect(body.items.map((p) => p.id)).toEqual(listed.items.map((i) => i.id));
      expect(body.items.find((p) => p.id === f.ids.acme)).toEqual({
        id: f.ids.acme, name: 'Acme Roofing', latitude: 40.721, longitude: -74.004, segment: 'strategic', priorityScore: 90,
        assignedRepId: f.users.rep1, countyFips: '36061', timing: 'medium',
      });
      expect(body.items.find((p) => p.id === f.ids.longisland)?.timing).toBe('info');
      expect(body.items.find((p) => p.id === f.ids.miami)?.timing).toBeNull();

      expect(((await map('?scope=mine', f.users.rep1)).body as LeadMapResponse).items.map((p) => p.id).sort())
        .toEqual([f.ids.acme, f.ids.brooklyn].sort());
      expect((await map(`?scope=rep:${f.users.rep1}`, f.users.rep1)).status).toBe(200);
      expect((await map('?scope=all', f.users.rep1)).status).toBe(403);
      expect((await map(`?scope=rep:${f.users.rep2}`, f.users.rep1)).status).toBe(403);
      expect((await map('?scope=everything', f.users.rep1)).status).toBe(400);
      const rep2Leads = (await map(`?scope=rep:${f.users.rep2.toUpperCase()}`, f.users.manager, 'manager')).body as LeadMapResponse;
      expect(rep2Leads.items.map((p) => p.id).sort()).toEqual([f.ids.hackensack, f.ids.staten].sort());
      const all = (await map('?scope=all', f.users.manager, 'manager')).body as LeadMapResponse;
      expect(all.items).toHaveLength(Object.keys(f.ids).length);
    });

    it('caches points under the list versions, shared by managers, and shows a name override', async () => {
      expect((await map('?scope=unallocated', f.users.manager, 'manager')).headers['x-cache']).toBe('miss');
      expect((await map('?scope=unallocated', f.users.manager, 'manager')).headers['x-cache']).toBe('hit');
      expect(await h.redis.keys('leads:map:mgr:*')).toHaveLength(1);
      expect((await map('', f.users.rep1)).headers['x-cache']).toBe('miss');
      expect((await map('', f.users.rep2)).headers['x-cache']).toBe('miss');
      await h.exec(`INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id)
        VALUES ($1::uuid, 'business_name', '"Zenith Roofing"', '"SoHo Slate"', $2::uuid)`, f.ids.soho, f.users.manager);
      try {
        expect((await map('', f.users.rep1)).headers['x-cache']).toBe('hit');
        await h.redis.incr('leads:v:pool');
        const fresh = await map('', f.users.rep1);
        expect(fresh.headers['x-cache']).toBe('miss');
        expect((fresh.body as LeadMapResponse).items.find((p) => p.id === f.ids.soho)?.name).toBe('Zenith Roofing');
        await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
        expect((await map('', f.users.rep1)).headers['x-cache']).toBe('bypass');
      } finally {
        await h.exec('DELETE FROM field_overrides');
      }
    });
  });

  describe('GET /custom-tags and /custom-fields/keys', () => {
    beforeAll(async () => {
      const tag = async (name: string, ...leads: string[]) => {
        const [{ id }] = await h.query<{ id: string }>(`INSERT INTO custom_tags (name, created_by) VALUES ($1, $2::uuid) RETURNING id`, name, f.users.rep1);
        for (const lead of leads) {
          await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
            f.ids[lead], id, f.users.manager);
        }
      };
      await tag('Hot Lead', 'acme', 'hackensack', 'jersey');
      await tag('Rep2 Only', 'hackensack');
      await tag('unused');
      const custom = (lead: string, value: object) =>
        h.exec(`UPDATE companies SET custom_fields = $2::jsonb WHERE id = $1::uuid`, f.ids[lead], JSON.stringify(value));
      await custom('hackensack', { secret_key: 'x', budget: 'high' });
      await custom('jersey', { next_visit: 'after the holidays' });
      await custom('queens', { gone: null });
    });

    it('lists every custom tag with counts over the leads the caller may see', async () => {
      const counts = (body: CustomTagsResponse) => body.items.map((t) => [t.name, t.leadCount]);
      const mine = (await rep1('/custom-tags')).body as CustomTagsResponse;
      expect(counts(mine)).toEqual([['Hot Lead', 2], ['Rep2 Only', 0], ['unused', 0]]);
      expect(mine.items[0]).toMatchObject({ createdBy: { id: f.users.rep1, name: 'Riley Rep' } });
      expect(counts((await manager('/custom-tags')).body)).toEqual([['Hot Lead', 3], ['Rep2 Only', 1], ['unused', 0]]);
    });

    it('lists custom field keys over visible leads with counts and inferred types', async () => {
      const mine = (await rep1('/custom-fields/keys')).body as CustomFieldKeysResponse;
      expect(mine.items).toEqual([
        { key: 'budget', leadCount: 2, valueType: 'number' },
        { key: 'next_visit', leadCount: 2, valueType: 'string' },
        { key: 'brands', leadCount: 1, valueType: 'array' },
        { key: 'po_number', leadCount: 1, valueType: 'string' },
      ]);
      const all = (await manager('/custom-fields/keys')).body as CustomFieldKeysResponse;
      expect(all.items.find((k) => k.key === 'budget')).toEqual({ key: 'budget', leadCount: 3, valueType: 'mixed' });
      expect(all.items.map((k) => k.key)).toContain('secret_key');
      expect(all.items.map((k) => k.key)).not.toContain('gone');
    });
  });

  describe('profile freshness and the activity timeline', () => {
    it('reflects an enrichment-only change (no version bump) on a cached profile', async () => {
      const soho = f.ids.soho;
      const first = await rep1(`/leads/${soho}`);
      expect(first.headers['x-cache']).toBe('miss');
      expect((first.body as LeadProfile).timing.map((b) => b.key)).toContain('weather_alert');
      await h.exec(`INSERT INTO enrichments (company_id, source, status, data) VALUES ($1::uuid, 'website_crawl', 'ok', '{"services": ["storm_damage"]}')`, soho);
      const second = await rep1(`/leads/${soho}`);
      expect([second.headers['x-cache'], second.body.version]).toEqual(['hit', first.body.version]);
      const keys = (second.body as LeadProfile).timing.map((b) => b.key);
      expect(keys).toContain('storm_response');
      expect(keys).not.toContain('weather_alert');
    });

    describe('timeline', () => {
      const lead = () => f.ids.queens;
      let expected: string[];

      beforeAll(async () => {
        const q = lead();
        // 101 user rows an hour apart, three of them sharing a timestamp, then pipeline history on top.
        await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text, created_at)
          SELECT $1::uuid, 'user', $2::uuid, CASE WHEN i % 10 = 0 THEN 'note' ELSE 'call' END, 'entry ' || i,
                 timestamptz '2026-10-01T00:00:00Z' + make_interval(hours => CASE WHEN i IN (50, 51, 52) THEN 50 ELSE i END)
          FROM generate_series(1, 101) i`, q, f.users.rep1);
        await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at) VALUES
          ($1::uuid, 'pipeline', NULL, 'scraped_change', '{"fields": ["phone"], "from": {"phone": "(212) 555-0100"}, "to": {"phone": "(212) 555-0111"}, "run_id": 7}', '2026-10-17T00:00:00Z'),
          ($1::uuid, 'pipeline', NULL, 'scraped_change', '{"delisted": true, "run_id": 8}', '2026-10-18T00:00:00Z')`, q);
        expected = (await h.query<{ id: string }>(
          `SELECT id FROM activity_logs WHERE company_id = $1::uuid ORDER BY created_at DESC, id DESC`, q)).map((r) => r.id);
      });

      it('renders pipeline rows without a user, labelled pipeline, and pages beyond the most recent 100', async () => {
        const p = (await rep1(`/leads/${lead()}`)).body as LeadProfile;
        expect(p.activity).toHaveLength(100);
        expect(p.activity[0]).toMatchObject({
          type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline', fieldDiff: { delisted: true, run_id: 8 },
        });
        expect(p.activity[1].fieldDiff).toEqual({ fields: ['phone'], from: { phone: '(212) 555-0100' }, to: { phone: '(212) 555-0111' }, run_id: 7 });
        expect(p.activity[2]).toMatchObject({ actorType: 'user', user: { id: f.users.rep1, name: 'Riley Rep' }, actorLabel: 'Riley Rep' });
        expect(p.activityNextCursor).toBe(p.activity[99].id);
        const rest = (await rep1(`/leads/${lead()}/activity?before=${p.activityNextCursor}`)).body as ActivityPage;
        expect(rest.nextCursor).toBeNull();
        expect([...p.activity, ...rest.items].map((a) => a.id)).toEqual(expected);
      });

      // The tied rows are entries 51-53 (newest first): 13 ends a page on the first of them, 53 on the middle one.
      it.each([7, 13, 53])('walks the whole timeline in pages of %i without gaps or repeats, ties included', async (limit) => {
        const seen: ActivityEntry[] = [];
        let cursor: string | null = null;
        do {
          const res = await rep1(`/leads/${lead()}/activity?limit=${limit}${cursor ? `&before=${cursor}` : ''}`);
          expect(res.status).toBe(200);
          const page = res.body as ActivityPage;
          seen.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen.map((a) => a.id)).toEqual(expected);
      });

      it('filters by type and rejects foreign or malformed cursors', async () => {
        const notes = (await rep1(`/leads/${lead()}/activity?type=note&limit=3`)).body as ActivityPage;
        expect(notes.items.map((a) => a.text)).toEqual(['entry 100', 'entry 90', 'entry 80']);
        const older = (await rep1(`/leads/${lead()}/activity?type=note&before=${notes.nextCursor}`)).body as ActivityPage;
        expect(older.items.map((a) => a.text)).toEqual(['entry 70', 'entry 60', 'entry 50', 'entry 40', 'entry 30', 'entry 20', 'entry 10']);
        const [{ id: foreign }] = await h.query<{ id: string }>(`INSERT INTO activity_logs (company_id, actor_type, action_type)
          VALUES ($1::uuid, 'system', 'allocation') RETURNING id`, f.ids.soho);
        expect((await rep1(`/leads/${lead()}/activity?before=${foreign}`)).status).toBe(400);
        expect((await rep1(`/leads/${lead()}/activity?before=nope`)).status).toBe(400);
        expect((await rep1(`/leads/${lead()}/activity?type=DROP%20TABLE`)).status).toBe(400);
      });

      it('filters by a comma-separated list of types, validating each, and pages within it', async () => {
        const all = (await h.query<{ id: string; action_type: string }>(
          `SELECT id, action_type FROM activity_logs WHERE company_id = $1::uuid ORDER BY created_at DESC, id DESC`, lead()));
        const want = (types: string[]) => all.filter((a) => types.includes(a.action_type)).map((a) => a.id);
        const walk = async (query: string, limit: number) => {
          const ids: string[] = [];
          let cursor: string | null = null;
          do {
            const res = await rep1(`/leads/${lead()}/activity?type=${query}&limit=${limit}${cursor ? `&before=${cursor}` : ''}`);
            expect(res.status).toBe(200);
            ids.push(...(res.body as ActivityPage).items.map((a) => a.id));
            cursor = (res.body as ActivityPage).nextCursor;
          } while (cursor);
          return ids;
        };
        expect(await walk('note,scraped_change', 4)).toEqual(want(['note', 'scraped_change']));
        expect(await walk('call,email,visit', 40)).toEqual(want(['call']));
        expect(await walk('note,%20note', 100)).toEqual(want(['note']));
        expect(await walk('email,visit', 10)).toEqual([]);
        for (const bad of ['note,nope', 'note,,call', '', 'NOTE', 'call;DROP', 'x'.repeat(501)]) {
          const res = await rep1(`/leads/${lead()}/activity?type=${encodeURIComponent(bad)}`);
          expect(res.status, bad).toBe(400);
        }
      });

      it("hides another rep's lead's activity", async () => {
        expect((await rep1(`/leads/${f.ids.hackensack}/activity`)).status).toBe(404);
        expect((await manager(`/leads/${f.ids.hackensack}/activity`)).status).toBe(200);
      });
    });
  });

  describe('saved views and preferences', () => {
    beforeAll(async () => {
      const view = (user: string, name: string, shared: boolean, filter: object, sort: object | null = null) =>
        h.exec(`INSERT INTO saved_views (user_id, name, filter, sort, is_shared, created_at, updated_at)
          VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
          user, name, JSON.stringify(filter), sort && JSON.stringify(sort), shared);
      await view(f.users.rep1, 'zeta mine', false, { scope: 'mine' });
      await view(f.users.rep1, 'Alpha mine', false, { counties: ['36061'], minPriority: 70 }, { by: 'rating', dir: 'desc' });
      await view(f.users.rep2, 'rep2 private', false, {});
      await view(f.users.manager, 'Team: storm leads', true, { tagsAny: ['service:storm_damage'] });
      await view(f.users.manager, 'Manager private', false, {});
      await h.exec(`INSERT INTO user_preferences (user_id, prefs, version, updated_at) VALUES ($1::uuid, '{"density": "compact"}', 3, '2026-10-03T00:00:00Z')`,
        f.users.rep1);
    });

    it("lists a rep's own views, then the team's shared ones, never another user's private ones", async () => {
      const res = await rep1('/views');
      expect(res.status).toBe(200);
      const items = (res.body as SavedViewsResponse).items;
      expect(items.map((v) => v.name)).toEqual(['Alpha mine', 'zeta mine', 'Team: storm leads']);
      expect(items[0]).toEqual({
        id: expect.any(String), name: 'Alpha mine', filter: { counties: ['36061'], minPriority: 70 }, sort: { by: 'rating', dir: 'desc' },
        isShared: false, owner: { id: f.users.rep1, name: 'Riley Rep' }, mine: true, canEdit: true,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
      });
      expect(items[2]).toMatchObject({ isShared: true, mine: false, canEdit: false, owner: { name: 'Morgan Manager' }, sort: null });
      const mgr = (await manager('/views')).body as SavedViewsResponse;
      expect(mgr.items.map((v) => [v.name, v.canEdit])).toEqual([['Manager private', true], ['Team: storm leads', true]]);
      expect((await get('/views', f.users.rep3)).body).toEqual({ items: [expect.objectContaining({ name: 'Team: storm leads', canEdit: false })] });
    });

    it('returns the caller\'s preferences with their version, or empty at version 0', async () => {
      expect((await rep1('/preferences')).body).toEqual({ prefs: { density: 'compact' }, version: 3, updatedAt: '2026-10-03T00:00:00.000Z' });
      expect((await get('/preferences', f.users.rep2)).body).toEqual({ prefs: {}, version: 0, updatedAt: null });
    });
  });

  it("re-reads a second manager's own flags on a shared list hit without waiting for a search slot", async () => {
    await request(h.app).post('/leads/search').set(as(f.users.manager, 'manager')).send({ filter: {} }).expect(200);
    const limiter = new Limiter({ concurrency: 1, maxQueue: 0, maxWaitMs: 1 });
    let release!: () => void;
    const held = limiter.run(new AbortController().signal, () => new Promise<void>((r) => (release = r)));
    const log = pino({ level: 'silent' });
    const saturated = createApp({
      db: { primary: h.prisma, replica: h.prisma }, cache: new Cache(h.redis, log), log, internalToken: TOKEN, leadListTtlSeconds: 60, searchLimiter: limiter,
    });
    try {
      const res = await request(saturated).post('/leads/search').set(as('00000000-0000-4000-8000-0000000000aa', 'manager')).send({ filter: {} });
      expect([res.status, res.headers['x-cache']]).toEqual([200, 'hit']);
    } finally {
      release();
      await held;
    }
  });
});
