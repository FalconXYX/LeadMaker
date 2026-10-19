// Section 4 read API: GET /leads/:id/ai-context, /filter-vocabulary and /territory-brief against the test database.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_CONTEXT_LIMITS, type FilterVocabulary, type LeadAiContext, type TerritoryBriefResponse } from '@leadmaker/shared';
import { as, clearCache, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

// Anything that looks like an email address or a North American phone number.
const CONTACT_DATA = /@|\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

describe.skipIf(!TEST_DATABASE_URL)('Section 4 read API', () => {
  let h: Harness;
  let f: Fixture;

  const getAs = (path: string, user: string, role: 'rep' | 'manager' = 'rep') => request(h.app).get(path).set(as(user, role));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    const { acme, hackensack } = f.ids;
    const { rep1, rep2, manager } = f.users;
    await h.exec(`INSERT INTO contacts (company_id, name, title, email, phone, source, confidence) VALUES
      ($1::uuid, 'Pat Office', 'Office Manager', 'pat@acme.test', NULL, 'website', 0.9),
      ($1::uuid, 'Jane Owner', 'Owner', NULL, '(212) 555-0199', 'bbb', 0.5)`, acme);
    for (let i = 0; i < 16; i++) {
      await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text, created_at)
        VALUES ($1::uuid, 'user', $2::uuid, 'note', $3, $4::timestamptz)`, acme, rep1,
        i === 15 ? `Newest: call Jane at 212-555-0199 or jane.owner@acme.test about ${'volume '.repeat(150)}` : `Note ${i}`,
        new Date(Date.UTC(2026, 9, 1 + i)).toISOString());
    }
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, outcome, note_text, created_at) VALUES
      ($1::uuid, 'user', $2::uuid, 'call', 'connected', 'Owner wants a quote on 40 squares', '2026-10-17T15:00:00Z'),
      ($1::uuid, 'user', $2::uuid, 'checked', NULL, NULL, '2026-10-17T16:00:00Z')`, acme, rep1);
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
      VALUES ($1::uuid, 'user', $2::uuid, 'stage_changed', '{"sales_stage": ["contacted", "interested"]}', '2026-10-17T17:00:00Z')`, acme, rep1);
    await h.exec(`INSERT INTO tasks (company_id, title, type, due_at, assignee_id, created_by) VALUES
      ($1::uuid, 'Send the quote', 'email', '2026-10-21T14:00:00Z', $2::uuid, $2::uuid)`, acme, rep1);
    const long = (word: string) => `${word} `.repeat(800);
    await h.exec(`INSERT INTO enrichments (company_id, source, status, data) VALUES
      ($1::uuid, 'website_crawl', 'ok', $2::jsonb), ($1::uuid, 'llm_extract', 'ok', $3::jsonb)`, acme,
      JSON.stringify({ pages: [
        { url: 'https://acme.test/', title: 'Home', text: `Call us at (212) 555-0100. ${long('roofing')}` },
        { url: 'https://acme.test/about', title: 'About', text: long('family') },
        { url: 'https://acme.test/contact', title: 'Contact', text: `Email office@acme.test ${long('contact')}` },
      ] }),
      JSON.stringify({ summary: 'A family roofer; reach them at info@acme.test.' }));
    await h.exec(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation, product_focus, model, prompt_version, input_hash)
      VALUES ($1::uuid, 'Acme is a Master Elite roofer.', 'Lead with architectural shingles.', '["architectural_shingles"]',
              'fake:fake-1', 'insights/v1', 'h1')`, acme);
    // Custom tags: one on a lead every viewer sees, one only on rep2's lead.
    const tag = async (name: string, company: string) => {
      const [{ id }] = await h.query<{ id: string }>(`INSERT INTO custom_tags (name, created_by) VALUES ($1, $2::uuid) RETURNING id`, name, manager);
      await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`, company, id, manager);
    };
    await tag('Bulk buyer', acme);
    await tag('Rep2 secret', hackensack);
    void rep2;
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  describe('GET /leads/:id/ai-context', () => {
    it('gives the allocated rep a sized, contact-free view of the lead', async () => {
      const res = await getAs(`/leads/${f.ids.acme}/ai-context`, f.users.rep1);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const c = res.body as LeadAiContext;
      expect(c).toMatchObject({
        id: f.ids.acme, businessName: 'Acme Roofing', city: 'New York', state: 'NY', postalCode: '10013',
        countyFips: '36061', countyName: 'New York County, NY', websiteUrl: 'https://example.com',
        size: 'large', segment: 'strategic', priorityScore: 90, priorityDrivers: ['GAF tier', 'Review volume'],
        accountStatus: 'prospect', salesStage: 'new', assignedRep: { id: f.users.rep1, name: 'Riley Rep' }, canWrite: true,
        customTags: ['Bulk buyer'],
        customFields: { po_number: 'PO-1001', budget: 5000, next_visit: '2026-11-01', brands: ['GAF', 'Owens'] },
        targetContact: { label: 'Ask for: Jane Owner', name: 'Jane Owner', title: 'Owner' },
        insights: { businessSummary: 'Acme is a Master Elite roofer.', productFocus: ['architectural_shingles'] },
        openTasks: [{ title: 'Send the quote', type: 'email', dueAt: '2026-10-21T14:00:00.000Z' }],
        websiteSummary: 'A family roofer; reach them at [email].',
      });
      expect(c.gaf).toMatchObject({ tier: null, rating: 4.9, reviewCount: 200, yearsInBusiness: new Date().getUTCFullYear() - 1990 });
      // The target first, then by confidence; only flags for email and phone.
      expect(c.contacts).toEqual([
        { name: 'Jane Owner', title: 'Owner', hasEmail: false, hasPhone: true, doNotContact: false, source: 'bbb' },
        { name: 'Pat Office', title: 'Office Manager', hasEmail: true, hasPhone: false, doNotContact: false, source: 'website' },
      ]);
      expect(c.tags.map((t) => t.key)).not.toContain('region');
      expect(c.tags.every((t) => t.category !== 'geography' && t.category !== 'data_quality')).toBe(true);
      expect(c.tags.map((t) => t.key)).toContain('gaf_tier');
    });

    it('caps notes, activity and website text to AI_CONTEXT_LIMITS', async () => {
      const c = (await getAs(`/leads/${f.ids.acme}/ai-context`, f.users.rep1)).body as LeadAiContext;
      expect(c.notes).toHaveLength(AI_CONTEXT_LIMITS.notes);
      expect(c.notes[0]).toMatchObject({ author: 'Riley R.', at: '2026-10-16T00:00:00.000Z' });
      expect(c.notes[0]!.text.length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.noteChars);
      expect(c.notes[0]!.text).toMatch(/^Newest: call Jane at \[phone\] or \[email\] about volume/);
      expect(c.notes[0]!.text.endsWith('…')).toBe(true);
      expect(c.notes.at(-1)!.text).toBe('Note 1');
      // Calls, emails, visits, stage and task changes only (no notes, no checked rows).
      expect(c.activity.map((a) => a.type)).toEqual(['stage_changed', 'call']);
      expect(c.activity[0]).toMatchObject({ author: 'Riley R.', text: 'stage Contacted -> Interested' });
      expect(c.activity[1]).toMatchObject({ outcome: 'connected', text: 'Owner wants a quote on 40 squares' });
      expect(c.website.map((p) => p.title)).toEqual(['Home', 'About', 'Contact']);
      for (const p of c.website) expect(p.text.length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.websitePageChars);
      expect(c.website.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.websiteChars);
      expect(c.website[0]!.text.startsWith('Call us at [phone].')).toBe(true);
    });

    it('never contains an email address or a phone number', async () => {
      for (const [id, user, role] of [
        [f.ids.acme, f.users.rep1, 'rep'], [f.ids.jersey, f.users.rep1, 'rep'], [f.ids.hackensack, f.users.manager, 'manager'],
      ] as const) {
        const res = await getAs(`/leads/${id}/ai-context`, user, role);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(CONTACT_DATA);
      }
    });

    it('applies the profile visibility: own and pool leads, not another rep\'s', async () => {
      const pool = await getAs(`/leads/${f.ids.jersey}/ai-context`, f.users.rep1);
      expect(pool.status).toBe(200);
      expect(pool.body).toMatchObject({ canWrite: false, assignedRep: null, insights: null, website: [], websiteSummary: null });
      const hidden = await getAs(`/leads/${f.ids.hackensack}/ai-context`, f.users.rep1);
      expect([hidden.status, hidden.body]).toEqual([404, { error: 'lead not found' }]);
      expect((await getAs('/leads/not-a-uuid/ai-context', f.users.rep1)).status).toBe(404);
      expect((await getAs(`/leads/${f.ids.hackensack}/ai-context`, f.users.rep2)).status).toBe(200);
      expect((await request(h.app).get(`/leads/${f.ids.acme}/ai-context`)).status).toBe(401);
    });

    it('is reachable under /api as the gateway forwards it', async () => {
      expect((await getAs(`/api/leads/${f.ids.acme}/ai-context`, f.users.rep1)).status).toBe(200);
    });
  });

  describe('GET /filter-vocabulary', () => {
    it('lists only what a rep can see, most leads first', async () => {
      const res = await getAs('/filter-vocabulary', f.users.rep1);
      expect([res.status, res.headers['x-cache']]).toEqual([200, 'miss']);
      const v = res.body as FilterVocabulary;
      const fips = v.counties.map((c) => c.fips);
      expect(fips).not.toContain('34003'); // hackensack (rep2)
      expect(fips).not.toContain('36085'); // staten (rep2)
      expect(v.counties[0]).toEqual({ fips: '36001', name: 'Albany County, NY', leadCount: 14 });
      expect(v.counties.find((c) => c.fips === '36061')).toMatchObject({ leadCount: 2, name: 'New York County, NY' });
      expect(v.counties.map((c) => c.leadCount)).toEqual([...v.counties.map((c) => c.leadCount)].sort((a, b) => b - a));
      expect(v.customTags.map((t) => [t.name, t.leadCount])).toEqual([['Bulk buyer', 1], ['Rep2 secret', 0]]);
      expect(v.customFieldKeys[0]).toEqual({ key: 'budget', valueType: 'number' });
      expect(v.customFieldKeys.map((k) => k.key).sort()).toEqual(['brands', 'budget', 'next_visit', 'po_number']);
      expect(v.reps).toEqual([]);
    });

    it('gives managers every county and the reps', async () => {
      const v = (await getAs('/filter-vocabulary', f.users.manager, 'manager')).body as FilterVocabulary;
      expect(v.counties.map((c) => c.fips)).toEqual(expect.arrayContaining(['34003', '36085']));
      expect(v.customTags.map((t) => [t.name, t.leadCount])).toEqual([['Bulk buyer', 1], ['Rep2 secret', 1]]);
      expect(v.reps).toEqual([
        { id: f.users.rep1, name: 'Riley Rep' }, { id: f.users.rep2, name: 'Sam Rep' }, { id: f.users.rep3, name: 'Taylor Rep' },
      ]);
    });

    it('caches per rep and once for managers, and bypasses right after a write', async () => {
      await getAs('/filter-vocabulary', f.users.rep1);
      expect((await getAs('/filter-vocabulary', f.users.rep1)).headers['x-cache']).toBe('hit');
      expect(await h.redis.ttl(`vocab:${f.users.rep1}`)).toBeGreaterThan(250);
      expect((await getAs('/filter-vocabulary', f.users.rep2)).headers['x-cache']).toBe('miss');
      await getAs('/filter-vocabulary', f.users.manager, 'manager');
      expect(await h.redis.exists('vocab:mgr')).toBe(1);
      await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
      expect((await getAs('/filter-vocabulary', f.users.rep1)).headers['x-cache']).toBe('bypass');
    });
  });

  describe('GET /territory-brief', () => {
    const teamDigest = () => ({
      v: 1, scope: 'team', as_of: '2026-10-19T17:00:00Z', book: { leads: 4 },
      poll: { run_id: null, finished_at: '2026-10-18T22:10:00Z', fresh: true, new: 3, changed: 1, delisted: 0, highlights: [] },
      pool: { new: 2 }, weather: { alerts: [], storm_response: [], storm_response_total: 0, weather_delays_total: 0 },
      leads: [{ id: f.ids.acme, name: 'Acme Roofing' }, { id: f.ids.hackensack, name: 'Hackensack Metal Works' }],
    });
    const insertBrief = (scope: string, digest: unknown, text: string, hash: string, quiet = false, computedAt = 'now()') =>
      h.exec(`INSERT INTO territory_briefs (scope, digest, digest_text, digest_hash, quiet, computed_at)
        VALUES ($1, $2::jsonb, $3, $4, $5, ${computedAt})
        ON CONFLICT (scope) DO UPDATE SET digest = EXCLUDED.digest, digest_text = EXCLUDED.digest_text,
          digest_hash = EXCLUDED.digest_hash, quiet = EXCLUDED.quiet, computed_at = EXCLUDED.computed_at`,
      scope, JSON.stringify(digest), text, hash, quiet);
    const insertRewrite = (scope: string, hash: string, text: string, at: string) =>
      h.exec(`INSERT INTO territory_brief_rewrites (scope, digest_hash, prompt_version, model, ai_text, generated_at)
        VALUES ($1, $2, 'briefing/v1', 'fake:fake-1', $3, $4::timestamptz)`, scope, hash, text, at);

    beforeAll(async () => {
      await h.exec('DELETE FROM territory_brief_rewrites');
      await h.exec('DELETE FROM territory_briefs');
    });

    it('returns {brief: null} before the worker has computed one', async () => {
      const res = await getAs('/territory-brief', f.users.manager, 'manager');
      expect([res.status, res.body]).toEqual([200, { brief: null }]);
    });

    it('serves the AI rewrite only while it matches the current digest', async () => {
      await insertBrief('team', teamDigest(), 'Since Saturday\'s poll: 3 new leads, 1 changed across the team.', 'hash-2');
      await insertRewrite('team', 'hash-1', 'An old rewrite of an older digest.', '2026-10-19T10:00:00Z');
      await insertRewrite('team', 'hash-2', 'Three new leads arrived in the last poll, led by Acme Roofing.', '2026-10-18T23:00:00Z');
      const res = await getAs('/territory-brief?scope=team', f.users.manager, 'manager');
      expect(res.status).toBe(200);
      expect((res.body as TerritoryBriefResponse).brief).toMatchObject({
        scope: 'team', text: 'Three new leads arrived in the last poll, led by Acme Roofing.', source: 'ai', quiet: false,
        stale: false, digestText: "Since Saturday's poll: 3 new leads, 1 changed across the team.",
        generatedAt: '2026-10-18T23:00:00.000Z', model: 'fake:fake-1', promptVersion: 'briefing/v1',
        pollFinishedAt: '2026-10-18T22:10:00.000Z',
        leads: [{ id: f.ids.acme, name: 'Acme Roofing' }, { id: f.ids.hackensack, name: 'Hackensack Metal Works' }],
      });
      // A newer digest without a rewrite: the deterministic text (after the 60 s cache).
      await insertBrief('team', teamDigest(), 'Since Saturday\'s poll: 4 new leads across the team.', 'hash-3');
      expect((await getAs('/territory-brief', f.users.manager, 'manager')).headers['x-cache']).toBe('hit');
      await clearCache(h.redis);
      const next = (await getAs('/territory-brief', f.users.manager, 'manager')).body as TerritoryBriefResponse;
      expect(next.brief).toMatchObject({
        text: 'Since Saturday\'s poll: 4 new leads across the team.', source: 'digest', generatedAt: null, model: null, promptVersion: null,
      });
      expect(await h.redis.ttl('brief:team')).toBeGreaterThan(0);
      expect(await h.redis.ttl('brief:team')).toBeLessThanOrEqual(60);
      // A rejected rewrite is stored as an empty marker (the worker's negative cache): never served.
      await insertRewrite('team', 'hash-3', '', '2026-10-19T12:00:00Z');
      await clearCache(h.redis);
      const marked = (await getAs('/territory-brief', f.users.manager, 'manager')).body as TerritoryBriefResponse;
      expect(marked.brief).toMatchObject({ text: 'Since Saturday\'s poll: 4 new leads across the team.', source: 'digest', model: null });
    });

    it('lets a rep read only their own scope and filters named leads by visibility', async () => {
      const scope = `rep:${f.users.rep1}`;
      await insertBrief(scope, { ...teamDigest(), scope }, '3 new leads in this territory.', 'r1');
      for (const q of ['', '?scope=mine', `?scope=${scope}`, `?scope=rep:${f.users.rep1.toUpperCase()}`]) {
        const res = await getAs(`/territory-brief${q}`, f.users.rep1);
        expect(res.status).toBe(200);
        expect(res.body.brief).toMatchObject({ scope, text: '3 new leads in this territory.', source: 'digest' });
        // hackensack is rep2's: the shared cache entry keeps it, this rep's answer doesn't.
        expect(res.body.brief.leads).toEqual([{ id: f.ids.acme, name: 'Acme Roofing' }]);
      }
      expect((await getAs(`/territory-brief?scope=${scope}`, f.users.manager, 'manager')).body.brief.leads).toHaveLength(2);
      expect((await getAs('/territory-brief?scope=team', f.users.rep1)).status).toBe(403);
      expect((await getAs(`/territory-brief?scope=rep:${f.users.rep2}`, f.users.rep1)).body).toEqual({ error: 'forbidden' });
      expect((await getAs(`/territory-brief?scope=rep:${f.users.rep2}`, f.users.rep1)).status).toBe(403);
    });

    it('rejects scopes that are not a brief scope', async () => {
      for (const q of ['all', 'rep:nope', 'rep:', 'pool']) {
        expect((await getAs(`/territory-brief?scope=${q}`, f.users.manager, 'manager')).status).toBe(400);
      }
      expect((await getAs('/territory-brief?scope=team&scope=mine', f.users.manager, 'manager')).status).toBe(400);
    });

    it('maps a manager\'s "mine" to the team, and flags quiet and stale briefs', async () => {
      expect((await getAs('/territory-brief?scope=mine', f.users.manager, 'manager')).body.brief.scope).toBe('team');
      const quietScope = `rep:${f.users.rep2}`;
      await insertBrief(quietScope, { ...teamDigest(), scope: quietScope, poll: null, leads: [] }, '', 'q', true,
        `now() - interval '40 hours'`);
      const res = await getAs('/territory-brief', f.users.rep2);
      expect(res.body.brief).toMatchObject({
        scope: quietScope, text: '', source: 'digest', quiet: true, stale: true, pollFinishedAt: null, leads: [],
      });
      expect((await getAs(`/territory-brief?scope=rep:${f.users.rep3}`, f.users.manager, 'manager')).body).toEqual({ brief: null });
    });
  });
});
