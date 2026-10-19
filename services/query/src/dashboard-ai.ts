// The dashboard's AI parts: the pitch for each lead on today's call list (callPitches) and the new leads worth a call
// (aiPicks), both from the batch insights (company_insights). They are part of the dashboard body, so they share its
// cache entry (dash:<rep> | dash:team, DASHBOARD_TTL_SECONDS) and scope: a rep's picks are the same whether the rep or
// a manager (rep:<id>) asks, and the team's are the same for every manager. Like every other lead field on the
// dashboard, an insight write shows within the TTL (the dashboard is not invalidated by events).
//
// Today's call list is ranked in the web (callList.ts buildBriefing) from five reads; callIdsQueries repeats those
// reads here (same filters, sort and limits) so the picks can leave its leads out.
import {
  and, countyName, filterConditions, raw, SALES_TIME_ZONE, sql, type AiPick, type LeadFilter, type ParsedSalesScope,
  type Sql, type TaskDue, type Viewer,
} from '@leadmaker/shared';
import type { PrismaClient } from '@leadmaker/db';
import { rows } from './db.ts';
import { tasksQuery } from './tasks.ts';

export const AI_PICKS_LIMIT = 5;
/** A lead first seen this many days ago or less is 'new'. */
export const AI_PICKS_NEW_DAYS = 14;
/** As the web's BRIEFING_TASK_LIMIT, BRIEFING_LEAD_LIMIT and QUIET_DAYS (features/dashboard). */
export const CALL_TASK_LIMIT = 50;
export const CALL_LEAD_LIMIT = 20;
export const CALL_QUIET_DAYS = 7;
const SENTENCE_MAX = 240;

/**
 * The first sentence of an insight text, trimmed; at most SENTENCE_MAX characters (cut at a word, with an ellipsis).
 * A period inside a short abbreviation or a number ("Inc.", "St.", "4.8") does not end the sentence.
 */
export function firstSentence(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const re = /[.!?](?=\s+["“(]?[A-Z0-9]|$)/g;
  let end = t.length;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const word = t.slice(0, m.index).split(' ').at(-1) ?? '';
    if (m[0] === '.' && /^(?:[A-Z][a-z]{0,3}|[A-Z](?:\.[A-Z])*|e\.g|i\.e|vs|approx)$/.test(word)) continue;
    end = m.index + 1;
    break;
  }
  const s = t.slice(0, end);
  if (s.length <= SENTENCE_MAX) return s;
  const cut = s.slice(0, SENTENCE_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), SENTENCE_MAX / 2)).replace(/[\s,;:.-]+$/, '')}…`;
}

/** Lead c's insight: the latest status 'ok' row with any text, else the latest row with any (any prompt version). */
const INSIGHT = raw(`LEFT JOIN LATERAL (
    SELECT NULLIF(btrim(i.business_summary), '') AS summary, NULLIF(btrim(i.sales_recommendation), '') AS pitch
    FROM company_insights i
    WHERE i.company_id = c.id AND (btrim(i.business_summary) <> '' OR btrim(i.sales_recommendation) <> '')
    ORDER BY (i.status = 'ok') DESC, i.generated_at DESC, i.id LIMIT 1) ins ON TRUE`);

const EFFECTIVE_NAME = raw(`COALESCE((SELECT o.value #>> '{}' FROM field_overrides o
    WHERE o.company_id = c.id AND o.contact_id IS NULL AND o.field = 'business_name' AND o.superseded_at IS NULL),
    c.business_name)`);

/** Whose eyes the scope's call list and picks are computed with: the scope's rep, or (team) the asking manager. */
export function scopeViewer(viewer: Viewer, rep: string | null): Viewer {
  return rep ? { id: rep, role: 'rep' } : viewer;
}

/** YYYY-MM-DD `days` ago in SALES_TIME_ZONE (the web sends its local date for notContactedSince). */
function daysAgo(days: number, now: Date): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: SALES_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** The web's call-list lead reads (dashboard queries.ts useBriefing), for the scope's viewer. */
export function callLeadFilters(rep: string | null, now = new Date()): LeadFilter[] {
  const scope: LeadFilter['scope'] = rep ? 'mine' : 'all';
  const sort = { by: 'priority_score', dir: 'desc' } as const;
  return [
    { scope, stages: ['interested', 'quoting'], notContactedSince: daysAgo(CALL_QUIET_DAYS, now), limit: CALL_LEAD_LIMIT, sort },
    { scope, stages: ['new'], updatedInLastPoll: true, limit: CALL_LEAD_LIMIT, sort },
    { scope, stages: ['new'], segment: ['strategic'], limit: CALL_LEAD_LIMIT, sort },
  ];
}

/** Lead ids of one call-list lead read: the search's filter, order and limit (filter-sql buildSearchQuery). */
export function callLeadIdsQuery(viewer: Viewer, filter: LeadFilter): Sql {
  return sql`SELECT c.id::text AS id FROM companies c WHERE ${and(filterConditions(filter, { viewer }))}
    ORDER BY c.priority_score DESC NULLS LAST, c.id DESC LIMIT ${filter.limit ?? CALL_LEAD_LIMIT}::int`;
}

/** The leads on today's call list: open follow-ups overdue or due today, then the three lead reads. */
export async function callLeadIds(client: PrismaClient, viewer: Viewer, scope: ParsedSalesScope, rep: string | null, now = new Date()): Promise<string[]> {
  const who = scopeViewer(viewer, rep);
  const taskScope: ParsedSalesScope = rep ? { kind: 'mine' } : scope;
  const tasks = (due: TaskDue) => rows<{ company_id: string }>(client, tasksQuery(who, { scope: taskScope, due, status: 'open', limit: CALL_TASK_LIMIT }));
  const found = await Promise.all([
    tasks('overdue').then((r) => r.slice(0, CALL_TASK_LIMIT).map((t) => t.company_id)),
    tasks('today').then((r) => r.slice(0, CALL_TASK_LIMIT).map((t) => t.company_id)),
    ...callLeadFilters(rep, now).map((f) => rows<{ id: string }>(client, callLeadIdsQuery(who, f)).then((r) => r.map((x) => x.id))),
  ]);
  return [...new Set(found.flat().map((id) => id.toLowerCase()))];
}

/** callPitches: each listed lead's pitch, first sentence; leads without one are left out. */
export async function readCallPitches(client: PrismaClient, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const found = await rows<{ id: string; pitch: string | null }>(client, sql`
    SELECT c.id::text AS id, ins.pitch FROM companies c ${INSIGHT} WHERE c.id = ANY(${ids}::uuid[])`);
  const out: Record<string, string> = {};
  for (const r of found) {
    const pitch = firstSentence(r.pitch);
    if (pitch) out[r.id] = pitch;
  }
  return out;
}

interface PickRow {
  id: string;
  name: string;
  city: string | null;
  county_fips: string | null;
  priority_score: number | null;
  summary: string | null;
  pitch: string | null;
  first_seen_at: Date | string | null;
  label: 'new' | 'top_match';
}

/**
 * aiPicks' candidates and order. Rep scope: unallocated or the rep's own leads the rep never called, emailed or
 * visited; team: unallocated leads nobody did. Never: do not contact, existing customers, won or lost leads, or a
 * lead in `exclude` (today's call list).
 */
export function aiPicksQuery(rep: string | null, exclude: string[]): Sql {
  const whose = rep ? sql`(c.assigned_rep_id IS NULL OR c.assigned_rep_id = ${rep}::uuid)` : raw('c.assigned_rep_id IS NULL');
  const untouched = rep
    ? sql`NOT EXISTS (SELECT 1 FROM activity_logs al WHERE al.company_id = c.id AND al.user_id = ${rep}::uuid
            AND al.action_type IN ('call', 'email', 'visit'))`
    : raw('c.last_contacted_at IS NULL');
  const base = sql`${whose} AND ${untouched}
    AND c.account_status NOT IN ('do_not_contact', 'existing_customer') AND c.sales_stage NOT IN ('won', 'lost')
    AND NOT (c.id = ANY(${exclude}::uuid[]))`;
  const isNew = sql`c.first_seen_at >= now() - make_interval(days => ${AI_PICKS_NEW_DAYS}::int)`;
  const limit = sql`${AI_PICKS_LIMIT}::int`;
  const cols = sql`c.id::text AS id, ${EFFECTIVE_NAME} AS name, c.city, c.county_fips,
    c.priority_score::float8 AS priority_score, ins.summary, ins.pitch, c.first_seen_at`;
  return sql`
    (SELECT ${cols}, 'new' AS label, 0 AS grp FROM companies c ${INSIGHT}
     WHERE ${base} AND ${isNew}
     ORDER BY c.priority_score DESC NULLS LAST, c.first_seen_at DESC, c.id DESC LIMIT ${limit})
    UNION ALL
    (SELECT ${cols}, 'top_match' AS label, 1 AS grp FROM companies c ${INSIGHT}
     WHERE ${base} AND NOT COALESCE(${isNew}, FALSE) AND (ins.summary IS NOT NULL OR ins.pitch IS NOT NULL)
     ORDER BY c.priority_score DESC NULLS LAST, c.id DESC LIMIT ${limit})
    ORDER BY grp, priority_score DESC NULLS LAST, first_seen_at DESC, id DESC`;
}

const isoOrNull = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

export async function readAiPicks(client: PrismaClient, rep: string | null, exclude: string[]): Promise<AiPick[]> {
  const found = await rows<PickRow>(client, aiPicksQuery(rep, exclude));
  return found.slice(0, AI_PICKS_LIMIT).map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    county: countyName(r.county_fips),
    priorityScore: r.priority_score,
    aiSummary: firstSentence(r.summary),
    aiPitch: firstSentence(r.pitch),
    foundAt: isoOrNull(r.first_seen_at),
    label: r.label,
  }));
}

/** Both AI parts for the scope: the call list's leads first (the picks leave them out), then pitches and picks. */
export async function readDashboardAi(
  client: PrismaClient, viewer: Viewer, scope: ParsedSalesScope, rep: string | null,
): Promise<{ aiPicks: AiPick[]; callPitches: Record<string, string> }> {
  const ids = await callLeadIds(client, viewer, scope, rep);
  const [callPitches, aiPicks] = await Promise.all([readCallPitches(client, ids), readAiPicks(client, rep, ids)]);
  return { aiPicks, callPitches };
}
