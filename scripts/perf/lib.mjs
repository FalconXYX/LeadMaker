// Shared by synth/explain/load: deterministic ids (same formula as synth.mjs pg_temp.uid) and the filter mix.
import { createHash } from 'node:crypto';

export const DEFAULT_DB_URL = 'postgres://leadmaker:leadmaker@localhost:55432/leadmaker_perf';

export function uid(seed) {
  const h = createHash('md5').update(seed).digest('hex').split('');
  h[12] = '4';
  h[16] = '8';
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const managerEmail = (i) => `manager${String(i).padStart(4, '0')}@perf.local`;
export const repEmail = (i) => `rep${String(i).padStart(4, '0')}@perf.local`;
export const repId = (i, managers = 200) => uid(`u${managers + i}`);
export const companyId = (n) => uid(`c${n}`);

const ZIPS = ['10001', '11201', '10458', '11375', '10301', '07030', '07601', '07102', '06901', '06511', '11550', '10601', '12207', '08540'];
const TEXT = ['summit', 'apex', 'roof', 'empire', 'hudson', 'pro', 'liberty', 'garden'];
const SERVICES = ['metal_roofing', 'flat_roofing', 'storm_damage', 'gutters', 'commercial_roofing', 'slate_roofing'];
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];

/** Named LeadFilter generators. `who` is 'rep' | 'manager' (manager-only scopes are only used for managers). */
export const FILTERS = {
  default: () => ({}),
  mine: () => ({ scope: 'mine' }),
  unallocated_tags: (rnd) => ({ scope: 'unallocated', tagsAll: [`service:${pick(rnd, SERVICES)}`], size: ['medium', 'large'] }),
  cert_segment_rating: () => ({ certifications: ['gaf:master_elite', 'gaf:certified_plus'], segment: ['strategic', 'growth'], minRating: 4.5 }),
  near_distance: (rnd) => ({ near: { zip: pick(rnd, ZIPS), radiusMiles: 10 }, sort: { by: 'distance', dir: 'asc' } }),
  near_storm: (rnd) => ({ near: { zip: pick(rnd, ZIPS), radiusMiles: 25 }, tagsAny: ['work_type:storm_emergency', 'service:storm_damage'] }),
  text: (rnd) => ({ text: pick(rnd, TEXT) }),
  unchecked_team: () => ({ unchecked: 'team', unserviced: 'team', updatedSince: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) }),
  unchecked_me: () => ({ unchecked: 'me', scope: 'mine' }),
  custom: () => ({ customFields: [{ key: 'preferred_supplier', op: 'eq', value: 'Beacon' }] }),
  years_sort: () => ({ minYearsInBusiness: 20, sort: { by: 'years_in_business', dir: 'desc' } }),
  scope_all: () => ({ scope: 'all', segment: ['strategic'] }),
};

/** Search mix weights by role (reps mostly look at their own list; managers browse wider). */
export const SEARCH_MIX = {
  rep: [['default', 20], ['mine', 25], ['unallocated_tags', 10], ['cert_segment_rating', 8], ['near_distance', 10],
    ['near_storm', 6], ['text', 8], ['unchecked_me', 8], ['custom', 3], ['years_sort', 2]],
  manager: [['default', 15], ['scope_all', 15], ['unallocated_tags', 10], ['cert_segment_rating', 10], ['near_distance', 10],
    ['near_storm', 8], ['text', 10], ['unchecked_team', 12], ['custom', 5], ['years_sort', 5]],
};

export function weighted(rnd, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [k, w] of pairs) if ((x -= w) < 0) return k;
  return pairs.at(-1)[0];
}

/** Small seeded PRNG (mulberry32) so runs are reproducible. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
