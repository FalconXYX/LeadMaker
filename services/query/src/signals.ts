// GET /signals: the weather/news timing layer (regional_signals) for the counties of the caller's leads.
// Cached briefly: alerts are polled every 15 min, and a scope's counties move only with allocations.
import {
  cacheKeys, countyName, isManager, raw, sql, SIGNALS_TTL_SECONDS, visibilitySql, type RegionalSignal, type SignalKind,
  type SignalScope, type SignalsResponse, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, type Db } from './db.ts';
import { iso } from './search.ts';

export const ALERT_LOOKBACK_DAYS = 7;
export const NEWS_LOOKBACK_DAYS = 30;
export const MAX_ALERTS = 200;
export const MAX_NEWS = 100;

interface SignalRow {
  id: string;
  county_fips: string;
  kind: SignalKind;
  source: string;
  payload: Record<string, unknown>;
  valid_from: string | null;
  valid_to: string | null;
  fetched_at: string;
  active: boolean;
  expired: boolean;
}

interface SignalsDoc {
  counties: { county_fips: string; lead_count: number }[];
  alerts: SignalRow[];
  storm_history: SignalRow[];
  news: SignalRow[];
}

export function defaultScope(viewer: Viewer): SignalScope {
  return isManager(viewer) ? 'all' : 'mine';
}

function scopeSql(viewer: Viewer, scope: SignalScope) {
  if (scope === 'mine') return sql`c.assigned_rep_id = ${viewer.id}::uuid`;
  return raw(scope === 'pool' ? 'c.assigned_rep_id IS NULL' : 'TRUE');
}

// A storm summary is rebuilt on every run (its valid_to is the build time), so it is current, never expired.
const COLUMNS = raw(`rs.id, rs.county_fips, rs.kind, rs.source, rs.payload, rs.valid_from, rs.valid_to, rs.fetched_at,
  rs.kind = 'storm_history' OR ((rs.valid_from IS NULL OR rs.valid_from <= now()) AND (rs.valid_to IS NULL OR rs.valid_to > now())) AS active,
  rs.kind <> 'storm_history' AND rs.valid_to IS NOT NULL AND rs.valid_to <= now() AS expired`);

export function signalsQuery(viewer: Viewer, scope: SignalScope) {
  return sql`
    WITH counties AS (
      SELECT c.county_fips, count(*)::int AS lead_count FROM companies c
      WHERE c.county_fips IS NOT NULL AND ${scopeSql(viewer, scope)} AND ${visibilitySql(viewer, 'view', 'c')}
      GROUP BY c.county_fips)
    SELECT
      (SELECT COALESCE(json_agg(k ORDER BY k.county_fips), '[]'::json) FROM counties k) AS counties,
      (SELECT COALESCE(json_agg(a ORDER BY a.sort_at DESC, a.id), '[]'::json) FROM (
         SELECT ${COLUMNS}, COALESCE(rs.valid_from, rs.fetched_at) AS sort_at
         FROM regional_signals rs JOIN counties k ON k.county_fips = rs.county_fips
         WHERE rs.kind = 'active_alert'
           AND (rs.valid_to IS NULL OR rs.valid_to > now() - make_interval(days => ${ALERT_LOOKBACK_DAYS}::int))
         ORDER BY sort_at DESC, rs.id LIMIT ${MAX_ALERTS}::int) a) AS alerts,
      (SELECT COALESCE(json_agg(h ORDER BY h.last_event_at DESC NULLS LAST, h.county_fips), '[]'::json) FROM (
         SELECT DISTINCT ON (rs.county_fips) ${COLUMNS}, rs.payload->>'last_event_at' AS last_event_at
         FROM regional_signals rs JOIN counties k ON k.county_fips = rs.county_fips
         WHERE rs.kind = 'storm_history'
         ORDER BY rs.county_fips, rs.fetched_at DESC, rs.id) h) AS storm_history,
      (SELECT COALESCE(json_agg(n ORDER BY n.sort_at DESC, n.id), '[]'::json) FROM (
         SELECT ${COLUMNS}, COALESCE(rs.valid_from, rs.fetched_at) AS sort_at
         FROM regional_signals rs JOIN counties k ON k.county_fips = rs.county_fips
         WHERE rs.kind = 'news'
           AND COALESCE(rs.valid_from, rs.fetched_at) > now() - make_interval(days => ${NEWS_LOOKBACK_DAYS}::int)
         ORDER BY sort_at DESC, rs.id LIMIT ${MAX_NEWS}::int) n) AS news`;
}

function signal(r: SignalRow): RegionalSignal {
  return {
    id: r.id,
    countyFips: r.county_fips,
    kind: r.kind,
    source: r.source,
    payload: r.payload,
    validFrom: iso(r.valid_from),
    validTo: iso(r.valid_to),
    fetchedAt: iso(r.fetched_at)!,
    active: r.active,
    expired: r.expired,
  };
}

/** Every caller gets the same answer for the pool and for a manager's 'all'; anything else is per user. */
export function signalsKey(viewer: Viewer, scope: SignalScope): string {
  const shared = scope === 'pool' || (scope === 'all' && isManager(viewer));
  return cacheKeys.signals(shared ? 'shared' : viewer.id, scope);
}

export async function getSignals(
  db: Db, cache: Cache, viewer: Viewer, scope: SignalScope,
): Promise<{ result: SignalsResponse; cache: 'hit' | 'miss' }> {
  const key = signalsKey(viewer, scope);
  const cached = await cache.getJson<SignalsResponse>(key);
  if (cached) return { result: cached, cache: 'hit' };
  const doc = await one<SignalsDoc>(db.replica, signalsQuery(viewer, scope));
  const result: SignalsResponse = {
    scope,
    counties: (doc?.counties ?? []).map((c) => ({
      countyFips: c.county_fips, leadCount: c.lead_count, name: countyName(c.county_fips),
    })),
    alerts: (doc?.alerts ?? []).map(signal),
    stormHistory: (doc?.storm_history ?? []).map(signal),
    news: (doc?.news ?? []).map(signal),
    generatedAt: new Date().toISOString(),
  };
  await cache.setJson(key, result, SIGNALS_TTL_SECONDS);
  return { result, cache: 'miss' };
}
