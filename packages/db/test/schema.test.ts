// Pins the database contract (db/migrations + db/seed) against a real migrated Postgres.
// Runs only with TEST_DATABASE_URL (npm run test:db resets leadmaker_test and sets it);
// refuses any database whose name does not end in _test because it truncates every table.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, Prisma, type PrismaClient } from '../src/index.ts';

const url = process.env.TEST_DATABASE_URL;
const seedDir = new URL('../../../db/seed/', import.meta.url);

describe.skipIf(!url)('database schema', () => {
  let db: PrismaClient;
  let manager: string;
  let rep: string;

  const one = async <T>(sql: string, ...params: unknown[]): Promise<T> =>
    ((await db.$queryRawUnsafe(sql, ...params)) as T[])[0];

  const pgError = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      const err = e as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } };
      return err.meta?.driverAdapterError?.cause?.originalCode ?? err.code;
    }
    return undefined;
  };

  const company = (over: Partial<Prisma.companiesUncheckedCreateInput> = {}) =>
    db.companies.create({
      data: { business_name: 'Acme Roofing', latitude: 40.72, longitude: -74.0, content_hash: 'h', ...over },
    });

  beforeAll(async () => {
    db = createPrismaClient(url);
    const { name } = await one<{ name: string }>('SELECT current_database() AS name');
    if (!name.endsWith('_test')) throw new Error(`refusing to truncate ${name}: TEST_DATABASE_URL must name a *_test database`);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DO $$ BEGIN
      EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' RESTART IDENTITY CASCADE'
               FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys'));
    END $$`);
    await db.$executeRawUnsafe('REFRESH MATERIALIZED VIEW team_dashboard_kpis');
    manager = (await db.users.create({ data: { name: 'M', email: 'm@test', role: 'manager' } })).id;
    rep = (await db.users.create({ data: { name: 'R', email: 'r@test', role: 'rep' } })).id;
  });

  it('derives location from latitude/longitude', async () => {
    const c = await company();
    const p = await one<{ x: number; y: number; near: boolean }>(
      `SELECT ST_X(location::geometry) AS x, ST_Y(location::geometry) AS y,
              ST_DWithin(location, ST_MakePoint(-74.0, 40.73)::geography, 1200) AS near
       FROM companies WHERE id = $1::uuid`, c.id);
    expect(p).toEqual({ x: -74.0, y: 40.72, near: true });
    await db.companies.update({ where: { id: c.id }, data: { latitude: 41 } });
    expect((await one<{ y: number }>('SELECT ST_Y(location::geometry) AS y FROM companies WHERE id = $1::uuid', c.id)).y).toBe(41);
  });

  it('bumps companies.version only on rep-visible changes, once per statement', async () => {
    const c = await company({ priority_score: 73.45 });
    expect(c.version).toBe(1);
    expect(c.priority_score?.toString()).toBe('73.5');
    const update = (data: Prisma.companiesUncheckedUpdateInput) => db.companies.update({ where: { id: c.id }, data });

    expect((await update({ business_name: 'Acme Roofing' })).version).toBe(1);
    expect((await update({ last_seen_at: new Date(), tagged_at: new Date(), profile_scraped_at: new Date(),
                           team_last_checked_at: new Date(), team_last_serviced_at: new Date() })).version).toBe(1);
    // A re-scrape from another ZIP rewrites the raw listing (distanceinmiles, transactionid) and nothing visible.
    expect((await update({ raw: { distanceinmiles: 3.2 }, content_hash: 'h2', listing_updated_at: new Date() })).version).toBe(1);
    const bumped = await update({ rating: 4.8 });
    expect(bumped.version).toBe(2);
    expect(bumped.updated_at.getTime()).toBeGreaterThan(c.updated_at.getTime());
    expect((await update({ assigned_rep_id: rep })).version).toBe(3);
    expect((await update({ custom_fields: { po: 'x' }, version: { increment: 1 } })).version).toBe(4);
    // A child-table write (override, contact, custom tag) bumps the company with a bare increment.
    expect((await update({ version: { increment: 1 } })).version).toBe(5);
  });

  it('never moves version backwards, so a versioned cache key is never reused', async () => {
    const c = await company();
    await db.companies.update({ where: { id: c.id }, data: { rating: 4 } });
    expect((await db.companies.update({ where: { id: c.id }, data: { version: 1 } })).version).toBe(2);
    const upsert = await one<{ version: number }>(
      `INSERT INTO companies (id, business_name, latitude, longitude, content_hash) VALUES ($1::uuid, 'Renamed', 40.72, -74.0, 'h')
       ON CONFLICT (id) DO UPDATE SET business_name = EXCLUDED.business_name, version = EXCLUDED.version
       RETURNING version`, c.id);
    expect(upsert.version).toBe(3);
  });

  it('supports the optimistic-lock write pattern', async () => {
    const c = await company();
    const write = (seen: number) => db.companies.updateMany({
      where: { id: c.id, version: seen }, data: { custom_fields: { seen }, version: { increment: 1 } },
    });
    expect((await write(1)).count).toBe(1);
    expect((await write(1)).count).toBe(0);
  });

  it('bumps companies.version for a sales stage change but not for last_contacted_at, and checks the stage', async () => {
    const c = await company();
    expect(c.sales_stage).toBe('new');
    expect((await db.companies.update({ where: { id: c.id }, data: { last_contacted_at: new Date() } })).version).toBe(1);
    expect((await db.companies.update({ where: { id: c.id }, data: { sales_stage: 'quoting', stage_changed_at: new Date() } })).version).toBe(2);
    expect(await pgError(db.companies.update({ where: { id: c.id }, data: { sales_stage: 'closed' } }))).toBe('23514');
  });

  it('keeps tasks on their lead: typed, titled, removed with the company', async () => {
    const c = await company();
    const task = (data: Partial<Prisma.tasksUncheckedCreateInput>) => db.tasks.create({
      data: { company_id: c.id, title: 'Call back', due_at: new Date(), assignee_id: rep, created_by: manager, ...data },
    });
    const t = await task({});
    expect(t).toMatchObject({ type: 'todo', version: 1, done_at: null, source: 'user' });
    expect(await pgError(task({ type: 'meeting' }))).toBe('23514');
    expect(await pgError(task({ title: '  ' }))).toBe('23514');
    expect(await pgError(task({ version: 0 }))).toBe('23514');
    expect(await pgError(task({ assignee_id: '7a1c4c8e-0000-4000-8000-000000000000' }))).toBe('23503');
    await db.companies.delete({ where: { id: c.id } });
    expect(await db.tasks.count()).toBe(0);
  });

  it('bumps contacts.version on contact changes but not on last_seen_at', async () => {
    const c = await company();
    const ct = await db.contacts.create({ data: { company_id: c.id, name: 'Pat', source: 'bbb' } });
    expect((await db.contacts.update({ where: { id: ct.id }, data: { last_seen_at: new Date() } })).version).toBe(1);
    expect((await db.contacts.update({ where: { id: ct.id }, data: { title: 'Owner' } })).version).toBe(2);
  });

  it('allows one active override per field, company-level included', async () => {
    const c = await company();
    const ct = await db.contacts.create({ data: { company_id: c.id, name: 'Pat', source: 'bbb' } });
    const override = (field: string, contact_id: string | null = null) =>
      db.field_overrides.create({ data: { company_id: c.id, contact_id, field, value: 'v', user_id: rep } });
    await override('phone');
    expect(await pgError(override('phone'))).toBe('23505');
    await override('phone', ct.id);
    expect(await pgError(override('phone', ct.id))).toBe('23505');
    await db.field_overrides.updateMany({ where: { field: 'phone', contact_id: null }, data: { superseded_at: new Date() } });
    await override('phone');
    expect(await db.field_overrides.count({ where: { company_id: c.id, contact_id: null } })).toBe(2);
  });

  it('allows one open allocation per lead and keeps the history', async () => {
    const c = await company();
    const allocate = () => db.lead_allocations.create({ data: { company_id: c.id, rep_id: rep, allocated_by: manager } });
    const first = await allocate();
    expect(await pgError(allocate())).toBe('23505');
    await db.lead_allocations.update({ where: { id: first.id }, data: { ended_at: new Date(), ended_by: manager } });
    await allocate();
    const withHistory = await db.companies.findUniqueOrThrow({ where: { id: c.id }, include: { lead_allocations: true } });
    expect(withHistory.lead_allocations).toHaveLength(2);
  });

  it('merges duplicate open jobs per dedupe key and links them to the requesting user', async () => {
    await db.jobs.create({ data: { kind: 'scrape', dedupe_key: 'scrape:10013:25:*', requested_by: rep } });
    expect(await pgError(db.jobs.create({ data: { kind: 'scrape', dedupe_key: 'scrape:10013:25:*' } }))).toBe('23505');
    await db.jobs.updateMany({ data: { status: 'succeeded' } });
    await db.jobs.create({ data: { kind: 'scrape', dedupe_key: 'scrape:10013:25:*' } });
    expect(await pgError(db.jobs.create({ data: { kind: 'scrape', requested_by: 'not-a-uuid' } }))).toBeDefined();
  });

  it('accepts only contract event types with an actor_type in outbox_events', async () => {
    const event = (event_type: string, payload: object) => db.outbox_events.create({ data: { event_type, payload } });
    expect(await pgError(event('lead.deleted', { actor_type: 'user' }))).toBe('23514');
    expect(await pgError(event('lead.updated', {}))).toBe('23514');
    expect(await pgError(event('lead.updated', { actor_type: 'robot' }))).toBe('23514');
    const ok = await event('pipeline.run_completed', { actor_type: 'pipeline', company_ids: [] });
    expect(typeof ok.id).toBe('bigint');
  });

  it('refreshes team_dashboard_kpis concurrently, with the unallocated pool as the NULL row', async () => {
    const mine = await company({ assigned_rep_id: rep, last_material_change_at: new Date(Date.now() - 60_000) });
    await company();
    await db.lead_rep_state.create({ data: { company_id: mine.id, user_id: rep, checked_at: new Date() } });
    await db.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY team_dashboard_kpis');
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT assigned_rep_id, lead_count, unserviced_count, unchecked_count, recent_updates_count,
              rep_unserviced_count, rep_unchecked_count
       FROM team_dashboard_kpis ORDER BY assigned_rep_id NULLS LAST`);
    expect(rows).toEqual([
      { assigned_rep_id: rep, lead_count: 1, unserviced_count: 1, unchecked_count: 1, recent_updates_count: 1,
        rep_unserviced_count: 1, rep_unchecked_count: 0 },
      { assigned_rep_id: null, lead_count: 1, unserviced_count: 1, unchecked_count: 1, recent_updates_count: 1,
        rep_unserviced_count: 1, rep_unchecked_count: 1 },
    ]);
  });

  it('seeds demo users and ~50 leads per rep by county, idempotently', async () => {
    const counties = ['34003', '34003', '34003', '34013', '34013', '36059', '34031', '36081'];
    await db.companies.createMany({
      data: Array.from({ length: 240 }, (_, i) => ({
        business_name: `Fake ${i}`, latitude: 40.7, longitude: -74.0, content_hash: `h${i}`,
        county_fips: counties[i % counties.length], priority_score: (i * 37) % 100,
      })),
    });
    const seed = async () => {
      for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()) {
        await db.$executeRawUnsafe(readFileSync(new URL(file, seedDir), 'utf8'));
      }
    };
    await seed();
    const history = () => one<{ activity: number; tasks: number; outbox: number; versions: number }>(
      `SELECT (SELECT count(*)::int FROM activity_logs) AS activity, (SELECT count(*)::int FROM tasks) AS tasks,
              (SELECT count(*)::int FROM outbox_events) AS outbox, (SELECT sum(version)::int FROM companies) AS versions`);
    const first = await history();
    await seed();
    expect(await history()).toEqual(first);

    const reps = await db.users.findMany({ where: { email: { endsWith: '@demo.local' }, role: 'rep' }, orderBy: { email: 'asc' } });
    expect(reps.map((u) => u.email)).toEqual(['rep1@demo.local', 'rep2@demo.local', 'rep3@demo.local']);
    expect(await db.users.count({ where: { email: 'manager@demo.local', role: 'manager' } })).toBe(1);
    for (const r of reps) {
      const leads = await db.companies.findMany({ where: { assigned_rep_id: r.id }, select: { county_fips: true } });
      expect(leads).toHaveLength(50);
    }
    const bergen = await db.companies.findMany({ where: { assigned_rep_id: reps[0].id }, distinct: ['county_fips'] });
    expect(bergen.map((c) => c.county_fips)).toEqual(['34003']);
    expect(await db.companies.count({ where: { assigned_rep_id: null } })).toBe(90);
    const drift = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM companies c
       FULL JOIN (SELECT * FROM lead_allocations WHERE ended_at IS NULL) a ON a.company_id = c.id
       WHERE a.rep_id IS DISTINCT FROM c.assigned_rep_id`);
    expect(drift.n).toBe(0);
    expect(await db.outbox_events.count({ where: { event_type: 'lead.allocated' } })).toBe(150);
    expect(await db.activity_logs.count({ where: { action_type: 'allocation' } })).toBe(150);

    // 003_demo_activity: the stage mix per rep, history only on the demo reps' leads, every row marked, consistent.
    for (const r of reps) {
      const stages = await db.$queryRawUnsafe<{ sales_stage: string; n: number }[]>(
        'SELECT sales_stage, count(*)::int AS n FROM companies WHERE assigned_rep_id = $1::uuid GROUP BY 1', r.id);
      expect(Object.fromEntries(stages.map((x) => [x.sales_stage, x.n])))
        .toEqual({ new: 20, contacted: 12, interested: 8, quoting: 4, won: 3, lost: 3 });
    }
    const marker = await db.audit_events.findMany({ where: { entity_type: 'demo_seed' } });
    expect(marker).toHaveLength(1);
    const made = marker[0].changes as { leads: number; activities: number; tasks: number; customers: string[] };
    expect(made.leads).toBe(150);
    expect(await db.tasks.count({ where: { source: 'demo_seed' } })).toBe(made.tasks);
    expect(await db.tasks.count()).toBe(made.tasks);
    const facts = await one<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM activity_logs WHERE field_diff->>'demo_seed' = 'true') AS marked,
      (SELECT count(*)::int FROM activity_logs WHERE action_type <> 'allocation' AND field_diff->>'demo_seed' IS DISTINCT FROM 'true') AS unmarked,
      (SELECT count(*)::int FROM companies WHERE assigned_rep_id IS NULL AND (sales_stage <> 'new' OR last_contacted_at IS NOT NULL)) AS pool_touched,
      (SELECT count(*)::int FROM companies WHERE (sales_stage = 'new') <> (last_contacted_at IS NULL)) AS stage_vs_contact,
      (SELECT count(*)::int FROM companies c WHERE last_contacted_at IS DISTINCT FROM (SELECT max(created_at) FROM activity_logs a
         WHERE a.company_id = c.id AND a.action_type IN ('call', 'email', 'visit'))) AS last_contact_off,
      (SELECT count(*)::int FROM companies c WHERE sales_stage <> COALESCE((SELECT a.field_diff->'sales_stage'->>1 FROM activity_logs a
         WHERE a.company_id = c.id AND a.action_type = 'stage_changed' ORDER BY a.created_at DESC LIMIT 1), 'new')) AS stage_off,
      (SELECT count(*)::int FROM companies c WHERE last_contacted_at IS DISTINCT FROM team_last_serviced_at) AS serviced_off,
      (SELECT count(*)::int FROM activity_logs a JOIN companies c ON c.id = a.company_id
         WHERE a.action_type IN ('call', 'email', 'visit') AND (a.user_id <> c.assigned_rep_id OR a.created_at > now()
           OR extract(isodow FROM a.created_at AT TIME ZONE 'America/New_York') > 5)) AS odd_touches,
      (SELECT count(*)::int FROM activity_logs WHERE action_type IN ('call', 'email', 'visit')) AS touches,
      (SELECT count(*)::int FROM companies WHERE account_status IN ('existing_customer', 'lapsed_customer')) AS customers,
      (SELECT count(*)::int FROM tasks WHERE done_at IS NULL AND due_at < now()) AS overdue,
      (SELECT count(*)::int FROM tasks WHERE done_at IS NULL AND due_at > now()) AS upcoming,
      (SELECT count(*)::int FROM tasks WHERE done_at IS NOT NULL) AS done`);
    expect(facts).toMatchObject({
      marked: made.activities, unmarked: 0, pool_touched: 0, stage_vs_contact: 0, last_contact_off: 0, stage_off: 0,
      serviced_off: 0, odd_touches: 0, customers: made.customers.length,
    });
    expect(facts.touches).toBeGreaterThan(200);
    expect(facts.customers).toBeGreaterThanOrEqual(9);
    expect(facts.customers).toBeLessThanOrEqual(24);
    for (const k of ['overdue', 'upcoming', 'done']) expect(facts[k], k).toBeGreaterThan(5);
  });

  it('skips the demo sales history when seed.demo_activity is 0', async () => {
    await db.companies.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        business_name: `Fake ${i}`, latitude: 40.7, longitude: -74.0, content_hash: `h${i}`, county_fips: '34003',
      })),
    });
    const files = readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL seed.demo_activity = '0'");
      for (const file of files) await tx.$executeRawUnsafe(readFileSync(new URL(file, seedDir), 'utf8'));
    });
    expect(await db.companies.count({ where: { assigned_rep_id: { not: null } } })).toBe(30);
    expect(await db.tasks.count()).toBe(0);
    expect(await db.audit_events.count({ where: { entity_type: 'demo_seed' } })).toBe(0);
    expect(await db.companies.count({ where: { sales_stage: { not: 'new' } } })).toBe(0);
  });
});
