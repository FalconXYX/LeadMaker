// GET /leads/map: one small point per lead the caller may see in a scope (the map needs no full summaries).
// One statement returns the points' inputs and their counties' signals; cached like the lists, under the
// viewer's list versions.
import {
  and, cacheKeys, isUuid, scopeCondition, sql, visibilitySql, type LeadMapPoint, type LeadMapResponse, type LeadScope,
  type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';
import { badRequest } from './errors.ts';
import { badgesFor, byCounty, enrichmentSql, signalRowsSql } from './lead-timing.ts';
import { gunzipJson, gzipJson } from './search.ts';
import type { SignalRow, TimingLead } from './timing.ts';

export function parseMapScope(value: string | undefined): LeadScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'mine' || value === 'unallocated' || value === 'all') return value;
  const repId = value.startsWith('rep:') ? value.slice(4) : '';
  if (!isUuid(repId)) throw badRequest('invalid scope', 'mine, unallocated, all or rep:{uuid}');
  return { repId: repId.toLowerCase() };
}

type MapRow = Omit<LeadMapPoint, 'priorityScore' | 'assignedRepId' | 'countyFips' | 'timing'> & TimingLead & {
  priority_score: number | null;
  assigned_rep_id: string | null;
  county_fips: string | null;
};

export function mapQuery(viewer: Viewer, scope: LeadScope | undefined) {
  const where = and([visibilitySql(viewer, 'view', 'c'), ...(scope === undefined ? [] : [scopeCondition(viewer, scope)])]);
  return sql`
    WITH leads AS (
      SELECT c.id, COALESCE(NULLIF(bn.value #>> '{}', ''), c.business_name) AS name, c.latitude, c.longitude, c.segment,
        c.priority_score::float8 AS priority_score, c.assigned_rep_id, c.county_fips, c.state,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', t->'key', 'value', t->'value')), '[]'::jsonb)
           FROM jsonb_array_elements(c.system_tags) t
           WHERE t->>'key' LIKE 'service:%' OR t->>'key' = 'storm_insurance') AS tags,
        (${enrichmentSql(sql`c.id`)}) AS enrichment
      FROM companies c
      LEFT JOIN field_overrides bn ON bn.company_id = c.id AND bn.contact_id IS NULL AND bn.field = 'business_name'
        AND bn.superseded_at IS NULL
      WHERE ${where})
    SELECT
      (SELECT COALESCE(json_agg(l ORDER BY l.priority_score DESC NULLS LAST, l.id DESC), '[]'::json) FROM leads l) AS items,
      (SELECT COALESCE(json_agg(s), '[]'::json) FROM (
         ${signalRowsSql(sql`rs.county_fips IN (SELECT county_fips FROM leads)`)}) s) AS signals`;
}

export async function readMap(db: Db, viewer: Viewer, scope: LeadScope | undefined, primary: boolean, now = new Date()) {
  const doc = await one<{ items: MapRow[]; signals: SignalRow[] }>(pick(db, primary), mapQuery(viewer, scope));
  const signals = byCounty(doc?.signals ?? []);
  return {
    items: (doc?.items ?? []).map((r): LeadMapPoint => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      segment: r.segment,
      priorityScore: r.priority_score,
      assignedRepId: r.assigned_rep_id,
      countyFips: r.county_fips,
      timing: badgesFor({ ...r, enrichment: r.enrichment ?? {} }, signals, now)[0]?.severity ?? null,
    })),
  } satisfies LeadMapResponse;
}

/** Managers share an entry unless the scope is their own leads; a rep's points are their own. */
export function mapKey(viewer: Viewer, version: string, scope: LeadScope | undefined): string {
  const shared = viewer.role === 'manager' && scope !== 'mine';
  const name = scope === undefined ? 'visible' : typeof scope === 'object' ? `rep:${scope.repId}` : scope;
  return cacheKeys.leadMap(shared ? 'mgr' : viewer.id, version, name);
}

/**
 * Cached for the list TTL; right after the user's own write, read from the primary and not from the cache.
 * `scopeParam` is a LeadMapScope ('mine', 'unallocated', 'all', 'rep:{id}') or undefined.
 */
export async function getMap(
  db: Db, cache: Cache, viewer: Viewer, scopeParam: string | undefined, ttlSeconds: number,
): Promise<{ result: LeadMapResponse; cache: 'hit' | 'miss' | 'bypass' }> {
  const scope = parseMapScope(scopeParam);
  if (scope !== undefined) scopeCondition(viewer, scope);
  const [fresh, version] = await Promise.all([cache.recentlyWrote(viewer.id), cache.listVersion(viewer)]);
  const key = version === null ? null : mapKey(viewer, version, scope);
  if (key && !fresh) {
    const hit = await gunzipJson<LeadMapResponse>(await cache.getJson<string>(key));
    if (hit) return { result: hit, cache: 'hit' };
  }
  const result = await readMap(db, viewer, scope, fresh);
  if (key) await cache.setJson(key, await gzipJson(result), ttlSeconds);
  return { result, cache: fresh ? 'bypass' : 'miss' };
}
