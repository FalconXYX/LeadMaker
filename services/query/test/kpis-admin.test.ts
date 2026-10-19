import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AllocationSuggestionsResponse, KpiResponse, UserListItem } from '@leadmaker/shared';
import { as, clearCache, COMPANIES, FILLERS, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

describe.skipIf(!TEST_DATABASE_URL)('KPIs, users and allocation suggestions', () => {
  let h: Harness;
  let f: Fixture;

  const get = (path: string, user: string, role: 'rep' | 'manager') => request(h.app).get(path).set(as(user, role));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    // rep1: acme checked after its change and serviced; brooklyn checked before its change. Only acme was in the last poll.
    await h.exec(`INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at) VALUES
      ($1::uuid, $3::uuid, '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
      ($2::uuid, $3::uuid, '2026-09-15T00:00:00Z', NULL)`, f.ids.acme, f.ids.brooklyn, f.users.rep1);
    await h.exec(`UPDATE companies SET updated_in_last_poll = (id = $1::uuid)`, f.ids.acme);
    // The manager checked hackensack (team-level checked, but not by rep2).
    await h.exec(`UPDATE companies SET team_last_checked_at = '2026-10-12T00:00:00Z' WHERE id = $1::uuid`, f.ids.hackensack);
    await h.exec('REFRESH MATERIALIZED VIEW team_dashboard_kpis');
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  it('computes a rep\'s own counters live and hides team KPIs from reps', async () => {
    const res = await get('/kpis', f.users.rep1, 'rep');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mine: { allocated: 2, unchecked: 1, unserviced: 1, updated_in_last_poll: 1 } });
    // rep2 never checked or serviced either lead (the manager's team-level check is not theirs).
    expect((await get('/kpis', f.users.rep2, 'rep')).body)
      .toEqual({ mine: { allocated: 2, unchecked: 2, unserviced: 2, updated_in_last_poll: 0 } });
  });

  it('gives managers per-rep and pool figures from team_dashboard_kpis', async () => {
    const body = (await get('/kpis', f.users.manager, 'manager')).body as KpiResponse;
    expect(body.mine).toEqual({ allocated: 0, unchecked: 0, unserviced: 0, updated_in_last_poll: 0 });
    const team = body.team!;
    expect(team.refreshedAt).toMatch(/^\d{4}-/);
    expect(team.totals.allocated).toBe(Object.keys(COMPANIES).length + FILLERS);
    expect(team.unallocated.allocated).toBe(6 + FILLERS);
    // totals.allocated counts every lead, the pool included; assigned only those with a rep.
    expect(team.totals.assigned).toBe(team.totals.allocated - team.unallocated.allocated);
    expect(team.totals.assigned).toBe(team.reps.reduce((n, r) => n + r.allocated, 0));
    const byName = Object.fromEntries(team.reps.map((r) => [r.name, r]));
    expect(Object.keys(byName)).toEqual(['Riley Rep', 'Sam Rep', 'Taylor Rep']);
    expect(byName['Riley Rep']).toMatchObject({ repId: f.users.rep1, allocated: 2, unchecked: 1, unserviced: 1, updated_in_last_poll: 1 });
    expect(byName['Sam Rep']).toMatchObject({ allocated: 2, unchecked: 2, unserviced: 2, teamUnchecked: 1, teamUnserviced: 2 });
    expect(byName['Taylor Rep']).toMatchObject({ allocated: 0, unchecked: 0 });
  });

  it('caches KPIs and recomputes a rep\'s counters right after their own write', async () => {
    await get('/kpis', f.users.rep1, 'rep');
    expect(JSON.parse((await h.redis.get(`kpi:rep:${f.users.rep1}`))!)).toMatchObject({ unchecked: 1 });
    await h.exec(`UPDATE lead_rep_state SET checked_at = now() WHERE company_id = $1::uuid AND user_id = $2::uuid`,
      f.ids.brooklyn, f.users.rep1);
    try {
      expect((await get('/kpis', f.users.rep1, 'rep')).body.mine.unchecked).toBe(1);
      await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
      expect((await get('/kpis', f.users.rep1, 'rep')).body.mine.unchecked).toBe(0);
      await h.redis.del(`rw:${f.users.rep1}`);
      expect((await get('/kpis', f.users.rep1, 'rep')).body.mine.unchecked).toBe(0);
    } finally {
      await h.exec(`UPDATE lead_rep_state SET checked_at = '2026-09-15T00:00:00Z' WHERE company_id = $1::uuid`, f.ids.brooklyn);
    }
    await get('/kpis', f.users.manager, 'manager');
    expect(await h.redis.exists('kpi:team')).toBe(1);
  });

  it('lists users for managers only', async () => {
    expect((await get('/users', f.users.rep1, 'rep')).status).toBe(403);
    const body = (await get('/users', f.users.manager, 'manager')).body as { items: UserListItem[] };
    expect(body.items.map((u) => [u.name, u.role, u.allocatedCount])).toEqual([
      ['Riley Rep', 'rep', 2], ['Sam Rep', 'rep', 2], ['Taylor Rep', 'rep', 0], ['Morgan Manager', 'manager', 0],
    ]);
    const reps = (await get('/users?role=rep', f.users.manager, 'manager')).body as { items: UserListItem[] };
    expect(reps.items).toHaveLength(3);
    expect((await get('/users?role=admin', f.users.manager, 'manager')).status).toBe(400);
  });

  it('suggests allocations by ZIP, then county, then the least-loaded rep (managers only)', async () => {
    expect((await get('/allocations/suggestions', f.users.rep1, 'rep')).status).toBe(403);
    const body = (await get('/allocations/suggestions', f.users.manager, 'manager')).body as AllocationSuggestionsResponse;
    expect(body.unallocatedTotal).toBe(6 + FILLERS);
    expect(body.considered).toBe(6 + FILLERS);
    const find = (id: string) => body.suggestions.find((s) => s.companyIds.includes(id))!;
    expect(find(f.ids.soho)).toMatchObject({ repId: f.users.rep1, basis: 'postal_code', key: '10013' });
    expect(find(f.ids.soho).reason).toContain('1 lead in ZIP 10013');
    expect(find(f.ids.williamsburg)).toMatchObject({ repId: f.users.rep1, basis: 'county', key: '36047' });
    // No rep works these areas: the emptiest rep (rep3) first, each county kept together.
    const albany = find(f.ids.filler0);
    expect(albany).toMatchObject({ basis: 'balance', key: '36001' });
    expect(albany.companyIds).toHaveLength(FILLERS);
    expect(find(f.ids.jersey)).toMatchObject({ repId: f.users.rep3, basis: 'balance', key: '34017' });
    const all = body.suggestions.flatMap((s) => s.companyIds);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(6 + FILLERS);
    // A lead without a county whose ZIP equals the fillers' county FIPS (36001) is its own area.
    const [{ id: zipOnly }] = await h.query<{ id: string }>(`INSERT INTO companies (business_name, latitude, longitude, postal_code,
      priority_score, content_hash) VALUES ('Zip Only Roofing', 32.5, -86.6, '36001', 10, 'h') RETURNING id`);
    try {
      const mixed = (await get('/allocations/suggestions', f.users.manager, 'manager')).body as AllocationSuggestionsResponse;
      const zipGroup = mixed.suggestions.find((s) => s.companyIds.includes(zipOnly))!;
      expect(zipGroup).toMatchObject({ basis: 'balance', key: '36001', companyIds: [zipOnly] });
      expect(zipGroup.reason).toContain('ZIP 36001');
      expect(mixed.suggestions.find((s) => s.companyIds.includes(f.ids.filler0))!.companyIds).toHaveLength(FILLERS);
    } finally {
      await h.exec('DELETE FROM companies WHERE id = $1::uuid', zipOnly);
    }
    const limited = (await get('/allocations/suggestions?limit=2', f.users.manager, 'manager')).body as AllocationSuggestionsResponse;
    expect(limited.considered).toBe(2);
    expect(limited.suggestions.flatMap((s) => s.leads.map((l) => l.businessName))).toEqual(['Jersey Flat Roofs', 'Queens Gutter & Roof']);
  });

  describe('HTTP surface', () => {
    it('requires the internal token and a valid user', async () => {
      expect((await request(h.app).get('/kpis')).status).toBe(401);
      expect((await request(h.app).get('/kpis').set({ ...as(f.users.rep1, 'rep'), 'x-internal-token': 'nope' })).status).toBe(401);
      expect((await request(h.app).get('/kpis').set({ ...as(f.users.rep1, 'rep'), 'x-user-role': 'admin' })).status).toBe(401);
      expect((await request(h.app).get('/kpis').set({ ...as('rep1', 'rep') })).status).toBe(401);
    });

    it('serves the same routes under /api', async () => {
      expect((await get('/api/kpis', f.users.rep1, 'rep')).body.mine.allocated).toBe(2);
      const res = await request(h.app).post('/api/leads/search').set(as(f.users.rep1, 'rep')).send({ filter: { scope: 'mine' } });
      expect(res.body.total).toBe(2);
    });

    it('answers health checks without auth and 404s unknown routes', async () => {
      expect((await request(h.app).get('/healthz')).body).toEqual({ ok: true });
      expect((await request(h.app).get('/readyz')).body).toEqual({ ok: true, postgres: true, redis: true });
      expect((await get('/nope', f.users.rep1, 'rep')).status).toBe(404);
      const bad = await request(h.app).post('/leads/search').set(as(f.users.rep1, 'rep'))
        .set('content-type', 'application/json').send('{"filter":');
      expect(bad.status).toBe(400);
    });
  });
});
