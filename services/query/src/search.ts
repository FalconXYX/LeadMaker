import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  canWrite, CERTIFICATIONS, leadListKey, sql, type LeadFilter, type LeadSearchResult, type LeadSummary, type NextTask,
  type SalesStage, type TimingBadge, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pgCode, pick, rows, type Db } from './db.ts';
import { badRequest } from './errors.ts';
import { buildSearchQuery, encodeCursor, METERS_PER_MILE, TOTAL_CAP } from './filter-sql.ts';
import { timingFor, type CountySignals } from './lead-timing.ts';
import type { TimingLead } from './timing.ts';
import type { Point } from '@leadmaker/shared';
import { zipCentroid } from './zip.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SearchRow {
  sort_key: string | null;
  distance_m: number | null;
  id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  website_url: string | null;
  latitude: number;
  longitude: number;
  county_fips: string | null;
  rating: number | null;
  review_count: number;
  tier: string | null;
  founded_year: number | null;
  segment: string | null;
  priority_score: number | null;
  account_status: LeadSummary['accountStatus'];
  assigned_rep_id: string | null;
  assigned_rep_name: string | null;
  tags: LeadSummary['tags'];
  overrides: Record<string, unknown> | null;
  custom_tags: LeadSummary['customTags'] | null;
  updated_in_last_poll: boolean;
  last_change_at: string;
  my_checked_at: string | null;
  my_serviced_at: string | null;
  my_checked: boolean;
  team_last_checked_at: string | null;
  team_last_serviced_at: string | null;
  team_checked: boolean;
  version: number;
  /** The timing badges' enrichment input (lead-timing enrichmentSql). */
  enrichment: TimingLead['enrichment'];
  sales_stage: SalesStage;
  last_contacted_at: string | null;
  next_task: NextTask | null;
}

export function iso(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function yearsSince(year: number | null | undefined, now = new Date()): number | null {
  return year ? Math.max(0, now.getUTCFullYear() - year) : null;
}

// LeadFilter.certifications '<source>:<level>' is the '<source>_tier' tag (certificationCondition).
const CERT_SOURCES = new Set(CERTIFICATIONS.map((c) => c.split(':')[0]));

function certifications(tags: LeadSummary['tags']): string[] {
  return tags.flatMap((t) => {
    const source = t.key.endsWith('_tier') ? t.key.slice(0, -'_tier'.length) : '';
    return CERT_SOURCES.has(source) && typeof t.value === 'string' && t.value ? [`${source}:${t.value}`] : [];
  });
}

function effective(row: SearchRow, field: string, scraped: string | null): string | null {
  const o = row.overrides;
  if (!o || !(field in o)) return scraped;
  const v = o[field];
  return v === null || v === undefined ? null : String(v);
}

export function toSummary(row: SearchRow, viewer: Viewer, timing: TimingBadge[] = []): LeadSummary {
  const drivers = row.tags.find((t) => t.key === 'priority_drivers')?.value;
  const size = row.tags.find((t) => t.key === 'size')?.value;
  return {
    id: row.id,
    businessName: effective(row, 'business_name', row.business_name) || row.business_name,
    city: effective(row, 'city', row.city),
    state: effective(row, 'state', row.state),
    postalCode: effective(row, 'postal_code', row.postal_code),
    phone: effective(row, 'phone', row.phone),
    websiteUrl: effective(row, 'website_url', row.website_url),
    latitude: row.latitude,
    longitude: row.longitude,
    countyFips: row.county_fips,
    rating: row.rating,
    reviewCount: row.review_count,
    tier: row.tier,
    yearsInBusiness: yearsSince(row.founded_year),
    segment: row.segment,
    priorityScore: row.priority_score,
    priorityDrivers: Array.isArray(drivers) ? drivers.map(String) : [],
    accountStatus: row.account_status,
    assignedRep: row.assigned_rep_id ? { id: row.assigned_rep_id, name: row.assigned_rep_name ?? '' } : null,
    tags: row.tags,
    customTags: row.custom_tags ?? [],
    updatedInLastPoll: row.updated_in_last_poll,
    lastChangeAt: iso(row.last_change_at)!,
    mine: {
      checked: row.my_checked,
      serviced: row.my_serviced_at !== null,
      checkedAt: iso(row.my_checked_at),
      servicedAt: iso(row.my_serviced_at),
    },
    team: {
      checked: row.team_checked,
      serviced: row.team_last_serviced_at !== null,
      checkedAt: iso(row.team_last_checked_at),
      servicedAt: iso(row.team_last_serviced_at),
    },
    distanceMiles: row.distance_m === null ? null : Math.round((row.distance_m / METERS_PER_MILE) * 100) / 100,
    canWrite: canWrite(viewer, row.assigned_rep_id),
    version: row.version,
    size: typeof size === 'string' && size ? size : null,
    certifications: certifications(row.tags),
    timing,
    salesStage: row.sales_stage,
    lastContactedAt: iso(row.last_contacted_at),
    nextTask: row.next_task && { ...row.next_task, dueAt: iso(row.next_task.dueAt)! },
  };
}

export type SearchResult = LeadSearchResult;

/** `timingDb` reads counties' signals missing from `signals` (the fast pool, so it never waits for a search slot). */
export async function runSearch(
  db: Db, filter: LeadFilter, viewer: Viewer, primary: boolean, signals: CountySignals, timingDb: Db = db,
): Promise<SearchResult> {
  const center: Point | undefined = filter.near ? await zipCentroid(db, filter.near.zip, viewer) : undefined;
  const { query, limit, signature } = buildSearchQuery(filter, { viewer, center });
  const res = await one<{ total: number; items: SearchRow[] }>(pick(db, primary), query).catch((err: unknown) => {
    // The cursor's sort key comes back from the client; one that is not a value of the sort column's
    // type fails its cast (SQLSTATE class 22, data exception). Every other value in the statement is validated.
    if (filter.cursor && pgCode(err)?.startsWith('22')) throw badRequest('invalid cursor');
    throw err;
  });
  const items = res?.items ?? [];
  const page = items.slice(0, limit);
  const last = page.at(-1);
  const total = res?.total ?? 0;
  const timing = await timingFor(signals, pick(timingDb, primary), page);
  return {
    items: page.map((r) => toSummary(r, viewer, timing.get(r.id))),
    nextCursor: items.length > limit && last ? encodeCursor({ s: signature, k: last.sort_key, id: last.id }) : null,
    total: Math.min(total, TOTAL_CAP),
    totalCapped: total > TOTAL_CAP,
  };
}

/** A cached page, gzipped (the summaries' tag arrays make it ~130 KB of JSON), and whom it was read for. */
interface CachedList {
  by: string;
  gz: string;
}

export async function gzipJson(value: unknown): Promise<string> {
  return (await gzipAsync(JSON.stringify(value))).toString('base64');
}

export async function gunzipJson<T>(gz: unknown): Promise<T | undefined> {
  if (typeof gz !== 'string') return undefined;
  try {
    return JSON.parse((await gunzipAsync(Buffer.from(gz, 'base64'))).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function pack(result: SearchResult, by: string): Promise<CachedList> {
  return { by, gz: await gzipJson(result) };
}

const unpack = (cached: CachedList | undefined) => gunzipJson<SearchResult>(cached?.gz);

/** The viewer's own checked/serviced flags on a page cached for another manager. */
async function withMyState(db: Db, result: SearchResult, viewer: Viewer): Promise<SearchResult> {
  const ids = result.items.map((i) => i.id);
  if (!ids.length) return result;
  const states = await rows<{ id: string; checked: boolean; checked_at: string | null; serviced_at: string | null }>(db.replica, sql`
    SELECT c.id, ms.checked_at, ms.serviced_at,
      (ms.checked_at IS NOT NULL AND (c.last_material_change_at IS NULL OR ms.checked_at >= c.last_material_change_at)) AS checked
    FROM companies c LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = ${viewer.id}::uuid
    WHERE c.id = ANY(${ids}::uuid[])`);
  const byId = new Map(states.map((s) => [s.id, s]));
  return {
    ...result,
    items: result.items.map((item) => {
      const s = byId.get(item.id);
      const mine = { checked: s?.checked ?? false, serviced: s?.serviced_at != null, checkedAt: iso(s?.checked_at), servicedAt: iso(s?.serviced_at) };
      return { ...item, mine };
    }),
  };
}

/**
 * Cached for the list TTL under the viewer's list versions (a rep's own leads and the pool, every lead for
 * managers; the relay bumps them as leads change): per user for reps, one entry for all managers unless the
 * filter is personal (leadListKey). Right after the user's own
 * write, served from the primary and not read from the cache. `stateDb` (the fast pool) re-reads the viewer's
 * own flags on a page cached for another manager, so that read never waits for a search slot.
 */
export async function searchLeads(
  db: Db, cache: Cache, filter: LeadFilter, viewer: Viewer, ttlSeconds: number, signals: CountySignals, stateDb: Db = db,
): Promise<{ result: SearchResult; cache: 'hit' | 'miss' | 'bypass' }> {
  const [fresh, version] = await Promise.all([cache.recentlyWrote(viewer.id), cache.listVersion(viewer)]);
  const key = version === null ? null : leadListKey(viewer, version, filter);
  if (key && !fresh) {
    const cached = await cache.getJson<CachedList>(key);
    const hit = await unpack(cached);
    if (cached && hit) return { result: cached.by === viewer.id ? hit : await withMyState(stateDb, hit, viewer), cache: 'hit' };
  }
  const result = await runSearch(db, filter, viewer, fresh, signals, stateDb);
  if (key) await cache.setJson(key, await pack(result, viewer.id), ttlSeconds);
  return { result, cache: fresh ? 'bypass' : 'miss' };
}
