// GET /dashboard: the sales dashboard for one rep's leads (mine, rep:<id>) or every allocated lead (team). A few
// independent statements run side by side; the result is cached for 30 s per scope (a rep's own dashboard and a
// manager's rep:<id> view of it share one entry, every manager one team entry), and right after the caller's own
// write it is read from the primary instead.
// The team's coverage and top tags read every allocated lead's tags and contacts and move only with pipeline runs,
// contact edits and allocations, so they are kept apart for TEAM_SLOW_FRESH_SECONDS and refreshed in the background
// once stale (stale-while-revalidate): a team dashboard never waits for them after the first.
import {
  ACCOUNT_STATUSES, dayStartSql, monthStartSql, raw, SALES_STAGES, SALES_TIME_ZONE, salesScopeString, SEGMENTS, sql,
  weekStartSql, type AccountStatus, type ActivityCounts, type ParsedSalesScope, type RepDashboardRow, type SalesDashboard,
  type SalesStage, type Segment, type Sql, type Viewer,
} from '@leadmaker/shared';
import type { PrismaClient } from '@leadmaker/db';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';
import { salesScope } from './tasks.ts';

export const DASHBOARD_TTL_SECONDS = 30;
export const TEAM_SLOW_FRESH_SECONDS = 300;
const TEAM_SLOW_TTL_SECONDS = 3600;
const TEAM_SLOW_LOCK_SECONDS = 30;
const TEAM_SLOW_WAIT_MS = 3000;
export const TEAM_SLOW_KEY = 'dash:team:slow';
export const TOP_TAGS = 10;
export const DAILY_DAYS = 14;

/** The rep whose leads the scope covers; null for team. */
function scopeRep(viewer: Viewer, scope: ParsedSalesScope): string | null {
  return scope.kind === 'team' ? null : scope.kind === 'rep' ? scope.repId : viewer.id;
}

export function dashboardKey(rep: string | null): string {
  return `dash:${rep ?? 'team'}`;
}

/** The scope's leads over companies c. */
function leadsIn(rep: string | null): Sql {
  return rep ? sql`c.assigned_rep_id = ${rep}::uuid` : raw('c.assigned_rep_id IS NOT NULL');
}

/** Evaluated once per statement (an InitPlan), not once per row. */
const once = (q: Sql) => sql`(SELECT ${q})`;
// Days and weeks as shared/sales defines them (taskDueCondition, weekStartSql), in SALES_TIME_ZONE.
const D0 = once(dayStartSql(0));
const D1 = once(dayStartSql(1));
const D7 = once(dayStartSql(7));
const W0 = once(weekStartSql(0));
const W1 = once(weekStartSql(-1));

// The tagger's target_contact tag names a contact in the decision-maker role for the lead's size. It does so for
// every decision_maker=identified lead and for some weak ones, so only the weak leads' tags are read. direct_email
// is an address found on the company's website. Literals, so partial indexes on the same predicates apply.
const NAMED_TARGET = raw(`(c.tag_facets @> '{decision_maker=identified}'::text[] OR (c.tag_facets @> '{decision_maker=weak}'::text[]
  AND c.system_tags @> '[{"key": "target_contact", "contact": {"named": true}}]'::jsonb))`);
const SITE_EMAIL = raw(`c.tag_facets @> '{direct_email}'::text[]`);
const DECISION_TITLE = raw(String.raw`'\m(owner|president|principal)\M'`);
// Chips worth showing: what the contractors do (service / specialty / work type tags) and their GAF level. Cheap
// prefix tests first: every lead has some forty facets.
const TOP_TAG_FACET = raw(`((f LIKE 'service:%' OR f LIKE 'specialty:%' OR f LIKE 'work\\_type:%') AND strpos(f, '=') = 0
  OR f IN ('gaf_tier=master_elite', 'gaf_tier=certified_plus', 'gaf_tier=certified'))`);
const CONTACT_KINDS = raw(`('call', 'email', 'visit')`);
const ACTIVITY_KINDS = raw(`('call', 'email', 'visit', 'note')`);

const counts = (window: Sql) => sql`json_build_object(
  'calls', count(*) FILTER (WHERE a.action_type = 'call' AND ${window}),
  'emails', count(*) FILTER (WHERE a.action_type = 'email' AND ${window}),
  'visits', count(*) FILTER (WHERE a.action_type = 'visit' AND ${window}),
  'notes', count(*) FILTER (WHERE a.action_type = 'note' AND ${window}))`;

/** Stage, account status and segment counts, contact recency and the latest run's changes, in one pass. */
export function leadsQuery(rep: string | null): Sql {
  return sql`
    SELECT COALESCE(json_agg(g), '[]'::json) AS groups FROM (
      SELECT c.sales_stage AS stage, c.account_status AS status, c.segment, count(*)::int AS n,
        (count(*) FILTER (WHERE c.last_contacted_at IS NULL))::int AS never,
        (count(*) FILTER (WHERE c.last_contacted_at <= now() - interval '30 days'))::int AS stale,
        (count(*) FILTER (WHERE c.updated_in_last_poll))::int AS fresh
      FROM companies c WHERE ${leadsIn(rep)}
      GROUP BY 1, 2, 3) g`;
}

/** Open tasks on the scope's leads per due window (shared/sales taskDueCondition's; all of them end by day 7). */
export function followUpsQuery(rep: string | null): Sql {
  return sql`
    SELECT (count(*) FILTER (WHERE t.due_at < ${D0}))::int AS overdue,
      (count(*) FILTER (WHERE t.due_at >= ${D0} AND t.due_at < ${D1}))::int AS today,
      (count(*) FILTER (WHERE t.due_at >= ${D0}))::int AS week
    FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.done_at IS NULL AND t.due_at < ${D7} AND ${leadsIn(rep)}`;
}

/** Calls, emails, visits and notes logged on the scope's leads: this week, last week and per day. */
export function activityQuery(rep: string | null): Sql {
  const tz = sql`${SALES_TIME_ZONE}::text`;
  return sql`
    WITH a AS MATERIALIZED (
      SELECT al.action_type, al.created_at
      FROM activity_logs al JOIN companies c ON c.id = al.company_id
      WHERE ${leadsIn(rep)} AND al.action_type IN ${ACTIVITY_KINDS}
        AND al.created_at >= ${once(sql`LEAST(${dayStartSql(1 - DAILY_DAYS)}, ${weekStartSql(-1)})`)}),
    days AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => i))::date AS day
      FROM generate_series(0, ${DAILY_DAYS - 1}::int) i)
    SELECT
      (SELECT ${counts(sql`a.created_at >= ${W0}`)} FROM a) AS this_week,
      (SELECT ${counts(sql`a.created_at >= ${W1} AND a.created_at < ${W0}`)} FROM a) AS last_week,
      (SELECT json_agg(json_build_object('date', d.day::text, 'calls', COALESCE(x.calls, 0), 'emails', COALESCE(x.emails, 0),
                                         'visits', COALESCE(x.visits, 0), 'notes', COALESCE(x.notes, 0)) ORDER BY d.day)
       FROM days d LEFT JOIN (
         SELECT (a.created_at AT TIME ZONE ${tz})::date AS day,
           count(*) FILTER (WHERE a.action_type = 'call') AS calls, count(*) FILTER (WHERE a.action_type = 'email') AS emails,
           count(*) FILTER (WHERE a.action_type = 'visit') AS visits, count(*) FILTER (WHERE a.action_type = 'note') AS notes
         FROM a GROUP BY 1) x ON x.day = d.day) AS daily`;
}

/** team: one row per rep (and anyone else holding leads), by name. */
export function repsQuery(): Sql {
  return sql`
    WITH k AS (
      SELECT s.rep_id, json_object_agg(s.stage, s.n) AS pipeline, sum(s.n)::int AS assigned FROM (
        SELECT c.assigned_rep_id AS rep_id, c.sales_stage AS stage, count(*)::int AS n
        FROM companies c WHERE c.assigned_rep_id IS NOT NULL GROUP BY 1, 2) s
      GROUP BY 1),
    w AS (
      SELECT c.assigned_rep_id AS rep_id, count(*)::int AS n FROM companies c
      WHERE c.assigned_rep_id IS NOT NULL AND c.sales_stage = 'won' AND c.stage_changed_at >= ${once(monthStartSql())}
      GROUP BY 1),
    a AS (
      SELECT al.user_id, count(*)::int AS n FROM activity_logs al
      WHERE al.user_id IS NOT NULL AND al.action_type IN ${CONTACT_KINDS} AND al.created_at >= ${W0}
      GROUP BY al.user_id),
    o AS (
      SELECT c.assigned_rep_id AS rep_id, count(*)::int AS n FROM tasks t JOIN companies c ON c.id = t.company_id
      WHERE t.done_at IS NULL AND t.due_at < ${D0} AND c.assigned_rep_id IS NOT NULL GROUP BY 1)
    SELECT COALESCE(json_agg(r ORDER BY r.name, r.id), '[]'::json) AS reps FROM (
      SELECT u.id, u.name, COALESCE(k.pipeline, '{}'::json) AS pipeline, COALESCE(k.assigned, 0) AS assigned,
        COALESCE(w.n, 0) AS won, COALESCE(a.n, 0) AS activity, COALESCE(o.n, 0) AS overdue
      FROM users u LEFT JOIN k ON k.rep_id = u.id LEFT JOIN w ON w.rep_id = u.id LEFT JOIN a ON a.user_id = u.id
        LEFT JOIN o ON o.rep_id = u.id
      WHERE u.role = 'rep' OR k.rep_id IS NOT NULL) r`;
}

/**
 * Leads with a decision-maker (the tagger's named target contact, or a contact titled owner / president / principal),
 * an email (the website's, or a contact's) and a phone (the company's, or a contact's). Contacts marked do not contact
 * don't count; rep corrections (field_overrides) do. Each count is a set of lead ids, so the company-level tests can
 * come from partial indexes instead of reading every lead's tags.
 */
export function coverageQuery(rep: string | null): Sql {
  const eff = (field: string, col: string) => raw(`CASE WHEN o.ov ? '${field}' THEN o.ov->>'${field}' ELSE ${col} END`);
  const present = (v: Sql) => sql`NULLIF(btrim(${v}), '') IS NOT NULL`;
  return sql`
    WITH s AS MATERIALIZED (SELECT c.id FROM companies c WHERE ${leadsIn(rep)}),
    o AS (
      SELECT f.contact_id, jsonb_object_agg(f.field, f.value) AS ov FROM field_overrides f
      WHERE f.contact_id IS NOT NULL AND f.superseded_at IS NULL GROUP BY f.contact_id),
    k AS MATERIALIZED (
      SELECT ct.company_id, ${present(eff('email', 'ct.email'))} AS email, ${present(eff('phone', 'ct.phone'))} AS phone,
        COALESCE(${eff('title', 'ct.title')} ~* ${DECISION_TITLE}, FALSE) AS dm
      FROM contacts ct JOIN s ON s.id = ct.company_id LEFT JOIN o ON o.contact_id = ct.id
      WHERE NOT COALESCE(CASE WHEN o.ov ? 'do_not_contact' THEN (o.ov->>'do_not_contact')::boolean ELSE ct.do_not_contact END, FALSE)),
    phone_override AS (
      SELECT f.company_id, ${present(raw(`f.value #>> '{}'`))} AS phone FROM field_overrides f JOIN s ON s.id = f.company_id
      WHERE f.contact_id IS NULL AND f.field = 'phone' AND f.superseded_at IS NULL),
    no_company_phone AS (
      SELECT c.id FROM companies c WHERE ${leadsIn(rep)} AND NULLIF(btrim(c.phone), '') IS NULL
        AND c.id NOT IN (SELECT company_id FROM phone_override WHERE phone)
      UNION SELECT company_id FROM phone_override WHERE NOT phone)
    SELECT (SELECT count(*) FROM s)::int AS total,
      (SELECT count(*) FROM (
         SELECT c.id FROM companies c WHERE ${leadsIn(rep)} AND ${NAMED_TARGET} UNION SELECT company_id FROM k WHERE dm) x)::int
        AS with_decision_maker,
      (SELECT count(*) FROM (
         SELECT c.id FROM companies c WHERE ${leadsIn(rep)} AND ${SITE_EMAIL} UNION SELECT company_id FROM k WHERE email) x)::int
        AS with_email,
      ((SELECT count(*) FROM s) - (SELECT count(*) FROM no_company_phone n
         WHERE NOT EXISTS (SELECT 1 FROM k WHERE k.company_id = n.id AND k.phone)))::int AS with_phone`;
}

/** The most common chip-worthy system tags and custom tags on the scope's leads, each with a label. */
export function topTagsQuery(rep: string | null): Sql {
  return sql`
    WITH f AS (
      SELECT f, count(*)::int AS n, any_value(c.id) AS sample FROM companies c, unnest(c.tag_facets) f
      WHERE ${leadsIn(rep)} AND ${TOP_TAG_FACET}
      GROUP BY f ORDER BY n DESC, f LIMIT ${TOP_TAGS}::int)
    SELECT
      (SELECT COALESCE(json_agg(json_build_object('key', f.f, 'count', f.n, 'label', (
         SELECT e->>'label' FROM companies x, jsonb_array_elements(x.system_tags) e
         WHERE x.id = f.sample AND e->>'key' = split_part(f.f, '=', 1)
           AND (strpos(f.f, '=') = 0 OR e->>'value' = split_part(f.f, '=', 2)) LIMIT 1)) ORDER BY f.n DESC, f.f), '[]'::json)
       FROM f) AS system,
      (SELECT COALESCE(json_agg(json_build_object('key', t.id, 'count', t.n, 'label', t.name) ORDER BY t.n DESC, lower(t.name)), '[]'::json)
       FROM (SELECT g.id, g.name, count(*)::int AS n
             FROM company_custom_tags x JOIN companies c ON c.id = x.company_id JOIN custom_tags g ON g.id = x.tag_id
             WHERE ${leadsIn(rep)} GROUP BY g.id, g.name ORDER BY n DESC, lower(g.name) LIMIT ${TOP_TAGS}::int) t) AS custom`;
}

interface LeadGroup {
  stage: SalesStage;
  status: AccountStatus;
  segment: string | null;
  n: number;
  never: number;
  stale: number;
  fresh: number;
}

interface RepRow {
  id: string;
  name: string;
  pipeline: Partial<Record<SalesStage, number>>;
  assigned: number;
  won: number;
  activity: number;
  overdue: number;
}

type TagRow = { key: string; count: number; label: string | null };
type Slow = Pick<SalesDashboard, 'coverage' | 'topTags'>;

const stages = (by: Partial<Record<string, number>>) => SALES_STAGES.map((stage) => ({ stage, count: by[stage] ?? 0 }));

function sum<K extends string>(groups: LeadGroup[], key: (g: LeadGroup) => K | null): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const g of groups) {
    const k = key(g);
    if (k !== null) out[k] = (out[k] ?? 0) + g.n;
  }
  return out;
}

const humanize = (key: string) => {
  const name = key.replace(/^[a-z_]+:/, '').replace(/[_=]/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export async function readSlow(client: PrismaClient, rep: string | null): Promise<Slow> {
  const [coverage, tags] = await Promise.all([
    one<{ total: number; with_decision_maker: number; with_email: number; with_phone: number }>(client, coverageQuery(rep)),
    one<{ system: TagRow[]; custom: TagRow[] }>(client, topTagsQuery(rep)),
  ]);
  return {
    coverage: {
      total: coverage?.total ?? 0,
      withDecisionMaker: coverage?.with_decision_maker ?? 0,
      withEmail: coverage?.with_email ?? 0,
      withPhone: coverage?.with_phone ?? 0,
    },
    topTags: [
      ...(tags?.system ?? []).map((t) => ({ key: t.key, label: t.label ?? humanize(t.key), count: t.count, kind: 'system' as const })),
      ...(tags?.custom ?? []).map((t) => ({ key: t.key, label: t.label ?? t.key, count: t.count, kind: 'custom' as const })),
    ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, TOP_TAGS),
  };
}

type CachedSlow = Slow & { at: number };

const strip = ({ coverage, topTags }: Slow): Slow => ({ coverage, topTags });

/**
 * The team's slow part: cached, and refreshed in the background once stale. One request at a time computes it (the
 * others wait for its result for up to TEAM_SLOW_WAIT_MS), so a burst of managers costs one scan.
 */
async function teamSlow(client: PrismaClient, cache: Cache, background: PrismaClient): Promise<Slow> {
  const lock = `${TEAM_SLOW_KEY}:refresh`;
  const read = () => cache.getJson<CachedSlow>(TEAM_SLOW_KEY);
  const refresh = async (c: PrismaClient) => {
    try {
      const slow = await readSlow(c, null);
      await cache.setJson(TEAM_SLOW_KEY, { ...slow, at: Date.now() } satisfies CachedSlow, TEAM_SLOW_TTL_SECONDS);
      return slow;
    } finally {
      await cache.unlock(lock);
    }
  };
  const cached = await read();
  if (cached) {
    if (Date.now() - cached.at > TEAM_SLOW_FRESH_SECONDS * 1000 && await cache.lock(lock, TEAM_SLOW_LOCK_SECONDS)) {
      refresh(background).catch((err: unknown) => cache.log.warn({ err: (err as Error).message }, 'team dashboard refresh failed'));
    }
    return strip(cached);
  }
  if (await cache.lock(lock, TEAM_SLOW_LOCK_SECONDS) || !cache.available) return refresh(client);
  for (const until = Date.now() + TEAM_SLOW_WAIT_MS; Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 100));
    const done = await read();
    if (done) return strip(done);
  }
  return readSlow(client, null);
}

export async function readDashboard(
  db: Db, viewer: Viewer, scope: ParsedSalesScope, weeklyGoal: number, primary: boolean, slow?: () => Promise<Slow>,
): Promise<SalesDashboard> {
  const client = pick(db, primary);
  const rep = scopeRep(viewer, scope);
  const [leads, followUps, activity, team, slowPart] = await Promise.all([
    one<{ groups: LeadGroup[] }>(client, leadsQuery(rep)),
    one<{ overdue: number; today: number; week: number }>(client, followUpsQuery(rep)),
    one<{ this_week: ActivityCounts; last_week: ActivityCounts; daily: SalesDashboard['activity']['daily'] }>(client, activityQuery(rep)),
    rep ? undefined : one<{ reps: RepRow[] }>(client, repsQuery()),
    slow ? slow() : readSlow(client, rep),
  ]);
  const groups = leads?.groups ?? [];
  const statuses = sum(groups, (g) => g.status);
  const segments = sum(groups, (g) => g.segment as Segment | null);
  const reps: RepDashboardRow[] | undefined = team?.reps.map((r) => ({
    rep: { id: r.id, name: r.name },
    assigned: r.assigned,
    pipeline: stages(r.pipeline),
    activityThisWeek: r.activity,
    overdue: r.overdue,
    wonThisMonth: r.won,
  }));
  return {
    scope: salesScopeString(scope),
    pipeline: stages(sum(groups, (g) => g.stage)),
    followUps: { overdue: followUps?.overdue ?? 0, today: followUps?.today ?? 0, week: followUps?.week ?? 0 },
    activity: {
      thisWeek: activity!.this_week,
      lastWeek: activity!.last_week,
      goalPerWeek: weeklyGoal * (reps ? reps.length : 1),
      daily: activity!.daily,
    },
    accounts: Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, statuses[s] ?? 0])) as Record<AccountStatus, number>,
    coverage: slowPart.coverage,
    neverContacted: groups.reduce((n, g) => n + g.never, 0),
    notContacted30d: groups.reduce((n, g) => n + g.stale, 0),
    newSinceLastPoll: groups.reduce((n, g) => n + g.fresh, 0),
    topTags: slowPart.topTags,
    segments: SEGMENTS.map((segment) => ({ segment, count: segments[segment] ?? 0 })),
    ...(reps ? { reps } : {}),
    generatedAt: new Date().toISOString(),
  };
}

/** Where the team's slow part runs: `scan` for a request, `background` for a refresh that outlives it. */
export interface TeamScanDb {
  scan: Db;
  background: Db;
}

export async function getDashboard(
  db: Db, cache: Cache, viewer: Viewer, scopeParam: string | undefined, weeklyGoal: number, team: TeamScanDb = { scan: db, background: db },
): Promise<{ result: SalesDashboard; cache: 'hit' | 'miss' | 'bypass' }> {
  // Default: the team for managers, their own leads for reps.
  const scope = salesScope(viewer, scopeParam ?? (viewer.role === 'manager' ? 'team' : 'mine'));
  const rep = scopeRep(viewer, scope);
  const key = dashboardKey(rep);
  const fresh = await cache.recentlyWrote(viewer.id);
  if (!fresh) {
    const hit = await cache.getJson<SalesDashboard>(key);
    // The entry may have been filled under the other name for the same leads (mine / rep:<id>).
    if (hit) return { result: { ...hit, scope: salesScopeString(scope) }, cache: 'hit' };
  }
  const slow = rep ? undefined : () => teamSlow(pick(team.scan, fresh), cache, team.background.replica);
  const result = await readDashboard(db, viewer, scope, weeklyGoal, fresh, slow);
  await cache.setJson(key, result, DASHBOARD_TTL_SECONDS);
  return { result, cache: fresh ? 'bypass' : 'miss' };
}
