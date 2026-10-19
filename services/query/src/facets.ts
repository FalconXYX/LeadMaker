// POST /leads/facets: facet counts over the leads a LeadFilter matches, in one statement (one pass over
// tag_facets), cached like the lists under the viewer's list versions.
import {
  and, CERTIFICATIONS, filterConditions, join, leadFacetsKey, MATERIALS, needsMyState, raw, SALES_STAGES, sql,
  type FacetCount, type LeadFacetsResponse, type LeadFilter, type Point, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';
import { zipCentroid } from './zip.ts';

// certificationCondition: '<source>:<level>' is the '<source>_tier' tag; '<source>:none', no such tag.
const CERT_SOURCES = [...new Set(CERTIFICATIONS.map((c) => c.split(':')[0]))];
const MATERIAL_KEYS = new Set<string>(MATERIALS);

interface FacetsDoc {
  total: number;
  none: Record<string, number>;
  segment: Record<string, number>;
  account_status: Record<string, number>;
  stages: Record<string, number>;
  tags: Record<string, number>;
  services: Record<string, number>;
  custom_tags: { id: string; name: string; n: number }[];
}

export function facetsQuery(filter: LeadFilter, viewer: Viewer, center?: Point) {
  const where = and(filterConditions(filter, { viewer, center }));
  const myState = needsMyState(filter)
    ? sql`LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = ${viewer.id}::uuid`
    : raw('');
  const tiers = CERT_SOURCES.map((s) => `${s}_tier=`);
  const none = CERT_SOURCES.map((s) => sql`${s}::text, count(*) FILTER (WHERE NOT m.tag_facets && ${[`${s}_tier`, `${s}_tier?=false`]}::text[]
      OR m.tag_facets @> ${[`${s}_tier=none`]}::text[])`);
  return sql`
    WITH m AS MATERIALIZED (
      SELECT c.id, c.segment, c.account_status, c.sales_stage, c.tag_facets FROM companies c ${myState} WHERE ${where}
    ), x AS (
      SELECT m.id, f FROM m, unnest(m.tag_facets) f
      WHERE f LIKE 'size=%' OR left(f, strpos(f, '=')) = ANY(${tiers}::text[]) OR f ~ '^(service|specialty):[^=]+\\?=true$'
    )
    SELECT
      (SELECT count(*)::int FROM m) AS total,
      (SELECT json_build_object(${join(none)}) FROM m) AS none,
      (SELECT COALESCE(json_object_agg(segment, n), '{}'::json) FROM (
         SELECT segment, count(*)::int AS n FROM m WHERE segment IS NOT NULL GROUP BY segment) s) AS segment,
      (SELECT COALESCE(json_object_agg(account_status, n), '{}'::json) FROM (
         SELECT account_status, count(*)::int AS n FROM m GROUP BY account_status) s) AS account_status,
      (SELECT COALESCE(json_object_agg(sales_stage, n), '{}'::json) FROM (
         SELECT sales_stage, count(*)::int AS n FROM m GROUP BY sales_stage) s) AS stages,
      (SELECT COALESCE(json_object_agg(f, n), '{}'::json) FROM (
         SELECT f, count(*)::int AS n FROM x WHERE f NOT LIKE '%?=true' GROUP BY f) t) AS tags,
      (SELECT COALESCE(json_object_agg(k, n), '{}'::json) FROM (
         SELECT regexp_replace(f, '^(service|specialty):([^=]+)\\?=true$', '\\2') AS k, count(DISTINCT id)::int AS n
         FROM x WHERE f LIKE '%?=true' GROUP BY 1) t) AS services,
      (SELECT COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name, 'n', k.n)), '[]'::json) FROM (
         SELECT cct.tag_id, count(*)::int AS n FROM company_custom_tags cct JOIN m ON m.id = cct.company_id
         GROUP BY cct.tag_id) k JOIN custom_tags t ON t.id = k.tag_id) AS custom_tags`;
}

const sorted = (counts: [string, number][]): FacetCount[] =>
  counts.filter(([, n]) => n > 0)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

export function toFacets(doc: FacetsDoc | undefined): LeadFacetsResponse {
  const tags = Object.entries(doc?.tags ?? {});
  const services = sorted(Object.entries(doc?.services ?? {}));
  return {
    total: doc?.total ?? 0,
    segment: sorted(Object.entries(doc?.segment ?? {})),
    size: sorted(tags.filter(([f]) => f.startsWith('size=')).map(([f, n]) => [f.slice('size='.length), n])),
    certifications: sorted([
      ...tags.flatMap(([f, n]): [string, number][] => {
        const [key, level] = [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)];
        return key.endsWith('_tier') && level !== 'none' ? [[`${key.slice(0, -'_tier'.length)}:${level}`, n]] : [];
      }),
      ...Object.entries(doc?.none ?? {}).map(([source, n]): [string, number] => [`${source}:none`, n]),
    ]),
    services,
    materials: services.filter((s) => MATERIAL_KEYS.has(s.value)),
    customTags: (doc?.custom_tags ?? []).filter((t) => t.n > 0)
      .map((t) => ({ id: t.id, value: t.name, count: t.n }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    accountStatus: sorted(Object.entries(doc?.account_status ?? {})),
    stages: SALES_STAGES.map((value) => ({ value, count: doc?.stages?.[value] ?? 0 })),
  };
}

/** Cached for the list TTL; right after the user's own write, read from the primary and not from the cache. */
export async function getFacets(
  db: Db, cache: Cache, filter: LeadFilter, viewer: Viewer, ttlSeconds: number,
): Promise<{ result: LeadFacetsResponse; cache: 'hit' | 'miss' | 'bypass' }> {
  const [fresh, version] = await Promise.all([cache.recentlyWrote(viewer.id), cache.listVersion(viewer)]);
  const key = version === null ? null : leadFacetsKey(viewer, version, filter);
  if (key && !fresh) {
    const hit = await cache.getJson<LeadFacetsResponse>(key);
    if (hit) return { result: hit, cache: 'hit' };
  }
  const center = filter.near ? await zipCentroid(db, filter.near.zip, viewer) : undefined;
  const result = toFacets(await one<FacetsDoc>(pick(db, fresh), facetsQuery(filter, viewer, center)));
  if (key) await cache.setJson(key, result, ttlSeconds);
  return { result, cache: fresh ? 'bypass' : 'miss' };
}
