import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countyName, type SalesDashboard } from '@leadmaker/shared';
import { AI_PICKS_LIMIT, firstSentence } from '../src/dashboard-ai.ts';
import { as, clearCache, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

describe('firstSentence', () => {
  it('keeps the first sentence, past abbreviations and decimals', () => {
    expect(firstSentence('Lead with same-day TPO delivery. Mention the rebate.')).toBe('Lead with same-day TPO delivery.');
    expect(firstSentence('  Acme Roofing Inc. is rated 4.8 by 200 reviewers! Call soon.')).toBe('Acme Roofing Inc. is rated 4.8 by 200 reviewers!');
    expect(firstSentence('No full stop at all')).toBe('No full stop at all');
    expect(firstSentence('')).toBeNull();
    expect(firstSentence(null)).toBeNull();
  });

  it('cuts a very long sentence at a word, with an ellipsis', () => {
    const s = firstSentence(`${'word '.repeat(80)}end.`)!;
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s.endsWith('word…')).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('GET /dashboard: aiPicks and callPitches', () => {
  let h: Harness;
  let f: Fixture;
  const get = (path: string, user: string, role: 'rep' | 'manager' = 'rep') => request(h.app).get(path).set(as(user, role));
  const insight = (company: string, summary: string, pitch: string, o: { status?: string; at?: string; version?: string } = {}) =>
    h.exec(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation, model, prompt_version, input_hash,
        generated_at, status) VALUES ($1::uuid, $2, $3, 'm', $4, gen_random_uuid()::text, $5::timestamptz, $6)`,
    company, summary, pitch, o.version ?? 'insights/v3', o.at ?? '2026-10-10', o.status ?? 'ok');

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    const { ids, users } = f;
    await h.exec(`UPDATE companies SET updated_in_last_poll = (id = $1::uuid)`, ids.jersey);
    // rep1 has worked both of their seeded leads; filler1 is a new strategic lead of theirs: on today's call list.
    await h.exec(`UPDATE companies SET assigned_rep_id = $2::uuid, segment = 'strategic' WHERE id = $1::uuid`, ids.filler1, users.rep1);
    const log = (company: string, user: string, type: string) => h.exec(`INSERT INTO activity_logs
      (company_id, actor_type, user_id, action_type) VALUES ($1::uuid, 'user', $2::uuid, $3)`, company, user, type);
    await log(ids.acme, users.rep1, 'call');
    await log(ids.brooklyn, users.rep1, 'visit');
    // filler0 was found two days ago (no insight yet): the one 'new' pick.
    await h.exec(`UPDATE companies SET first_seen_at = now() - interval '2 days' WHERE id = $1::uuid`, ids.filler0);
    await insight(ids.jersey, 'Jersey Flat Roofs installs TPO for warehouses. They want faster deliveries.',
      'Lead with same-day TPO delivery. Mention the rebate.');
    await insight(ids.hackensack, 'Hackensack Metal Works does standing seam.', 'Pitch the metal panel line.');
    // queens: an older ok row and a newer failed one with text; the ok one is served.
    await insight(ids.queens, 'Queens Gutter does gutters and roofs.', 'Queens ok pitch. Second sentence.', { at: '2026-10-01' });
    await insight(ids.queens, 'Queens error summary.', 'Queens error pitch.', { at: '2026-10-12', status: 'error' });
    await insight(ids.williamsburg, 'Williamsburg Roof Care repairs brownstone roofs.', 'Offer the coatings bundle.', { version: 'insights/v2' });
    await insight(ids.filler1, 'Filler One is a strategic account.', 'Ask about their spring backlog. Then quote.');
  });

  afterAll(async () => h?.close());

  it("gives a rep picks from the pool and their own untouched leads, new first, then AI top matches", async () => {
    await clearCache(h.redis);
    const d = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
    expect(d.aiPicks.map((p) => [p.id, p.label])).toEqual([
      [f.ids.filler0, 'new'], [f.ids.jersey, 'top_match'], [f.ids.queens, 'top_match'], [f.ids.williamsburg, 'top_match'],
    ]);
    expect(d.aiPicks.length).toBeLessThanOrEqual(AI_PICKS_LIMIT);
    expect(d.aiPicks[0]).toMatchObject({ aiSummary: null, aiPitch: null, name: 'Filler Roofing 00', city: 'Albany' });
    expect(Date.parse(d.aiPicks[0]!.foundAt!)).toBeGreaterThan(Date.now() - 3 * 86_400_000);
    expect(d.aiPicks[1]).toEqual({
      id: f.ids.jersey, name: 'Jersey Flat Roofs', city: 'Jersey City', county: countyName('34017'), priorityScore: 80,
      aiSummary: 'Jersey Flat Roofs installs TPO for warehouses.', aiPitch: 'Lead with same-day TPO delivery.',
      foundAt: '2026-09-01T00:00:00.000Z', label: 'top_match',
    });
    expect(d.aiPicks[2]).toMatchObject({ aiPitch: 'Queens ok pitch.', aiSummary: 'Queens Gutter does gutters and roofs.' });
  });

  it("never gives a rep another rep's leads, and leaves out leads the rep contacted or that are on today's calls", async () => {
    await clearCache(h.redis);
    const d = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
    const picked = d.aiPicks.map((p) => p.id);
    for (const id of [f.ids.hackensack, f.ids.staten, f.ids.acme, f.ids.brooklyn, f.ids.filler1]) expect(picked).not.toContain(id);
    const owners = await h.query<{ assigned_rep_id: string | null }>(
      `SELECT assigned_rep_id::text FROM companies WHERE id = ANY($1::uuid[])`, picked);
    for (const o of owners) expect([null, f.users.rep1]).toContain(o.assigned_rep_id);
    // filler1 is on the call list (new, strategic): its pitch is there instead.
    expect(d.callPitches).toEqual({ [f.ids.filler1]: 'Ask about their spring backlog.' });
    // A manager looking at rep1's dashboard gets the same picks (one cache entry).
    const viewed = (await get(`/dashboard?scope=rep:${f.users.rep1}`, f.users.manager, 'manager')).body as SalesDashboard;
    expect(viewed.aiPicks).toEqual(d.aiPicks);
  });

  it("gives the team unallocated leads nobody contacted, without today's team calls", async () => {
    await clearCache(h.redis);
    const d = (await get('/dashboard', f.users.manager, 'manager')).body as SalesDashboard;
    // jersey is fresh from the latest run (a team call today); the strategic new leads are calls too.
    expect(d.aiPicks.map((p) => [p.id, p.label])).toEqual([
      [f.ids.filler0, 'new'], [f.ids.queens, 'top_match'], [f.ids.williamsburg, 'top_match'],
    ]);
    expect(d.callPitches).toMatchObject({
      [f.ids.jersey]: 'Lead with same-day TPO delivery.', [f.ids.hackensack]: 'Pitch the metal panel line.',
      [f.ids.filler1]: 'Ask about their spring backlog.',
    });
  });

  it('fills the picks with top matches when nothing is new, and shows an insight write after the cache entry expires', async () => {
    await h.exec(`UPDATE companies SET first_seen_at = '2026-09-01' WHERE id = $1::uuid`, f.ids.filler0);
    try {
      await clearCache(h.redis);
      const before = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
      expect(before.aiPicks.every((p) => p.label === 'top_match')).toBe(true);
      expect(before.aiPicks.map((p) => p.id)).toEqual([f.ids.jersey, f.ids.queens, f.ids.williamsburg]);
      await insight(f.ids.soho, 'SoHo Slate restores slate roofs.', 'Bring slate samples.', { at: '2026-10-18' });
      expect(((await get('/dashboard', f.users.rep1)).body as SalesDashboard).aiPicks).toHaveLength(3);
      await h.redis.del(`dash:${f.users.rep1}`);
      const after = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
      expect(after.aiPicks.map((p) => p.id)).toEqual([f.ids.jersey, f.ids.queens, f.ids.soho, f.ids.williamsburg]);
    } finally {
      await h.exec(`UPDATE companies SET first_seen_at = now() - interval '2 days' WHERE id = $1::uuid`, f.ids.filler0);
      await h.exec(`DELETE FROM company_insights WHERE company_id = $1::uuid`, f.ids.soho);
    }
  });
});
