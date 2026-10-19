// Redis keys shared by query (reads/fills), crm-write (read-your-writes flag) and relay (invalidation).
import { createHash } from 'node:crypto';
import type { LeadFilter } from './filter.ts';
import type { Viewer } from './visibility.ts';

/** Stable JSON: object keys sorted, undefined dropped, so equal filters hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export const KPI_TEAM_KEY = 'kpi:team';

export const cacheKeys = {
  /** Immutable per version: the version-bound part of a lead profile. */
  leadProfile: (companyId: string, version: number) => `lead:${companyId}:v${version}`,
  /**
   * List-cache version counters, INCRed by the relay's invalidation consumer: 'all' on any lead change,
   * 'pool' when an unallocated lead changes, joins or leaves the pool, 'rep:{id}' when one of that rep's
   * leads does (or is allocated away). List keys embed the counters their viewer depends on
   * (listVersionKeys), so a bump orphans exactly those cached lists.
   */
  leadsVersionAll: 'leads:v:all',
  leadsVersionPool: 'leads:v:pool',
  leadsVersionRep: (repId: string) => `leads:v:rep:${repId}`,
  leadList: (userId: string, version: number | string, filter: unknown) =>
    `leads:q:${userId}:${version}:${sha1(canonicalJson(filter))}`,
  /** One entry for all managers (they see the same leads); see leadListKey. */
  leadListShared: (version: number | string, filter: unknown) =>
    `leads:q:mgr:${version}:${sha1(canonicalJson(filter))}`,
  /** POST /leads/facets, versioned like the lists (leadFacetsKey). */
  leadFacets: (subject: string, version: number | string, filter: unknown) =>
    `leads:facets:${subject}:${version}:${sha1(canonicalJson(filter))}`,
  /** GET /leads/map for a scope, versioned like the lists; `subject` is the user id, or 'mgr' (shared by managers). */
  leadMap: (subject: string, version: number | string, scope: string) => `leads:map:${subject}:${version}:${scope}`,
  kpiRep: (userId: string) => `kpi:rep:${userId}`,
  kpiTeam: KPI_TEAM_KEY,
  /** Set by crm-write after a user's write; while present, query serves that user from the primary, uncached. */
  readYourWrites: (userId: string) => `rw:${userId}`,
  /** GET /signals for a scope; `subject` is the user id, or 'shared' when every caller gets the same answer. */
  signals: (subject: string, scope: string) => `signals:${subject}:${scope}`,
  /** The gateway's copy of users.role ('none' once the user is gone). */
  userRole: (userId: string) => `user:${userId}:role`,
  /**
   * GET /filter-vocabulary (the AI filter tool's values): per rep, or 'mgr' (shared by managers). TTL only: counties,
   * custom tags and field keys drift slowly, and a value missing for 5 minutes only makes the tool say it can't filter.
   */
  filterVocabulary: (subject: string) => `vocab:${subject}`,
  /**
   * GET /territory-brief for one brief scope ('team' | 'rep:<id>'), before the per-viewer visibility filter of its
   * leads; shared by everyone allowed that scope. TTL only: the worker rewrites briefs, with no outbox event.
   */
  territoryBrief: (scope: string) => `brief:${scope}`,
} as const;

/** The version counters a viewer's lists depend on: every lead for managers; a rep's own leads and the pool. */
export function listVersionKeys(viewer: Viewer): string[] {
  return viewer.role === 'manager'
    ? [cacheKeys.leadsVersionAll]
    : [cacheKeys.leadsVersionRep(viewer.id), cacheKeys.leadsVersionPool];
}

/** The version part of a list key from the counters' values (listVersionKeys order; missing = 0). */
export function listVersion(values: readonly (string | number | null | undefined)[]): string {
  return values.map((v) => v ?? 0).join('.');
}

/** The filter's leads depend on who asks ("mine", or my checked/serviced state). */
export function filterIsPersonal(filter: LeadFilter): boolean {
  return filter.scope === 'mine' || filter.unchecked === 'me' || filter.unserviced === 'me';
}

/** List cache key: per user for reps; shared by managers unless the filter is personal. */
export function leadListKey(viewer: Viewer, version: number | string, filter: LeadFilter): string {
  return viewer.role === 'manager' && !filterIsPersonal(filter)
    ? cacheKeys.leadListShared(version, filter)
    : cacheKeys.leadList(viewer.id, version, filter);
}

/** Facet counts cache key: as leadListKey, without the page fields (cursor, limit, sort). */
export function leadFacetsKey(viewer: Viewer, version: number | string, filter: LeadFilter): string {
  const { cursor: _cursor, limit: _limit, sort: _sort, ...rest } = filter;
  return cacheKeys.leadFacets(viewer.role === 'manager' && !filterIsPersonal(filter) ? 'mgr' : viewer.id, version, rest);
}

export const READ_YOUR_WRITES_TTL_SECONDS = 5;
export const LEAD_LIST_TTL_SECONDS = 60;
export const LEAD_PROFILE_TTL_SECONDS = 24 * 3600;
export const KPI_TTL_SECONDS = 300;
export const SIGNALS_TTL_SECONDS = 60;
export const FILTER_VOCABULARY_TTL_SECONDS = 300;
export const TERRITORY_BRIEF_TTL_SECONDS = 60;
/** How long a demoted or deleted user keeps their old access at most. */
export const USER_ROLE_TTL_SECONDS = 30;
