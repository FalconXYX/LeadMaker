import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tagCondition, type FacetCount, type LeadFacetsResponse, type LeadSearchResult, type LeadSummary } from '@leadmaker/shared';
import { as, clearCache, COMPANIES, FILLERS, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

describe.skipIf(!TEST_DATABASE_URL)('POST /leads/search', () => {
  let h: Harness;
  let f: Fixture;
  let key: Map<string, string>;

  const search = async (user: string, role: 'rep' | 'manager', filter: Record<string, unknown> = {}, expectStatus = 200) => {
    const res = await request(h.app).post('/leads/search').set(as(user, role)).send({ filter });
    expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
    return res;
  };
  const names = (body: LeadSearchResult) => body.items.map((i) => key.get(i.id)).filter((k) => !k?.startsWith('filler'));
  const rep1 = (filter: Record<string, unknown> = {}) => search(f.users.rep1, 'rep', filter).then((r) => r.body as LeadSearchResult);
  const manager = (filter: Record<string, unknown> = {}) => search(f.users.manager, 'manager', filter).then((r) => r.body as LeadSearchResult);
  const set = (body: LeadSearchResult) => new Set(names(body));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    key = new Map(Object.entries(f.ids).map(([k, v]) => [v, k]));
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  describe('visibility and scope', () => {
    it('shows a rep their own and unallocated leads, never another rep\'s', async () => {
      const body = await rep1({ limit: 200 });
      expect(body.total).toBe(Object.keys(COMPANIES).length - 2 + FILLERS);
      expect(set(body)).toEqual(new Set(['acme', 'jersey', 'brooklyn', 'queens', 'soho', 'williamsburg', 'miami', 'longisland']));
      expect(body.items.find((i) => key.get(i.id) === 'acme')?.canWrite).toBe(true);
      expect(body.items.find((i) => key.get(i.id) === 'jersey')?.canWrite).toBe(false);
    });

    it('applies scope mine / unallocated / own repId for a rep', async () => {
      expect(set(await rep1({ scope: 'mine' }))).toEqual(new Set(['acme', 'brooklyn']));
      expect(set(await rep1({ scope: { repId: f.users.rep1 } }))).toEqual(new Set(['acme', 'brooklyn']));
      expect((await rep1({ scope: 'unallocated', limit: 200 })).total).toBe(6 + FILLERS);
    });

    it('rejects scope all and other reps for a rep', async () => {
      await search(f.users.rep1, 'rep', { scope: 'all' }, 403);
      await search(f.users.rep1, 'rep', { scope: { repId: f.users.rep2 } }, 403);
    });

    it('shows a manager everything, or one rep\'s leads', async () => {
      expect((await manager({ limit: 1 })).total).toBe(Object.keys(COMPANIES).length + FILLERS);
      expect((await manager({ scope: 'all', limit: 1 })).total).toBe(Object.keys(COMPANIES).length + FILLERS);
      expect(set(await manager({ scope: { repId: f.users.rep2 } }))).toEqual(new Set(['hackensack', 'staten']));
      expect((await manager({ scope: 'mine' })).total).toBe(0);
    });
  });

  describe('facets', () => {
    it('filters system tags (all / any, key or key=value, false values excluded)', async () => {
      expect(set(await manager({ tagsAll: ['gaf_tier=master_elite', 'service:metal_roofing'] }))).toEqual(new Set(['acme']));
      expect(set(await manager({ tagsAny: ['region=Brooklyn', 'region=Queens'] }))).toEqual(new Set(['brooklyn', 'queens']));
      expect(set(await manager({ tagsAll: ['offers_financing'] }))).toEqual(new Set(['brooklyn']));
      expect(set(await manager({ tagsAll: ['offers_financing=false'] }))).toEqual(new Set(['queens']));
      expect(set(await manager({ tagsAll: ['social=instagram'] }))).toEqual(new Set(['longisland']));
      expect(set(await manager({ tagsAll: ['presidents_club=2'] }))).toEqual(new Set(['jersey']));
      expect(set(await manager({ tagsAll: ['distance_band=0-5'] }))).toEqual(new Set(['jersey']));
    });

    it('filters certifications, size, segment and account status (OR within, AND across)', async () => {
      expect(set(await manager({ certifications: ['gaf:master_elite', 'gaf:certified_plus'] })))
        .toEqual(new Set(['acme', 'jersey', 'hackensack']));
      expect(set(await manager({ certifications: ['gaf:none'] }))).toEqual(new Set(['longisland', 'miami']));
      expect(set(await manager({ size: ['small', 'large'] }))).toEqual(new Set(['acme', 'brooklyn', 'staten']));
      expect(set(await manager({ size: ['small'], segment: ['growth'] }))).toEqual(new Set(['brooklyn']));
      expect(set(await manager({ accountStatus: ['existing_customer'] }))).toEqual(new Set(['longisland']));
    });

    it('filters materials and services through service:* and specialty:* tags', async () => {
      expect(set(await manager({ materials: ['metal_roofing'] }))).toEqual(new Set(['acme', 'hackensack']));
      expect(set(await manager({ materials: ['tpo_roofing', 'slate_roofing'] }))).toEqual(new Set(['jersey', 'soho']));
      expect(set(await manager({ services: ['storm_damage'], materials: ['metal_roofing'] }))).toEqual(new Set(['acme']));
    });

    it('filters minimum rating and years in business (best founding year)', async () => {
      const rated = await manager({ minRating: 4.5, limit: 200 });
      expect(set(rated)).toEqual(new Set(['acme', 'hackensack', 'miami']));
      expect(rated.items.every((i) => (i.rating ?? 0) >= 4.5)).toBe(true);
      // acme: maturity tag says 1990 (column 2001); jersey: scraped founded_year 1975; longisland: column 2020.
      expect(set(await manager({ minYearsInBusiness: 30 }))).toEqual(new Set(['acme', 'jersey']));
      expect(set(await manager({ minYearsInBusiness: 1 }))).toEqual(new Set(['acme', 'jersey', 'longisland']));
    });

    it('filters counties (FIPS, any of) and a minimum priority score, under visibility and cached per filter', async () => {
      expect(set(await manager({ counties: ['36061', '36047'] }))).toEqual(new Set(['acme', 'soho', 'brooklyn', 'williamsburg']));
      const scored = await manager({ minPriority: 70, limit: 200 });
      expect(set(scored)).toEqual(new Set(['acme', 'brooklyn', 'jersey', 'hackensack', 'staten']));
      expect(scored.items.every((i) => (i.priorityScore ?? 0) >= 70)).toBe(true);
      expect(set(await rep1({ counties: ['34003', '36061'], minPriority: 50 }))).toEqual(new Set(['acme', 'soho']));
      expect((await manager({ counties: ['99999'] })).total).toBe(0);
      const hit = (filter: Record<string, unknown>) => search(f.users.manager, 'manager', filter).then((r) => r.headers['x-cache']);
      expect([await hit({ counties: ['36085'] }), await hit({ counties: ['36085'] }), await hit({ counties: ['36081'] })])
        .toEqual(['miss', 'hit', 'miss']);
      expect([await hit({ minPriority: 60 }), await hit({ minPriority: 61 })]).toEqual(['miss', 'miss']);
      await search(f.users.manager, 'manager', { counties: ['3606'] }, 400);
      await search(f.users.manager, 'manager', { minPriority: 101 }, 400);
    });

    it('filters custom tags by name or id', async () => {
      const [{ id: hot }] = await h.query<{ id: string }>(
        `INSERT INTO custom_tags (name, created_by) VALUES ('Hot Lead', $1::uuid) RETURNING id`, f.users.rep1);
      await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid),
        ($4::uuid, $2::uuid, $3::uuid)`, f.ids.acme, hot, f.users.rep1, f.ids.jersey);
      try {
        expect(set(await rep1({ customTags: ['HOT lead '] }))).toEqual(new Set(['acme', 'jersey']));
        expect(set(await rep1({ customTags: [hot] }))).toEqual(new Set(['acme', 'jersey']));
        expect((await rep1({ customTags: ['nope'] })).total).toBe(0);
        const acme = (await rep1({ customTags: [hot] })).items.find((i) => key.get(i.id) === 'acme');
        expect(acme?.customTags).toEqual([{ id: hot, name: 'Hot Lead' }]);
      } finally {
        await h.exec('DELETE FROM custom_tags');
      }
    });

    it('filters custom fields with every operator', async () => {
      const cf = (customFields: unknown[]) => manager({ customFields });
      expect(set(await cf([{ key: 'po_number', op: 'eq', value: 'PO-1001' }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'budget', op: 'gte', value: 2000 }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'budget', op: 'lte', value: 2000 }]))).toEqual(new Set(['brooklyn']));
      expect(set(await cf([{ key: 'budget', op: 'eq', value: 5000 }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'next_visit', op: 'lte', value: '2026-12-31' }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'po_number', op: 'contains', value: 'po-10' }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'brands', op: 'contains', value: 'owens' }]))).toEqual(new Set(['acme']));
      expect(set(await cf([{ key: 'budget', op: 'exists' }]))).toEqual(new Set(['acme', 'brooklyn']));
      // A string value is never compared numerically (and never errors).
      expect((await cf([{ key: 'po_number', op: 'gte', value: 1 }])).total).toBe(0);
      expect(set(await cf([{ key: 'budget', op: 'exists' }, { key: 'po_number', op: 'exists' }]))).toEqual(new Set(['acme']));
    });

    it('filters by radius around a ZIP centroid and sorts by distance', async () => {
      const near5 = await manager({ near: { zip: '10013', radiusMiles: 5 }, sort: { by: 'distance', dir: 'asc' } });
      expect(names(near5)).toEqual(['acme', 'soho', 'jersey', 'williamsburg', 'brooklyn']);
      const miles = near5.items.map((i) => i.distanceMiles!);
      expect(miles).toEqual([...miles].sort((a, b) => a - b));
      expect(miles[0]).toBeLessThan(0.2);
      expect(miles[2]).toBeCloseTo(2.0, 0);
      expect(set(await manager({ near: { zip: '10013', radiusMiles: 12 } })))
        .toEqual(new Set(['acme', 'soho', 'jersey', 'williamsburg', 'brooklyn', 'queens', 'hackensack']));
      // Visibility still applies inside the radius.
      expect(set(await rep1({ near: { zip: '10013', radiusMiles: 12 } })))
        .toEqual(new Set(['acme', 'soho', 'jersey', 'williamsburg', 'brooklyn', 'queens']));
    });

    it('falls back to company postal codes for ZIPs outside the centroid table, and rejects unknown ZIPs', async () => {
      expect(set(await manager({ near: { zip: '33101', radiusMiles: 1 } }))).toEqual(new Set(['miami']));
      const res = await search(f.users.manager, 'manager', { near: { zip: '99999', radiusMiles: 5 } }, 400);
      expect(res.body.error).toContain('unknown ZIP');
    });

    it('filters unchecked / unserviced for me and for the team', async () => {
      // rep1 checked acme after its last material change and serviced it; checked brooklyn before its change.
      await h.exec(`INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at) VALUES
        ($1::uuid, $3::uuid, '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
        ($2::uuid, $3::uuid, '2026-09-15T00:00:00Z', NULL)`, f.ids.acme, f.ids.brooklyn, f.users.rep1);
      await h.exec(`UPDATE companies SET team_last_checked_at = '2026-10-12T00:00:00Z', team_last_serviced_at = '2026-10-12T00:00:00Z'
        WHERE id = $1::uuid`, f.ids.acme);
      // Team-checked before its last material change: unchecked again at team level too.
      await h.exec(`UPDATE companies SET team_last_checked_at = '2026-09-15T00:00:00Z' WHERE id = $1::uuid`, f.ids.brooklyn);
      try {
        expect(set(await rep1({ scope: 'mine', unchecked: 'me' }))).toEqual(new Set(['brooklyn']));
        expect(set(await rep1({ scope: 'mine', unserviced: 'me' }))).toEqual(new Set(['brooklyn']));
        expect(set(await manager({ scope: { repId: f.users.rep1 }, unchecked: 'team' }))).toEqual(new Set(['brooklyn']));
        expect(set(await manager({ scope: { repId: f.users.rep1 }, unserviced: 'team' }))).toEqual(new Set(['brooklyn']));
        // The manager never checked or serviced anything, so for them both are unchecked and unserviced.
        expect(set(await manager({ scope: { repId: f.users.rep1 }, unchecked: 'me' }))).toEqual(new Set(['acme', 'brooklyn']));
        expect(set(await manager({ scope: { repId: f.users.rep1 }, unserviced: 'me' }))).toEqual(new Set(['acme', 'brooklyn']));
        const items = (await rep1({ scope: 'mine' })).items;
        const acme = items.find((i) => key.get(i.id) === 'acme')!;
        const brooklyn = items.find((i) => key.get(i.id) === 'brooklyn')!;
        expect(acme.mine).toMatchObject({ checked: true, serviced: true, checkedAt: '2026-10-12T00:00:00.000Z' });
        expect(acme.team).toMatchObject({ checked: true, serviced: true });
        expect(brooklyn.mine).toMatchObject({ checked: false, serviced: false, checkedAt: '2026-09-15T00:00:00.000Z' });
      } finally {
        await h.exec('DELETE FROM lead_rep_state');
        await h.exec('UPDATE companies SET team_last_checked_at = NULL, team_last_serviced_at = NULL');
      }
    });

    it('filters by last change and by name text (escaped, override-aware)', async () => {
      expect(set(await manager({ updatedSince: '2026-10-05' }))).toEqual(new Set(['acme']));
      expect(set(await manager({ updatedSince: '2026-09-30T00:00:00Z' }))).toEqual(new Set(['acme', 'brooklyn']));
      expect(set(await manager({ text: 'acme' }))).toEqual(new Set(['acme']));
      expect(set(await manager({ text: '100%' }))).toEqual(new Set(['jersey']));
      expect((await manager({ text: '%' })).total).toBe(1);
      expect((await manager({ text: '_' })).total).toBe(0);
      await h.exec(`INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id)
        VALUES ($1::uuid, 'business_name', '"Zenith Roofing"', '"SoHo Slate"', $2::uuid)`, f.ids.soho, f.users.manager);
      // A cleared (superseded) override shows neither in the list nor in text search.
      await h.exec(`INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id, superseded_at)
        VALUES ($1::uuid, 'business_name', '"Old Name Inc"', '"Jersey Flat Roofs"', $2::uuid, now()),
               ($1::uuid, 'city', '"Hoboken"', '"Jersey City"', $2::uuid, now())`, f.ids.jersey, f.users.manager);
      try {
        const found = await rep1({ text: 'zenith' });
        expect(names(found)).toEqual(['soho']);
        expect(found.items[0].businessName).toBe('Zenith Roofing');
        expect((await rep1({ text: 'old name' })).total).toBe(0);
        const jersey = (await rep1({ text: 'jersey flat' })).items[0];
        expect([jersey.businessName, jersey.city]).toEqual(['Jersey Flat Roofs', 'Jersey City']);
      } finally {
        await h.exec('DELETE FROM field_overrides');
      }
    });

    it('filters by the pipeline\'s updated-in-last-poll flag', async () => {
      await h.exec(`UPDATE companies SET updated_in_last_poll = (id = ANY($1::uuid[]))`, [f.ids.acme, f.ids.jersey, f.ids.hackensack]);
      try {
        expect(set(await manager({ updatedInLastPoll: true }))).toEqual(new Set(['acme', 'jersey', 'hackensack']));
        expect(set(await rep1({ updatedInLastPoll: true }))).toEqual(new Set(['acme', 'jersey']));
        const not = await manager({ updatedInLastPoll: false, limit: 200 });
        expect(not.total).toBe(Object.keys(COMPANIES).length + FILLERS - 3);
        expect(not.items.every((i) => !i.updatedInLastPoll)).toBe(true);
      } finally {
        await h.exec('UPDATE companies SET updated_in_last_poll = TRUE');
      }
    });

    it('rejects invalid filters with details', async () => {
      const res = await search(f.users.rep1, 'rep', { size: ['huge'] }, 400);
      expect(res.body.error).toBe('invalid filter');
      expect(res.body.details).toBeTruthy();
      await search(f.users.rep1, 'rep', { sort: { by: 'distance', dir: 'asc' } }, 400);
      const bad = await request(h.app).post('/leads/search').set(as(f.users.rep1, 'rep')).send({ filter: {}, extra: 1 });
      expect(bad.status).toBe(400);
    });
  });

  describe('sorting and keyset pagination', () => {
    const pages = async (filter: Record<string, unknown>, limit: number) => {
      const all: LeadSummary[] = [];
      let cursor: string | undefined;
      const totals = new Set<number>();
      let count = 0;
      for (let i = 0; i < 50; i++) {
        const body = await manager({ ...filter, limit, cursor });
        count++;
        all.push(...body.items);
        totals.add(body.total);
        if (!body.nextCursor) break;
        expect(body.items).toHaveLength(limit);
        cursor = body.nextCursor;
      }
      // No trailing empty page, also when the total is a multiple of the page size.
      expect(count).toBe(Math.max(1, Math.ceil(all.length / limit)));
      return { all, totals };
    };

    it.each([
      [{ by: 'priority_score', dir: 'desc' }, 7],
      [{ by: 'priority_score', dir: 'desc' }, 8],
      [{ by: 'priority_score', dir: 'asc' }, 5],
      [{ by: 'rating', dir: 'desc' }, 4],
      [{ by: 'rating', dir: 'asc' }, 6],
      [{ by: 'review_count', dir: 'desc' }, 3],
      [{ by: 'years_in_business', dir: 'desc' }, 4],
      [{ by: 'last_change', dir: 'desc' }, 5],
    ])('pages through every lead exactly once by %o', async (sort, limit) => {
      const full = await manager({ sort, limit: 200 });
      const { all, totals } = await pages({ sort }, limit);
      expect(all.map((i) => i.id)).toEqual(full.items.map((i) => i.id));
      expect(new Set(all.map((i) => i.id)).size).toBe(Object.keys(COMPANIES).length + FILLERS);
      expect([...totals]).toEqual([full.total]);
    });

    it('orders by the requested key with NULLs last and ties broken by id', async () => {
      const desc = (await manager({ limit: 200 })).items;
      expect(key.get(desc[0].id)).toBe('acme');
      expect(desc.at(-1)?.priorityScore).toBeNull();
      const scores = desc.map((i) => i.priorityScore).filter((s): s is number => s !== null);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      const tied = desc.filter((i) => i.priorityScore === 70).map((i) => i.id);
      expect(tied).toEqual([...tied].sort().reverse());
      const asc = (await manager({ sort: { by: 'rating', dir: 'asc' }, limit: 200 })).items;
      expect(asc[0].rating).toBe(3.5);
      expect(asc.at(-1)?.rating).toBeNull();
      const years = (await manager({ sort: { by: 'years_in_business', dir: 'desc' }, limit: 3 })).items;
      expect(years.map((i) => key.get(i.id))).toEqual(['jersey', 'acme', 'longisland']);
    });

    it('pages a distance sort and stops with a null cursor', async () => {
      const filter = { near: { zip: '10013', radiusMiles: 12 }, sort: { by: 'distance', dir: 'asc' } };
      const { all } = await pages(filter, 2);
      expect(all.map((i) => key.get(i.id))).toEqual(['acme', 'soho', 'jersey', 'williamsburg', 'brooklyn', 'queens', 'hackensack']);
    });

    it('rejects a cursor from another sort', async () => {
      const first = await manager({ limit: 2 });
      await search(f.users.manager, 'manager', { limit: 2, cursor: first.nextCursor, sort: { by: 'rating', dir: 'asc' } }, 400);
      await search(f.users.manager, 'manager', { cursor: 'garbage' }, 400);
    });

    it.each([
      ['priority_score:desc', undefined, 'abc'],
      ['review_count:desc', { by: 'review_count', dir: 'desc' }, '99999999999'],
      ['last_change:desc', { by: 'last_change', dir: 'desc' }, '2026-13-45 99:00:00+00'],
    ])('rejects a tampered %s cursor key with 400, not 500', async (s, sort, k) => {
      const cursor = Buffer.from(JSON.stringify({ s, k, id: f.ids.acme })).toString('base64url');
      const res = await search(f.users.manager, 'manager', { cursor, ...(sort ? { sort } : {}) }, 400);
      expect(res.body.error).toBe('invalid cursor');
    });
  });

  describe('POST /leads/facets', () => {
    const facets = async (user: string, role: 'rep' | 'manager', filter: Record<string, unknown> = {}, expectStatus = 200) => {
      const res = await request(h.app).post('/leads/facets').set(as(user, role)).send({ filter });
      expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
      return res;
    };

    it('counts each facet value exactly as the list filtered on that value', async () => {
      const [{ id: hot }] = await h.query<{ id: string }>(
        `INSERT INTO custom_tags (name, created_by) VALUES ('Hot Lead', $1::uuid) RETURNING id`, f.users.rep1);
      await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $3::uuid, $4::uuid),
        ($2::uuid, $3::uuid, $4::uuid)`, f.ids.acme, f.ids.hackensack, hot, f.users.manager);
      try {
        const cases: [string, 'rep' | 'manager', Record<string, unknown>][] = [
          [f.users.manager, 'manager', {}], [f.users.rep1, 'rep', {}], [f.users.manager, 'manager', { scope: 'unallocated' }],
          [f.users.rep1, 'rep', { minRating: 4, limit: 5, sort: { by: 'rating', dir: 'desc' } }],
          [f.users.rep1, 'rep', { scope: 'mine', unchecked: 'me' }],
          [f.users.manager, 'manager', { counties: ['36061', '36047', '34017'], minPriority: 50 }],
        ];
        for (const [user, role, base] of cases) {
          const body = (await facets(user, role, base)).body as LeadFacetsResponse;
          const total = async (extra: Record<string, unknown>) =>
            ((await search(user, role, { ...base, ...extra })).body as LeadSearchResult).total;
          expect(body.total).toBe(await total({}));
          const checks: [FacetCount[], (v: string) => Record<string, unknown>][] = [
            [body.segment, (v) => ({ segment: [v] })], [body.size, (v) => ({ size: [v] })],
            [body.certifications, (v) => ({ certifications: [v] })], [body.services, (v) => ({ services: [v] })],
            [body.materials, (v) => ({ materials: [v] })], [body.accountStatus, (v) => ({ accountStatus: [v] })],
            [body.customTags, (v) => ({ customTags: [v] })],
          ];
          for (const [counts, filterOn] of checks) {
            for (const c of counts) expect(c.count, `${JSON.stringify(base)} ${c.value}`).toBe(await total(filterOn(c.value)));
          }
        }
        const all = (await facets(f.users.manager, 'manager')).body as LeadFacetsResponse;
        expect(all.services.find((s) => s.value === 'metal_roofing')?.count).toBe(2);
        expect(all.materials.map((m) => m.value)).toContain('metal_roofing');
        expect(all.materials.map((m) => m.value)).not.toContain('storm_damage');
        expect(all.certifications.find((c) => c.value === 'gaf:none')?.count).toBe(2 + FILLERS);
        expect(all.customTags).toEqual([{ id: hot, value: 'Hot Lead', count: 2 }]);
        expect(((await facets(f.users.rep1, 'rep')).body as LeadFacetsResponse).customTags).toEqual([{ id: hot, value: 'Hot Lead', count: 1 }]);
      } finally {
        await h.exec('DELETE FROM custom_tags');
      }
    });

    it('is cached like the lists, applies visibility and validates the filter', async () => {
      expect((await facets(f.users.manager, 'manager', { segment: ['growth'], limit: 5 })).headers['x-cache']).toBe('miss');
      expect((await facets(f.users.manager, 'manager', { segment: ['growth'], cursor: 'x' })).headers['x-cache']).toBe('hit');
      expect(await h.redis.keys('leads:facets:mgr:*')).toHaveLength(1);
      await h.redis.incr('leads:v:all');
      expect((await facets(f.users.manager, 'manager', { segment: ['growth'] })).headers['x-cache']).toBe('miss');
      await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
      expect((await facets(f.users.rep1, 'rep')).headers['x-cache']).toBe('bypass');
      await facets(f.users.rep1, 'rep', { scope: 'all' }, 403);
      await facets(f.users.rep1, 'rep', { size: ['huge'] }, 400);
      expect(((await facets(f.users.manager, 'manager', { near: { zip: '10013', radiusMiles: 1 } })).body as LeadFacetsResponse).total)
        .toBe(2);
    });
  });

  describe('cache', () => {
    it('serves a rep\'s repeats from Redis until their own or the pool\'s list version moves', async () => {
      const filter = { scope: 'mine' };
      const first = await search(f.users.rep1, 'rep', filter);
      expect(first.headers['x-cache']).toBe('miss');
      const keys = await h.redis.keys(`leads:q:${f.users.rep1}:*`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^leads:q:${f.users.rep1}:0\\.0:[0-9a-f]{40}$`));
      expect(await h.redis.ttl(keys[0])).toBeGreaterThan(50);
      // A DB change without an event is not visible until the version moves (proves the hit is cached).
      await h.exec(`UPDATE companies SET rating = 1.0 WHERE id = $1::uuid`, f.ids.acme);
      try {
        const second = await search(f.users.rep1, 'rep', filter);
        expect(second.headers['x-cache']).toBe('hit');
        expect(second.body).toEqual(first.body);
        // other reps' leads and the manager-wide counter do not touch rep1's lists
        await Promise.all([h.redis.incr(`leads:v:rep:${f.users.rep2}`), h.redis.incr('leads:v:all')]);
        expect((await search(f.users.rep1, 'rep', filter)).headers['x-cache']).toBe('hit');
        await h.redis.incr(`leads:v:rep:${f.users.rep1}`);
        const third = await search(f.users.rep1, 'rep', filter);
        expect(third.headers['x-cache']).toBe('miss');
        expect(third.body.items.find((i: LeadSummary) => i.id === f.ids.acme).rating).toBe(1.0);
        expect((await search(f.users.rep1, 'rep', filter)).headers['x-cache']).toBe('hit');
        await h.redis.incr('leads:v:pool');
        expect((await search(f.users.rep1, 'rep', filter)).headers['x-cache']).toBe('miss');
      } finally {
        await h.exec(`UPDATE companies SET rating = 4.9 WHERE id = $1::uuid`, f.ids.acme);
      }
    });

    it('serves managers\' repeats until the all-leads version moves', async () => {
      expect((await search(f.users.manager, 'manager', { limit: 3 })).headers['x-cache']).toBe('miss');
      await Promise.all([h.redis.incr('leads:v:pool'), h.redis.incr(`leads:v:rep:${f.users.rep1}`)]);
      expect((await search(f.users.manager, 'manager', { limit: 3 })).headers['x-cache']).toBe('hit');
      await h.redis.incr('leads:v:all');
      expect((await search(f.users.manager, 'manager', { limit: 3 })).headers['x-cache']).toBe('miss');
    });

    it('keys lists per user, so one rep never gets another user\'s cached list', async () => {
      await search(f.users.rep1, 'rep', { limit: 5 });
      const other = await search(f.users.rep2, 'rep', { limit: 5 });
      expect(other.headers['x-cache']).toBe('miss');
      expect(other.body.items.some((i: LeadSummary) => i.id === f.ids.acme)).toBe(false);
    });

    it('bypasses the cache right after the user\'s own write', async () => {
      await search(f.users.rep1, 'rep', { scope: 'mine' });
      await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
      const res = await search(f.users.rep1, 'rep', { scope: 'mine' });
      expect(res.headers['x-cache']).toBe('bypass');
    });

    it('shares managers\' lists, with each manager\'s own checked/serviced state', async () => {
      const [{ id: other }] = await h.query<{ id: string }>(
        `INSERT INTO users (name, email, role) VALUES ('Other Manager', 'other-manager@test', 'manager') RETURNING id`);
      await h.exec(`INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at) VALUES ($1::uuid, $2::uuid, now(), now())`,
        f.ids.acme, other);
      try {
        const first = await search(f.users.manager, 'manager', { limit: 5 });
        expect(first.headers['x-cache']).toBe('miss');
        expect(await h.redis.keys('leads:q:mgr:*')).toHaveLength(1);
        const second = await search(other, 'manager', { limit: 5 });
        expect(second.headers['x-cache']).toBe('hit');
        expect(second.body.items.map((i: LeadSummary) => i.id)).toEqual(first.body.items.map((i: LeadSummary) => i.id));
        const acme = (body: LeadSearchResult) => body.items.find((i) => i.id === f.ids.acme)!;
        expect(acme(first.body).mine.checked).toBe(false);
        expect(acme(second.body).mine).toMatchObject({ checked: true, serviced: true });
        expect(acme(second.body).team).toEqual(acme(first.body).team);
        expect((await search(other, 'manager', { limit: 5, unchecked: 'me' })).headers['x-cache']).toBe('miss');
      } finally {
        await h.exec(`DELETE FROM lead_rep_state WHERE user_id = $1::uuid`, other);
        await h.exec(`DELETE FROM users WHERE id = $1::uuid`, other);
      }
    });
  });

  describe('total and derived columns', () => {
    it('gives each lead its size and certification levels from its system tags', async () => {
      const items = (await manager({ limit: 200 })).items;
      const by = (k: string) => items.find((i) => key.get(i.id) === k)!;
      expect([by('acme').size, by('acme').certifications]).toEqual(['large', ['gaf:master_elite']]);
      expect([by('jersey').size, by('jersey').certifications]).toEqual(['medium', ['gaf:certified_plus']]);
      expect([by('hackensack').size, by('hackensack').certifications]).toEqual([null, ['gaf:master_elite']]);
      expect([by('longisland').size, by('longisland').certifications]).toEqual([null, []]);
      // The same values the certifications and size filters select on.
      expect(set(await manager({ certifications: ['gaf:certified_plus'], size: ['medium'] }))).toEqual(new Set(['jersey']));
    });

    it('reports an exact total below the cap', async () => {
      const body = await manager({ limit: 1 }) as LeadSearchResult & { totalCapped: boolean };
      expect(body.total).toBe(Object.keys(COMPANIES).length + FILLERS);
      expect(body.totalCapped).toBe(false);
    });

    it('keeps tag_facets current and does not bump the version for bookkeeping writes', async () => {
      const [before] = await h.query<{ version: number }>(`SELECT version FROM companies WHERE id = $1::uuid`, f.ids.jersey);
      await h.exec(`UPDATE companies SET last_seen_at = now() WHERE id = $1::uuid`, f.ids.jersey);
      const [after] = await h.query<{ version: number }>(`SELECT version FROM companies WHERE id = $1::uuid`, f.ids.jersey);
      expect(after.version).toBe(before.version);
      await h.exec(`UPDATE companies SET system_tags = system_tags || '[{"key":"probe","value":7}]' WHERE id = $1::uuid`, f.ids.jersey);
      try {
        expect(set(await manager({ tagsAll: ['probe=7.0'] }))).toEqual(new Set(['jersey']));
        expect(set(await manager({ tagsAll: ['probe'] }))).toEqual(new Set(['jersey']));
      } finally {
        await h.exec(`UPDATE companies SET system_tags = COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements(system_tags) t WHERE t->>'key' <> 'probe'), '[]') WHERE id = $1::uuid`, f.ids.jersey);
      }
    });

    it('accepts tag values too long for a GIN key and still matches them through system_tags', async () => {
      const long = randomBytes(6000).toString('base64');
      const tags = JSON.stringify([{ key: 'probe', value: long }, { key: 'probe', value: [long, 'el'] }]);
      await h.exec(`UPDATE companies SET system_tags = system_tags || $2::jsonb WHERE id = $1::uuid`, f.ids.jersey, tags);
      try {
        expect(set(await manager({ tagsAll: ['probe', 'probe=el'] }))).toEqual(new Set(['jersey']));
        const cond = tagCondition(`probe=${long}`).compile();
        expect(cond.text).not.toContain('tag_facets');
        const [row] = await h.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM companies c WHERE ${cond.text} AND c.id = $${cond.values.length + 1}::uuid`, ...cond.values, f.ids.jersey);
        expect(row.n).toBe(1);
      } finally {
        await h.exec(`UPDATE companies SET system_tags = COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements(system_tags) t WHERE t->>'key' <> 'probe'), '[]') WHERE id = $1::uuid`, f.ids.jersey);
      }
    });
  });
});
