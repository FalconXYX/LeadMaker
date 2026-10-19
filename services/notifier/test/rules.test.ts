import type { PrismaClient } from '@leadmaker/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processDueTasks, processEvents, prune } from '../src/engine.ts';
import { dueLabel } from '../src/rules.ts';
import { company, event, hasInfra, notifications, openDb, resetDb, seed } from './helpers.ts';

describe.skipIf(!hasInfra)('notification rules (Postgres)', () => {
  let db: PrismaClient;
  let u: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    db = await openDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    u = await seed(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const allocated = (companyId: string, to: string | null, from: string | null, actor = u.manager.id) =>
    event(db, 'lead.allocated', companyId, { assigned_rep_id: to, previous_rep_id: from, rep_id: to, actor_id: actor, version: 2 });
  const outbox = () => db.$queryRaw<{ company_id: string | null; payload: Record<string, unknown> }[]>`
    SELECT company_id::text, payload FROM outbox_events WHERE event_type = 'notification.created' ORDER BY id`;

  describe('lead.allocated', () => {
    it('tells the new rep, merges a bulk allocation into one notification with a count, and publishes it', async () => {
      const leads = await Promise.all(['A1', 'A2', 'A3', 'A4'].map((n) => company(db, n, u.rep1.id)));
      await processEvents(db, [await allocated(leads[0].id, u.rep1.id, null)]);
      let [n] = await notifications(db, u.rep1.id);
      expect(n).toMatchObject({ type: 'allocated', count: 1, title: 'New lead allocated to you', body: 'A1 is now yours', company_id: leads[0].id });
      await processEvents(db, await Promise.all(leads.slice(1).map((l) => allocated(l.id, u.rep1.id, null))));
      const rows = await notifications(db, u.rep1.id);
      expect(rows).toHaveLength(1);
      [n] = rows;
      expect(n).toMatchObject({ count: 4, title: '4 new leads allocated to you', body: 'Latest: A4', company_id: leads[3].id });
      expect(n.data.company_ids).toEqual(leads.map((l) => l.id));
      // One notification.created per notification written per batch, addressed to its user, never naming a lead.
      const events = await outbox();
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.company_id === null && !('company_id' in e.payload))).toBe(true);
      expect(events[1].payload).toMatchObject({ user_id: u.rep1.id, notification_id: n.id, type: 'allocated', count: 4, actor_type: 'system' });
      // The merged row's title and body ride along, so the client needs no extra GET.
      expect(events.map((e) => [e.payload.title, e.payload.body, e.payload.actor_name])).toEqual([
        ['New lead allocated to you', 'A1 is now yours', 'system'], ['4 new leads allocated to you', 'Latest: A4', 'system'],
      ]);
    });

    it('tells the previous rep a lead moved away, linking it only when it went back to the pool', async () => {
      const moved = await company(db, 'Moved', u.rep2.id);
      const returned = await company(db, 'Returned', null);
      await processEvents(db, [await allocated(moved.id, u.rep2.id, u.rep1.id), await allocated(returned.id, null, u.rep2.id)]);
      const [away1] = await notifications(db, u.rep1.id);
      expect(away1).toMatchObject({ type: 'reassigned_away', company_id: null, body: 'Moved is no longer allocated to you' });
      const rep2 = await notifications(db, u.rep2.id);
      expect(rep2.map((r) => [r.type, r.company_id, r.body])).toEqual([
        ['allocated', moved.id, 'Moved is now yours'],
        ['reassigned_away', returned.id, 'Returned went back to the unallocated pool'],
      ]);
    });

    it('still tells the previous rep when a lead returned to the pool has moved on, without the link', async () => {
      const lead = await company(db, 'Returned', u.rep2.id);
      await processEvents(db, [await allocated(lead.id, null, u.rep1.id)]);
      const [away] = await notifications(db, u.rep1.id);
      expect(away).toMatchObject({ type: 'reassigned_away', company_id: null, body: 'Returned went back to the unallocated pool' });
    });

    it('starts a new notification once the unread one was read', async () => {
      const [a, b] = await Promise.all([company(db, 'A', u.rep1.id), company(db, 'B', u.rep1.id)]);
      await processEvents(db, [await allocated(a.id, u.rep1.id, null)]);
      await db.$executeRaw`UPDATE notifications SET read_at = NOW()`;
      await processEvents(db, [await allocated(b.id, u.rep1.id, null)]);
      const rows = await notifications(db, u.rep1.id);
      expect(rows.map((r) => [r.count, r.read_at !== null])).toEqual([[1, true], [1, false]]);
    });

    it('is idempotent: a redelivered event (or the same outbox id twice in a batch) writes nothing again', async () => {
      const lead = await company(db, 'A', u.rep1.id);
      const e = await allocated(lead.id, u.rep1.id, null);
      expect(await processEvents(db, [e, { ...e, streamId: '99-0' }])).toHaveLength(1);
      expect(await processEvents(db, [e])).toEqual([]);
      const [n] = await notifications(db, u.rep1.id);
      expect(n.count).toBe(1);
      expect(await outbox()).toHaveLength(1);
    });

    it('honours opt-outs and never notifies the actor', async () => {
      const [a, b] = await Promise.all([company(db, 'A', u.rep1.id), company(db, 'B', u.rep2.id)]);
      await db.$executeRaw`INSERT INTO notification_preferences (user_id, type, enabled) VALUES (${u.rep1.id}::uuid, 'allocated', FALSE)`;
      await processEvents(db, [await allocated(a.id, u.rep1.id, null), await allocated(b.id, u.rep2.id, null, u.rep2.id)]);
      expect(await notifications(db)).toEqual([]);
    });

    it('skips a lead that moved on before the event was processed', async () => {
      const lead = await company(db, 'Gone', u.rep2.id);
      await processEvents(db, [await allocated(lead.id, u.rep1.id, null)]);
      expect(await notifications(db, u.rep1.id)).toEqual([]);
    });
  });

  describe('note.added', () => {
    const note = async (companyId: string, actor: string, text: string) => {
      const [row] = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text)
        VALUES (${companyId}::uuid, 'user', ${actor}::uuid, 'note', ${text}) RETURNING id::text`;
      return event(db, 'note.added', companyId, { note_id: row.id, actor_id: actor, version: 1 });
    };

    it("tells the lead's rep about a manager's notes, merged per lead, and ignores reps' and pool notes", async () => {
      const [mine, pool] = await Promise.all([company(db, 'Acme', u.rep1.id), company(db, 'Pool', null)]);
      await processEvents(db, [await note(mine.id, u.manager.id, 'Call   them\nbefore Friday')]);
      let [n] = await notifications(db, u.rep1.id);
      expect(n).toMatchObject({ type: 'manager_note', title: 'Manager left a note on Acme', body: 'Call them before Friday', company_id: mine.id });
      await processEvents(db, [await note(mine.id, u.manager2.id, 'x'.repeat(300)), await note(mine.id, u.rep1.id, 'mine'), await note(pool.id, u.manager.id, 'pool')]);
      const rows = await notifications(db);
      expect(rows).toHaveLength(1);
      [n] = rows;
      expect(n.count).toBe(2);
      expect(n.title).toBe('2 new manager notes on Acme');
      expect(n.body).toMatch(/^Boss: x{139}…$/);
    });
  });

  describe('tasks', () => {
    const task = (companyId: string, assignee: string, title: string, due: Date, extra: Record<string, unknown> = {}) =>
      db.tasks.create({ data: { company_id: companyId, title, due_at: due, assignee_id: assignee, created_by: u.manager.id, ...extra } });
    const taskEvent = (t: { id: string; company_id: string; title: string; assignee_id: string }, action: string, actor: string,
      extra: Record<string, unknown> = {}) => event(db, 'lead.updated', t.company_id, {
      fields: ['tasks'], task_id: t.id, task_action: action, task_title: t.title, task_type: 'call', due_at: new Date().toISOString(),
      done: false, assignee_id: t.assignee_id, previous_assignee_id: null, actor_id: actor, version: 1, ...extra,
    });
    const at = (iso: string) => new Date(iso);

    it('labels due times in New York, a midnight due date as the whole day', () => {
      const now = at('2026-10-20T15:00:00Z');
      expect(dueLabel(at('2026-10-20T18:30:00Z'), now)).toBe('due today at 2:30 PM');
      expect(dueLabel(at('2026-10-21T04:00:00Z'), now)).toBe('due Wed, Oct 21');
      expect(dueLabel(at('2026-10-21T03:59:00Z'), now)).toBe('due today at 11:59 PM');
    });

    it("tells the assignee about a task someone else gave them, merged until read; never their own or a finished one", async () => {
      const [a, b] = await Promise.all([company(db, 'Acme', u.rep1.id), company(db, 'Bolt', u.rep1.id)]);
      const t1 = await task(a.id, u.rep1.id, 'Call back about TPO', at('2026-10-21T14:00:00Z'));
      await processEvents(db, [await taskEvent(t1, 'created', u.manager.id)]);
      let [n] = await notifications(db, u.rep1.id);
      expect(n).toMatchObject({ type: 'task_assigned', count: 1, title: 'Manager assigned you a task: Call back about TPO', company_id: a.id });
      expect(n.body).toMatch(/^Acme, due (today|Wed, Oct 21) at 10:00 AM$/);
      const own = await task(b.id, u.rep1.id, 'My own', at('2026-10-21T14:00:00Z'), { created_by: u.rep1.id });
      const done = await task(b.id, u.rep1.id, 'Done already', at('2026-10-21T14:00:00Z'), { done_at: new Date() });
      const t2 = await task(b.id, u.rep1.id, 'Drop off samples', at('2026-10-22T04:00:00Z'));
      await processEvents(db, [
        await taskEvent(own, 'created', u.rep1.id), await taskEvent(done, 'created', u.manager.id),
        await taskEvent(t1, 'completed', u.manager.id), await taskEvent(t1, 'updated', u.manager.id),
        await taskEvent(t2, 'created', u.manager2.id),
      ]);
      const rows = await notifications(db);
      expect(rows).toHaveLength(1);
      [n] = rows;
      expect(n).toMatchObject({ count: 2, title: '2 new tasks assigned to you', body: 'Latest: Drop off samples (Bolt, from Boss)', company_id: b.id });
      expect(n.data.task_ids).toEqual([t1.id, t2.id]);
    });

    it('tells the new assignee of a reassigned task, unless it moved on again before the event was handled', async () => {
      const lead = await company(db, 'Pool lead', null);
      const t = await task(lead.id, u.rep2.id, 'Measure the roof', at('2026-10-21T14:00:00Z'));
      await processEvents(db, [await taskEvent({ ...t, assignee_id: u.rep2.id }, 'updated', u.manager.id, { previous_assignee_id: u.rep1.id })]);
      expect((await notifications(db, u.rep2.id)).map((r) => r.type)).toEqual(['task_assigned']);
      await processEvents(db, [await taskEvent({ ...t, assignee_id: u.rep1.id }, 'updated', u.manager.id, { previous_assignee_id: u.rep2.id })]);
      expect(await notifications(db, u.rep1.id)).toEqual([]);
    });

    it('sends task_due once per task and due time, for tasks due now or within 15 minutes and at most a day ago', async () => {
      const now = new Date();
      const mins = (m: number) => new Date(now.getTime() + m * 60_000);
      const [mine, theirs] = await Promise.all([company(db, 'Acme', u.rep1.id), company(db, 'Other', u.rep2.id)]);
      const soon = await task(mine.id, u.rep1.id, 'Call the owner', mins(10));
      const missed = await task(mine.id, u.rep1.id, 'Send the quote', mins(-120));
      await task(mine.id, u.rep1.id, 'Too old', mins(-25 * 60));
      await task(mine.id, u.rep1.id, 'Later', mins(60));
      await task(mine.id, u.rep1.id, 'Finished', mins(-5), { done_at: now });
      await task(theirs.id, u.rep1.id, 'Not my lead any more', mins(-5));
      const written = await processDueTasks(db, now);
      expect(written.map((w) => w.title).sort()).toEqual(['Task due: Call the owner', 'Task due: Send the quote']);
      const rows = await notifications(db, u.rep1.id);
      expect(rows.find((r) => r.data.task_id === soon.id)).toMatchObject({ type: 'task_due', company_id: mine.id, body: expect.stringMatching(/^Acme, due /) });
      expect((await outbox()).map((e) => e.payload.type)).toEqual(['task_due', 'task_due']);

      await db.$executeRaw`UPDATE notifications SET read_at = NOW()`;
      expect(await processDueTasks(db, now)).toEqual([]);
      await db.tasks.update({ where: { id: missed.id }, data: { due_at: mins(-30) } });
      expect((await processDueTasks(db, now)).map((w) => w.title)).toEqual(['Task due: Send the quote']);
      await db.notification_preferences.create({ data: { user_id: u.rep1.id, type: 'task_due', enabled: false } });
      await db.tasks.update({ where: { id: soon.id }, data: { due_at: mins(5) } });
      expect(await processDueTasks(db, now)).toEqual([]);
    });
  });

  describe('lead.updated by the pipeline', () => {
    const override = (companyId: string, field: string, value: unknown, atEdit: unknown, userId: string, contactId: string | null = null) =>
      db.$executeRaw`
        INSERT INTO field_overrides (company_id, contact_id, field, value, scraped_value_at_edit, user_id)
        VALUES (${companyId}::uuid, ${contactId}::uuid, ${field}, ${JSON.stringify(value)}::jsonb, ${JSON.stringify(atEdit)}::jsonb, ${userId}::uuid)`;
    const updated = (companyId: string, fields: string[], actor_type = 'pipeline') =>
      event(db, 'lead.updated', companyId, { actor_type, actor_id: null, fields, run_id: null, version: 3 });

    it("tells an override's author each time the source value under it changes", async () => {
      const lead = await company(db, 'Acme', u.rep1.id, { phone: '111', website_url: 'a.com' });
      await override(lead.id, 'phone', '999', '111', u.rep1.id);
      await override(lead.id, 'website_url', 'b.com', 'a.com', u.manager.id);
      // An unrelated field, an unchanged value, and a user write: nothing.
      await processEvents(db, [await updated(lead.id, ['rating']), await updated(lead.id, ['phone']), await updated(lead.id, ['phone'], 'user')]);
      expect(await notifications(db)).toEqual([]);

      await db.companies.update({ where: { id: lead.id }, data: { phone: '222', website_url: 'c.com' } });
      await processEvents(db, [await updated(lead.id, ['phone', 'website'])]);
      const [rep] = await notifications(db, u.rep1.id);
      expect(rep).toMatchObject({
        type: 'source_changed', company_id: lead.id, count: 1, dedupe_key: `source_changed:${lead.id}`,
        body: 'Acme: phone changed at the source; your edit still shows',
      });
      expect((await notifications(db, u.manager.id))[0].body).toBe('Acme: website changed at the source; your edit still shows');

      // The same source value again is not news; the next new one merges into the unread row.
      await processEvents(db, [await updated(lead.id, ['phone'])]);
      expect((await notifications(db, u.rep1.id))[0].count).toBe(1);
      await db.companies.update({ where: { id: lead.id }, data: { phone: '333' } });
      await processEvents(db, [await updated(lead.id, ['phone'])]);
      expect((await notifications(db, u.rep1.id))[0]).toMatchObject({ count: 2, title: 'The source changed fields you edited (2 changes)' });
    });

    it("reports an override of an address part when the pipeline changes the listing's address", async () => {
      const lead = await company(db, 'Acme', u.rep1.id, { postal_code: '07030', city: 'Hoboken' });
      await override(lead.id, 'postal_code', '07031', '07030', u.rep1.id);
      await override(lead.id, 'city', 'Weehawken', 'Hoboken', u.rep1.id);
      await db.companies.update({ where: { id: lead.id }, data: { postal_code: '07302', address: '1 Main St, Jersey City' } });
      await processEvents(db, [await updated(lead.id, ['address'])]);
      const rows = await notifications(db, u.rep1.id);
      expect(rows.map((r) => [r.count, r.body])).toEqual([[1, 'Acme: ZIP code changed at the source; your edit still shows']]);
    });

    it('covers contact overrides and skips authors who can no longer see the lead', async () => {
      const lead = await company(db, 'Acme', u.rep1.id);
      const contact = await db.contacts.create({ data: { company_id: lead.id, name: 'Jo', email: 'jo@a.com', source: 'website' } });
      await override(lead.id, 'email', 'jo@b.com', 'jo@a.com', u.rep1.id, contact.id);
      await db.contacts.update({ where: { id: contact.id }, data: { email: 'jo@c.com' } });
      await processEvents(db, [await updated(lead.id, ['contacts'])]);
      expect((await notifications(db, u.rep1.id))[0].body).toBe("Acme: Jo's email changed at the source; your edit still shows");

      const other = await company(db, 'Other', u.rep2.id, { phone: '1' });
      await override(other.id, 'phone', '5', '1', u.rep1.id);
      await db.companies.update({ where: { id: other.id }, data: { phone: '2' } });
      await processEvents(db, [await updated(other.id, ['phone'])]);
      expect(await notifications(db, u.rep1.id)).toHaveLength(1);
    });
  });

  describe('pipeline.run_completed', () => {
    const STORM = [{ key: 'work_type:storm_emergency', value: true, label: 'Storm', category: 'work_type', reason: 'r', source: 's' }];
    const alert = (externalId: string, county: string, extra: { valid_to?: Date | null; payload?: object } = {}) =>
      db.$executeRaw`
        INSERT INTO regional_signals (county_fips, kind, source, external_id, payload, valid_from, valid_to, fetched_at)
        VALUES (${county}, 'active_alert', 'nws', ${externalId},
                ${JSON.stringify(extra.payload ?? { event: 'Severe Thunderstorm Warning', areaDesc: 'Essex, NJ', severity: 'Severe' })}::jsonb,
                NOW() - INTERVAL '1 hour', ${extra.valid_to === undefined ? new Date(Date.now() + 3_600_000) : extra.valid_to}, NOW())
        ON CONFLICT (source, external_id, county_fips) DO UPDATE SET fetched_at = NOW()`;
    const run = (payload: Record<string, unknown>) =>
      event(db, 'pipeline.run_completed', null, { actor_type: 'pipeline', status: 'succeeded', company_ids: [], ...payload });

    it('sends one storm alert per rep with leads in the county and per manager, once per alert', async () => {
      await Promise.all([
        company(db, 'R1 storm', u.rep1.id, { county_fips: '34013', system_tags: STORM }),
        company(db, 'R1 plain', u.rep1.id, { county_fips: '34013' }),
        company(db, 'Pool storm', null, { county_fips: '34013', system_tags: STORM }),
        company(db, 'R2 elsewhere', u.rep2.id, { county_fips: '36061' }),
      ]);
      await alert('urn:a1', '34013');
      await alert('urn:old', '34013', { valid_to: new Date(Date.now() - 60_000) });
      await alert('urn:cancelled', '34013', { payload: { event: 'Flood Watch', cancelled_at: '2026-10-18T00:00:00Z' } });
      await processEvents(db, [await run({ run_id: 1, kind: 'signals' })]);
      const rows = await notifications(db);
      expect(rows.map((r) => [r.user_id, r.type, r.title, r.body, r.county_fips])).toEqual(expect.arrayContaining([
        [u.rep1.id, 'storm_alert', 'Severe Thunderstorm Warning: Essex, NJ',
          '2 of your leads are in the alert area (1 storm/emergency or repair specialists)', '34013'],
        [u.manager.id, 'storm_alert', 'Severe Thunderstorm Warning: Essex, NJ',
          '3 leads in the alert area (2 storm/emergency or repair specialists)', '34013'],
        [u.manager2.id, 'storm_alert', 'Severe Thunderstorm Warning: Essex, NJ',
          '3 leads in the alert area (2 storm/emergency or repair specialists)', '34013'],
      ]));
      expect(rows).toHaveLength(3);
      const [{ value }] = await db.$queryRaw<{ value: unknown }[]>`SELECT value FROM notifier_state WHERE key = 'signals_watermark'`;
      expect(typeof value).toBe('string');

      // The next signals run re-fetches the same alert: nothing new, even after everything was read.
      await db.$executeRaw`UPDATE notifications SET read_at = NOW()`;
      await alert('urn:a1', '34013');
      await processEvents(db, [await run({ run_id: 2, kind: 'signals' })]);
      expect(await notifications(db)).toHaveLength(3);
    });

    it("tells the requester once when their refresh job's last run completes, counting only leads they can view", async () => {
      const job = async (requester: string) => (await db.$queryRaw<{ id: number }[]>`
        INSERT INTO jobs (kind, params, status, requested_by) VALUES ('scrape', '{"postal_code": "07030", "radius_miles": 10}', 'running', ${requester}::uuid)
        RETURNING id`)[0].id;
      const jobId = await job(u.rep1.id);
      const [scrape] = await db.$queryRaw<{ id: number }[]>`
        INSERT INTO scrape_runs (kind, status, stats) VALUES ('gaf_ingest', 'succeeded', '{"upsert": {"new": 3, "changed": 2, "unchanged": 9}}')
        RETURNING id`;
      const [pool, mine, theirs, changedMine, changedTheirs] = await Promise.all([
        company(db, 'Pool'), company(db, 'Mine', u.rep1.id), company(db, 'Theirs', u.rep2.id),
        company(db, 'Changed mine', u.rep1.id), company(db, 'Changed theirs', u.rep2.id),
      ]);
      const audit = (entity: string, companyId: string, action: string) => db.$executeRaw`
        INSERT INTO audit_events (run_id, entity_type, entity_id, company_id, action) VALUES (${scrape.id}, ${entity}, ${companyId}, ${companyId}::uuid, ${action})`;
      await Promise.all([
        audit('company', pool.id, 'created'), audit('company', pool.id, 'updated'), audit('company', mine.id, 'created'),
        audit('company', theirs.id, 'created'), audit('company', changedMine.id, 'updated'), audit('company', changedTheirs.id, 'updated'),
        audit('profile', changedMine.id, 'updated'),
      ]);
      const stamp = { job_id: jobId, job_kind: 'scrape', requested_by: u.rep1.id };
      await processEvents(db, [
        await run({ run_id: scrape.id, kind: 'gaf_ingest', ...stamp, job_run_ids: [] }),
        await run({ run_id: scrape.id + 1, kind: 'counties', ...stamp, job_run_ids: [scrape.id] }),
      ]);
      expect(await notifications(db, u.rep1.id)).toEqual([]);
      await processEvents(db, [await run({ run_id: scrape.id + 2, kind: 'tag', ...stamp, job_run_ids: [scrape.id, scrape.id + 1] })]);
      const [n] = await notifications(db, u.rep1.id);
      expect(n).toMatchObject({ type: 'refresh_done', title: 'Refresh of 07030 (10 mi) finished', body: '2 new leads, 1 changed lead' });
      expect(n.data).toMatchObject({ job_id: jobId, new: 2, changed: 1, status: 'succeeded' });
      // A retried attempt of the same job does not notify again; a scheduled job (no requester) never does.
      await processEvents(db, [
        await run({ run_id: 50, kind: 'tag', ...stamp, job_run_ids: [] }),
        await run({ run_id: 51, kind: 'tag', job_id: jobId + 1, job_kind: 'tag', requested_by: null, job_run_ids: [] }),
      ]);
      const done = async () => (await notifications(db)).filter((r) => r.type === 'refresh_done');
      expect(await done()).toHaveLength(1);
      // A manager's refresh counts every lead.
      const managerJob = await job(u.manager.id);
      await processEvents(db, [await run({
        run_id: scrape.id + 3, kind: 'tag', job_id: managerJob, job_kind: 'scrape', requested_by: u.manager.id, job_run_ids: [scrape.id],
      })]);
      expect((await done()).map((r) => [r.user_id, r.body])).toEqual([
        [u.rep1.id, '2 new leads, 1 changed lead'], [u.manager.id, '3 new leads, 2 changed leads'],
      ]);
    });

    it('tells the requester once when their job went dead or its last run failed (refresh_failed), honouring opt-outs', async () => {
      const job = async (requester: string, attempts = 3) => (await db.$queryRaw<{ id: number }[]>`
        INSERT INTO jobs (kind, params, status, attempts, requested_by)
        VALUES ('scrape', '{"postal_code": "07030", "radius_miles": 10}', 'dead', ${attempts}, ${requester}::uuid) RETURNING id`)[0].id;
      // leadmaker/jobs.py job_dead_event
      const died = (jobId: number, requester: string | null, runIds: number[] = []) => run({
        run_id: null, kind: 'job', status: 'failed', complete: false, changed_companies: 0, job_id: jobId, job_kind: 'scrape',
        job_status: 'dead', requested_by: requester, job_run_ids: runIds,
      });
      const [scrape] = await db.$queryRaw<{ id: number }[]>`
        INSERT INTO scrape_runs (kind, status, stats) VALUES ('gaf_ingest', 'failed', '{}') RETURNING id`;
      const lead = await company(db, 'Half scraped', u.rep1.id);
      await db.$executeRaw`
        INSERT INTO audit_events (run_id, entity_type, entity_id, company_id, action) VALUES (${scrape.id}, 'company', ${lead.id}, ${lead.id}::uuid, 'created')`;
      const jobId = await job(u.rep1.id);
      await processEvents(db, [await died(jobId, u.rep1.id, [scrape.id]), await died(jobId, u.rep1.id)]);
      const [n] = await notifications(db, u.rep1.id);
      expect(n).toMatchObject({
        type: 'refresh_failed', title: 'Refresh of 07030 (10 mi) failed', body: 'It stopped after 3 attempts; request it again to retry',
        dedupe_key: `refresh_failed:${jobId}`, company_id: null,
      });
      expect(n.data).toMatchObject({ job_id: jobId, status: 'failed', attempts: 3, new: null, changed: null, postal_code: '07030' });
      await db.$executeRaw`UPDATE notifications SET read_at = NOW()`;
      await processEvents(db, [await died(jobId, u.rep1.id)]);
      expect(await notifications(db, u.rep1.id)).toHaveLength(1);

      // A job's last run that failed is a refresh_failed too, never a refresh_done.
      const other = await job(u.rep1.id, 1);
      await processEvents(db, [await run({ run_id: 90, kind: 'tag', status: 'failed', job_id: other, job_kind: 'scrape', requested_by: u.rep1.id, job_run_ids: [] })]);
      expect((await notifications(db, u.rep1.id)).map((r) => [r.type, r.dedupe_key])).toEqual([
        ['refresh_failed', `refresh_failed:${jobId}`], ['refresh_failed', `refresh_failed:${other}`],
      ]);

      // No requester (a scheduled job): nobody; an opted-out requester: nothing.
      await processEvents(db, [await died(await job(u.rep2.id), null)]);
      await db.$executeRaw`INSERT INTO notification_preferences (user_id, type, enabled) VALUES (${u.rep2.id}::uuid, 'refresh_failed', FALSE)`;
      await processEvents(db, [await died(await job(u.rep2.id), u.rep2.id)]);
      expect(await notifications(db, u.rep2.id)).toEqual([]);
      expect(await outbox()).toHaveLength(2);
    });

    it('tells every manager how many new leads a GAF scrape left in the pool, merging runs', async () => {
      const [a, b, mine] = await Promise.all([company(db, 'New A'), company(db, 'New B'), company(db, 'Taken', u.rep1.id)]);
      const created = (runId: number, companyId: string) => db.$executeRaw`
        INSERT INTO audit_events (run_id, entity_type, entity_id, company_id, action) VALUES (${runId}, 'company', ${companyId}, ${companyId}::uuid, 'created')`;
      await Promise.all([created(7, a.id), created(7, b.id), created(7, mine.id)]);
      await db.$executeRaw`
        INSERT INTO audit_events (run_id, entity_type, entity_id, company_id, action) VALUES (7, 'company', ${a.id}, ${a.id}::uuid, 'updated')`;
      await processEvents(db, [await run({ run_id: 7, kind: 'gaf_ingest' })]);
      const rows = await notifications(db);
      expect(rows.map((r) => [r.user_id, r.type, r.count, r.title]).sort()).toEqual([
        [u.manager.id, 'pool_grew', 2, '2 new leads in the unallocated pool'],
        [u.manager2.id, 'pool_grew', 2, '2 new leads in the unallocated pool'],
      ].sort());
      const c = await company(db, 'New C');
      await created(8, c.id);
      await processEvents(db, [await run({ run_id: 8, kind: 'gaf_ingest' }), await run({ run_id: 9, kind: 'gaf_ingest' })]);
      expect((await notifications(db, u.manager.id))[0]).toMatchObject({ count: 3, title: '3 new leads in the unallocated pool' });
    });
  });

  it('prunes old processed-event claims, state of superseded overrides and long-read notifications', async () => {
    const lead = await company(db, 'A', u.rep1.id);
    const [live, gone] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO field_overrides (company_id, field, value, user_id, superseded_at)
      VALUES (${lead.id}::uuid, 'phone', '"1"', ${u.rep1.id}::uuid, NULL), (${lead.id}::uuid, 'city', '"x"', ${u.rep1.id}::uuid, NOW())
      RETURNING id::text`;
    await db.$executeRaw`
      INSERT INTO notifier_state (key, value) VALUES (${`override:${live.id}`}, '{}'), (${`override:${gone.id}`}, '{}'), ('signals_watermark', 'null')`;
    await db.$executeRaw`INSERT INTO notifier_processed_events (outbox_id, processed_at) VALUES (1, NOW() - INTERVAL '30 days'), (2, NOW())`;
    await db.$executeRaw`
      INSERT INTO notifications (user_id, type, title, dedupe_key, read_at)
      VALUES (${u.rep1.id}::uuid, 'allocated', 'old', 'a', NOW() - INTERVAL '100 days'), (${u.rep1.id}::uuid, 'allocated', 'new', 'b', NOW())`;
    expect(await prune(db, 14)).toBe(3);
    expect((await db.$queryRaw<{ key: string }[]>`SELECT key FROM notifier_state ORDER BY key`).map((r) => r.key))
      .toEqual([`override:${live.id}`, 'signals_watermark']);
    expect((await notifications(db)).map((n) => n.title)).toEqual(['new']);
  });

  it('ignores event types without a rule, including its own notification.created', async () => {
    const lead = await company(db, 'A', u.rep1.id);
    const written = await processEvents(db, [
      await event(db, 'state.changed', lead.id, { actor_id: u.rep1.id }),
      await event(db, 'notification.created', null, { actor_type: 'system', user_id: u.rep1.id }),
    ]);
    expect(written).toEqual([]);
    expect(await db.$queryRaw<unknown[]>`SELECT 1 FROM notifier_processed_events`).toEqual([]);
  });
});
