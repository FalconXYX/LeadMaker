// GET /kpis. mine: live indexed counts over the user's allocated leads and their own lead_rep_state
// (cached as kpi:rep:{userId}; the relay deletes it on events). team (managers): team_dashboard_kpis,
// refreshed by the relay every 5 minutes and after each pipeline run (cached as kpi:team).
import { cacheKeys, KPI_TTL_SECONDS, sql, type KpiCounts, type KpiResponse, type TeamKpis, type Viewer } from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';

export function mineQuery(userId: string) {
  return sql`
    SELECT count(*)::int AS allocated,
      (count(*) FILTER (WHERE s.checked_at IS NULL OR s.checked_at < c.last_material_change_at))::int AS unchecked,
      (count(*) FILTER (WHERE s.serviced_at IS NULL))::int AS unserviced,
      (count(*) FILTER (WHERE c.updated_in_last_poll))::int AS updated_in_last_poll
    FROM companies c LEFT JOIN lead_rep_state s ON s.company_id = c.id AND s.user_id = ${userId}::uuid
    WHERE c.assigned_rep_id = ${userId}::uuid`;
}

interface ViewRow {
  lead_count: number;
  unchecked_count: number;
  unserviced_count: number;
  recent_updates_count: number;
}

const TEAM_QUERY = sql`
  SELECT
    (SELECT max(refreshed_at) FROM team_dashboard_kpis) AS refreshed_at,
    (SELECT row_to_json(t) FROM (
       SELECT COALESCE(sum(lead_count), 0)::int AS lead_count, COALESCE(sum(unchecked_count), 0)::int AS unchecked_count,
              COALESCE(sum(unserviced_count), 0)::int AS unserviced_count,
              COALESCE(sum(recent_updates_count), 0)::int AS recent_updates_count
       FROM team_dashboard_kpis) t) AS totals,
    (SELECT row_to_json(p) FROM (
       SELECT lead_count, unchecked_count, unserviced_count, recent_updates_count
       FROM team_dashboard_kpis WHERE assigned_rep_id IS NULL) p) AS pool,
    (SELECT COALESCE(json_agg(r ORDER BY r.name, r.rep_id), '[]'::json) FROM (
       SELECT u.id AS rep_id, u.name, u.email, COALESCE(k.lead_count, 0) AS lead_count,
              COALESCE(k.rep_unchecked_count, 0) AS rep_unchecked_count,
              COALESCE(k.rep_unserviced_count, 0) AS rep_unserviced_count,
              COALESCE(k.recent_updates_count, 0) AS recent_updates_count,
              COALESCE(k.unchecked_count, 0) AS unchecked_count, COALESCE(k.unserviced_count, 0) AS unserviced_count
       FROM users u LEFT JOIN team_dashboard_kpis k ON k.assigned_rep_id = u.id
       WHERE u.role = 'rep') r) AS reps`;

interface TeamRow {
  refreshed_at: Date | null;
  totals: ViewRow;
  pool: ViewRow | null;
  reps: (ViewRow & { rep_id: string; name: string; email: string; rep_unchecked_count: number; rep_unserviced_count: number })[];
}

const counts = (r: ViewRow | null): KpiCounts => ({
  allocated: r?.lead_count ?? 0,
  unchecked: r?.unchecked_count ?? 0,
  unserviced: r?.unserviced_count ?? 0,
  updated_in_last_poll: r?.recent_updates_count ?? 0,
});

export async function teamKpis(db: Db, primary: boolean): Promise<TeamKpis> {
  const row = (await one<TeamRow>(pick(db, primary), TEAM_QUERY))!;
  return {
    refreshedAt: row.refreshed_at ? new Date(row.refreshed_at).toISOString() : null,
    totals: { ...counts(row.totals), assigned: (row.totals.lead_count ?? 0) - (row.pool?.lead_count ?? 0) },
    unallocated: counts(row.pool),
    reps: row.reps.map((r) => ({
      repId: r.rep_id,
      name: r.name,
      email: r.email,
      allocated: r.lead_count,
      unchecked: r.rep_unchecked_count,
      unserviced: r.rep_unserviced_count,
      updated_in_last_poll: r.recent_updates_count,
      teamUnchecked: r.unchecked_count,
      teamUnserviced: r.unserviced_count,
    })),
  };
}

export async function getKpis(db: Db, cache: Cache, viewer: Viewer): Promise<KpiResponse> {
  const fresh = await cache.recentlyWrote(viewer.id);
  const mineKey = cacheKeys.kpiRep(viewer.id);
  let mine = fresh ? undefined : await cache.getJson<KpiCounts>(mineKey);
  if (!mine) {
    mine = (await one<KpiCounts>(pick(db, fresh), mineQuery(viewer.id)))!;
    await cache.setJson(mineKey, mine, KPI_TTL_SECONDS);
  }
  if (viewer.role !== 'manager') return { mine };
  let team = await cache.getJson<TeamKpis>(cacheKeys.kpiTeam);
  if (!team) {
    team = await teamKpis(db, false);
    await cache.setJson(cacheKeys.kpiTeam, team, KPI_TTL_SECONDS);
  }
  return { mine, team };
}
