import { Prisma } from '@leadmaker/db';
import { COMPANY_OVERRIDE_FIELDS, isUuid, SALES_TIME_ZONE, visibilitySql } from '@leadmaker/shared';
import { isDeepStrictEqual } from 'node:util';
import type { Data, Draft, Tx } from './store.ts';
import { uuidOrNull, type NotifierEvent } from './stream.ts';

/** Leads, users and managers the batch's events name, loaded once per batch. */
export type Context = {
  tx: Tx;
  companies: Map<string, { name: string; assigned_rep_id: string | null }>;
  users: Map<string, { name: string; role: string }>;
  managers: () => Promise<string[]>;
};

export type Rule = (e: NotifierEvent, ctx: Context) => Promise<Draft[]>;

const USER_FIELDS = ['actor_id', 'assigned_rep_id', 'previous_rep_id', 'requested_by', 'assignee_id'];

export async function loadContext(tx: Tx, events: NotifierEvent[]): Promise<Context> {
  const companyIds = [...new Set(events.flatMap((e) => (e.companyId ? [e.companyId] : [])))];
  const userIds = [...new Set(events.flatMap((e) => USER_FIELDS.map((k) => uuidOrNull(e.payload[k])).filter((u) => u !== null)))];
  const [companies, users] = await Promise.all([
    companyIds.length
      ? tx.$queryRaw<{ id: string; business_name: string; assigned_rep_id: string | null }[]>`
          SELECT id::text, business_name, assigned_rep_id::text FROM companies WHERE id = ANY(${companyIds}::uuid[])`
      : [],
    userIds.length
      ? tx.$queryRaw<{ id: string; name: string; role: string }[]>`
          SELECT id::text, name, role FROM users WHERE id = ANY(${userIds}::uuid[])`
      : [],
  ]);
  let managers: Promise<string[]> | undefined;
  return {
    tx,
    companies: new Map(companies.map((c) => [c.id, { name: c.business_name, assigned_rep_id: c.assigned_rep_id }])),
    users: new Map(users.map((u) => [u.id, { name: u.name, role: u.role }])),
    managers: () => (managers ??= tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM users WHERE role = 'manager' ORDER BY id`
      .then((rows) => rows.map((r) => r.id))),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const excerpt = (s: string, n = 140) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

// ------------------------------------------------------------------- lead.allocated
/** The new rep hears about every lead they get, the previous rep about every lead they lose; both merge. */
export const allocationRule: Rule = async (e, ctx) => {
  if (!e.companyId) return [];
  const name = ctx.companies.get(e.companyId)?.name ?? 'A lead';
  const actorId = uuidOrNull(e.payload.actor_id);
  const to = uuidOrNull(e.payload.assigned_rep_id);
  const from = uuidOrNull(e.payload.previous_rep_id);
  const drafts: Draft[] = [];
  if (to) {
    drafts.push({
      userId: to, type: 'allocated', dedupeKey: 'allocated', companyId: e.companyId, actorId,
      data: { company_ids: [e.companyId], latest: name },
      render: (n, d) => n === 1
        ? { title: 'New lead allocated to you', body: `${d.latest} is now yours` }
        : { title: `${n} new leads allocated to you`, body: `Latest: ${d.latest}` },
    });
  }
  if (from && from !== to) {
    // Another rep's lead is not the previous owner's to open any more; a lead back in the pool still is.
    drafts.push({
      userId: from, type: 'reassigned_away', dedupeKey: 'reassigned_away', companyId: to ? null : e.companyId, optionalLink: true, actorId,
      data: { latest: name, to_pool: !to },
      render: (n, d) => n === 1
        ? {
            title: 'A lead was reassigned away from you',
            body: d.to_pool ? `${d.latest} went back to the unallocated pool` : `${d.latest} is no longer allocated to you`,
          }
        : { title: `${n} leads were reassigned away from you`, body: `Latest: ${d.latest}` },
    });
  }
  return drafts;
};

// ----------------------------------------------------------------------- note.added
/** A manager's note on a rep's lead tells that rep; notes on one lead merge until read. */
export const managerNoteRule: Rule = async (e, ctx) => {
  const actorId = uuidOrNull(e.payload.actor_id);
  const author = actorId ? ctx.users.get(actorId) : undefined;
  if (!e.companyId || author?.role !== 'manager') return [];
  const lead = ctx.companies.get(e.companyId);
  if (!lead?.assigned_rep_id) return [];
  let text = '';
  if (isUuid(e.payload.note_id)) {
    const [row] = await ctx.tx.$queryRaw<{ note_text: string | null }[]>`
      SELECT note_text FROM activity_logs WHERE id = ${e.payload.note_id}::uuid AND company_id = ${e.companyId}::uuid`;
    text = excerpt(row?.note_text ?? '');
  }
  return [{
    userId: lead.assigned_rep_id, type: 'manager_note', dedupeKey: `manager_note:${e.companyId}`, companyId: e.companyId,
    actorId, data: { author: author.name, company: lead.name, latest: text },
    render: (n, d) => n === 1
      ? { title: `${d.author} left a note on ${d.company}`, body: str(d.latest) }
      : { title: `${n} new manager notes on ${d.company}`, body: `${d.author}: ${str(d.latest)}` },
  }];
};

// ------------------------------------------------------------- lead.updated (pipeline)
// Pipeline field names that differ from the companies column a rep overrides.
const PIPELINE_COLUMNS: Record<string, string> = { name: 'business_name', website: 'website_url' };
// The pipeline audits a listing's address as one field; its parsed parts change with it.
const ADDRESS_PARTS = ['address', 'street', 'city', 'state', 'postal_code'];
const FIELD_LABELS: Record<string, string> = {
  business_name: 'business name', website_url: 'website', postal_code: 'ZIP code', do_not_contact: 'do-not-contact',
};
const label = (field: string) => FIELD_LABELS[field] ?? field;

/**
 * A pipeline change to a field someone overrode tells the override's author. The source value is compared with
 * the one last reported for that override (initially the value at edit time), so each new source value is
 * reported once, whichever event carries it.
 */
export const sourceChangedRule: Rule = async (e, ctx) => {
  if (e.payload.actor_type !== 'pipeline' || !e.companyId || !Array.isArray(e.payload.fields)) return [];
  const fields = e.payload.fields.filter((f): f is string => typeof f === 'string');
  const columns = [...new Set(fields.flatMap((f) => (f === 'address' ? ADDRESS_PARTS : [PIPELINE_COLUMNS[f] ?? f])))]
    .filter((f) => (COMPANY_OVERRIDE_FIELDS as readonly string[]).includes(f));
  const contacts = fields.includes('contacts');
  if (!columns.length && !contacts) return [];
  const rows = await ctx.tx.$queryRaw<{
    id: string; user_id: string; field: string; contact_id: string | null; contact_name: string | null;
    scraped: unknown; at_edit: unknown; reported: { scraped: unknown } | null;
  }[]>`
    SELECT o.id::text, o.user_id::text, o.field, o.contact_id::text, ct.name AS contact_name,
           CASE WHEN o.contact_id IS NULL THEN to_jsonb(c) -> o.field ELSE to_jsonb(ct) -> o.field END AS scraped,
           o.scraped_value_at_edit AS at_edit, s.value AS reported
    FROM field_overrides o
    JOIN companies c ON c.id = o.company_id
    LEFT JOIN contacts ct ON ct.id = o.contact_id
    LEFT JOIN notifier_state s ON s.key = 'override:' || o.id::text
    WHERE o.company_id = ${e.companyId}::uuid AND o.superseded_at IS NULL
      AND ((o.contact_id IS NULL AND o.field = ANY(${columns}::text[])) OR (o.contact_id IS NOT NULL AND ${contacts}))
    ORDER BY o.created_at, o.id`;
  const company = ctx.companies.get(e.companyId)?.name ?? 'A lead';
  const drafts: Draft[] = [];
  for (const r of rows) {
    const last = r.reported ? r.reported.scraped : r.at_edit;
    if (isDeepStrictEqual(r.scraped ?? null, last ?? null)) continue;
    await ctx.tx.$executeRaw`
      INSERT INTO notifier_state (key, value) VALUES (${`override:${r.id}`}, ${JSON.stringify({ scraped: r.scraped ?? null })}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    const what = r.contact_id ? `${r.contact_name || 'contact'}'s ${label(r.field)}` : label(r.field);
    drafts.push({
      userId: r.user_id, type: 'source_changed', dedupeKey: `source_changed:${e.companyId}`, companyId: e.companyId,
      data: { company, fields: [what] },
      render: (n, d) => {
        const list = (d.fields as string[]).join(', ');
        return n === 1
          ? { title: 'The source changed a field you edited', body: `${d.company}: ${list} changed at the source; your edit still shows` }
          : { title: `The source changed fields you edited (${n} changes)`, body: `${d.company}: ${list}` };
      },
    });
  }
  return drafts;
};

// --------------------------------------------------------- pipeline.run_completed
const SPECIALIST_FACETS = [
  'work_type:storm_emergency', 'storm_insurance', 'service:storm_damage', 'service:emergency_service', 'service:roof_repair',
];
const WATERMARK = 'signals_watermark';
// Rows re-fetched shortly before the watermark are looked at again; per-user dedupe keeps that harmless.
const WATERMARK_OVERLAP = '15 minutes';

type Alert = { source: string; external_id: string; counties: string[]; payload: Data; valid_to: Date | null };

/**
 * New active NWS alerts since the watermark: each rep with allocated leads in an alert's counties gets one
 * notification (their lead count and how many are storm/emergency or repair specialists), each manager one
 * with the totals. One per user and alert, ever.
 */
export async function stormAlerts(ctx: Context): Promise<Draft[]> {
  const { tx } = ctx;
  await tx.$executeRaw`INSERT INTO notifier_state (key, value) VALUES (${WATERMARK}, 'null'::jsonb) ON CONFLICT (key) DO NOTHING`;
  const [{ value }] = await tx.$queryRaw<{ value: string | null }[]>`
    SELECT value #>> '{}' AS value FROM notifier_state WHERE key = ${WATERMARK} FOR UPDATE`;
  const since = value ? new Date(value) : null;
  const alerts = await tx.$queryRaw<Alert[]>`
    SELECT source, external_id, array_agg(DISTINCT county_fips::text ORDER BY county_fips::text) AS counties,
           (array_agg(payload ORDER BY fetched_at DESC))[1] AS payload, max(valid_to) AS valid_to
    FROM regional_signals
    WHERE kind = 'active_alert' AND (valid_to IS NULL OR valid_to > NOW()) AND NOT payload ? 'cancelled_at'
      AND (${since}::timestamptz IS NULL OR fetched_at > ${since}::timestamptz - ${WATERMARK_OVERLAP}::interval)
    GROUP BY source, external_id
    ORDER BY min(valid_from) NULLS LAST, external_id`;
  const [{ top }] = await tx.$queryRaw<{ top: string | null }[]>`
    SELECT to_json(max(fetched_at)) #>> '{}' AS top FROM regional_signals WHERE kind = 'active_alert'`;
  if (top) {
    await tx.$executeRaw`UPDATE notifier_state SET value = to_jsonb(${top}::text), updated_at = NOW() WHERE key = ${WATERMARK}`;
  }
  const drafts: Draft[] = [];
  for (const a of alerts) {
    const counts = await tx.$queryRaw<{ rep: string | null; total: boolean; leads: number; specialists: number }[]>`
      SELECT assigned_rep_id::text AS rep, GROUPING(assigned_rep_id) = 1 AS total, count(*)::int AS leads,
             count(*) FILTER (WHERE tag_facets && ${SPECIALIST_FACETS}::text[])::int AS specialists
      FROM companies WHERE county_fips = ANY(${a.counties}::text[])
      GROUP BY ROLLUP (assigned_rep_id)`;
    const total = counts.find((c) => c.total);
    if (!total?.leads) continue;
    const event = str(a.payload.event, 'Weather alert');
    const area = str(a.payload.areaDesc);
    const data = {
      event, severity: a.payload.severity ?? null, headline: a.payload.headline ?? null, area: area || null,
      counties: a.counties, ends: a.valid_to, url: a.payload.url ?? null,
    };
    const base = {
      type: 'storm_alert' as const, dedupeKey: `storm_alert:${a.source}:${a.external_id}`, once: true, countyFips: a.counties[0],
    };
    const title = area ? `${event}: ${area}` : event;
    for (const c of counts) {
      if (c.total || !c.rep) continue;
      drafts.push({
        ...base, userId: c.rep, data: { ...data, leads: c.leads, specialists: c.specialists },
        render: () => ({
          title,
          body: `${c.leads} of your leads ${c.leads === 1 ? 'is' : 'are'} in the alert area `
            + `(${c.specialists} storm/emergency or repair specialists)`,
        }),
      });
    }
    for (const m of await ctx.managers()) {
      drafts.push({
        ...base, userId: m, data: { ...data, leads: total.leads, specialists: total.specialists },
        render: () => ({
          title,
          body: `${plural(total.leads, 'lead')} in the alert area (${total.specialists} storm/emergency or repair specialists)`,
        }),
      });
    }
  }
  return drafts;
}

/** New companies a GAF scrape left in the pool: one merged notification per manager, counting leads. */
export async function poolGrew(ctx: Context, runId: number): Promise<Draft[]> {
  const rows = await ctx.tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id::text FROM audit_events a JOIN companies c ON c.id = a.company_id
    WHERE a.run_id = ${runId} AND a.entity_type = 'company' AND a.action = 'created' AND c.assigned_rep_id IS NULL`;
  if (!rows.length) return [];
  return (await ctx.managers()).map((userId) => ({
    userId, type: 'pool_grew' as const, dedupeKey: 'pool_grew', increment: rows.length, data: { run_ids: [runId] },
    render: (n: number) => ({
      title: `${plural(n, 'new lead')} in the unallocated pool`,
      body: 'Found by the latest GAF scrape and ready to allocate',
    }),
  }));
}

// The run a job finishes with (leadmaker/jobs.py execute): a refresh scrapes, assigns counties, then tags.
const FINAL_RUN: Record<string, string> = { scrape: 'tag', pipeline: 'tag', tag: 'tag', enrich: 'enrich', signals: 'signals' };

/**
 * A user's on-demand job finished: one notification per job. refresh_done carries the scrape's new/changed
 * counts, from its audit trail over the leads the requester can view, so a rep learns nothing about the other
 * reps' leads in the area. refresh_failed: the job's last run failed, or the job went dead (leadmaker/jobs.py
 * job_dead_event: kind 'job', status 'failed') after its retries.
 */
export async function refreshDone(ctx: Context, p: Data): Promise<Draft[]> {
  const userId = uuidOrNull(p.requested_by);
  const dead = p.kind === 'job' && p.status === 'failed';
  if (!userId || !Number.isInteger(p.job_id) || (!dead && FINAL_RUN[str(p.job_kind)] !== p.kind)) return [];
  const runIds = [...(Array.isArray(p.job_run_ids) ? p.job_run_ids : []), p.run_id].filter(Number.isInteger) as number[];
  const [[scrape], [job]] = await Promise.all([
    ctx.tx.$queryRaw<{ id: number; status: string }[]>`
      SELECT id, status FROM scrape_runs WHERE id = ANY(${runIds}::int[]) AND kind = 'gaf_ingest' ORDER BY id DESC LIMIT 1`,
    ctx.tx.$queryRaw<{ params: Data; attempts: number }[]>`SELECT params, attempts FROM jobs WHERE id = ${p.job_id as number}`,
  ]);
  const viewer = { id: userId, role: ctx.users.get(userId)?.role === 'manager' ? 'manager' as const : 'rep' as const };
  const visible = visibilitySql(viewer, 'view', 'c');
  const [counts] = scrape && !dead
    ? await ctx.tx.$queryRaw<{ new: number; changed: number }[]>`
        SELECT count(DISTINCT a.company_id) FILTER (WHERE a.action = 'created')::int AS new,
               (count(DISTINCT a.company_id) - count(DISTINCT a.company_id) FILTER (WHERE a.action = 'created'))::int AS changed
        FROM audit_events a JOIN companies c ON c.id = a.company_id
        WHERE a.run_id = ${scrape.id} AND a.entity_type = 'company' AND a.action IN ('created', 'updated')
          AND ${new Prisma.Sql(visible.strings, visible.values)}`
    : [];
  const params = job?.params ?? {};
  const failed = dead || scrape?.status === 'failed' || p.status === 'failed';
  const type = failed ? 'refresh_failed' : 'refresh_done';
  const zip = str(params.postal_code);
  const where = zip ? `${zip}${params.radius_miles ? ` (${params.radius_miles} mi)` : ''}` : 'your area';
  const data = {
    job_id: p.job_id, job_kind: p.job_kind, run_id: p.run_id ?? null, status: failed ? 'failed' : 'succeeded',
    postal_code: zip || null, radius_miles: params.radius_miles ?? null,
    new: counts ? counts.new : null, changed: counts ? counts.changed : null,
    ...(dead ? { attempts: job?.attempts ?? null } : {}),
  };
  const counted = counts ? `${plural(counts.new, 'new lead')}, ${plural(counts.changed, 'changed lead')}` : null;
  return [{
    userId, type, dedupeKey: `${type}:${p.job_id}`, once: true, data,
    render: () => {
      if (!failed) return { title: `Refresh of ${where} finished`, body: counted ?? 'Leads are re-tagged and up to date' };
      const tries = job?.attempts ? `It stopped after ${plural(job.attempts, 'attempt')}` : 'It stopped';
      return {
        title: `Refresh of ${where} failed`,
        body: dead ? `${tries}; request it again to retry` : counted ?? 'Leads may be out of date; request it again to retry',
      };
    },
  }];
}

export const runCompletedRule: Rule = async (e, ctx) => {
  const p = e.payload;
  const drafts: Draft[] = [];
  if (p.kind === 'signals') drafts.push(...await stormAlerts(ctx));
  if (p.kind === 'gaf_ingest' && Number.isInteger(p.run_id)) drafts.push(...await poolGrew(ctx, p.run_id as number));
  if (p.requested_by) drafts.push(...await refreshDone(ctx, p));
  return drafts;
};

// ------------------------------------------------------------------------- tasks
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: SALES_TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: SALES_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SALES_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: SALES_TIME_ZONE });

/** "due today at 2:00 PM", "due Tue, Oct 20" (a task due at midnight is due that whole day), in SALES_TIME_ZONE. */
export function dueLabel(due: Date, now = new Date()): string {
  const day = dateKey.format(due) === dateKey.format(now) ? 'today' : dayFmt.format(due);
  if (clockFmt.format(due) === '00:00') return `due ${day}`;
  return `due ${day} at ${timeFmt.format(due).replace(/\s/g, ' ')}`;
}

/**
 * A task someone else gave a user (created for them, or reassigned to them) tells them; these merge until read.
 * Skipped once the task is done, gone or with someone else again.
 */
export const taskAssignedRule: Rule = async (e, ctx) => {
  const p = e.payload;
  const taskId = uuidOrNull(p.task_id);
  const to = uuidOrNull(p.assignee_id);
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const assigned = p.task_action === 'created' || (p.task_action === 'updated' && uuidOrNull(p.previous_assignee_id) !== null);
  if (!e.companyId || !taskId || !to || !fields.includes('tasks') || !assigned) return [];
  const [task] = await ctx.tx.$queryRaw<{ title: string; due_at: Date; assignee_id: string; done: boolean }[]>`
    SELECT title, due_at, assignee_id::text, done_at IS NOT NULL AS done FROM tasks WHERE id = ${taskId}::uuid`;
  if (!task || task.done || task.assignee_id !== to) return [];
  const actorId = uuidOrNull(p.actor_id);
  const by = (actorId && ctx.users.get(actorId)?.name) || str(p.actor_name, 'Someone');
  const company = ctx.companies.get(e.companyId)?.name ?? 'a lead';
  return [{
    userId: to, type: 'task_assigned', dedupeKey: 'task_assigned', companyId: e.companyId, actorId,
    data: { task_ids: [taskId], latest: task.title, company, by, due: dueLabel(task.due_at) },
    render: (n, d) => n === 1
      ? { title: `${d.by} assigned you a task: ${d.latest}`, body: `${d.company}, ${d.due}` }
      : { title: `${n} new tasks assigned to you`, body: `Latest: ${d.latest} (${d.company}, from ${d.by})` },
  }];
};

/** How far ahead a task's due time counts as due, and how far back a missed one is still sent. */
export const TASK_DUE_LEAD_MINUTES = 15;
export const TASK_DUE_LOOKBACK_HOURS = 24;

/**
 * Open tasks whose due time has come (or comes within TASK_DUE_LEAD_MINUTES), due at most TASK_DUE_LOOKBACK_HOURS
 * ago: one notification to the assignee per task and due time, ever (a rescheduled task is due again).
 */
export async function dueTaskDrafts(tx: Tx, now = new Date()): Promise<Draft[]> {
  const rows = await tx.$queryRaw<{ id: string; company_id: string; title: string; due_at: Date; assignee_id: string; company: string }[]>`
    SELECT t.id::text, t.company_id::text, t.title, t.due_at, t.assignee_id::text,
           COALESCE((SELECT o.value #>> '{}' FROM field_overrides o
                     WHERE o.company_id = t.company_id AND o.contact_id IS NULL AND o.field = 'business_name'
                       AND o.superseded_at IS NULL), c.business_name) AS company
    FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.done_at IS NULL
      AND t.due_at <= ${now}::timestamptz + make_interval(mins => ${TASK_DUE_LEAD_MINUTES})
      AND t.due_at > ${now}::timestamptz - make_interval(hours => ${TASK_DUE_LOOKBACK_HOURS})
    ORDER BY t.due_at, t.id
    LIMIT 2000`;
  return rows.map((t) => ({
    userId: t.assignee_id, type: 'task_due' as const, dedupeKey: `task_due:${t.id}:${t.due_at.toISOString()}`, once: true,
    companyId: t.company_id,
    data: { task_id: t.id, title: t.title, company: t.company, due_at: t.due_at.toISOString() },
    render: () => ({ title: `Task due: ${t.title}`, body: `${t.company}, ${dueLabel(t.due_at, now)}` }),
  }));
}

export const leadUpdatedRule: Rule = async (e, ctx) => [...await sourceChangedRule(e, ctx), ...await taskAssignedRule(e, ctx)];

export const RULES: Record<string, Rule> = {
  'lead.allocated': allocationRule,
  'note.added': managerNoteRule,
  'lead.updated': leadUpdatedRule,
  'pipeline.run_completed': runCompletedRule,
};
