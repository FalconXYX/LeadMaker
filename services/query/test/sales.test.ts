import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LeadFacetsResponse, LeadProfile, LeadSearchResult, SalesDashboard, Task, TasksPage } from '@leadmaker/shared';
import { TEAM_SLOW_KEY } from '../src/dashboard.ts';
import { as, clearCache, COMPANIES, FILLERS, harness, seed, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

// A time `days` days from today at `hours` o'clock in the sales time zone (America/New_York).
const nyDay = (days: number, hours = 12) =>
  `((date_trunc('day', now() AT TIME ZONE 'America/New_York') + interval '${days} days ${hours} hours') AT TIME ZONE 'America/New_York')`;
const lastWeek = `((date_trunc('week', now() AT TIME ZONE 'America/New_York') - interval '1 day' + interval '12 hours') AT TIME ZONE 'America/New_York')`;

describe.skipIf(!TEST_DATABASE_URL)('sales reads: tasks, dashboard and the stage-aware lists', () => {
  let h: Harness;
  let f: Fixture;
  const t: Record<string, string> = {};
  let hot: string;

  const get = (path: string, user: string, role: 'rep' | 'manager' = 'rep') => request(h.app).get(path).set(as(user, role));
  const post = (path: string, body: object, user: string, role: 'rep' | 'manager' = 'rep') =>
    request(h.app).post(path).set(as(user, role)).send(body);
  const titles = (items: Task[]) => items.map((i) => Object.keys(t).find((k) => t[k] === i.id));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
    const { ids, users } = f;
    await h.exec(`UPDATE companies SET updated_in_last_poll = (id = $1::uuid)`, ids.acme);
    await h.exec(`UPDATE companies SET sales_stage = 'quoting', stage_changed_at = now() - interval '2 days',
      last_contacted_at = now() - interval '1 day' WHERE id = $1::uuid`, ids.acme);
    await h.exec(`UPDATE companies SET sales_stage = CASE WHEN id = $1::uuid THEN 'won' ELSE 'lost' END, stage_changed_at = now(),
      last_contacted_at = now() - CASE WHEN id = $1::uuid THEN interval '41 days' ELSE interval '40 days' END
      WHERE id IN ($1::uuid, $2::uuid)`, ids.hackensack, ids.staten);
    const task = async (name: string, company: string, assignee: string, due: string, done: string | null = null) => {
      t[name] = (await h.query<{ id: string }>(`INSERT INTO tasks (company_id, title, type, due_at, done_at, assignee_id, created_by)
        VALUES ($1::uuid, $2, 'call', ${due}, ${done ?? 'NULL'}, $3::uuid, $4::uuid) RETURNING id`,
        company, name, assignee, users.manager))[0].id;
    };
    await task('overdue', ids.acme, users.rep1, nyDay(-1, 10));
    await task('managerToday', ids.acme, users.manager, nyDay(0, 12));
    await task('inThreeDays', ids.acme, users.rep1, nyDay(3));
    await task('doneOnAcme', ids.acme, users.rep1, nyDay(-2), `now() - interval '1 hour'`);
    await task('inTenDays', ids.brooklyn, users.rep1, nyDay(10));
    await task('poolMine', ids.jersey, users.rep1, nyDay(1));
    await task('poolTheirs', ids.jersey, users.rep2, nyDay(2));
    await task('mineOnTheirLead', ids.hackensack, users.rep1, nyDay(0, 13));
    await task('theirsOverdue', ids.hackensack, users.rep2, nyDay(-1, 11));
    await task('doneOnStaten', ids.staten, users.rep2, nyDay(-3), `now() - interval '2 hours'`);
    // rep1's activity this week (and one call last week); a manager's note on acme; rep2's call on hackensack.
    const log = (company: string, user: string, type: string, at = 'now()') => h.exec(`INSERT INTO activity_logs
      (company_id, actor_type, user_id, action_type, created_at) VALUES ($1::uuid, 'user', $2::uuid, $3, ${at})`, company, user, type);
    await log(ids.acme, users.rep1, 'call');
    await log(ids.acme, users.rep1, 'email');
    await log(ids.brooklyn, users.rep1, 'visit');
    await log(ids.acme, users.manager, 'note');
    await log(ids.acme, users.rep1, 'call', lastWeek);
    await log(ids.acme, users.rep1, 'checked');
    await log(ids.hackensack, users.rep2, 'call');
    // Coverage: acme's target contact is named (a weak decision-maker), hackensack's decision-maker identified, staten's
    // only weak; brooklyn has a president (with a phone and, by a rep's correction, an email) and an owner marked do
    // not contact. Brooklyn's company phone was cleared by a rep.
    await h.exec(`UPDATE companies SET system_tags = (SELECT jsonb_agg(CASE WHEN e->>'key' = 'target_contact'
      THEN jsonb_set(e, '{contact,named}', 'true') ELSE e END) FROM jsonb_array_elements(system_tags) e) WHERE id = $1::uuid`, ids.acme);
    const dm = (company: string, value: string) => h.exec(`UPDATE companies SET system_tags = system_tags || jsonb_build_array(
      jsonb_build_object('key', 'decision_maker', 'value', $2::text, 'label', 'DM', 'category', 'contactability')) WHERE id = $1::uuid`,
    company, value);
    await dm(ids.acme, 'weak');
    await dm(ids.hackensack, 'identified');
    await dm(ids.staten, 'weak');
    const contact = async (company: string, name: string, title: string, email: string | null, phone: string | null, dnc = false) =>
      (await h.query<{ id: string }>(`INSERT INTO contacts (company_id, name, title, email, phone, source, do_not_contact)
        VALUES ($1::uuid, $2, $3, $4, $5, 'test', $6) RETURNING id`, company, name, title, email, phone, dnc))[0].id;
    await contact(ids.acme, 'Jane Owner', 'Office Manager', 'jane@acme.test', null);
    const bob = await contact(ids.brooklyn, 'Bob Boss', 'President', null, '555-0101');
    await contact(ids.brooklyn, 'Dee Nope', 'Owner', 'dee@brooklyn.test', null, true);
    await h.exec(`INSERT INTO field_overrides (company_id, contact_id, field, value, user_id)
      VALUES ($1::uuid, $2::uuid, 'email', '"bob@brooklyn.test"', $3::uuid), ($1::uuid, NULL, 'phone', 'null', $3::uuid)`,
    ids.brooklyn, bob, users.rep1);
    hot = (await h.query<{ id: string }>(`INSERT INTO custom_tags (name, created_by) VALUES ('Hot', $1::uuid) RETURNING id`, users.rep1))[0].id;
    await h.exec(`INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $3::uuid, $4::uuid), ($2::uuid, $3::uuid, $4::uuid)`,
      ids.acme, ids.brooklyn, hot, users.rep1);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => clearCache(h.redis));

  describe('GET /tasks', () => {
    it("lists a rep's tasks: assigned to them or on their leads, on leads they may open, earliest due first", async () => {
      const res = await get('/tasks', f.users.rep1);
      expect(res.status).toBe(200);
      const body = res.body as TasksPage;
      expect(titles(body.items)).toEqual(['overdue', 'managerToday', 'poolMine', 'inThreeDays', 'inTenDays']);
      expect(body.nextCursor).toBeNull();
      expect(body.items[1]).toMatchObject({
        companyId: f.ids.acme, companyName: 'Acme Roofing', title: 'managerToday', type: 'call', doneAt: null, note: null,
        assignee: { id: f.users.manager, name: 'Morgan Manager' }, createdBy: { id: f.users.manager, name: 'Morgan Manager' }, version: 1,
      });
      expect(body.items[0].dueAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it('narrows to due windows in the sales time zone', async () => {
      const due = async (d: string) => titles((await get(`/tasks?due=${d}`, f.users.rep1)).body.items);
      expect(await due('overdue')).toEqual(['overdue']);
      expect(await due('today')).toEqual(['managerToday']);
      expect(await due('week')).toEqual(['managerToday', 'poolMine', 'inThreeDays']);
      expect(await due('upcoming')).toEqual(['poolMine', 'inThreeDays', 'inTenDays']);
      expect(await due('all')).toHaveLength(5);
    });

    it('lists done tasks most recently completed first', async () => {
      expect(titles((await get('/tasks?status=done', f.users.rep1)).body.items)).toEqual(['doneOnAcme']);
      expect(titles((await get('/tasks?scope=team&status=done', f.users.manager, 'manager')).body.items))
        .toEqual(['doneOnAcme', 'doneOnStaten']);
    });

    it('gives managers the team, one rep, or their own', async () => {
      const list = async (scope: string) => titles((await get(`/tasks?scope=${scope}`, f.users.manager, 'manager')).body.items);
      expect(await list('team')).toEqual([
        'overdue', 'theirsOverdue', 'managerToday', 'mineOnTheirLead', 'poolMine', 'poolTheirs', 'inThreeDays', 'inTenDays',
      ]);
      expect(await list(`rep:${f.users.rep2}`)).toEqual(['theirsOverdue', 'mineOnTheirLead', 'poolTheirs']);
      expect(await list(`rep:${f.users.rep1}`)).toEqual(['overdue', 'managerToday', 'mineOnTheirLead', 'poolMine', 'inThreeDays', 'inTenDays']);
      expect(await list('mine')).toEqual(['managerToday']);
    });

    it('keeps team and other reps to managers and checks its parameters', async () => {
      expect((await get('/tasks?scope=team', f.users.rep1)).status).toBe(403);
      expect((await get(`/tasks?scope=rep:${f.users.rep2}`, f.users.rep1)).status).toBe(403);
      expect((await get(`/tasks?scope=rep:${f.users.rep1}`, f.users.rep1)).body.items).toHaveLength(5);
      expect((await get('/tasks?scope=everyone', f.users.rep1)).status).toBe(400);
      expect((await get('/tasks?due=someday', f.users.rep1)).status).toBe(400);
      expect((await get('/tasks?limit=0', f.users.rep1)).status).toBe(400);
      expect((await get('/tasks?cursor=nope', f.users.rep1)).status).toBe(400);
    });

    it('pages with a keyset cursor tied to the status', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: TasksPage = (await get(`/tasks?limit=2${cursor ? `&cursor=${cursor}` : ''}`, f.users.rep1)).body;
        seen.push(...titles(page.items) as string[]);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['overdue', 'managerToday', 'poolMine', 'inThreeDays', 'inTenDays']);
      const first = (await get('/tasks?scope=team&limit=1', f.users.manager, 'manager')).body as TasksPage;
      expect((await get(`/tasks?scope=team&status=done&cursor=${first.nextCursor}`, f.users.manager, 'manager')).status).toBe(400);
      const forged = Buffer.from(JSON.stringify({ s: 'open', k: 'yesterday-ish', id: t.overdue })).toString('base64url');
      expect((await get(`/tasks?cursor=${forged}`, f.users.rep1)).status).toBe(400);
    });
  });

  describe('lists, facets and profiles', () => {
    it('adds the stage, last contact and next open task to summaries', async () => {
      const { items } = (await post('/leads/search', { filter: { scope: 'mine' } }, f.users.rep1)).body as LeadSearchResult;
      const acme = items.find((i) => i.id === f.ids.acme)!;
      expect(acme).toMatchObject({ salesStage: 'quoting', nextTask: { id: t.overdue, title: 'overdue', type: 'call' } });
      expect(Date.now() - Date.parse(acme.lastContactedAt!)).toBeGreaterThan(23 * 3600e3);
      expect(acme.nextTask!.dueAt).toMatch(/Z$/);
      expect(items.find((i) => i.id === f.ids.brooklyn)).toMatchObject({ salesStage: 'new', lastContactedAt: null, nextTask: { title: 'inTenDays' } });
      // Whoever the task is assigned to.
      const pool = (await post('/leads/search', { filter: { scope: 'unallocated' } }, f.users.rep3)).body as LeadSearchResult;
      expect(pool.items.find((i) => i.id === f.ids.jersey)!.nextTask).toMatchObject({ title: 'poolMine' });
      expect(pool.items.find((i) => i.id === f.ids.queens)!.nextTask).toBeNull();
    });

    it('sorts by next follow-up (none last) and last contact (never counts as oldest), page by page', async () => {
      const walk = async (filter: object, user: string, role: 'rep' | 'manager') => {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const page: LeadSearchResult = (await post('/leads/search', { filter: { ...filter, limit: 3, ...(cursor ? { cursor } : {}) } }, user, role)).body;
          ids.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor;
        } while (cursor);
        return ids;
      };
      const all = Object.keys(COMPANIES).length + FILLERS;
      const next = await walk({ sort: { by: 'next_follow_up', dir: 'asc' } }, f.users.manager, 'manager');
      expect(next.slice(0, 4)).toEqual([f.ids.acme, f.ids.hackensack, f.ids.jersey, f.ids.brooklyn]);
      expect(new Set(next).size).toBe(all);
      const nextDesc = await walk({ sort: { by: 'next_follow_up', dir: 'desc' } }, f.users.manager, 'manager');
      expect(nextDesc.slice(0, 4)).toEqual([f.ids.brooklyn, f.ids.jersey, f.ids.hackensack, f.ids.acme]);
      expect(new Set(nextDesc).size).toBe(all);
      expect(await walk({ scope: 'mine', sort: { by: 'next_follow_up', dir: 'asc' } }, f.users.rep1, 'rep')).toEqual([f.ids.acme, f.ids.brooklyn]);
      const contacted = await walk({ sort: { by: 'last_contacted', dir: 'desc' } }, f.users.manager, 'manager');
      expect(contacted.slice(0, 3)).toEqual([f.ids.acme, f.ids.staten, f.ids.hackensack]);
      expect(new Set(contacted).size).toBe(all);
      const oldest = await walk({ sort: { by: 'last_contacted', dir: 'asc' } }, f.users.manager, 'manager');
      expect(oldest.slice(-3)).toEqual([f.ids.hackensack, f.ids.staten, f.ids.acme]);
    });

    it('filters by stage, follow-up and last contact', async () => {
      const ids = async (filter: object, user = f.users.manager, role: 'rep' | 'manager' = 'manager') =>
        ((await post('/leads/search', { filter }, user, role)).body as LeadSearchResult).items.map((i) => i.id).sort();
      expect(await ids({ stages: ['quoting', 'won'] })).toEqual([f.ids.acme, f.ids.hackensack].sort());
      expect(await ids({ followUp: 'overdue' })).toEqual([f.ids.acme, f.ids.hackensack].sort());
      const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
      expect(await ids({ scope: 'mine', notContactedSince: monthAgo }, f.users.rep1, 'rep')).toEqual([f.ids.brooklyn]);
    });

    it('counts every stage in pipeline order', async () => {
      const facets = (await post('/leads/facets', { filter: { scope: 'mine' } }, f.users.rep1)).body as LeadFacetsResponse;
      expect(facets.stages).toEqual([
        { value: 'new', count: 1 }, { value: 'contacted', count: 0 }, { value: 'interested', count: 0 },
        { value: 'quoting', count: 1 }, { value: 'won', count: 0 }, { value: 'lost', count: 0 },
      ]);
    });

    it("puts the stage, last contact and the lead's tasks on the profile, read live", async () => {
      const profile = (await get(`/leads/${f.ids.acme}`, f.users.rep1)).body as LeadProfile;
      expect(profile).toMatchObject({ salesStage: 'quoting' });
      expect(profile.stageChangedAt).toMatch(/Z$/);
      expect(profile.lastContactedAt).toMatch(/Z$/);
      expect(titles(profile.tasks)).toEqual(['overdue', 'managerToday', 'inThreeDays', 'doneOnAcme']);
      expect(profile.tasks[3].doneAt).toMatch(/Z$/);
      // Every task on a lead the caller may open, whoever it is assigned to.
      expect(titles(((await get(`/leads/${f.ids.jersey}`, f.users.rep3)).body as LeadProfile).tasks)).toEqual(['poolMine', 'poolTheirs']);
      // The body is cached by version; tasks and the last contact are read on every request.
      await h.exec(`UPDATE tasks SET done_at = now() WHERE id = $1::uuid`, t.inThreeDays);
      await h.exec(`UPDATE companies SET last_contacted_at = '2026-10-01T00:00:00Z' WHERE id = $1::uuid`, f.ids.acme);
      try {
        const again = await get(`/leads/${f.ids.acme}`, f.users.rep1);
        expect(again.headers['x-cache']).toBe('hit');
        expect(titles(again.body.tasks)).toEqual(['overdue', 'managerToday', 'inThreeDays', 'doneOnAcme']);
        expect(again.body.tasks[2].doneAt).not.toBeNull();
        expect(again.body.lastContactedAt).toBe('2026-10-01T00:00:00.000Z');
      } finally {
        await h.exec(`UPDATE tasks SET done_at = NULL WHERE id = $1::uuid`, t.inThreeDays);
        await h.exec(`UPDATE companies SET last_contacted_at = now() - interval '1 day' WHERE id = $1::uuid`, f.ids.acme);
      }
    });
  });

  describe('GET /dashboard', () => {
    const today = async () => (await h.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d`))[0].d;

    it("summarises a rep's own leads", async () => {
      const res = await get('/dashboard', f.users.rep1);
      expect(res.status).toBe(200);
      expect(res.headers['x-cache']).toBe('miss');
      const d = res.body as SalesDashboard;
      expect(d.scope).toBe('mine');
      expect(d.pipeline).toEqual([
        { stage: 'new', count: 1 }, { stage: 'contacted', count: 0 }, { stage: 'interested', count: 0 },
        { stage: 'quoting', count: 1 }, { stage: 'won', count: 0 }, { stage: 'lost', count: 0 },
      ]);
      expect(d.followUps).toEqual({ overdue: 1, today: 1, week: 2 });
      expect(d.activity.thisWeek).toEqual({ calls: 1, emails: 1, visits: 1, notes: 1 });
      expect(d.activity.lastWeek).toEqual({ calls: 1, emails: 0, visits: 0, notes: 0 });
      expect(d.activity.goalPerWeek).toBe(25);
      expect(d.activity.daily).toHaveLength(14);
      expect(d.activity.daily.at(-1)).toEqual({ date: await today(), calls: 1, emails: 1, visits: 1, notes: 1 });
      expect(d.activity.daily.map((x) => x.date)).toEqual([...d.activity.daily.map((x) => x.date)].sort());
      expect(d.activity.daily.reduce((n, x) => n + x.calls, 0)).toBe(2);
      expect(d.accounts).toEqual({ prospect: 2, existing_customer: 0, lapsed_customer: 0, do_not_contact: 0 });
      // acme: named target contact, contact email; brooklyn: president with a phone and a corrected email.
      expect(d.coverage).toEqual({ total: 2, withDecisionMaker: 2, withEmail: 2, withPhone: 2 });
      expect(d).toMatchObject({ neverContacted: 1, notContacted30d: 0, newSinceLastPoll: 1 });
      expect(d.topTags[0]).toEqual({ key: hot, label: 'Hot', count: 2, kind: 'custom' });
      expect(d.topTags.slice(1).map((x) => [x.key, x.count, x.kind])).toEqual([
        ['gaf_tier=certified', 1, 'system'], ['gaf_tier=master_elite', 1, 'system'], ['service:metal_roofing', 1, 'system'],
        ['service:shingle_roofing', 1, 'system'], ['service:storm_damage', 1, 'system'],
      ]);
      expect(d.topTags[2].label).toBe('gaf_tier: master_elite');
      expect(d.segments).toEqual([
        { segment: 'strategic', count: 1 }, { segment: 'growth', count: 1 }, { segment: 'emerging', count: 0 }, { segment: 'long_tail', count: 0 },
      ]);
      expect(d.reps).toBeUndefined();
      expect(Date.parse(d.generatedAt)).toBeGreaterThan(Date.now() - 60e3);
    });

    it('drops contacts marked do not contact and counts a rep-cleared company phone as none', async () => {
      await h.exec(`UPDATE contacts SET do_not_contact = TRUE WHERE name = 'Bob Boss'`);
      try {
        const d = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
        expect(d.coverage).toEqual({ total: 2, withDecisionMaker: 1, withEmail: 1, withPhone: 1 });
      } finally {
        await h.exec(`UPDATE contacts SET do_not_contact = FALSE WHERE name = 'Bob Boss'`);
      }
    });

    it('gives managers every allocated lead with a row per rep', async () => {
      const d = (await get('/dashboard', f.users.manager, 'manager')).body as SalesDashboard;
      expect(d.scope).toBe('team');
      expect(d.pipeline.map((p) => p.count)).toEqual([1, 0, 0, 1, 1, 1]);
      expect(d.followUps).toEqual({ overdue: 2, today: 2, week: 3 });
      expect(d.activity.thisWeek).toEqual({ calls: 2, emails: 1, visits: 1, notes: 1 });
      expect(d.activity.goalPerWeek).toBe(75);
      expect(d.coverage).toEqual({ total: 4, withDecisionMaker: 3, withEmail: 2, withPhone: 4 });
      expect(d).toMatchObject({ neverContacted: 1, notContacted30d: 2, newSinceLastPoll: 1 });
      expect(d.accounts.prospect).toBe(4);
      expect(d.reps).toEqual([
        { rep: { id: f.users.rep1, name: 'Riley Rep' }, assigned: 2, pipeline: d.pipeline.map((p) => ({ ...p, count: ['new', 'quoting'].includes(p.stage) ? 1 : 0 })),
          activityThisWeek: 3, overdue: 1, wonThisMonth: 0 },
        { rep: { id: f.users.rep2, name: 'Sam Rep' }, assigned: 2, pipeline: d.pipeline.map((p) => ({ ...p, count: ['won', 'lost'].includes(p.stage) ? 1 : 0 })),
          activityThisWeek: 1, overdue: 1, wonThisMonth: 1 },
        { rep: { id: f.users.rep3, name: 'Taylor Rep' }, assigned: 0, pipeline: d.pipeline.map((p) => ({ ...p, count: 0 })),
          activityThisWeek: 0, overdue: 0, wonThisMonth: 0 },
      ]);
    });

    it("shows a manager a rep's dashboard, keeps team and other reps from reps, and checks the scope", async () => {
      const mine = (await get('/dashboard', f.users.rep1)).body as SalesDashboard;
      const viewed = await get(`/dashboard?scope=rep:${f.users.rep1}`, f.users.manager, 'manager');
      // One entry serves both names for the same leads.
      expect(viewed.headers['x-cache']).toBe('hit');
      expect(viewed.body).toEqual({ ...mine, scope: `rep:${f.users.rep1}` });
      expect((await get(`/dashboard?scope=rep:${f.users.rep1}`, f.users.rep1)).status).toBe(200);
      expect((await get('/dashboard?scope=team', f.users.rep1)).status).toBe(403);
      expect((await get(`/dashboard?scope=rep:${f.users.rep2}`, f.users.rep1)).status).toBe(403);
      expect((await get('/dashboard?scope=rep:nobody', f.users.manager, 'manager')).status).toBe(400);
      expect(((await get('/dashboard?scope=mine', f.users.manager, 'manager')).body as SalesDashboard).coverage.total).toBe(0);
    });

    it('caches for 30 s and reads past the cache right after the caller\'s own write', async () => {
      await get('/dashboard', f.users.rep1);
      expect(await h.redis.ttl(`dash:${f.users.rep1}`)).toBeGreaterThan(25);
      await h.exec(`UPDATE companies SET sales_stage = 'interested' WHERE id = $1::uuid`, f.ids.brooklyn);
      try {
        const cached = await get('/dashboard', f.users.rep1);
        expect(cached.headers['x-cache']).toBe('hit');
        expect(cached.body.pipeline[0]).toEqual({ stage: 'new', count: 1 });
        await h.redis.set(`rw:${f.users.rep1}`, '1', 'EX', 5);
        const fresh = await get('/dashboard', f.users.rep1);
        expect(fresh.headers['x-cache']).toBe('bypass');
        expect(fresh.body.pipeline.map((p: { count: number }) => p.count)).toEqual([0, 0, 1, 1, 0, 0]);
      } finally {
        await h.redis.del(`rw:${f.users.rep1}`);
        await h.exec(`UPDATE companies SET sales_stage = 'new' WHERE id = $1::uuid`, f.ids.brooklyn);
      }
    });

    it("serves the team's coverage and top tags from their own cache and refreshes them in the background once stale", async () => {
      const first = (await get('/dashboard', f.users.manager, 'manager')).body as SalesDashboard;
      const slow = JSON.parse((await h.redis.get(TEAM_SLOW_KEY))!);
      expect(slow.coverage).toEqual(first.coverage);
      await h.exec(`INSERT INTO contacts (company_id, name, email, source) VALUES ($1::uuid, 'Hal', 'hal@hackensack.test', 'test')`, f.ids.hackensack);
      try {
        await h.redis.del('dash:team');
        await h.redis.set(TEAM_SLOW_KEY, JSON.stringify({ ...slow, at: Date.now() - 3600e3 }));
        // Stale: served as is while one refresh runs.
        expect(((await get('/dashboard', f.users.manager, 'manager')).body as SalesDashboard).coverage.withEmail).toBe(2);
        let refreshed: { at: number; coverage: SalesDashboard['coverage'] } | undefined;
        for (let i = 0; i < 50 && !(refreshed && refreshed.at > Date.now() - 60e3); i++) {
          await new Promise((r) => setTimeout(r, 50));
          refreshed = JSON.parse((await h.redis.get(TEAM_SLOW_KEY))!);
        }
        expect(refreshed!.coverage.withEmail).toBe(3);
        await h.redis.del('dash:team');
        expect(((await get('/dashboard', f.users.manager, 'manager')).body as SalesDashboard).coverage.withEmail).toBe(3);
      } finally {
        await h.exec(`DELETE FROM contacts WHERE name = 'Hal'`);
      }
    });
  });
});
