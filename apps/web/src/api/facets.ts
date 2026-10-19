// Facet counts for filter panels (POST /api/leads/facets), disjunctive: a facet's own selection is left out
// when counting its options, so picking "Growth" still shows how many "Strategic" leads there are (values
// inside one facet are OR'ed). One request for the filter, plus one per facet that has a selection.
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as ep from './endpoints';
import { qk } from './queries';
import type { FacetCount, LeadFacetsResponse, LeadFilter } from './types';

export type FacetKey = 'segment' | 'size' | 'certifications' | 'materials' | 'services' | 'customTags' | 'accountStatus';

const FACETS: readonly FacetKey[] = ['segment', 'size', 'certifications', 'materials', 'services', 'customTags', 'accountStatus'];

export interface FacetCounts {
  /** The count for one option; undefined while loading or when counts are unavailable. */
  count: (facet: FacetKey, value: string) => number | undefined;
  /** Matching leads for the whole filter. */
  total: number | undefined;
  /** Counts arrived (at least once). */
  ready: boolean;
}

function pageless(filter: LeadFilter): LeadFilter {
  const { cursor: _c, limit: _l, sort: _s, ...rest } = filter;
  return rest;
}

function lookup(list: FacetCount[] | undefined, value: string, facet: FacetKey): number {
  if (!Array.isArray(list)) return 0;
  const v = value.toLowerCase();
  const hit = list.find((f) => f.value === value
    || (facet === 'customTags' && (f.value.toLowerCase() === v || (f as FacetCount & { id?: string }).id === value)));
  return hit?.count ?? 0;
}

export function useFacetCounts(filter: LeadFilter, opts: { enabled?: boolean; facets?: readonly FacetKey[] } = {}): FacetCounts {
  const base = useMemo(() => pageless(filter), [filter]);
  const wanted = (opts.facets ?? FACETS).join(',');
  const filters = useMemo(() => {
    const out: { key: FacetKey | 'base'; filter: LeadFilter }[] = [{ key: 'base', filter: base }];
    for (const k of wanted.split(',') as FacetKey[]) {
      if (!((base[k] as unknown[] | undefined)?.length)) continue;
      const { [k]: _drop, ...rest } = base;
      out.push({ key: k, filter: rest });
    }
    return out;
  }, [base, wanted]);
  const results = useQueries({
    queries: filters.map((f) => ({
      queryKey: qk.leads.facets(f.filter),
      queryFn: ({ signal }: { signal: AbortSignal }) => ep.getLeadFacets(f.filter, { signal }),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      enabled: opts.enabled ?? true,
      retry: false,
    })),
  });
  return useMemo(() => {
    const byKey = new Map<FacetKey | 'base', LeadFacetsResponse | undefined>();
    // A body without a total is not a facet response (an older server, an error page): no counts then.
    filters.forEach((f, i) => {
      const d = results[i]?.data;
      byKey.set(f.key, d && typeof d.total === 'number' ? d : undefined);
    });
    const baseData = byKey.get('base');
    return {
      total: baseData?.total,
      ready: !!baseData,
      count: (facet, value) => {
        const data = byKey.has(facet) ? byKey.get(facet) : baseData;
        return data && baseData ? lookup(data[facet], value, facet) : undefined;
      },
    };
  }, [filters, results]);
}
