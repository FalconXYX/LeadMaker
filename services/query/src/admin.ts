// Manager-only reads: GET /users and GET /allocations/suggestions.
import { sql, type AllocationSuggestion, type AllocationSuggestionsResponse, type UserListItem } from '@leadmaker/shared';
import { one, rows, type Db } from './db.ts';

export async function listUsers(db: Db, role?: 'rep' | 'manager'): Promise<UserListItem[]> {
  const where = role ? sql`WHERE u.role = ${role}` : sql``;
  const list = await rows<{ id: string; name: string; email: string; role: UserListItem['role']; allocated_count: number }>(db.replica, sql`
    SELECT u.id, u.name, u.email, u.role,
           (SELECT count(*)::int FROM companies c WHERE c.assigned_rep_id = u.id) AS allocated_count
    FROM users u ${where} ORDER BY u.role DESC, u.name, u.id`);
  return list.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, allocatedCount: u.allocated_count }));
}

export const DEFAULT_SUGGESTION_LIMIT = 500;

interface PoolRow {
  id: string;
  business_name: string;
  postal_code: string | null;
  county_fips: string | null;
  priority_score: number | null;
  zip_rep: string | null;
  zip_n: number | null;
  county_rep: string | null;
  county_n: number | null;
}

/**
 * Suggestions for the unallocated pool, highest priority first: the rep who already works the most leads
 * in the lead's ZIP, else in its county (ties: the less-loaded rep), else the least-loaded rep (balance),
 * who then takes the rest of that county too.
 * Grouped per rep and basis so a manager can approve a group with one POST /api/allocations.
 */
export async function allocationSuggestions(db: Db, limit = DEFAULT_SUGGESTION_LIMIT): Promise<AllocationSuggestionsResponse> {
  const res = (await one<{ reps: { id: string; name: string; n: number }[]; pool: PoolRow[]; total: number }>(db.replica, sql`
    WITH reps AS MATERIALIZED (
      SELECT u.id, u.name, (SELECT count(*)::int FROM companies c WHERE c.assigned_rep_id = u.id) AS n
      FROM users u WHERE u.role = 'rep'),
    pool AS (
      SELECT id, business_name, postal_code, county_fips, priority_score::float8 AS priority_score
      FROM companies WHERE assigned_rep_id IS NULL
      ORDER BY priority_score DESC NULLS LAST, id DESC LIMIT ${limit}::int),
    -- The best rep per ZIP / county (most leads there, then the less-loaded), computed once and hash-joined:
    -- a LATERAL per pool row would re-aggregate companies for each of them.
    zip_best AS (
      SELECT DISTINCT ON (b.zip) b.zip, b.rep_id, b.n FROM (
        SELECT c.assigned_rep_id AS rep_id, left(c.postal_code, 5) AS zip, count(*)::int AS n
        FROM companies c JOIN reps r ON r.id = c.assigned_rep_id
        WHERE c.postal_code IS NOT NULL AND left(c.postal_code, 5) IN (SELECT left(postal_code, 5) FROM pool)
        GROUP BY 1, 2) b JOIN reps r ON r.id = b.rep_id
      ORDER BY b.zip, b.n DESC, r.n, b.rep_id),
    county_best AS (
      SELECT DISTINCT ON (b.county_fips) b.county_fips, b.rep_id, b.n FROM (
        SELECT c.assigned_rep_id AS rep_id, c.county_fips, count(*)::int AS n
        FROM companies c JOIN reps r ON r.id = c.assigned_rep_id
        WHERE c.county_fips IN (SELECT county_fips FROM pool)
        GROUP BY 1, 2) b JOIN reps r ON r.id = b.rep_id
      ORDER BY b.county_fips, b.n DESC, r.n, b.rep_id)
    SELECT
      (SELECT COALESCE(json_agg(r ORDER BY r.n, r.name, r.id), '[]'::json) FROM reps r) AS reps,
      (SELECT count(*)::int FROM companies WHERE assigned_rep_id IS NULL) AS total,
      (SELECT COALESCE(json_agg(x ORDER BY x.priority_score DESC NULLS LAST, x.id DESC), '[]'::json) FROM (
        SELECT p.*, z.rep_id AS zip_rep, z.n AS zip_n, k.rep_id AS county_rep, k.n AS county_n
        FROM pool p
        LEFT JOIN zip_best z ON z.zip = left(p.postal_code, 5)
        LEFT JOIN county_best k ON k.county_fips = p.county_fips
      ) x) AS pool`))!;

  const names = new Map(res.reps.map((r) => [r.id, r.name]));
  const load = new Map(res.reps.map((r) => [r.id, r.n]));
  const groups = new Map<string, AllocationSuggestion>();
  const balanced = new Map<string, string>();
  for (const p of res.pool) {
    let repId: string;
    let basis: AllocationSuggestion['basis'];
    let key: string | null;
    let reason: string;
    let area: string | null = null;
    if (p.zip_rep) {
      [repId, basis, key] = [p.zip_rep, 'postal_code', p.postal_code!.slice(0, 5)];
      reason = `${names.get(repId)} already works ${p.zip_n} lead${p.zip_n === 1 ? '' : 's'} in ZIP ${key}`;
    } else if (p.county_rep) {
      [repId, basis, key] = [p.county_rep, 'county', p.county_fips];
      reason = `${names.get(repId)} already works ${p.county_n} lead${p.county_n === 1 ? '' : 's'} in county ${key}`;
    } else {
      if (!load.size) break;
      // The least-loaded rep takes the whole county (or ZIP), so new territories stay contiguous.
      key = p.county_fips ?? p.postal_code?.slice(0, 5) ?? null;
      // County FIPS and ZIP codes are both 5 digits (36061 is Manhattan and a ZIP in Alabama).
      area = key === null ? null : `${p.county_fips ? 'county' : 'zip'}:${key}`;
      const claimed = area === null ? undefined : balanced.get(area);
      repId = claimed ?? [...load.entries()].sort((a, b) => a[1] - b[1] || names.get(a[0])!.localeCompare(names.get(b[0])!))[0][0];
      if (area !== null) balanced.set(area, repId);
      basis = 'balance';
      reason = `${names.get(repId)} has the fewest allocated leads${key ? `; keeps ${p.county_fips ? 'county' : 'ZIP'} ${key} together` : ''}`;
    }
    load.set(repId, (load.get(repId) ?? 0) + 1);
    const groupKey = `${repId}|${basis}|${area ?? key}`;
    const g = groups.get(groupKey) ?? {
      repId, repName: names.get(repId) ?? '', basis, key, reason, companyIds: [], leads: [],
    };
    g.companyIds.push(p.id);
    g.leads.push({ id: p.id, businessName: p.business_name, postalCode: p.postal_code, countyFips: p.county_fips,
                   priorityScore: p.priority_score });
    groups.set(groupKey, g);
  }
  return { suggestions: [...groups.values()], considered: res.pool.length, unallocatedTotal: res.total };
}
