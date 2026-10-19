// The list half of a lead search: sort, keyset pagination and the one statement returning a page plus
// the total. The WHERE conditions come from @leadmaker/shared (filterConditions), shared with crm-write's
// allocation by filter.
import {
  and, centerSql, DEFAULT_LIMIT, FOUNDED_YEAR, filterConditions, isUuid, LAST_CHANGE, needsMyState, NEXT_FOLLOW_UP, raw, sql,
  type FilterContext, type LeadFilter, type Point, type Sql, type SortField,
} from '@leadmaker/shared';
import { badRequest } from './errors.ts';
import { enrichmentSql } from './lead-timing.ts';

export { METERS_PER_MILE } from '@leadmaker/shared';

const TRUE = raw('TRUE');
// Never contacted counts as the oldest contact, so it sorts first ascending and last descending.
const LAST_CONTACTED = raw(`COALESCE(c.last_contacted_at, '-infinity'::timestamptz)`);
// NEXT_FOLLOW_UP for every lead at once: one pass over the open tasks instead of one probe per lead, for lists
// wider than one rep's leads.
const NEXT_FOLLOW_UP_JOIN = raw(`LEFT JOIN (
        SELECT t.company_id, min(t.due_at) AS next_due FROM tasks t WHERE t.done_at IS NULL GROUP BY t.company_id
      ) nf ON nf.company_id = c.id`);

interface SortSpec {
  expr: Sql;
  dir: 'asc' | 'desc';
  cast: Sql;
  signature: string;
  /** Joined into the page's FROM for expr. */
  join?: Sql;
}

export function sortSpec(filter: LeadFilter, center?: Point): SortSpec {
  const by: SortField = filter.sort?.by ?? 'priority_score';
  const dir = filter.sort?.dir ?? 'desc';
  const signature = `${by}:${dir}${by === 'distance' ? `:${filter.near?.zip}` : ''}`;
  const flip = dir === 'asc' ? 'desc' : 'asc';
  switch (by) {
    case 'priority_score': return { expr: raw('c.priority_score'), dir, cast: raw('numeric'), signature };
    case 'rating': return { expr: raw('c.rating'), dir, cast: raw('float8'), signature };
    case 'review_count': return { expr: raw('c.review_count'), dir, cast: raw('int'), signature };
    // More years in business = an earlier founding year.
    case 'years_in_business': return { expr: FOUNDED_YEAR, dir: flip, cast: raw('int'), signature };
    case 'last_change': return { expr: LAST_CHANGE, dir, cast: raw('timestamptz'), signature };
    case 'last_contacted': return { expr: LAST_CONTACTED, dir, cast: raw('timestamptz'), signature };
    // Leads without an open task are NULL: last either way.
    case 'next_follow_up':
      return filter.scope === 'mine' || typeof filter.scope === 'object'
        ? { expr: NEXT_FOLLOW_UP, dir, cast: raw('timestamptz'), signature }
        : { expr: raw('nf.next_due'), dir, cast: raw('timestamptz'), signature, join: NEXT_FOLLOW_UP_JOIN };
    case 'distance':
      if (!center) throw badRequest('sort by distance needs near');
      return { expr: sql`ST_Distance(c.location, ${centerSql(center)})`, dir, cast: raw('float8'), signature };
  }
}

interface Cursor {
  s: string;
  k: string | null;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(value: string | undefined, signature: string): Cursor | undefined {
  if (!value) return undefined;
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  if (!c || typeof c !== 'object' || !isUuid(c.id) || !(c.k === null || typeof c.k === 'string'))
    throw badRequest('invalid cursor');
  if (c.s !== signature) throw badRequest('cursor belongs to a different sort');
  return c as Cursor;
}

/** Rows after the cursor in ORDER BY sort_val <dir> NULLS LAST, id <dir>. */
function keyset(spec: SortSpec, cursor: Cursor | undefined): Sql {
  if (!cursor) return TRUE;
  const op = raw(spec.dir === 'desc' ? '<' : '>');
  const id = sql`${cursor.id}::uuid`;
  const v = spec.expr;
  if (cursor.k === null) return sql`(${v} IS NULL AND c.id ${op} ${id})`;
  const k = sql`${cursor.k}::${spec.cast}`;
  return sql`(${v} ${op} ${k} OR (${v} = ${k} AND c.id ${op} ${id}) OR ${v} IS NULL)`;
}

/** The total counts at most this many matches (+1 to know it was capped), not the whole matched set. */
export const TOTAL_CAP = 1000;

export interface SearchQuery {
  query: Sql;
  limit: number;
  signature: string;
}

export function buildSearchQuery(filter: LeadFilter, ctx: FilterContext): SearchQuery {
  const spec = sortSpec(filter, ctx.center);
  const cursor = decodeCursor(filter.cursor, spec.signature);
  const limit = filter.limit ?? DEFAULT_LIMIT;
  const order = sql`${raw(spec.dir)} NULLS LAST, `;
  const dir = raw(spec.dir);
  const me = sql`${ctx.viewer.id}::uuid`;
  const distance = ctx.center ? sql`ST_Distance(c.location, ${centerSql(ctx.center)})` : raw('NULL::float8');
  const myState = needsMyState(filter) ? sql`LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = ${me}` : raw('');
  const where = and(filterConditions(filter, ctx));

  // The page walks the sort order and stops after limit + 1 rows (an index scan where one fits).
  const query = sql`
    WITH page AS (
      SELECT c.id, ${spec.expr} AS sort_val, ${distance} AS distance_m
      FROM companies c ${myState} ${spec.join ?? raw('')}
      WHERE ${where} AND ${keyset(spec, cursor)}
      ORDER BY ${spec.expr} ${order}c.id ${dir} LIMIT ${limit + 1}::int
    )
    SELECT (SELECT count(*)::int FROM (
        SELECT 1 FROM companies c ${myState} WHERE ${where} LIMIT ${TOTAL_CAP + 1}::int) capped) AS total,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT row_number() OVER (ORDER BY p.sort_val ${order}p.id ${dir}) AS ord,
          p.sort_val::text AS sort_key, p.distance_m,
          c.id, c.business_name, c.city, c.state, c.postal_code, c.phone, c.website_url, c.latitude, c.longitude,
          c.county_fips, c.rating, c.review_count, c.tier, ${FOUNDED_YEAR} AS founded_year, c.segment,
          c.priority_score::float8 AS priority_score, c.account_status, c.assigned_rep_id, u.name AS assigned_rep_name,
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', t->'key', 'value', t->'value', 'label', t->'label',
                                                        'category', t->'category')), '[]'::jsonb)
             FROM jsonb_array_elements(c.system_tags) t) AS tags,
          ov.overrides, ct.custom_tags, c.updated_in_last_poll, ${LAST_CHANGE} AS last_change_at,
          ms.checked_at AS my_checked_at, ms.serviced_at AS my_serviced_at,
          (ms.checked_at IS NOT NULL
            AND (c.last_material_change_at IS NULL OR ms.checked_at >= c.last_material_change_at)) AS my_checked,
          c.team_last_checked_at, c.team_last_serviced_at,
          (c.team_last_checked_at IS NOT NULL
            AND (c.last_material_change_at IS NULL OR c.team_last_checked_at >= c.last_material_change_at)) AS team_checked,
          c.version, (${enrichmentSql(raw('c.id'))}) AS enrichment,
          c.sales_stage, c.last_contacted_at, nt.next_task
        FROM page p
        JOIN companies c ON c.id = p.id
        LEFT JOIN users u ON u.id = c.assigned_rep_id
        LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = ${me}
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(o.field, o.value) AS overrides FROM field_overrides o
          WHERE o.company_id = c.id AND o.contact_id IS NULL AND o.superseded_at IS NULL) ov ON TRUE
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY lower(t.name), t.id) AS custom_tags
          FROM company_custom_tags x JOIN custom_tags t ON t.id = x.tag_id WHERE x.company_id = c.id) ct ON TRUE
        LEFT JOIN LATERAL (
          SELECT json_build_object('id', t.id, 'title', t.title, 'type', t.type, 'dueAt', t.due_at) AS next_task
          FROM tasks t WHERE t.company_id = c.id AND t.done_at IS NULL ORDER BY t.due_at, t.id LIMIT 1) nt ON TRUE
      ) r), '[]'::json) AS items`;
  return { query, limit, signature: spec.signature };
}
