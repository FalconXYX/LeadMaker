// The list's URL state: the shared LeadFilter (via useLeadFilterParams' format) plus one list-only flag,
// `alert=1` ("has a storm / severe-weather timing badge"), which LeadFilter cannot express. The shared
// setter rebuilds the query string from the filter alone and would drop the flag, so writes go through
// this wrapper, which keeps (or explicitly sets) it in the same history entry.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { LeadFilter } from '@/api/types';
import { filterToSearchParams as baseToParams, searchParamsToFilter as baseFromParams } from '@/lib/filterUrl';

export const ALERT_PARAM = 'alert';
/** The list's LeadFilter params are lib/filterUrl's (stage, followUp, notContactedSince, county, minPriority, sort). */
export const filterToSearchParams = baseToParams;
export const searchParamsToFilter = baseFromParams;

export interface SetFilterOptions {
  replace?: boolean;
  /** Set or clear the alert flag in the same navigation (default: keep it). */
  alert?: boolean;
}

export type FilterUpdate = Partial<LeadFilter> | ((prev: LeadFilter) => LeadFilter);

export type SetLeadFilter = (update: FilterUpdate, opts?: SetFilterOptions) => void;

export function useLeadsUrlState(): {
  filter: LeadFilter;
  setFilter: SetLeadFilter;
  alertOnly: boolean;
  setAlertOnly: (on: boolean) => void;
} {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const filter = useMemo(() => searchParamsToFilter(params), [key]);
  const alertOnly = params.get(ALERT_PARAM) === '1';

  const setFilter = useCallback<SetLeadFilter>((update, opts) => {
    setParams((prev) => {
      const current = searchParamsToFilter(prev);
      const next = typeof update === 'function' ? update(current) : { ...current, ...update };
      const out = filterToSearchParams(next);
      const keepAlert = opts?.alert ?? prev.get(ALERT_PARAM) === '1';
      if (keepAlert) out.set(ALERT_PARAM, '1');
      return out;
    }, { replace: opts?.replace });
  }, [setParams]);

  const setAlertOnly = useCallback((on: boolean) => setFilter((f) => f, { alert: on }), [setFilter]);

  return { filter, setFilter, alertOnly, setAlertOnly };
}

/** A URL query for a filter (+ flag), as saved views store it. */
export function viewQuery(filter: LeadFilter, alert = false): string {
  const p = filterToSearchParams(filter);
  if (alert) p.set(ALERT_PARAM, '1');
  return p.toString();
}

/** Order-insensitive comparison of two view queries. */
export function normalizeQuery(query: string): string {
  const p = new URLSearchParams(query);
  const filter = searchParamsToFilter(p);
  return viewQuery(normalizeFilter(filter), p.get(ALERT_PARAM) === '1')
    .split('&').filter(Boolean).sort().join('&');
}

function normalizeFilter(f: LeadFilter): LeadFilter {
  const out: LeadFilter = { ...f };
  for (const k of ['tagsAll', 'tagsAny', 'customTags', 'certifications', 'materials', 'services', 'segment', 'size', 'accountStatus', 'counties', 'stages'] as const) {
    const v = out[k] as string[] | undefined;
    if (v) (out as Record<string, unknown>)[k] = [...v].sort();
  }
  return out;
}
