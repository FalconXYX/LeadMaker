// LeadFilter -> SQL conditions over companies (alias c), shared by the list (query service) and bulk
// allocation by filter (crm-write), so both select exactly the same leads. Every user value is bound.
import { readFileSync } from 'node:fs';
import { parseTagRef, TAG_KEY, type CustomFieldCondition, type LeadFilter } from './filter.ts';
import { isUuid } from './internal-auth.ts';
import { followUpCondition, notContactedSinceCondition } from './sales.ts';
import { join, raw, sql, type Sql } from './sql.ts';
import { visibilitySql, type Viewer } from './visibility.ts';

export const METERS_PER_MILE = 1609.344;

/** A filter the caller may not use (403) or that cannot be evaluated (400). */
export class FilterError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

const TRUE = raw('TRUE');
const TAGS = raw('c.system_tags');
// Stored generated columns (db/migrations/20261018220000_search_performance.sql).
const FACETS = raw('c.tag_facets');

/** Oldest credible founding year: the pipeline's scraped value, else the maturity tag's year, else GAF's. */
export const FOUNDED_YEAR = raw('c.founded_year');

/** When the lead last changed materially (or first appeared). */
export const LAST_CHANGE = raw('COALESCE(c.last_material_change_at, c.first_seen_at)');

export function and(parts: Sql[]): Sql {
  return parts.length ? sql`(${join(parts, ' AND ')})` : TRUE;
}

export function or(parts: Sql[]): Sql {
  return parts.length ? sql`(${join(parts, ' OR ')})` : raw('FALSE');
}

function contains(col: Sql, tags: Record<string, unknown>[]): Sql {
  return sql`${col} @> ${JSON.stringify(tags)}::jsonb`;
}

/** The lead has every / at least one of these tag_facets strings (see system_tag_facets in the migration). */
function facetsAll(facets: string[]): Sql {
  return sql`${FACETS} @> ${facets}::text[]`;
}

function facetsAny(facets: string[]): Sql {
  return sql`${FACETS} && ${facets}::text[]`;
}

// system_tag_facets leaves out longer keys and values (characters), so a GIN key stays under about 2.7 KB.
const FACET_KEY_MAX = 200;
const FACET_VALUE_MAX = 500;
const indexedKey = (key: string) => TAG_KEY.test(key) && key.length <= FACET_KEY_MAX;
const indexedValue = (value: string) => [...value].length <= FACET_VALUE_MAX;

/** "key": a tag with that key whose value is not false. "key=value": that exact value (string, number,
 *  boolean, or an element of an array value). Keys outside TAG_KEY, and over-long keys or values, are
 *  not in tag_facets. */
export function tagCondition(ref: string): Sql {
  const { key, value } = parseTagRef(ref);
  if (!indexedKey(key) || (value !== undefined && !indexedValue(value))) return systemTagCondition(key, value);
  if (value === undefined) return facetsAll([key]);
  const facets = [`${key}=${value}`, `${key}[]=${value}`];
  if (value === 'true' || value === 'false') facets.push(`${key}?=${value}`);
  if (value.trim() !== '' && Number.isFinite(Number(value)))
    return sql`${FACETS} && array_append(${facets}::text[], ${`${key}#=`} || trim_scale(${JSON.stringify(Number(value))}::jsonb::numeric)::text)`;
  return facetsAny(facets);
}

/** tagCondition over the raw system_tags. */
function systemTagCondition(key: string, value: string | undefined): Sql {
  if (value === undefined) return sql`(${contains(TAGS, [{ key }])} AND NOT ${contains(TAGS, [{ key, value: false }])})`;
  const candidates: unknown[] = [value, [value]];
  if (value === 'true' || value === 'false') candidates.push(value === 'true');
  if (value.trim() !== '' && Number.isFinite(Number(value))) candidates.push(Number(value));
  return or(candidates.map((v) => contains(TAGS, [{ key, value: v }])));
}

/** "gaf:master_elite" -> gaf_tier tag = master_elite; "<source>:none" also matches leads without the tag. */
export function certificationCondition(cert: string): Sql {
  const [source, level] = cert.split(':');
  const key = `${source}_tier`;
  if (level === undefined || !indexedKey(key) || !indexedValue(level)) {
    const exact = contains(TAGS, [{ key, value: level }]);
    return level === 'none' ? sql`(${exact} OR NOT ${contains(TAGS, [{ key }])})` : exact;
  }
  const exact = facetsAll([`${key}=${level}`]);
  // A tag with the key exists: one not false ("key") or one false ("key?=false").
  return level === 'none' ? sql`(${exact} OR NOT ${facetsAny([key, `${key}?=false`])})` : exact;
}

function serviceCondition(keys: string[]): Sql {
  const tagKeys = keys.flatMap((k) => [`service:${k}`, `specialty:${k}`]);
  if (tagKeys.every(indexedKey)) return facetsAny(tagKeys.map((k) => `${k}?=true`));
  return or(tagKeys.map((key) => contains(TAGS, [{ key, value: true }])));
}

export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function customFieldCondition(f: CustomFieldCondition): Sql {
  const v = sql`(c.custom_fields -> ${f.key}::text)`;
  const t = sql`jsonb_typeof(${v})`;
  switch (f.op) {
    case 'exists':
      return sql`COALESCE(${t}, 'null') <> 'null'`;
    case 'eq':
      return sql`c.custom_fields @> jsonb_build_object(${f.key}::text, ${JSON.stringify(f.value)}::jsonb)`;
    case 'gte':
    case 'lte': {
      const op = raw(f.op === 'gte' ? '>=' : '<=');
      return typeof f.value === 'number'
        ? sql`(CASE WHEN ${t} = 'number' THEN (${v} #>> '{}')::numeric ${op} ${f.value}::numeric ELSE FALSE END)`
        : sql`(CASE WHEN ${t} = 'string' THEN (${v} #>> '{}') COLLATE "C" ${op} ${String(f.value)}::text COLLATE "C" ELSE FALSE END)`;
    }
    case 'contains': {
      const p = likePattern(String(f.value));
      return sql`(CASE ${t} WHEN 'string' THEN (${v} #>> '{}') ILIKE ${p}
        WHEN 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(${v}) e WHERE e ILIKE ${p})
        ELSE FALSE END)`;
    }
  }
}

export function customTagCondition(values: string[]): Sql {
  const ids = values.filter(isUuid).map((v) => v.toLowerCase());
  const names = values.map((v) => v.trim().toLowerCase());
  return sql`EXISTS (SELECT 1 FROM company_custom_tags cct JOIN custom_tags ct ON ct.id = cct.tag_id
    WHERE cct.company_id = c.id AND (ct.id = ANY(${ids}::uuid[]) OR lower(ct.name) = ANY(${names}::text[])))`;
}

export function scopeCondition(viewer: Viewer, scope: LeadFilter['scope']): Sql {
  if (scope === undefined) return TRUE;
  if (scope === 'mine') return sql`c.assigned_rep_id = ${viewer.id}::uuid`;
  if (scope === 'unallocated') return raw('c.assigned_rep_id IS NULL');
  const manager = viewer.role === 'manager';
  if (scope === 'all') {
    if (!manager) throw new FilterError(403, 'scope "all" is for managers');
    return TRUE;
  }
  if (!manager && scope.repId.toLowerCase() !== viewer.id) throw new FilterError(403, 'scope repId is for managers');
  return sql`c.assigned_rep_id = ${scope.repId}::uuid`;
}

export interface Point {
  lat: number;
  lng: number;
}

export function centerSql(center: Point): Sql {
  return sql`ST_SetSRID(ST_MakePoint(${center.lng}::float8, ${center.lat}::float8), 4326)::geography`;
}

const IS_UNCHECKED = (s: string) => raw(`(${s}.checked_at IS NULL OR ${s}.checked_at < c.last_material_change_at)`);

export interface FilterContext {
  viewer: Viewer;
  /** Centroid of filter.near.zip: zctaCentroid, else zipFallbackSql. Required when filter.near is set. */
  center?: Point;
}

/**
 * {lat, lng}: the mean location of the companies with this postal code that the viewer may see (so the answer
 * reveals nothing about the others), for ZIPs outside zcta-centroids.tsv. Without a viewer, unallocated ones only.
 */
export function zipFallbackSql(zip: string, viewer?: Viewer): Sql {
  const visible = viewer ? visibilitySql(viewer, 'view', 'c') : raw('c.assigned_rep_id IS NULL');
  return sql`SELECT avg(c.latitude) AS lat, avg(c.longitude) AS lng FROM companies c
    WHERE left(c.postal_code, 5) = ${zip} AND ${visible}`;
}

/**
 * The WHERE conditions of a LeadFilter, visibility first (AND them with `and`). When needsMyState(filter),
 * the statement must join the viewer's state as
 *   LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = <viewer id>
 */
export function filterConditions(filter: LeadFilter, ctx: FilterContext): Sql[] {
  const { viewer } = ctx;
  const where: Sql[] = [visibilitySql(viewer, 'view', 'c')];
  if (filter.scope !== undefined) where.push(scopeCondition(viewer, filter.scope));
  for (const ref of filter.tagsAll ?? []) where.push(tagCondition(ref));
  if (filter.tagsAny?.length) where.push(or(filter.tagsAny.map(tagCondition)));
  if (filter.customTags?.length) where.push(customTagCondition(filter.customTags));
  for (const f of filter.customFields ?? []) where.push(customFieldCondition(f));
  if (filter.certifications?.length) where.push(or(filter.certifications.map(certificationCondition)));
  if (filter.size?.length) {
    where.push(filter.size.every(indexedValue)
      ? facetsAny(filter.size.map((s) => `size=${s}`))
      : or(filter.size.map((s) => contains(TAGS, [{ key: 'size', value: s }]))));
  }
  if (filter.segment?.length) where.push(sql`c.segment = ANY(${filter.segment}::text[])`);
  if (filter.accountStatus?.length) where.push(sql`c.account_status = ANY(${filter.accountStatus}::text[])`);
  if (filter.stages?.length) where.push(sql`c.sales_stage = ANY(${filter.stages}::text[])`);
  if (filter.followUp) where.push(followUpCondition(filter.followUp));
  if (filter.notContactedSince) where.push(notContactedSinceCondition(filter.notContactedSince));
  if (filter.materials?.length) where.push(serviceCondition(filter.materials));
  if (filter.services?.length) where.push(serviceCondition(filter.services));
  if (filter.minRating !== undefined) where.push(sql`c.rating >= ${filter.minRating}::float8`);
  if (filter.minPriority !== undefined) where.push(sql`c.priority_score >= ${filter.minPriority}::numeric`);
  // bpchar[] like the column, so companies_county_fips_idx applies.
  if (filter.counties?.length) where.push(sql`c.county_fips = ANY(${filter.counties}::bpchar[])`);
  if (filter.minYearsInBusiness !== undefined)
    where.push(sql`${FOUNDED_YEAR} <= EXTRACT(YEAR FROM now())::int - ${filter.minYearsInBusiness}::int`);
  if (filter.near) {
    if (!ctx.center) throw new FilterError(400, `unknown ZIP code ${filter.near.zip}`);
    where.push(sql`ST_DWithin(c.location, ${centerSql(ctx.center)}, ${filter.near.radiusMiles * METERS_PER_MILE}::float8)`);
  }
  if (filter.unchecked === 'me') where.push(IS_UNCHECKED('ms'));
  if (filter.unchecked === 'team')
    where.push(raw('(c.team_last_checked_at IS NULL OR c.team_last_checked_at < c.last_material_change_at)'));
  if (filter.unserviced === 'me') where.push(raw('ms.serviced_at IS NULL'));
  if (filter.unserviced === 'team') where.push(raw('c.team_last_serviced_at IS NULL'));
  if (filter.updatedSince) where.push(sql`${LAST_CHANGE} >= ${filter.updatedSince}::timestamptz`);
  if (filter.updatedInLastPoll !== undefined) where.push(sql`c.updated_in_last_poll = ${filter.updatedInLastPoll}::boolean`);
  if (filter.text) {
    const p = likePattern(filter.text);
    where.push(sql`(c.business_name ILIKE ${p} OR c.dba ILIKE ${p} OR EXISTS (
      SELECT 1 FROM field_overrides o WHERE o.company_id = c.id AND o.contact_id IS NULL AND o.superseded_at IS NULL
        AND o.field = 'business_name' AND (o.value #>> '{}') ILIKE ${p}))`);
  }
  return where;
}

export function needsMyState(filter: LeadFilter): boolean {
  return filter.unchecked === 'me' || filter.unserviced === 'me';
}

let zcta: Map<string, Point> | undefined;

/** Census ZCTA internal point for ZIPs 00xxx-19xxx (data/zcta-centroids.tsv); undefined elsewhere. */
export function zctaCentroid(zip: string): Point | undefined {
  if (!zcta) {
    zcta = new Map();
    for (const line of readFileSync(new URL('../data/zcta-centroids.tsv', import.meta.url), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [z, lat, lng] = line.split('\t');
      zcta.set(z, { lat: Number(lat), lng: Number(lng) });
    }
  }
  return zcta.get(zip);
}
