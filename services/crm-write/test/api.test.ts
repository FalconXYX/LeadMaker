import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, url, type Fixture, type User } from './harness.ts';

const h = new Harness();
const venvPython = new URL('../../../.venv/bin/python', import.meta.url).pathname;

describe.skipIf(!url)('crm-write API', () => {
  let f: Fixture;

  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(async () => {
    f = await h.reset();
  });

  describe('internal hop', () => {
    it('serves /health without credentials', async () => {
      const res = await h.as(f.rep1, { token: '' }).get('/health');
      expect(res.status).toBe(200);
    });

    it('rejects a missing or wrong internal token, and unknown users', async () => {
      const note = (r: ReturnType<typeof h.as>) => r.post(`/api/leads/${f.leads.own}/notes`, { text: 'x' });
      expect((await note(h.as(f.rep1, { token: '' }))).status).toBe(401);
      expect((await note(h.as(f.rep1, { token: 'wrong-token-of-other-len' }))).status).toBe(401);
      const ghost: User = { id: '7a1c4c8e-0000-4000-8000-000000000000', role: 'manager', name: 'Ghost' };
      expect((await note(h.as(ghost))).body).toEqual({ error: 'unauthorized', details: 'unknown user' });
      expect((await h.counts()).activity).toBe(0);
    });

    it('takes the role from the users row, not the header', async () => {
      const res = await h.as(f.rep1, { role: 'manager' }).post('/api/allocations', { companyIds: [f.leads.pool], repId: f.rep1.id });
      expect(res.status).toBe(403);
    });

    it('accepts paths without the /api prefix', async () => {
      expect((await h.as(f.rep1).post(`/leads/${f.leads.own}/notes`, { text: 'x' })).status).toBe(201);
    });
  });

  // Every lead write, with what it emits (one activity row per event). ctx is read fresh for each case.
  type Ctx = { lead: string; contact: string; version: number; contactVersion: number };
  type Write = { call: (r: ReturnType<typeof h.as>, c: Ctx) => Promise<{ status: number }>; event: string | string[] };
  const writes: Record<string, Write> = {
    note: { call: (r, c) => r.post(`/api/leads/${c.lead}/notes`, { text: 'Spoke to the owner' }), event: 'note.added' },
    // On a new lead, also its move to contacted.
    activity: {
      call: (r, c) => r.post(`/api/leads/${c.lead}/activities`, { type: 'call', outcome: 'interested' }),
      event: ['state.changed', 'lead.updated'],
    },
    stage: { call: (r, c) => r.put(`/api/leads/${c.lead}/stage`, { stage: 'quoting', version: c.version }), event: 'lead.updated' },
    task: {
      call: (r, c) => r.post(`/api/leads/${c.lead}/tasks`, { title: 'Send the TPO price sheet', type: 'email', dueAt: '2026-10-20' }),
      event: 'lead.updated',
    },
    state: { call: (r, c) => r.post(`/api/leads/${c.lead}/state`, { checked: true }), event: 'state.changed' },
    override: { call: (r, c) => r.put(`/api/leads/${c.lead}/overrides/phone`, { value: '(212) 555-0100', version: c.version }), event: 'override.set' },
    'contact override': {
      call: (r, c) => r.put(`/api/contacts/${c.contact}/overrides/email`, { value: 'owner@acme.com', version: c.contactVersion }),
      event: 'override.set',
    },
    'custom field': { call: (r, c) => r.put(`/api/leads/${c.lead}/custom-fields/po_number`, { value: 'PO-1', version: c.version }), event: 'lead.updated' },
    'custom tag': { call: (r, c) => r.post(`/api/leads/${c.lead}/custom-tags`, { tagId: f.tag }), event: 'tags.changed' },
    'add contact': { call: (r, c) => r.post(`/api/leads/${c.lead}/contacts`, { name: 'Sam Estimator' }), event: 'lead.updated' },
  };
  const cases: [string, 'rep1' | 'manager', 'own' | 'pool' | 'other', number][] = [
    ['rep on own lead', 'rep1', 'own', 2],
    ['rep on unallocated lead', 'rep1', 'pool', 403],
    ["rep on another rep's lead", 'rep1', 'other', 404],
    ['manager on unallocated lead', 'manager', 'pool', 2],
    ["manager on a rep's lead", 'manager', 'other', 2],
  ];

  describe.each(Object.entries(writes))('permission matrix: %s', (_name, w) => {
    it.each(cases)('%s', async (_label, who, which, expected) => {
      const actor = f[who];
      const lead = f.leads[which];
      const ctx: Ctx = {
        lead, contact: f.contacts[which], version: await h.version(lead),
        contactVersion: (await h.one<{ version: number }>('SELECT version FROM contacts WHERE id = $1::uuid', f.contacts[which])).version,
      };
      const res = await w.call(h.as(actor), ctx);
      const events = await h.outbox();
      const { activity } = await h.counts();
      if (expected === 2) {
        expect(res.status, JSON.stringify((res as { body?: unknown }).body)).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        // Exactly its outbox rows and as many activity rows, in the same transaction as the write.
        const types = [w.event].flat();
        expect(events.map((e) => e.event_type)).toEqual(types);
        for (const e of events) {
          expect(e).toMatchObject({
            company_id: lead,
            payload: { company_id: lead, actor_type: 'user', actor_id: actor.id, actor_name: actor.name, version: await h.version(lead) },
          });
        }
        expect(activity).toBe(types.length);
        if (h.redis) {
          const ttl = await h.redis.ttl(`rw:${actor.id}`);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(5);
        }
      } else {
        expect(res.status).toBe(expected);
        expect(events).toHaveLength(0);
        expect(activity).toBe(0);
        expect(await h.version(lead)).toBe(ctx.version);
        if (h.redis) expect(await h.redis.exists(`rw:${actor.id}`)).toBe(0);
      }
    });
  });

  it('applies the matrix to clearing overrides and unlinking tags too', async () => {
    for (const lead of [f.leads.pool, f.leads.other]) {
      await h.db.$executeRawUnsafe(
        `INSERT INTO field_overrides (company_id, field, value, user_id) VALUES ($1::uuid, 'phone', '"x"', $2::uuid)`, lead, f.manager.id);
      await h.db.$executeRawUnsafe(
        `INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`, lead, f.tag, f.manager.id);
    }
    const rep = h.as(f.rep1);
    expect((await rep.delete(`/api/leads/${f.leads.pool}/overrides/phone`, { version: 1 })).status).toBe(403);
    expect((await rep.delete(`/api/leads/${f.leads.other}/overrides/phone?version=1`)).status).toBe(404);
    expect((await rep.delete(`/api/leads/${f.leads.pool}/custom-tags/${f.tag}`)).status).toBe(403);
    expect((await rep.delete(`/api/leads/${f.leads.other}/custom-tags/${f.tag}`)).status).toBe(404);
    expect((await rep.delete(`/api/contacts/${f.contacts.other}/overrides/email?version=1`)).status).toBe(404);
    expect((await h.counts()).outbox).toBe(0);
    const mgr = h.as(f.manager);
    expect((await mgr.delete(`/api/leads/${f.leads.other}/overrides/phone?version=1`)).status).toBe(200);
    expect((await mgr.delete(`/api/leads/${f.leads.other}/custom-tags/${f.tag}`)).status).toBe(200);
    expect((await h.outbox()).map((e) => e.event_type)).toEqual(['override.set', 'tags.changed']);
  });

  it('returns 404 for leads that do not exist or are not ids, and 400 for bad bodies', async () => {
    const rep = h.as(f.rep1);
    expect((await rep.post('/api/leads/2d9f3c1a-0000-4000-8000-000000000000/notes', { text: 'x' })).status).toBe(404);
    expect((await rep.post('/api/leads/not-a-uuid/notes', { text: 'x' })).status).toBe(404);
    const blank = await rep.post(`/api/leads/${f.leads.own}/notes`, { text: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('invalid_request');
    expect((await rep.post(`/api/leads/${f.leads.own}/activities`, { type: 'fax' })).status).toBe(400);
    expect((await rep.post(`/api/leads/${f.leads.own}/state`, {})).body.error).toBe('nothing_to_change');
    expect((await rep.put(`/api/leads/${f.leads.own}/overrides/rating`, { value: 5, version: 1 })).body.error).toBe('unknown_field');
    expect((await rep.put(`/api/leads/${f.leads.own}/overrides/phone`, { version: 1 })).status).toBe(400);
    expect((await rep.put(`/api/contacts/${f.contacts.own}/overrides/email`, { value: 'nope', version: 1 })).status).toBe(400);
    const json = await rep.post(`/api/leads/${f.leads.own}/notes`).set('content-type', 'application/json').send('{bad');
    expect(json.status).toBe(400);
    expect((await h.counts()).outbox).toBe(0);
  });

  describe('notes and lead state', () => {
    it('appends notes with attribution and does not bump the lead version', async () => {
      const res = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/notes`, { text: '  Wants a quote on TPO  ' });
      expect(res.status).toBe(201);
      expect(res.body.note).toMatchObject({ companyId: f.leads.own, text: 'Wants a quote on TPO', userId: f.rep1.id, userName: 'Jordan Rep' });
      const row = await h.one<Record<string, unknown>>('SELECT * FROM activity_logs');
      expect(row).toMatchObject({ action_type: 'note', actor_type: 'user', user_id: f.rep1.id, note_text: 'Wants a quote on TPO' });
      expect(await h.version(f.leads.own)).toBe(1);
      expect((await h.outbox())[0].payload).toMatchObject({ note_id: res.body.note.id, assigned_rep_id: f.rep1.id, version: 1 });
    });

    it('keeps per-user checked/serviced state and derives team state from every user', async () => {
      const lead = f.leads.own;
      const team = () => h.one<{ c: Date | null; s: Date | null }>(
        'SELECT team_last_checked_at AS c, team_last_serviced_at AS s FROM companies WHERE id = $1::uuid', lead);
      const rep = await h.as(f.rep1).post(`/api/leads/${lead}/state`, { checked: true });
      expect(rep.body.state).toMatchObject({ checked: true, serviced: false, servicedAt: null });
      const repCheckedAt = rep.body.state.checkedAt;
      expect((await team()).c?.toISOString()).toBe(repCheckedAt);

      const mgr = await h.as(f.manager).post(`/api/leads/${lead}/state`, { checked: true, serviced: true });
      expect(mgr.body.team.lastCheckedAt).toBe(mgr.body.state.checkedAt);
      expect(mgr.body.team.lastServicedAt).toBe(mgr.body.state.servicedAt);

      // Clearing the manager's marks falls back to the most recent other user's.
      const cleared = await h.as(f.manager).post(`/api/leads/${lead}/state`, { checked: false, serviced: false });
      expect(cleared.body.state).toMatchObject({ checked: false, serviced: false, checkedAt: null, servicedAt: null });
      expect(cleared.body.team).toEqual({ lastCheckedAt: repCheckedAt, lastServicedAt: null });
      expect(await team()).toEqual({ c: new Date(repCheckedAt), s: null });

      const states = await h.all<{ user_id: string; checked_at: Date | null }>(
        'SELECT user_id, checked_at FROM lead_rep_state WHERE company_id = $1::uuid ORDER BY user_id', lead);
      expect(states).toHaveLength(2);
      const actions = await h.all<{ action_type: string; field_diff: Record<string, unknown> }>(
        "SELECT action_type, field_diff FROM activity_logs ORDER BY created_at, action_type");
      expect(actions.map((a) => a.action_type)).toEqual(['checked', 'checked', 'serviced', 'checked', 'serviced']);
      expect(actions[3].field_diff.checked_at).toEqual([mgr.body.state.checkedAt, null]);
      expect(await h.version(lead)).toBe(1);
    });

    it('marks a lead serviced when a call, email or visit is logged', async () => {
      const res = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/activities`, { type: 'visit', outcome: 'left_brochure', note: 'Met the foreman' });
      expect(res.status).toBe(201);
      expect(res.body.activity).toMatchObject({ type: 'visit', outcome: 'left_brochure', note: 'Met the foreman', userId: f.rep1.id });
      expect(res.body.state.serviced).toBe(true);
      expect(res.body.team.lastServicedAt).toBe(res.body.state.servicedAt);
      expect(await h.one('SELECT action_type, outcome, note_text FROM activity_logs ORDER BY created_at LIMIT 1'))
        .toEqual({ action_type: 'visit', outcome: 'left_brochure', note_text: 'Met the foreman' });
      expect((await h.outbox())[0].payload).toMatchObject({ activity_type: 'visit', serviced: true, user_id: f.rep1.id });
    });

    it('reports checked = false once the lead changed materially after the check', async () => {
      await h.db.$executeRawUnsafe(`UPDATE companies SET last_material_change_at = now() + interval '1 hour' WHERE id = $1::uuid`, f.leads.own);
      const res = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/state`, { checked: true });
      expect(res.body.state.checked).toBe(false);
    });
  });

  describe('overrides', () => {
    it('rejects a stale version with the current value, who changed it and when', async () => {
      const lead = f.leads.own;
      const first = await h.as(f.rep1).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0100', version: 1 });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ field: 'phone', value: '(212) 555-0100', version: 2, companyVersion: 2 });
      expect(first.body.override).toMatchObject({ value: '(212) 555-0100', scrapedValueAtEdit: '(212) 555-0000', userId: f.rep1.id });

      const stale = await h.as(f.manager).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0199', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({
        error: 'version_conflict',
        current: { version: 2, field: 'phone', value: '(212) 555-0100', scrapedValue: '(212) 555-0000', overridden: true },
        changedBy: { id: f.rep1.id, name: 'Jordan Rep' },
        changedByType: 'user',
        changedAt: expect.any(String),
      });
      const { updated_at } = await h.one<{ updated_at: Date }>('SELECT updated_at FROM companies WHERE id = $1::uuid', lead);
      expect(stale.body.changedAt).toBe(updated_at.toISOString());
      expect((await h.counts()).outbox).toBe(1);
      expect((await h.all('SELECT id FROM field_overrides'))).toHaveLength(1);

      // A pipeline change since: the conflict names no user.
      await h.db.$executeRawUnsafe(`UPDATE companies SET rating = 4.9 WHERE id = $1::uuid`, lead);
      await h.db.$executeRawUnsafe(
        `INSERT INTO audit_events (entity_type, entity_id, company_id, action, changes, at)
         VALUES ('company', $1::text, $1::text::uuid, 'updated', '{"rating": [null, 4.9]}', now() + interval '1 second')`, lead);
      const afterPipeline = await h.as(f.rep1).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0101', version: 2 });
      expect(afterPipeline.status).toBe(409);
      expect(afterPipeline.body).toMatchObject({ current: { version: 3 }, changedBy: null, changedByType: 'pipeline' });
    });

    it('survives a pipeline re-scrape and keeps what is needed to flag "source changed since your edit"', async () => {
      const lead = f.leads.own;
      await h.as(f.rep1).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0100', version: 1 });
      // The pipeline writes only the scraped column (the trigger bumps the version)...
      await h.db.$executeRawUnsafe(`UPDATE companies SET phone = '(212) 555-9999' WHERE id = $1::uuid`, lead);
      expect(await h.version(lead)).toBe(3);
      // ...so the rep's edit is untouched, and scraped_value_at_edit differs from the current scraped value.
      const active = await h.one<{ value: string; scraped_value_at_edit: string; scraped: string }>(
        `SELECT o.value, o.scraped_value_at_edit, c.phone AS scraped FROM field_overrides o JOIN companies c ON c.id = o.company_id
         WHERE o.superseded_at IS NULL`);
      expect(active).toEqual({ value: '(212) 555-0100', scraped_value_at_edit: '(212) 555-0000', scraped: '(212) 555-9999' });

      // A new edit supersedes the old one (one active per field) and records the new scraped value.
      const again = await h.as(f.manager).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0102', version: 3 });
      expect(again.status).toBe(200);
      expect(again.body.override.scrapedValueAtEdit).toBe('(212) 555-9999');
      const rows = await h.all<{ value: string; superseded_by: string | null; user_id: string }>(
        'SELECT value, superseded_by, user_id FROM field_overrides ORDER BY created_at');
      expect(rows).toEqual([
        { value: '(212) 555-0100', superseded_by: f.manager.id, user_id: f.rep1.id },
        { value: '(212) 555-0102', superseded_by: null, user_id: f.manager.id },
      ]);

      // Clearing falls back to the scraped value; clearing again finds nothing.
      const cleared = await h.as(f.rep1).delete(`/api/leads/${lead}/overrides/phone`, { version: 4 });
      expect(cleared.body).toMatchObject({ field: 'phone', value: '(212) 555-9999', override: null, version: 5 });
      expect((await h.all('SELECT 1 FROM field_overrides WHERE superseded_at IS NULL'))).toHaveLength(0);
      expect((await h.as(f.rep1).delete(`/api/leads/${lead}/overrides/phone?version=5`)).body.error).toBe('override_not_found');
      const diffs = await h.all<{ field_diff: Record<string, unknown> }>(
        "SELECT field_diff FROM activity_logs WHERE action_type = 'override' ORDER BY created_at");
      expect(diffs.map((d) => d.field_diff)).toEqual([
        { phone: ['(212) 555-0000', '(212) 555-0100'] },
        { phone: ['(212) 555-0100', '(212) 555-0102'] },
        { phone: ['(212) 555-0102', '(212) 555-9999'], cleared: true },
      ]);
    });

    it('locks contact overrides on the contact version and bumps the lead version too', async () => {
      const res = await h.as(f.rep1).put(`/api/contacts/${f.contacts.own}/overrides/do_not_contact`, { value: true, version: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 2, contactVersion: 2, companyVersion: 2, override: { contactId: f.contacts.own } });
      expect((await h.one<{ version: number }>('SELECT version FROM contacts WHERE id = $1::uuid', f.contacts.own)).version).toBe(2);
      const stale = await h.as(f.manager).put(`/api/contacts/${f.contacts.own}/overrides/do_not_contact`, { value: false, version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ current: { version: 2, value: true, scrapedValue: false, overridden: true }, changedBy: { id: f.rep1.id } });
      expect((await h.outbox())[0].payload).toMatchObject({ contact_id: f.contacts.own, field: 'do_not_contact', version: 2, contact_version: 2 });
      // A company-level override of the same name is a different field.
      const company = await h.as(f.rep1).put(`/api/leads/${f.leads.own}/overrides/phone`, { value: '1', version: 2 });
      expect(company.status).toBe(200);
      expect((await h.all('SELECT 1 FROM field_overrides WHERE superseded_at IS NULL'))).toHaveLength(2);
    });

    it('version-checks clearing an override like setting one', async () => {
      const lead = f.leads.own;
      await h.as(f.rep1).put(`/api/leads/${lead}/overrides/phone`, { value: '(212) 555-0100', version: 1 });
      const before = await h.counts();
      const stale = await h.as(f.manager).delete(`/api/leads/${lead}/overrides/phone`, { version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ current: { version: 2, value: '(212) 555-0100', overridden: true }, changedBy: { id: f.rep1.id } });
      expect(await h.counts()).toEqual(before);
      expect(await h.version(lead)).toBe(2);
      expect((await h.all('SELECT 1 FROM field_overrides WHERE superseded_at IS NULL'))).toHaveLength(1);
      expect((await h.as(f.manager).delete(`/api/leads/${lead}/overrides/phone`)).status).toBe(400);
    });

    it('allows null to blank a nullable field but not a required one', async () => {
      expect((await h.as(f.rep1).put(`/api/leads/${f.leads.own}/overrides/website_url`, { value: null, version: 1 })).status).toBe(200);
      expect((await h.as(f.rep1).put(`/api/leads/${f.leads.own}/overrides/business_name`, { value: null, version: 2 })).status).toBe(400);
      expect((await h.as(f.rep1).put(`/api/leads/${f.leads.own}/overrides/website_url`, { value: 'ftp://x', version: 2 })).status).toBe(400);
    });
  });

  describe('rep-added contacts', () => {
    type ContactDb = {
      source: string; source_key: string | null; name: string; title: string | null; email: string | null; phone: string | null;
      confidence: number; version: number; first_seen_at: Date; last_seen_at: Date;
    };
    const contactRow = (id: string) => h.one<ContactDb>(
      `SELECT source, source_key, name, title, email, phone, confidence, version, first_seen_at, last_seen_at
       FROM contacts WHERE id = $1::uuid`, id);
    const add = (who: User, lead: string, body: object = { name: 'Sam Estimator', title: 'Estimator' }) =>
      h.as(who).post(`/api/leads/${lead}/contacts`, body);

    it('creates a source=rep contact the pipeline cannot key, bumping the lead version with its activity and event', async () => {
      const lead = f.leads.own;
      const res = await add(f.rep1, lead, { name: ' Sam Estimator ', title: 'Estimator', email: 'sam@acme.com', phone: '(212) 555-0142' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        version: 2,
        contact: {
          companyId: lead, name: 'Sam Estimator', title: 'Estimator', email: 'sam@acme.com', phone: '(212) 555-0142',
          doNotContact: false, source: 'rep', confidence: 1, version: 1,
        },
      });
      const id = res.body.contact.id as string;
      const row = await contactRow(id);
      expect(row).toMatchObject({ source: 'rep', source_key: null, confidence: 1, version: 1 });
      expect(row.first_seen_at.getTime()).toBe(row.last_seen_at.getTime());
      expect(await h.version(lead)).toBe(2);
      const [activity] = await h.all<{ action_type: string; actor_type: string; user_id: string; field_diff: unknown }>(
        'SELECT action_type, actor_type, user_id, field_diff FROM activity_logs');
      expect(activity).toEqual({
        action_type: 'contact', actor_type: 'user', user_id: f.rep1.id,
        field_diff: {
          contact: [null, { name: 'Sam Estimator', title: 'Estimator', email: 'sam@acme.com', phone: '(212) 555-0142' }],
          contact_id: id,
        },
      });
      expect(await h.outbox()).toEqual([{
        event_type: 'lead.updated', company_id: lead,
        payload: {
          company_id: lead, fields: ['contacts'], contact_id: id, assigned_rep_id: f.rep1.id, version: 2,
          actor_type: 'user', actor_id: f.rep1.id, actor_name: 'Jordan Rep',
        },
      }]);
    });

    it('can then be edited through contact overrides on its own version', async () => {
      const created = await add(f.rep1, f.leads.own);
      const id = created.body.contact.id as string;
      // Adding it moved the lead version, so a stale lead write names who added it.
      const staleLead = await h.as(f.manager).put(`/api/leads/${f.leads.own}/overrides/phone`, { value: '1', version: 1 });
      expect(staleLead.body).toMatchObject({ current: { version: 2 }, changedBy: { id: f.rep1.id }, changedByType: 'user' });
      const put = await h.as(f.rep1).put(`/api/contacts/${id}/overrides/email`, { value: 'sam@acme.com', version: 1 });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ value: 'sam@acme.com', contactVersion: 2, companyVersion: 3, override: { contactId: id } });
      // A later pipeline change to another contact of the lead is not this contact's change.
      await h.db.$executeRawUnsafe(
        `INSERT INTO audit_events (entity_type, entity_id, company_id, action, changes, at)
         VALUES ('contact', 'some-source-key', $1::uuid, 'updated', '{"title": [null, "CEO"]}', now() + interval '1 second')`, f.leads.own);
      const stale = await h.as(f.manager).put(`/api/contacts/${id}/overrides/email`, { value: 'x@acme.com', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        current: { version: 2, value: 'sam@acme.com', scrapedValue: null }, changedBy: { id: f.rep1.id }, changedByType: 'user',
      });
      // The scraped columns keep what the rep entered; the edit lives in field_overrides.
      expect(await contactRow(id)).toMatchObject({ email: null, version: 2, source: 'rep' });
    });

    it('stores role as the title, treats blank optional fields as absent and validates the rest', async () => {
      const role = await add(f.rep1, f.leads.own, { name: 'Lee', role: 'Office Manager', email: '', phone: '  ' });
      expect(role.status).toBe(201);
      expect(role.body.contact).toMatchObject({ title: 'Office Manager', email: null, phone: null });
      // Provenance and placement come from the server, never the body.
      const forged = await add(f.rep1, f.leads.own, {
        name: 'Kim', source: 'bbb', source_key: 'k', confidence: 0.1, version: 9, company_id: f.leads.other,
      });
      expect(forged.status).toBe(201);
      expect(await h.one('SELECT company_id, source, source_key, confidence, version FROM contacts WHERE id = $1::uuid', forged.body.contact.id))
        .toEqual({ company_id: f.leads.own, source: 'rep', source_key: null, confidence: 1, version: 1 });
      const before = await h.counts();
      const bad = [
        {}, { name: '  ' }, { name: 'x'.repeat(256) }, { name: 'Lee', email: 'not-an-email' }, { name: 'Lee', phone: '1'.repeat(65) },
        { name: 'Lee', title: 'x'.repeat(256) }, { name: 'Lee', title: 'Owner', role: 'Estimator' }, { name: 42 },
      ];
      for (const body of bad) {
        const res = await add(f.rep1, f.leads.own, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toBe('invalid_request');
      }
      expect((await add(f.rep1, f.leads.own, { name: 'Lee', title: 'Owner', role: 'Owner' })).status).toBe(201);
      expect((await h.counts()).activity).toBe(before.activity + 1);
      expect((await add(f.rep1, '2d9f3c1a-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('writes nothing when the event cannot be written (one transaction)', async () => {
      const lead = f.leads.own;
      await h.db.$executeRawUnsafe(`CREATE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$`);
      await h.db.$executeRawUnsafe(`CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_outbox()`);
      try {
        expect((await add(f.rep1, lead)).status).toBe(500);
      } finally {
        await h.db.$executeRawUnsafe('DROP TRIGGER test_fail_outbox ON outbox_events');
        await h.db.$executeRawUnsafe('DROP FUNCTION test_fail_outbox()');
      }
      expect(await h.all(`SELECT 1 FROM contacts WHERE source = 'rep'`)).toHaveLength(0);
      expect(await h.counts()).toMatchObject({ outbox: 0, activity: 0 });
      expect(await h.version(lead)).toBe(1);
    });

    it('caps rep-added contacts per lead, also under concurrent requests', async () => {
      await h.db.$executeRawUnsafe(
        `INSERT INTO contacts (company_id, name, source) SELECT $1::uuid, 'P' || g, 'rep' FROM generate_series(1, 49) g`, f.leads.own);
      // Hold the lead row until all four requests are queued behind it, so they really overlap.
      let locked!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((r) => { locked = r; });
      const gate = new Promise<void>((r) => { release = r; });
      const holder = h.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT 1 FROM companies WHERE id = $1::uuid FOR UPDATE', f.leads.own);
        locked();
        await gate;
      });
      await ready;
      const racing = Promise.all([1, 2, 3, 4].map((i) => add(f.rep1, f.leads.own, { name: `Racer ${i}` })));
      await vi.waitFor(async () => expect((await h.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n).toBe(4), { timeout: 5000 });
      release();
      await holder;
      expect((await racing).map((r) => r.status).sort()).toEqual([201, 400, 400, 400]);
      const res = await add(f.rep1, f.leads.own);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'too_many_contacts', details: { max: 50 } });
      expect((await add(f.manager, f.leads.own)).status).toBe(400);
      expect(await h.all(`SELECT 1 FROM contacts WHERE company_id = $1::uuid AND source = 'rep'`, f.leads.own)).toHaveLength(50);
      expect((await h.counts()).outbox).toBe(1);
      expect((await add(f.manager, f.leads.pool)).status).toBe(201);
    });

    it('deletes only rep-added contacts, under the lead permissions and the contact version', async () => {
      const ids = {} as Record<'own' | 'pool' | 'other', string>;
      for (const which of ['own', 'pool', 'other'] as const) ids[which] = (await add(f.manager, f.leads[which])).body.contact.id;
      await h.as(f.rep1).put(`/api/contacts/${ids.own}/overrides/phone`, { value: '(212) 555-0177', version: 1 });
      const before = await h.counts();
      const del = (who: User, id: string, version?: number) =>
        h.as(who).delete(`/api/contacts/${id}`, version === undefined ? undefined : { version });

      expect((await del(f.rep1, ids.pool, 1)).status).toBe(403);
      expect((await del(f.rep1, ids.other, 1)).status).toBe(404);
      expect((await del(f.rep1, f.contacts.own, 1)).body).toEqual({ error: 'forbidden', details: 'only contacts added by a rep can be deleted' });
      expect((await del(f.rep1, '2d9f3c1a-0000-4000-8000-000000000000', 1)).status).toBe(404);
      expect((await del(f.rep1, 'nope', 1)).status).toBe(404);
      expect((await del(f.rep1, ids.own)).status).toBe(400);
      const stale = await del(f.rep1, ids.own, 1);
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        current: { version: 2, contact: { name: 'Sam Estimator', phone: '(212) 555-0177' } }, changedBy: { id: f.rep1.id },
      });
      expect(await h.counts()).toEqual(before);

      const lead = f.leads.own;
      const version = await h.version(lead);
      const ok = await h.as(f.rep1).delete(`/api/contacts/${ids.own}?version=2`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ deleted: true, contactId: ids.own, version: version + 1 });
      expect(await h.all('SELECT 1 FROM contacts WHERE id = $1::uuid', ids.own)).toHaveLength(0);
      expect(await h.all('SELECT 1 FROM field_overrides WHERE contact_id = $1::uuid', ids.own)).toHaveLength(0);
      const activity = await h.one<{ field_diff: unknown }>(
        `SELECT field_diff FROM activity_logs WHERE action_type = 'contact' ORDER BY created_at DESC LIMIT 1`);
      expect(activity.field_diff).toEqual({
        contact: [{ name: 'Sam Estimator', title: 'Estimator', email: null, phone: '(212) 555-0177', do_not_contact: false }, null],
        contact_id: ids.own,
      });
      expect((await h.outbox()).at(-1)).toMatchObject({
        event_type: 'lead.updated', company_id: lead,
        payload: { fields: ['contacts'], contact_id: ids.own, deleted: true, version: version + 1, actor_id: f.rep1.id },
      });
      expect((await del(f.rep1, ids.own, 2)).status).toBe(404);
      expect((await del(f.manager, ids.other, 1)).status).toBe(200);
    });

    it.skipIf(!existsSync(venvPython))('is left alone by a pipeline contact refresh', async () => {
      const lead = f.leads.own;
      const id = (await add(f.rep1, lead, { name: 'Pat Owner', title: 'Owner' })).body.contact.id as string;
      const before = await contactRow(id);
      execFileSync(venvPython, ['-c', `
import sys
from leadmaker.db.repository import Repository
from leadmaker.models import Contact, EnrichmentResult, EnrichmentStatus
repo = Repository(sys.argv[1])
repo.save_enrichment(sys.argv[2], EnrichmentResult(source="website_crawl", status=EnrichmentStatus.OK,
                     contacts=[Contact(name="Pat Owner", title="CEO", source="website", confidence=0.9)]))
repo.save_enrichment(sys.argv[2], EnrichmentResult(source="website_crawl", status=EnrichmentStatus.OK))
`, url!, lead], { cwd: new URL('../../..', import.meta.url).pathname });
      expect(await contactRow(id)).toEqual(before);
      expect(await h.all(`SELECT 1 FROM contacts WHERE source = 'website'`)).toHaveLength(0);
    });
  });

  describe('custom fields and tags', () => {
    it('sets and removes custom fields with a version check', async () => {
      const lead = f.leads.own;
      const set = await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/annual_volume`, { value: 1200, version: 1 });
      expect(set.body).toMatchObject({ key: 'annual_volume', value: 1200, customFields: { annual_volume: 1200 }, version: 2 });
      const stale = await h.as(f.manager).put(`/api/leads/${lead}/custom-fields/annual_volume`, { value: 99, version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ current: { version: 2, key: 'annual_volume', value: 1200 }, changedBy: { id: f.rep1.id } });
      const removed = await h.as(f.manager).put(`/api/leads/${lead}/custom-fields/annual_volume`, { value: null, version: 2 });
      expect(removed.body).toMatchObject({ customFields: {}, version: 3 });
      expect((await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/Bad-Key`, { value: 1, version: 3 })).status).toBe(400);
      expect((await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/k`, { value: { nested: 1 }, version: 3 })).status).toBe(400);
      expect((await h.outbox()).map((e) => e.payload.fields)).toEqual([['custom_fields.annual_volume'], ['custom_fields.annual_volume']]);
    });

    it('caps the number of custom field keys per lead, but still allows updating and removing them', async () => {
      const lead = f.leads.own;
      await h.db.$executeRawUnsafe(
        `UPDATE companies SET custom_fields = (SELECT jsonb_object_agg('k' || i, i) FROM generate_series(1, 100) i), version = 5
         WHERE id = $1::uuid`, lead);
      const full = await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/one_more`, { value: 'x', version: 5 });
      expect(full.status).toBe(400);
      expect(full.body).toEqual({ error: 'too_many_custom_fields', details: { max: 100 } });
      expect((await h.counts()).outbox).toBe(0);
      expect((await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/k1`, { value: 'updated', version: 5 })).status).toBe(200);
      expect((await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/k2`, { value: null, version: 6 })).status).toBe(200);
      expect((await h.as(f.rep1).put(`/api/leads/${lead}/custom-fields/one_more`, { value: 'x', version: 7 })).status).toBe(200);
    });

    it('creates tags once per name ignoring case', async () => {
      const created = await h.as(f.rep1).post('/api/custom-tags', { name: 'Hail 2026' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ created: true, tag: { name: 'Hail 2026', createdBy: f.rep1.id } });
      const again = await h.as(f.rep2).post('/api/custom-tags', { name: '  hail 2026 ' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ created: false, tag: { id: created.body.tag.id, name: 'Hail 2026' } });
      expect((await h.as(f.rep1).post('/api/custom-tags', { name: '' })).status).toBe(400);
      const events = await h.outbox();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: 'tags.changed', company_id: null, payload: { tag_id: created.body.tag.id, created: true } });
      expect(await h.one('SELECT entity_type, action, actor_id FROM audit_events'))
        .toEqual({ entity_type: 'custom_tag', action: 'created', actor_id: f.rep1.id });
    });

    it('links and unlinks tags idempotently, bumping the lead version only on change', async () => {
      const lead = f.leads.own;
      const rep = h.as(f.rep1);
      expect((await rep.post(`/api/leads/${lead}/custom-tags`, { tagId: f.tag })).body).toMatchObject({ added: true, version: 2 });
      expect((await rep.post(`/api/leads/${lead}/custom-tags`, { tagId: f.tag })).body).toMatchObject({ added: false, version: 2 });
      const missing = await rep.post(`/api/leads/${lead}/custom-tags`, { tagId: '0d9f3c1a-0000-4000-8000-000000000000' });
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('tag_not_found');
      expect((await rep.delete(`/api/leads/${lead}/custom-tags/${f.tag}`)).body).toEqual({ removed: true, tagId: f.tag, version: 3 });
      expect((await rep.delete(`/api/leads/${lead}/custom-tags/${f.tag}`)).body.error).toBe('tag_not_linked');
      expect((await h.outbox()).map((e) => [e.event_type, e.payload.added])).toEqual([['tags.changed', true], ['tags.changed', false]]);
    });
  });

  describe('bulk tag attach', () => {
    it('tags the leads the caller may write in one transaction, as the single attach does, and reports the rest', async () => {
      const ghost = '4d9f3c1a-0000-4000-8000-000000000000';
      const rep = h.as(f.rep1);
      const res = await rep.post(`/api/custom-tags/${f.tag}/leads`, {
        companyIds: [f.leads.own, f.leads.pool, f.leads.other, ghost, f.leads.own.toUpperCase()],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        tag: { id: f.tag, name: 'Storm chaser' }, attached: [{ companyId: f.leads.own, version: 2 }], alreadyTagged: [],
        skippedReadOnly: [f.leads.pool], skippedInvisible: [f.leads.other, ghost],
      });
      // The same event and activity row as POST /api/leads/:id/custom-tags.
      const single = await h.as(f.manager).post(`/api/leads/${f.leads.pool}/custom-tags`, { tagId: f.tag });
      expect(single.status).toBe(201);
      const [bulkEvent, singleEvent] = await h.outbox();
      expect(bulkEvent).toEqual({
        event_type: 'tags.changed', company_id: f.leads.own,
        payload: {
          company_id: f.leads.own, tag_id: f.tag, tag_name: 'Storm chaser', added: true, assigned_rep_id: f.rep1.id, version: 2,
          actor_type: 'user', actor_id: f.rep1.id, actor_name: 'Jordan Rep',
        },
      });
      expect(Object.keys(bulkEvent.payload).sort()).toEqual(Object.keys(singleEvent.payload).sort());
      const diffs = await h.all<{ company_id: string; field_diff: unknown }>(
        "SELECT company_id, field_diff FROM activity_logs WHERE action_type = 'custom_tag' ORDER BY created_at");
      expect(diffs.map((d) => d.field_diff)).toEqual([
        { custom_tag: [null, { id: f.tag, name: 'Storm chaser' }] }, { custom_tag: [null, { id: f.tag, name: 'Storm chaser' }] },
      ]);

      const mgr = await h.as(f.manager).post(`/api/custom-tags/${f.tag}/leads`, { companyIds: [f.leads.other, f.leads.own, f.leads.pool] });
      expect(mgr.body).toMatchObject({
        attached: [{ companyId: f.leads.other, version: 2 }], skippedReadOnly: [], skippedInvisible: [],
      });
      expect([...mgr.body.alreadyTagged].sort()).toEqual([f.leads.own, f.leads.pool].sort());
      expect((await h.all('SELECT 1 FROM company_custom_tags'))).toHaveLength(3);
    });

    it('rejects unknown tags and empty or oversized batches', async () => {
      const rep = h.as(f.rep1);
      const unknown = await rep.post('/api/custom-tags/5d9f3c1a-0000-4000-8000-000000000000/leads', { companyIds: [f.leads.own] });
      expect([unknown.status, unknown.body.error]).toEqual([404, 'tag_not_found']);
      expect((await rep.post(`/api/custom-tags/${f.tag}/leads`, { companyIds: [] })).status).toBe(400);
      const many = Array.from({ length: 501 }, (_, i) => `6d9f3c1a-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect((await rep.post(`/api/custom-tags/${f.tag}/leads`, { companyIds: many })).status).toBe(400);
      expect((await rep.post('/api/custom-tags/not-a-uuid/leads', { companyIds: [f.leads.own] })).status).toBe(400);
      expect(await h.counts()).toEqual({ outbox: 0, activity: 0, audit: 0 });
    });
  });

  describe('allocations', () => {
    it('are manager-only', async () => {
      const rep = h.as(f.rep1);
      expect((await rep.post('/api/allocations', { companyIds: [f.leads.pool], repId: f.rep1.id })).status).toBe(403);
      expect((await rep.post('/api/allocations/by-filter', { filter: {}, repId: f.rep1.id })).status).toBe(403);
      expect((await rep.delete(`/api/allocations/${f.leads.own}`)).status).toBe(403);
      expect((await h.counts()).outbox).toBe(0);
    });

    it('keeps the allocation history and assigned_rep_id in step across allocate, reassign and release', async () => {
      const lead = f.leads.pool;
      const mgr = h.as(f.manager);
      const first = await mgr.post('/api/allocations', { companyIds: [lead], repId: f.rep1.id });
      expect(first.body).toEqual({ repId: f.rep1.id, allocated: [{ companyId: lead, previousRepId: null, version: 2 }], unchanged: [] });
      await h.as(f.rep1).post(`/api/leads/${lead}/notes`, { text: 'Owner prefers email' });

      const moved = await mgr.post('/api/allocations', { companyIds: [lead, f.leads.other], repId: f.rep1.id });
      expect(moved.body.unchanged).toEqual([lead]);
      expect(moved.body.allocated).toEqual([{ companyId: f.leads.other, previousRepId: f.rep2.id, version: 2 }]);

      const reassigned = await mgr.post('/api/allocations', { companyIds: [lead], repId: f.rep2.id });
      expect(reassigned.body.allocated).toEqual([{ companyId: lead, previousRepId: f.rep1.id, version: 3 }]);
      const history = await h.all<{ rep_id: string; allocated_by: string; ended_by: string | null; open: boolean }>(
        `SELECT rep_id, allocated_by, ended_by, ended_at IS NULL AS open FROM lead_allocations
         WHERE company_id = $1::uuid ORDER BY allocated_at, ended_at NULLS LAST`, lead);
      expect(history).toEqual([
        { rep_id: f.rep1.id, allocated_by: f.manager.id, ended_by: f.manager.id, open: false },
        { rep_id: f.rep2.id, allocated_by: f.manager.id, ended_by: null, open: true },
      ]);
      expect((await h.one<{ assigned_rep_id: string }>('SELECT assigned_rep_id FROM companies WHERE id = $1::uuid', lead)).assigned_rep_id).toBe(f.rep2.id);

      // The note stays with the lead; the old rep loses access, the new rep can act.
      expect((await h.all("SELECT 1 FROM activity_logs WHERE action_type = 'note' AND company_id = $1::uuid", lead))).toHaveLength(1);
      expect((await h.as(f.rep1).post(`/api/leads/${lead}/notes`, { text: 'x' })).status).toBe(404);
      expect((await h.as(f.rep2).post(`/api/leads/${lead}/notes`, { text: 'Picked up' })).status).toBe(201);

      const released = await mgr.delete(`/api/allocations/${lead}`);
      expect(released.body).toEqual({ companyId: lead, previousRepId: f.rep2.id, version: 4 });
      expect((await h.all('SELECT 1 FROM lead_allocations WHERE company_id = $1::uuid AND ended_at IS NULL', lead))).toHaveLength(0);
      expect((await mgr.delete(`/api/allocations/${lead}`)).body.error).toBe('not_allocated');
      expect((await h.as(f.rep1).post(`/api/leads/${lead}/notes`, { text: 'x' })).status).toBe(403);

      const allocations = (await h.outbox()).filter((e) => e.event_type === 'lead.allocated');
      expect(allocations.map((e) => [e.company_id, e.payload.previous_rep_id, e.payload.assigned_rep_id, e.payload.version])).toEqual([
        [lead, null, f.rep1.id, 2],
        [f.leads.other, f.rep2.id, f.rep1.id, 2],
        [lead, f.rep1.id, f.rep2.id, 3],
        [lead, f.rep2.id, null, 4],
      ]);
      const diffs = await h.all<{ field_diff: unknown }>(
        "SELECT field_diff FROM activity_logs WHERE action_type = 'allocation' AND company_id = $1::uuid ORDER BY created_at", lead);
      expect(diffs.map((d) => d.field_diff)).toEqual([
        { assigned_rep_id: [null, f.rep1.id] }, { assigned_rep_id: [f.rep1.id, f.rep2.id] }, { assigned_rep_id: [f.rep2.id, null] },
      ]);
    });

    it('serialises concurrent allocations of the same lead into one consistent history', async () => {
      const lead = f.leads.pool;
      const reps = [f.rep1, f.rep2, f.rep1, f.rep2, f.rep1, f.rep2];
      const results = await Promise.all(reps.map((r) => h.as(f.manager).post('/api/allocations', { companyIds: [lead], repId: r.id })));
      expect(results.map((r) => r.status)).toEqual(reps.map(() => 200));
      const history = await h.all<{ rep_id: string; open: boolean }>(
        `SELECT rep_id, ended_at IS NULL AS open FROM lead_allocations WHERE company_id = $1::uuid ORDER BY allocated_at, ended_at NULLS LAST`, lead);
      expect(history.filter((r) => r.open)).toHaveLength(1);
      const { assigned_rep_id } = await h.one<{ assigned_rep_id: string }>('SELECT assigned_rep_id FROM companies WHERE id = $1::uuid', lead);
      expect(history.at(-1)).toEqual({ rep_id: assigned_rep_id, open: true });
      // Each event's previous owner is the one before it: no move was computed from a stale read.
      const moves = (await h.outbox()).map((e) => [e.payload.previous_rep_id, e.payload.assigned_rep_id]);
      moves.forEach(([prev], i) => expect(prev).toBe(i === 0 ? null : moves[i - 1][1]));
    });

    it('rejects unknown leads, non-rep targets and oversized batches without writing anything', async () => {
      const mgr = h.as(f.manager);
      const ghost = '1d9f3c1a-0000-4000-8000-000000000000';
      const missing = await mgr.post('/api/allocations', { companyIds: [f.leads.pool, ghost], repId: f.rep1.id });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'not_found', details: { missing: [ghost] } });
      expect((await mgr.post('/api/allocations', { companyIds: [f.leads.pool], repId: f.manager.id })).body.error).toBe('invalid_rep');
      expect((await mgr.post('/api/allocations', { companyIds: [], repId: f.rep1.id })).status).toBe(400);
      const many = Array.from({ length: 51 }, (_, i) => `2d9f3c1a-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect((await mgr.post('/api/allocations', { companyIds: many, repId: f.rep1.id })).body.error).toBe('too_many_leads');
      expect(await h.counts()).toEqual({ outbox: 0, activity: 0, audit: 0 });
      expect((await h.all('SELECT 1 FROM lead_allocations'))).toHaveLength(2);
    });

    it('bulk-assigns what a filter matches, resolved with the list\'s conditions in the same transaction', async () => {
      const mgr = h.as(f.manager);
      await h.db.$executeRawUnsafe(`UPDATE companies SET segment = 'growth' WHERE id = ANY($1::uuid[])`, [f.leads.pool, f.leads.other]);
      const res = await mgr.post('/api/allocations/by-filter', { filter: { scope: 'all', segment: ['growth'], limit: 1 }, repId: f.rep1.id });
      expect(res.status).toBe(200);
      const moved = [[f.leads.pool, null], [f.leads.other, f.rep2.id]].sort(([a], [b]) => (a! < b! ? -1 : 1));
      expect(res.body).toEqual({
        repId: f.rep1.id, matched: 2, missing: [], unchanged: [],
        allocated: moved.map(([companyId, previousRepId]) => ({ companyId, previousRepId, version: 3 })),
      });
      const owners = await h.all<{ id: string; assigned_rep_id: string | null; open_rep: string | null }>(
        `SELECT c.id, c.assigned_rep_id, la.rep_id AS open_rep FROM companies c
         LEFT JOIN lead_allocations la ON la.company_id = c.id AND la.ended_at IS NULL WHERE c.id = ANY($1::uuid[])`,
        [f.leads.pool, f.leads.other]);
      expect(owners.every((o) => o.assigned_rep_id === f.rep1.id && o.open_rep === f.rep1.id)).toBe(true);
      const events = (await h.outbox()).filter((e) => e.event_type === 'lead.allocated')
        .sort((a, b) => (a.company_id! < b.company_id! ? -1 : 1));
      expect(events.map((e) => [e.company_id, e.payload.previous_rep_id, e.payload.assigned_rep_id, e.payload.actor_id, e.payload.actor_name]))
        .toEqual(moved.map(([id, prev]) => [id, prev, f.rep1.id, f.manager.id, 'Alex Manager']));
      expect((await h.all("SELECT 1 FROM activity_logs WHERE action_type = 'allocation'"))).toHaveLength(2);

      const again = await mgr.post('/api/allocations/by-filter', { filter: { segment: ['growth'] }, repId: f.rep1.id });
      expect(again.body).toMatchObject({ matched: 2, allocated: [], unchanged: moved.map(([id]) => id) });

      // Conditions on other tables (custom tags), the viewer's own state (unchecked 'me') and near all apply.
      await h.db.$executeRawUnsafe(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        f.leads.own, f.tag, f.manager.id);
      const tagged = await mgr.post('/api/allocations/by-filter', { filter: { customTags: ['storm CHASER'] }, repId: f.rep2.id });
      expect(tagged.body).toMatchObject({ matched: 1, allocated: [{ companyId: f.leads.own, previousRepId: f.rep1.id }] });
      const unchecked = await mgr.post('/api/allocations/by-filter', {
        filter: { scope: { repId: f.rep1.id }, unchecked: 'me', near: { zip: '10013', radiusMiles: 5 } }, repId: f.rep2.id,
      });
      expect(unchecked.body.matched).toBe(2);
      expect((await h.all('SELECT 1 FROM companies WHERE assigned_rep_id = $1::uuid', f.rep2.id))).toHaveLength(3);
      expect((await mgr.post('/api/allocations/by-filter', { filter: { text: 'no such lead' }, repId: f.rep1.id })).body)
        .toEqual({ repId: f.rep1.id, allocated: [], unchanged: [], missing: [], matched: 0 });
    });

    it('refuses more matches than MAX_BULK_ALLOCATION with the true count, and bad filters or reps, writing nothing', async () => {
      const mgr = h.as(f.manager);
      await h.db.$executeRawUnsafe(`INSERT INTO companies (business_name, latitude, longitude, content_hash)
        SELECT 'Bulk ' || i, 40.7, -74.0, 'h' FROM generate_series(1, 51) i`);
      const res = await mgr.post('/api/allocations/by-filter', { filter: { scope: 'unallocated' }, repId: f.rep1.id });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'too_many_leads', details: { matched: 52, max: 50 } });
      expect((await mgr.post('/api/allocations/by-filter', { filter: { scope: 'everything' }, repId: f.rep1.id })).status).toBe(400);
      expect((await mgr.post('/api/allocations/by-filter', { filter: {}, repId: f.manager.id })).body.error).toBe('invalid_rep');
      const unknownZip = await mgr.post('/api/allocations/by-filter', { filter: { near: { zip: '99999', radiusMiles: 5 } }, repId: f.rep1.id });
      expect(unknownZip.status).toBe(400);
      expect(unknownZip.body.error).toBe('invalid_filter');
      expect(await h.counts()).toEqual({ outbox: 0, activity: 0, audit: 0 });
      expect((await h.all('SELECT 1 FROM companies WHERE assigned_rep_id IS NULL'))).toHaveLength(52);
    });

    it('runs concurrent bulk allocations over overlapping leads without deadlocks, ending consistent', async () => {
      const mgr = h.as(f.manager);
      await h.db.$executeRawUnsafe(`INSERT INTO companies (business_name, latitude, longitude, content_hash)
        SELECT 'Overlap ' || i, 40.7, -74.0, 'h' FROM generate_series(1, 30) i`);
      const ids = (await h.all<{ id: string }>('SELECT id FROM companies ORDER BY id')).map((r) => r.id);
      const results = await Promise.all([
        mgr.post('/api/allocations/by-filter', { filter: { scope: 'all' }, repId: f.rep1.id }),
        mgr.post('/api/allocations', { companyIds: [...ids].reverse().slice(0, 20), repId: f.rep2.id }),
        mgr.post('/api/allocations/by-filter', { filter: { text: 'overlap' }, repId: f.rep2.id }),
        mgr.post('/api/allocations', { companyIds: ids.slice(0, 20), repId: f.rep1.id }),
        mgr.post('/api/allocations/by-filter', { filter: {}, repId: f.rep2.id }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const drift = await h.all(`SELECT c.id FROM companies c
        LEFT JOIN lead_allocations la ON la.company_id = c.id AND la.ended_at IS NULL
        WHERE c.assigned_rep_id IS DISTINCT FROM la.rep_id`);
      expect(drift).toEqual([]);
    });
  });

  describe('refresh', () => {
    const refresh = (u: User, postal_code: string, radius_miles = 25) =>
      h.as(u).post('/api/refresh', { postal_code, radius_miles });

    it('enqueues a scrape job with the Python dedupe key and merges duplicates for free', async () => {
      const res = await refresh(f.rep1, '10013');
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ merged: false, job: { kind: 'scrape', status: 'queued', dedupeKey: 'scrape:10013:25:*' } });
      const job = await h.one<{ params: unknown; requested_by: string; kind: string; params_text: string }>(
        'SELECT kind, params, params::text AS params_text, requested_by FROM jobs');
      expect(job).toMatchObject({ kind: 'scrape', params: { postal_code: '10013', radius_miles: 25 }, requested_by: f.rep1.id });
      expect(job.params_text).toBe('{"postal_code": "10013", "radius_miles": 25}');
      expect(await h.one('SELECT entity_type, entity_id, action, actor_type, actor_id FROM audit_events'))
        .toEqual({ entity_type: 'job', entity_id: String(res.body.job.id), action: 'created', actor_type: 'user', actor_id: f.rep1.id });

      const dup = await refresh(f.manager, '10013', 25.0);
      expect(dup.status).toBe(200);
      expect(dup.body).toMatchObject({ merged: true, job: { id: res.body.job.id } });
      expect((await h.all('SELECT 1 FROM jobs'))).toHaveLength(1);
      expect((await refresh(f.rep1, '10013', 10)).body.job.dedupeKey).toBe('scrape:10013:10:*');
      expect((await h.as(f.rep1).post('/api/refresh', { postal_code: '1001', radius_miles: 5 })).status).toBe(400);
      expect((await h.as(f.rep1).post('/api/refresh', { postal_code: '10013', radius_miles: 500 })).status).toBe(400);
    });

    it.skipIf(!existsSync(venvPython))('builds the same key as leadmaker.jobs.area_dedupe_key from the stored params', async () => {
      for (const radius of [25, 12.5, 33.333333]) await refresh(f.rep1, '07030', radius);
      const jobs = await h.all<{ dedupe_key: string; params: string }>('SELECT dedupe_key, params::text AS params FROM jobs ORDER BY id');
      for (const job of jobs) {
        const py = execFileSync(venvPython, ['-c',
          'import json, sys; from leadmaker.jobs import area_dedupe_key; print(area_dedupe_key("scrape", json.loads(sys.argv[1])))',
          job.params], { cwd: new URL('../../..', import.meta.url).pathname }).toString().trim();
        expect(py).toBe(job.dedupe_key);
      }
    });

    it('limits each user to LEADMAKER_USER_JOBS_PER_HOUR new jobs per rolling hour (429 + Retry-After)', async () => {
      for (const zip of ['10001', '10002', '10003']) expect((await refresh(f.rep1, zip)).status).toBe(202);
      const limited = await refresh(f.rep1, '10004');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(3500);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(3600);
      expect(limited.body).toMatchObject({ error: 'rate_limited', details: { limit: 3, retryAt: expect.any(String) } });
      // Merging into an open job is free even at the limit; other users have their own budget.
      expect((await refresh(f.rep1, '10001')).status).toBe(200);
      expect((await refresh(f.rep2, '10004')).status).toBe(202);
      // Jobs older than an hour no longer count.
      await h.db.$executeRawUnsafe(`UPDATE jobs SET created_at = now() - interval '61 minutes', status = 'succeeded' WHERE dedupe_key = 'scrape:10001:25:*'`);
      const after = await refresh(f.rep1, '10005');
      expect(after.status).toBe(202);
      expect((await h.all('SELECT 1 FROM jobs WHERE requested_by = $1::uuid', f.rep1.id))).toHaveLength(4);
    });

    it('starts a new job for an area once its previous job has finished', async () => {
      const first = await refresh(f.rep1, '10013');
      await h.db.$executeRawUnsafe(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, first.body.job.id);
      const again = await refresh(f.rep2, '10013');
      expect(again.status).toBe(202);
      expect(again.body.merged).toBe(false);
      expect(again.body.job.id).not.toBe(first.body.job.id);
      await h.db.$executeRawUnsafe(`UPDATE jobs SET status = 'dead' WHERE id = $1`, again.body.job.id);
      expect((await refresh(f.rep2, '10013')).status).toBe(202);
      expect((await h.all('SELECT 1 FROM jobs')).length).toBe(3);
    });

    it('does not limit requests when LEADMAKER_USER_JOBS_PER_HOUR is 0', async () => {
      const saved = h.config;
      h.config = { ...saved, userJobsPerHour: 0 };
      try {
        for (const zip of ['10001', '10002', '10003', '10004', '10005']) expect((await refresh(f.rep1, zip)).status).toBe(202);
      } finally {
        h.config = saved;
      }
    });

    it('holds the limit under concurrent requests from one user', async () => {
      const results = await Promise.all(['11201', '11202', '11203', '11204', '11205', '11206'].map((zip) => refresh(f.rep1, zip)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([202, 202, 202, 429, 429, 429]);
      expect((await h.all('SELECT 1 FROM jobs'))).toHaveLength(3);
    });

    it('merges concurrent requests for the same area into one job', async () => {
      const results = await Promise.all([f.rep1, f.rep2, f.manager].map((u) => refresh(u, '11211')));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
      expect(new Set(results.map((r) => r.body.job.id)).size).toBe(1);
      expect((await h.all('SELECT 1 FROM jobs'))).toHaveLength(1);
    });
  });

  it('serialises concurrent overrides of one field: one wins, the rest get 409', async () => {
    const users = [f.rep1, f.manager, f.rep1, f.manager];
    const results = await Promise.all(users.map((u, i) =>
      h.as(u).put(`/api/leads/${f.leads.own}/overrides/city`, { value: `City ${i}`, version: 1 })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await h.all('SELECT 1 FROM field_overrides WHERE superseded_at IS NULL'))).toHaveLength(1);
    expect(await h.version(f.leads.own)).toBe(2);
  });
});
