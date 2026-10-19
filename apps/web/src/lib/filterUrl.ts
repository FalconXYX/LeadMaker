// LeadFilter <-> URL query string, so list views are shareable, bookmarkable and survive reload.
// Arrays are repeated keys (?segment=strategic&segment=growth). `cursor` and `limit` never go in the URL.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { CustomFieldCondition, LeadFilter, SortField } from '@/api/types';
import { ACCOUNT_STATUSES, FOLLOW_UPS, SALES_STAGES, SEGMENTS, SIZES, SORT_FIELDS } from './labels';

const ARRAY_PARAMS = {
  tag: 'tagsAll',
  anyTag: 'tagsAny',
  ctag: 'customTags',
  cert: 'certifications',
  material: 'materials',
  service: 'services',
} as const satisfies Record<string, keyof LeadFilter>;

const CF_OPS = ['eq', 'gte', 'lte', 'contains', 'exists'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIPS = /^\d{5}$/;

export function filterToSearchParams(filter: LeadFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.text) p.set('q', filter.text);
  if (filter.scope) p.set('scope', typeof filter.scope === 'string' ? filter.scope : `rep:${filter.scope.repId}`);
  for (const [param, key] of Object.entries(ARRAY_PARAMS)) {
    for (const v of (filter[key] as string[] | undefined) ?? []) p.append(param, v);
  }
  for (const v of filter.segment ?? []) p.append('segment', v);
  for (const v of filter.size ?? []) p.append('size', v);
  for (const v of filter.accountStatus ?? []) p.append('status', v);
  for (const v of filter.stages ?? []) p.append('stage', v);
  for (const v of filter.counties ?? []) p.append('county', v);
  for (const c of filter.customFields ?? []) p.append('cf', encodeCustomField(c));
  if (filter.followUp) p.set('followUp', filter.followUp);
  if (filter.notContactedSince) p.set('notContactedSince', filter.notContactedSince);
  if (filter.minPriority !== undefined) p.set('minPriority', String(filter.minPriority));
  if (filter.minRating !== undefined) p.set('minRating', String(filter.minRating));
  if (filter.minYearsInBusiness !== undefined) p.set('minYears', String(filter.minYearsInBusiness));
  if (filter.near) {
    p.set('zip', filter.near.zip);
    p.set('radius', String(filter.near.radiusMiles));
  }
  if (filter.unchecked) p.set('unchecked', filter.unchecked);
  if (filter.unserviced) p.set('unserviced', filter.unserviced);
  if (filter.updatedSince) p.set('since', filter.updatedSince);
  // Only "updated in the last poll" is linkable (the API's false, "not updated", has no list use).
  if (filter.updatedInLastPoll) p.set('new', '1');
  if (filter.sort) p.set('sort', `${filter.sort.by}:${filter.sort.dir}`);
  return p;
}

/** Lenient: unknown or malformed params are dropped, never thrown. */
export function searchParamsToFilter(p: URLSearchParams): LeadFilter {
  const f: LeadFilter = {};
  const text = p.get('q')?.trim();
  if (text) f.text = text.slice(0, 200);

  const scope = p.get('scope');
  if (scope === 'mine' || scope === 'unallocated' || scope === 'all') f.scope = scope;
  else if (scope?.startsWith('rep:') && UUID.test(scope.slice(4))) f.scope = { repId: scope.slice(4) };

  for (const [param, key] of Object.entries(ARRAY_PARAMS)) {
    const values = uniq(p.getAll(param).filter(Boolean));
    if (values.length) (f as Record<string, unknown>)[key] = values;
  }
  const segment = oneOf(p.getAll('segment'), SEGMENTS);
  if (segment.length) f.segment = segment;
  const size = oneOf(p.getAll('size'), SIZES);
  if (size.length) f.size = size;
  const status = oneOf(p.getAll('status'), ACCOUNT_STATUSES);
  if (status.length) f.accountStatus = status;
  const stages = oneOf(p.getAll('stage'), SALES_STAGES);
  if (stages.length) f.stages = stages;
  const counties = uniq(p.getAll('county').filter((c) => FIPS.test(c))).slice(0, 100);
  if (counties.length) f.counties = counties;
  const followUp = oneOf([p.get('followUp') ?? ''], FOLLOW_UPS)[0];
  if (followUp) f.followUp = followUp;
  const notContactedSince = p.get('notContactedSince');
  if (notContactedSince && !Number.isNaN(Date.parse(notContactedSince))) f.notContactedSince = notContactedSince;
  const minPriority = num(p.get('minPriority'));
  if (minPriority !== undefined && minPriority >= 0 && minPriority <= 100) f.minPriority = minPriority;
  const cfs = p.getAll('cf').map(decodeCustomField).filter((c): c is CustomFieldCondition => c !== null);
  if (cfs.length) f.customFields = cfs;

  const minRating = num(p.get('minRating'));
  if (minRating !== undefined && minRating >= 0 && minRating <= 5) f.minRating = minRating;
  const minYears = num(p.get('minYears'));
  if (minYears !== undefined && Number.isInteger(minYears) && minYears >= 0) f.minYearsInBusiness = minYears;
  const zip = p.get('zip');
  const radius = num(p.get('radius'));
  if (zip && /^\d{5}$/.test(zip) && radius !== undefined && radius > 0 && radius <= 250) {
    f.near = { zip, radiusMiles: radius };
  }
  const unchecked = p.get('unchecked');
  if (unchecked === 'me' || unchecked === 'team') f.unchecked = unchecked;
  const unserviced = p.get('unserviced');
  if (unserviced === 'me' || unserviced === 'team') f.unserviced = unserviced;
  const since = p.get('since');
  if (since && !Number.isNaN(Date.parse(since))) f.updatedSince = since;
  if (p.get('new') === '1') f.updatedInLastPoll = true;

  const [by, dir] = (p.get('sort') ?? '').split(':');
  if ((SORT_FIELDS as readonly string[]).includes(by ?? '') && (dir === 'asc' || dir === 'desc')) {
    if (by !== 'distance' || f.near) f.sort = { by: by as SortField, dir };
  }
  return f;
}

/** key:op[:value]; value is JSON when it parses as a number/boolean, else a raw string. */
function encodeCustomField(c: CustomFieldCondition): string {
  const key = encodeURIComponent(c.key);
  if (c.op === 'exists' || c.value === undefined) return `${key}:${c.op}`;
  return `${key}:${c.op}:${typeof c.value === 'string' ? c.value : JSON.stringify(c.value)}`;
}

function decodeCustomField(s: string): CustomFieldCondition | null {
  const [rawKey, op, ...rest] = s.split(':');
  if (!rawKey || !(CF_OPS as readonly string[]).includes(op ?? '')) return null;
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return null;
  }
  const typedOp = op as CustomFieldCondition['op'];
  if (typedOp === 'exists') return { key, op: typedOp };
  const raw = rest.join(':');
  if (!raw) return null;
  let value: string | number | boolean = raw;
  if (raw === 'true' || raw === 'false') value = raw === 'true';
  else if (typedOp !== 'contains' && raw.trim() !== '' && Number.isFinite(Number(raw))) value = Number(raw);
  return { key, op: typedOp, value };
}

function oneOf<T extends string>(values: string[], allowed: readonly T[]): T[] {
  return uniq(values.filter((v): v is T => (allowed as readonly string[]).includes(v)));
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Active facet count, for a "Filters (3)" button. Text, scope and sort are not counted. */
export function countActiveFilters(f: LeadFilter): number {
  const { text: _t, scope: _s, sort: _o, cursor: _c, limit: _l, ...rest } = f;
  return Object.values(rest).filter((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined)).length;
}

export type FilterUpdate = Partial<LeadFilter> | ((prev: LeadFilter) => LeadFilter);

/**
 * The lead list filter, read from and written to the URL.
 *   const [filter, setFilter] = useLeadFilterParams();
 *   setFilter({ segment: ['strategic'] });          // merge (undefined clears a key)
 *   setFilter((f) => ({ ...f, text: undefined }));   // replace via updater
 * Typing-heavy inputs (search box) should pass { replace: true } to avoid flooding history.
 */
export function useLeadFilterParams(): [LeadFilter, (update: FilterUpdate, opts?: { replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const filter = useMemo(() => searchParamsToFilter(params), [key]);
  const setFilter = useCallback(
    (update: FilterUpdate, opts?: { replace?: boolean }) => {
      setParams((prev) => {
        const current = searchParamsToFilter(prev);
        const next = typeof update === 'function' ? update(current) : { ...current, ...update };
        return filterToSearchParams(next);
      }, { replace: opts?.replace });
    },
    [setParams],
  );
  return [filter, setFilter];
}

/** Link target for "show these leads": `/leads?${leadsSearch({ unchecked: 'me' })}`. */
export function leadsHref(filter: LeadFilter): string {
  const qs = filterToSearchParams(filter).toString();
  return qs ? `/leads?${qs}` : '/leads';
}
