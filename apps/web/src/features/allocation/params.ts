// Allocation queue state in the URL: the shared LeadFilter params (same names as /leads, so links from
// the leads list just work; ?new=1 is "updated in the last poll") plus two more, sent to the server as
// LeadFilter.counties and LeadFilter.minPriority:
//   ?county=36047&county=34003   county FIPS (any of)
//   ?minPriority=60              priority score floor
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { LeadFilter } from '@/api/types';
import { filterToSearchParams, searchParamsToFilter } from '@/lib/filterUrl';

export type QueueScope = 'unallocated' | { repId: string };

export interface QueueRefine {
  counties: string[];
  minPriority: number | null;
}

export interface QueueState extends QueueRefine {
  scope: QueueScope;
  /** Server-side facets (no scope, cursor or limit). */
  filter: LeadFilter;
}

export const DEFAULT_SORT = { by: 'priority_score', dir: 'desc' } as const;

export function scopeKey(scope: QueueScope): string {
  return typeof scope === 'string' ? scope : `rep:${scope.repId}`;
}

/** The LeadFilter for the queue as shown: facets, counties, priority floor and scope (no cursor or limit). */
export function queueFilter(s: QueueState): LeadFilter {
  return {
    ...s.filter,
    ...(s.counties.length ? { counties: s.counties } : {}),
    ...(s.minPriority !== null ? { minPriority: s.minPriority } : {}),
    scope: s.scope,
  };
}

/** Facets that narrow the queue (scope and sort excluded). */
export function activeFacetCount(s: QueueState): number {
  const f = s.filter;
  return (
    (f.text ? 1 : 0) + (f.segment?.length ? 1 : 0) + (f.tagsAll?.length ? 1 : 0) + (f.near ? 1 : 0)
    + (s.counties.length ? 1 : 0) + (s.minPriority !== null ? 1 : 0) + (f.updatedInLastPoll ? 1 : 0)
  );
}

export function parseQueue(p: URLSearchParams): QueueState {
  // counties / minPriority live beside the filter (their own chips); taken out in case the shared parser reads them too.
  const { scope, cursor: _c, limit: _l, counties: fromFilter, minPriority: minFromFilter, ...filter } = searchParamsToFilter(p);
  const counties = [...new Set([...p.getAll('county'), ...(fromFilter ?? [])].filter((c) => /^\d{5}$/.test(c)))];
  const min = p.has('minPriority') ? Number(p.get('minPriority')) : minFromFilter;
  return {
    scope: typeof scope === 'object' ? scope : 'unallocated',
    filter,
    counties,
    minPriority: typeof min === 'number' && Number.isFinite(min) && min > 0 && min <= 100 ? min : null,
  };
}

export function serializeQueue(s: QueueState): URLSearchParams {
  const p = filterToSearchParams({ ...s.filter, scope: typeof s.scope === 'object' ? s.scope : undefined });
  for (const c of s.counties) p.append('county', c);
  if (s.minPriority !== null) p.set('minPriority', String(s.minPriority));
  return p;
}

export type QueueUpdate = Partial<Omit<QueueState, 'filter'>> & { filter?: Partial<LeadFilter> };

/** const [state, update] = useQueueParams(); update({ filter: { segment: ['growth'] } }). */
export function useQueueParams(): [QueueState, (patch: QueueUpdate | ((s: QueueState) => QueueState), opts?: { replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const state = useMemo(() => parseQueue(params), [key]);
  const update = useCallback(
    (patch: QueueUpdate | ((s: QueueState) => QueueState), opts?: { replace?: boolean }) => {
      setParams((prev) => {
        const cur = parseQueue(prev);
        const next = typeof patch === 'function'
          ? patch(cur)
          : { ...cur, ...patch, filter: patch.filter ? { ...cur.filter, ...patch.filter } : cur.filter };
        return serializeQueue(next);
      }, { replace: opts?.replace, preventScrollReset: true });
    },
    [setParams],
  );
  return [state, update];
}
