import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LeadProfile } from '@leadmaker/shared';
import { as, clearCache, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

describe.skipIf(!TEST_DATABASE_URL)('GET /leads/:id', () => {
  let h: Harness;
  let f: Fixture;
  let contactId: string;

  const get = (id: string, user: string, role: 'rep' | 'manager' = 'rep') =>
    request(h.app).get(`/leads/${id}`).set(as(user, role));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    const { acme } = f.ids;
    const { rep1, rep2, manager } = f.users;
    await h.exec(`INSERT INTO company_source_ids (source, external_id, company_id) VALUES ('gaf', '1001', $1::uuid)`, acme);
    contactId = (await h.query<{ id: string }>(`INSERT INTO contacts (company_id, name, title, email, phone, source, confidence)
      VALUES ($1::uuid, 'Jane Owner', 'Owner', NULL, '(212) 555-0199', 'bbb', 0.9),
             ($1::uuid, 'Pat Office', 'Office Manager', 'pat@acme.test', NULL, 'website', 0.6) RETURNING id`, acme))[0].id;
    // Company override (source unchanged since) and phone override (source changed since the edit).
    await h.exec(`INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id) VALUES
      ($1::uuid, 'business_name', '"Acme Roofing & Sons"', '"Acme Roofing"', $2::uuid),
      ($1::uuid, 'phone', '"(212) 555-7777"', '"(212) 555-0000"', $2::uuid)`, acme, rep1);
    await h.exec(`INSERT INTO field_overrides (company_id, contact_id, field, value, scraped_value_at_edit, user_id)
      VALUES ($1::uuid, $2::uuid, 'email', '"jane@acme.test"', 'null', $3::uuid)`, acme, contactId, manager);
    await h.exec(`INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id, superseded_at)
      VALUES ($1::uuid, 'city', '"Old"', '"New York"', $2::uuid, now())`, acme, rep1);
    const [{ id: tagId }] = await h.query<{ id: string }>(
      `INSERT INTO custom_tags (name, created_by) VALUES ('Hot Lead', $1::uuid) RETURNING id`, rep1);
    await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`, acme, tagId, rep1);
    await h.exec(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation, model, prompt_version, input_hash, generated_at)
      VALUES ($1::uuid, 'Old summary', 'Old pitch', 'm', 'v1', 'a', '2026-10-01')`, acme);
    await h.exec(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation, talking_points, target_contact,
        product_focus, cited_facts, model, prompt_version, input_hash, generated_at)
      VALUES ($1::uuid, 'New summary', 'New pitch', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, 'gemini:gemini-3.8-flash', 'insights/v1', 'b',
              '2026-10-15')`, acme, JSON.stringify(['Ask about their volume.', 'Follow up on deliveries.']),
      JSON.stringify({ name: 'Jane Owner', title: 'Owner', why: 'Signs off on suppliers.' }), JSON.stringify(['architectural_shingles']),
      JSON.stringify([{ id: 'F1', text: 'business_name: Acme Roofing' }, { id: 'F3', text: 'gaf_tier: GAF Master Elite' }]));
    // A newer failed generation: never served.
    await h.exec(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation, model, prompt_version, input_hash,
        generated_at, status, error, attempts)
      VALUES ($1::uuid, '', '', 'm', 'insights/v1', 'c', '2026-10-16', 'error', 'L1: cited F19, which does not exist', 2)`, acme);
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text, created_at) VALUES
      ($1::uuid, 'user', $2::uuid, 'note', 'Called, owner out until Monday', '2026-10-14T15:00:00Z'),
      ($1::uuid, 'user', $3::uuid, 'note', 'Manager note', '2026-10-15T15:00:00Z'),
      ($1::uuid, 'pipeline', NULL, 'scraped_change', NULL, '2026-10-16T15:00:00Z')`, acme, rep1, manager);
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, outcome, created_at)
      VALUES ($1::uuid, 'user', $2::uuid, 'call', 'voicemail', '2026-10-13T15:00:00Z')`, acme, rep1);
    await h.exec(`INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at) VALUES
      ($1::uuid, $2::uuid, '2026-10-12T00:00:00Z', '2026-10-13T15:00:00Z'),
      ($1::uuid, $3::uuid, '2026-10-01T00:00:00Z', NULL)`, acme, rep1, manager);
    await h.exec(`UPDATE companies SET team_last_checked_at = '2026-10-12T00:00:00Z', team_last_serviced_at = '2026-10-13T15:00:00Z'
      WHERE id = $1::uuid`, acme);
    // An active storm warning in acme's county and one in another county.
    const alert = (county: string, event: string) => h.exec(`INSERT INTO regional_signals
      (county_fips, kind, source, external_id, payload, valid_from, valid_to)
      VALUES ($1, 'active_alert', 'nws', $2, $3::jsonb, now() - interval '1 hour', now() + interval '2 hours')`,
      county, `${county}-${event}`, JSON.stringify({ event }));
    await alert('36061', 'Severe Thunderstorm Warning');
    await alert('34003', 'Tornado Warning');
    await h.exec(`INSERT INTO regional_signals (county_fips, kind, source, external_id, payload, valid_from, valid_to)
      VALUES ('36061', 'active_alert', 'nws', 'old', '{"event": "High Wind Warning"}', now() - interval '20 days', now() - interval '19 days')`);
    // A reassignment history: rep2 had it first.
    await h.exec(`UPDATE lead_allocations SET allocated_at = '2026-10-05T00:00:00Z' WHERE company_id = $1::uuid`, acme);
    await h.exec(`INSERT INTO lead_allocations (company_id, rep_id, allocated_by, allocated_at, ended_at, ended_by)
      VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-20T00:00:00Z', '2026-10-05T00:00:00Z', $3::uuid)`, acme, rep2, manager);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  it('builds the full profile for the allocated rep', async () => {
    const res = await get(f.ids.acme, f.users.rep1);
    expect(res.status).toBe(200);
    const p = res.body as LeadProfile;
    expect(p.id).toBe(f.ids.acme);
    expect(p.fields.business_name).toMatchObject({
      value: 'Acme Roofing & Sons', scraped: 'Acme Roofing', overridden: true, sourceChangedSinceEdit: false,
      editedBy: { id: f.users.rep1, name: 'Riley Rep' },
    });
    expect(p.fields.phone).toMatchObject({ value: '(212) 555-7777', scraped: '(212) 555-0100', overridden: true, sourceChangedSinceEdit: true });
    expect(p.fields.city).toMatchObject({ value: 'New York', overridden: false, editedBy: null });
    expect(p.details).toMatchObject({ rating: 4.9, inBusinessSince: 1990, segment: 'strategic', sourceIds: [{ source: 'gaf', externalId: '1001' }] });
    const jane = p.contacts.find((c) => c.name.value === 'Jane Owner')!;
    expect(jane.email).toMatchObject({ value: 'jane@acme.test', scraped: null, overridden: true, sourceChangedSinceEdit: false,
                                      editedBy: { id: f.users.manager, name: 'Morgan Manager' } });
    expect(jane.isTarget).toBe(true);
    expect(p.contacts.map((c) => c.name.value)).toEqual(['Jane Owner', 'Pat Office']);
    expect(p.targetContact).toMatchObject({ role: 'owner', contactId: jane.id });
    expect(p.systemTags.find((t) => t.key === 'gaf_tier')).toMatchObject({ value: 'master_elite', reason: 'gaf_tier reason', source: 'gaf' });
    expect(p.customTags).toMatchObject([{ name: 'Hot Lead', addedBy: { id: f.users.rep1 } }]);
    expect(p.customFields).toMatchObject({ po_number: 'PO-1001', budget: 5000 });
    expect(p.insights).toEqual({
      businessSummary: 'New summary', salesRecommendation: 'New pitch',
      talkingPoints: ['Ask about their volume.', 'Follow up on deliveries.'],
      targetContact: { name: 'Jane Owner', title: 'Owner', why: 'Signs off on suppliers.' },
      productFocus: ['architectural_shingles'],
      citedFacts: [{ id: 'F1', text: 'business_name: Acme Roofing' }, { id: 'F3', text: 'gaf_tier: GAF Master Elite' }],
      model: 'gemini:gemini-3.8-flash', promptVersion: 'insights/v1', generatedAt: '2026-10-15T00:00:00.000Z',
    });
    // The newer failed attempt is not served as text, but insightAttempt reports it (status only, no reason).
    expect(p.insightAttempt).toEqual({ status: 'error', at: '2026-10-16T00:00:00.000Z' });
    expect(p.timing.map((b) => b.key)).toEqual(['storm_response', 'season']);
    expect(p.timing[0]).toMatchObject({ severity: 'medium', label: 'Storm response: Severe Thunderstorm Warning' });
    expect(p.notes.map((n) => n.text)).toEqual(['Manager note', 'Called, owner out until Monday']);
    expect(p.activity.map((a) => a.type)).toEqual(['scraped_change', 'note', 'note', 'call']);
    expect(p.activity[3]).toMatchObject({ outcome: 'voicemail', user: { id: f.users.rep1, name: 'Riley Rep' } });
    expect(p.allocation.current).toMatchObject({ rep: { id: f.users.rep1 }, allocatedBy: { id: f.users.manager }, endedAt: null });
    expect(p.allocation.history.map((a) => a.rep.id)).toEqual([f.users.rep1, f.users.rep2]);
    expect(p.state.mine).toEqual({ checked: true, serviced: true, checkedAt: '2026-10-12T00:00:00.000Z', servicedAt: '2026-10-13T15:00:00.000Z' });
    expect(p.state.team).toMatchObject({ checked: true, serviced: true });
    expect(p.state.team.byUser.map((s) => [s.user.name, s.checked])).toEqual([['Morgan Manager', false], ['Riley Rep', true]]);
    expect(p.permissions).toEqual({ canWrite: true, canAllocate: false });
  });

  it('keeps the target contact after a rep corrects that contact\'s name', async () => {
    await h.exec(`INSERT INTO field_overrides (company_id, contact_id, field, value, scraped_value_at_edit, user_id)
      VALUES ($1::uuid, $2::uuid, 'name', '"Jane Owner-Smith"', '"Jane Owner"', $3::uuid)`, f.ids.acme, contactId, f.users.rep1);
    try {
      const p = (await get(f.ids.acme, f.users.rep1)).body as LeadProfile;
      const jane = p.contacts.find((c) => c.id === contactId)!;
      expect(jane.name).toMatchObject({ value: 'Jane Owner-Smith', scraped: 'Jane Owner', overridden: true });
      expect(jane.isTarget).toBe(true);
      expect(p.targetContact?.contactId).toBe(contactId);
    } finally {
      await h.exec(`DELETE FROM field_overrides WHERE contact_id = $1::uuid AND field = 'name'`, contactId);
    }
  });

  it('shows the same lead to a manager with their own state', async () => {
    const p = (await get(f.ids.acme, f.users.manager, 'manager')).body as LeadProfile;
    expect(p.state.mine).toMatchObject({ checked: false, serviced: false, checkedAt: '2026-10-01T00:00:00.000Z' });
    expect(p.permissions).toEqual({ canWrite: true, canAllocate: true });
  });

  it('lets a rep view, not act on, an unallocated lead (notes included)', async () => {
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text)
      VALUES ($1::uuid, 'user', $2::uuid, 'note', 'Pool note')`, f.ids.jersey, f.users.manager);
    const p = (await get(f.ids.jersey, f.users.rep1)).body as LeadProfile;
    expect(p.permissions.canWrite).toBe(false);
    expect(p.notes.map((n) => n.text)).toEqual(['Pool note']);
    expect(p.allocation.current).toBeNull();
    expect(p.insights).toBeNull();
    expect(p.insightAttempt).toBeNull();
    expect(p.details.inBusinessSince).toBe(1975);
  });

  it('returns 404 for another rep\'s lead, a missing lead and a malformed id', async () => {
    const hidden = await get(f.ids.hackensack, f.users.rep1);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'lead not found' });
    expect((await get('00000000-0000-4000-8000-000000000000', f.users.rep1)).status).toBe(404);
    expect((await get('not-a-uuid', f.users.rep1)).status).toBe(404);
    expect((await get(f.ids.hackensack, f.users.rep2)).status).toBe(200);
    expect(await h.redis.keys(`lead:${f.ids.hackensack}:*`)).toHaveLength(1);
  });

  it('never serves an invisible lead from the cache', async () => {
    await get(f.ids.hackensack, f.users.manager, 'manager');
    expect(await h.redis.keys(`lead:${f.ids.hackensack}:*`)).toHaveLength(1);
    expect((await get(f.ids.hackensack, f.users.rep1)).status).toBe(404);
  });

  it('caches the version-bound part per version, shared across viewers, and invalidates by version', async () => {
    const first = await get(f.ids.acme, f.users.rep1);
    expect(first.headers['x-cache']).toBe('miss');
    const v = first.body.version as number;
    expect(await h.redis.exists(`lead:${f.ids.acme}:v${v}`)).toBe(1);
    expect(await h.redis.ttl(`lead:${f.ids.acme}:v${v}`)).toBeGreaterThan(3600);
    expect((await get(f.ids.acme, f.users.manager, 'manager')).headers['x-cache']).toBe('hit');

    // Bookkeeping (no version bump): still served from the cache, so the change is not visible.
    await h.exec(`UPDATE companies SET last_seen_at = now(), profile_error = 'x' WHERE id = $1::uuid`, f.ids.acme);
    const kept = await get(f.ids.acme, f.users.rep1);
    expect([kept.headers['x-cache'], kept.body.version]).toEqual(['hit', v]);

    // A rep-visible change bumps the version: the next read misses and is fresh.
    await h.exec(`UPDATE companies SET description = 'Family-run since 1990' WHERE id = $1::uuid`, f.ids.acme);
    const second = await get(f.ids.acme, f.users.rep1);
    expect(second.headers['x-cache']).toBe('miss');
    expect(second.body.version).toBe(v + 1);
    expect(second.body.details.description).toBe('Family-run since 1990');
    expect((await get(f.ids.acme, f.users.manager, 'manager')).headers['x-cache']).toBe('hit');
  });

  it('serves a new insight on the next read without a version bump while the body stays cached (D4)', async () => {
    const first = await get(f.ids.acme, f.users.rep1);
    const v = first.body.version as number;
    expect(first.body.insights.businessSummary).toBe('New summary');
    const [{ id }] = await h.query<{ id: string }>(`INSERT INTO company_insights (company_id, business_summary, sales_recommendation,
        model, prompt_version, input_hash, generated_at)
      VALUES ($1::uuid, 'Newest summary', 'Newest pitch', 'fake:fake-1', 'insights/v1', 'd', now()) RETURNING id`, f.ids.acme);
    try {
      const second = await get(f.ids.acme, f.users.rep1);
      expect([second.headers['x-cache'], second.body.version]).toEqual(['hit', v]);
      expect(second.body.insights).toMatchObject({ businessSummary: 'Newest summary', talkingPoints: [], targetContact: null, citedFacts: [] });
      expect(second.body.insightAttempt).toEqual({ status: 'ok', at: second.body.insights.generatedAt });
      // A body cached before insights moved to the head still holds one: it is ignored.
      const k = `lead:${f.ids.acme}:v${v}`;
      const cached = JSON.parse((await h.redis.get(k))!);
      expect(cached).not.toHaveProperty('insight');
      await h.redis.set(k, JSON.stringify({ ...cached, insight: { business_summary: 'CACHED', sales_recommendation: 'CACHED' } }));
      const third = await get(f.ids.acme, f.users.manager, 'manager');
      expect([third.headers['x-cache'], third.body.insights.businessSummary]).toEqual(['hit', 'Newest summary']);
    } finally {
      await h.exec(`DELETE FROM company_insights WHERE id = $1::uuid`, id);
    }
  });

  it('keeps per-user state, notes and timing out of the shared cache entry', async () => {
    await get(f.ids.acme, f.users.manager, 'manager');
    await h.exec(`INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text)
      VALUES ($1::uuid, 'user', $2::uuid, 'note', 'Fresh note')`, f.ids.acme, f.users.rep1);
    const res = await get(f.ids.acme, f.users.rep1);
    expect(res.headers['x-cache']).toBe('hit');
    expect(res.body.notes[0].text).toBe('Fresh note');
    expect(res.body.state.mine.checked).toBe(true);
    expect(res.body.permissions.canWrite).toBe(true);
    const cached = JSON.parse((await h.redis.get(`lead:${f.ids.acme}:v${res.body.version}`))!);
    expect(JSON.stringify(cached)).not.toContain('Fresh note');
    expect(cached).not.toHaveProperty('my_state');
  });

  it('serves the writer from the database right after their write (read-your-writes)', async () => {
    const first = await get(f.ids.acme, f.users.rep1);
    const k = `lead:${f.ids.acme}:v${first.body.version}`;
    const poisoned = JSON.parse((await h.redis.get(k))!);
    poisoned.business_name = 'STALE';
    await h.redis.set(k, JSON.stringify(poisoned));
    expect((await get(f.ids.acme, f.users.manager, 'manager')).body.fields.business_name.scraped).toBe('STALE');
    await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
    const fresh = await get(f.ids.acme, f.users.rep1);
    expect(fresh.headers['x-cache']).toBe('bypass');
    expect(fresh.body.fields.business_name.scraped).toBe('Acme Roofing');
  });

  it('still answers when Redis is unavailable', async () => {
    const { createApp } = await import('../src/app.ts');
    const { Cache } = await import('../src/cache.ts');
    const { Redis } = await import('ioredis');
    const { pino } = await import('pino');
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    const log = pino({ level: 'silent' });
    const app = createApp({ db: { primary: h.prisma, replica: h.prisma }, cache: new Cache(dead, log), log,
                            internalToken: 'test-internal-token', leadListTtlSeconds: 60 });
    const res = await request(app).get(`/leads/${f.ids.acme}`).set(as(f.users.rep1, 'rep'));
    expect(res.status).toBe(200);
    // Uncached from the normal read path (the replica), not 'bypass' (primary): unknown is not a recent write.
    expect(res.headers['x-cache']).toBe('miss');
    const list = await request(app).post('/leads/search').set(as(f.users.rep1, 'rep')).send({ filter: { scope: 'mine' } });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    dead.disconnect();
  });
});
