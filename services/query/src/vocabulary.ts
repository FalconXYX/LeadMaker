// GET /filter-vocabulary: the values the AI filter tool may put in a LeadFilter for this viewer (FilterVocabulary):
// the counties of the leads they can see, the most used custom tags and custom field keys, and (managers) the reps.
// Cached per rep, or once for all managers (they see the same leads), for FILTER_VOCABULARY_TTL_SECONDS; a user's
// own write (read-your-writes) reads fresh from the primary, uncached.
import {
  cacheKeys, countyName, FILTER_VOCABULARY_TTL_SECONDS, isManager, sql, visibilitySql, type FilterVocabulary, type Viewer,
} from '@leadmaker/shared';
import { listUsers } from './admin.ts';
import type { Cache } from './cache.ts';
import { listCustomFieldKeys, listCustomTags } from './catalog.ts';
import { pick, rows, type Db } from './db.ts';

export const VOCAB_CUSTOM_TAGS = 50;
export const VOCAB_CUSTOM_FIELD_KEYS = 30;

export function countiesQuery(viewer: Viewer) {
  return sql`
    SELECT c.county_fips, count(*)::int AS lead_count FROM companies c
    WHERE ${visibilitySql(viewer, 'view', 'c')} AND c.county_fips IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC, 1`;
}

export function vocabularyKey(viewer: Viewer): string {
  return cacheKeys.filterVocabulary(isManager(viewer) ? 'mgr' : viewer.id);
}

/**
 * fast: custom tags and reps; scan: the counties and custom-field-key scans over the visible leads (a search slot,
 * like GET /custom-fields/keys).
 */
export async function getFilterVocabulary(
  dbs: { fast: Db; scan: Db }, cache: Cache, viewer: Viewer,
): Promise<{ result: FilterVocabulary; cache: 'hit' | 'miss' | 'bypass' }> {
  const primary = await cache.recentlyWrote(viewer.id);
  const key = vocabularyKey(viewer);
  if (!primary) {
    const cached = await cache.getJson<FilterVocabulary>(key);
    if (cached) return { result: cached, cache: 'hit' };
  }
  const [counties, tags, keys, reps] = await Promise.all([
    rows<{ county_fips: string; lead_count: number }>(pick(dbs.scan, primary), countiesQuery(viewer)),
    listCustomTags(dbs.fast, viewer, primary),
    listCustomFieldKeys(dbs.scan, viewer, primary),
    isManager(viewer) ? listUsers(dbs.fast, 'rep') : Promise.resolve([]),
  ]);
  const result: FilterVocabulary = {
    counties: counties.map((c) => ({ fips: c.county_fips, name: countyName(c.county_fips), leadCount: c.lead_count })),
    // Most used first; tags on no visible lead stay listed after them, so naming one filters to nothing
    // instead of failing as unknown.
    customTags: [...tags]
      .sort((a, b) => b.leadCount - a.leadCount || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
      .slice(0, VOCAB_CUSTOM_TAGS)
      .map((t) => ({ id: t.id, name: t.name, leadCount: t.leadCount })),
    customFieldKeys: keys.slice(0, VOCAB_CUSTOM_FIELD_KEYS).map((k) => ({ key: k.key, valueType: k.valueType })),
    reps: reps.map((u) => ({ id: u.id, name: u.name })),
    generatedAt: new Date().toISOString(),
  };
  if (!primary) await cache.setJson(key, result, FILTER_VOCABULARY_TTL_SECONDS);
  return { result, cache: primary ? 'bypass' : 'miss' };
}
