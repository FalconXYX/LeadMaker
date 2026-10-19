import type { LeadFilter } from '@/api/types';
import { SEGMENT_LABELS, SORT_LABELS } from '@/lib/labels';
import { countyPlace } from '@/lib/counties';
import type { QueueState, QueueUpdate } from './params';

/** System tags worth slicing the pool by (LeadFilter.tagsAll refs). */
export const TAG_OPTIONS = [
  { ref: 'work_type:storm_emergency', label: 'Storm / emergency work' },
  { ref: 'storm_insurance', label: 'Insurance claims' },
  { ref: 'gaf_tier=master_elite', label: 'GAF Master Elite' },
  { ref: 'gaf_tier=certified_plus', label: 'GAF Certified Plus' },
  { ref: 'decision_maker=identified', label: 'Decision-maker identified' },
  { ref: 'direct_email', label: 'Direct email found' },
  { ref: 'recent_reviews', label: 'Reviewed in last 6 months' },
  { ref: 'service:commercial_roofing', label: 'Commercial roofing' },
  { ref: 'service:roof_repair', label: 'Roof repair' },
  { ref: 'service:metal_roofing', label: 'Metal roofing' },
  { ref: 'offers_financing', label: 'Offers financing' },
  { ref: 'multi_trade', label: 'Multi-trade contractor' },
] as const;

export const tagLabel = (ref: string) => TAG_OPTIONS.find((t) => t.ref === ref)?.label ?? ref;

export const PRIORITY_FLOORS = [40, 50, 60, 70, 80] as const;
export const RADIUS_OPTIONS = [1, 3, 5, 10, 25] as const;

export const SORT_OPTIONS: { value: string; label: string; sort: NonNullable<LeadFilter['sort']> }[] = [
  { value: 'priority_score:desc', label: 'Highest priority', sort: { by: 'priority_score', dir: 'desc' } },
  { value: 'priority_score:asc', label: 'Lowest priority', sort: { by: 'priority_score', dir: 'asc' } },
  { value: 'last_change:desc', label: 'Recently changed', sort: { by: 'last_change', dir: 'desc' } },
  { value: 'rating:desc', label: `${SORT_LABELS.rating} (high first)`, sort: { by: 'rating', dir: 'desc' } },
  { value: 'review_count:desc', label: 'Most reviews', sort: { by: 'review_count', dir: 'desc' } },
  { value: 'years_in_business:desc', label: 'Longest in business', sort: { by: 'years_in_business', dir: 'desc' } },
];

export interface ActiveChip {
  key: string;
  /** "Segment", "County", ...: shown muted before the value, as in the lead list. */
  facet?: string;
  label: string;
  /** Applying this patch removes the facet value. */
  remove: QueueUpdate;
}

/** Removable chips for every active facet value, in a stable order. */
export function activeChips(s: QueueState): ActiveChip[] {
  const f = s.filter;
  const chips: ActiveChip[] = [];
  if (f.text) chips.push({ key: 'text', facet: 'Name', label: `“${f.text}”`, remove: { filter: { text: undefined } } });
  for (const seg of f.segment ?? []) {
    const rest = (f.segment ?? []).filter((x) => x !== seg);
    chips.push({ key: `seg:${seg}`, facet: 'Segment', label: SEGMENT_LABELS[seg], remove: { filter: { segment: rest.length ? rest : undefined } } });
  }
  for (const c of s.counties) {
    chips.push({ key: `county:${c}`, facet: 'County', label: countyPlace(c), remove: { counties: s.counties.filter((x) => x !== c) } });
  }
  if (f.near) {
    chips.push({ key: 'near', facet: 'Near', label: `${f.near.zip} · ${f.near.radiusMiles} mi`, remove: { filter: { near: undefined, sort: f.sort?.by === 'distance' ? undefined : f.sort } } });
  }
  for (const t of f.tagsAll ?? []) {
    const rest = (f.tagsAll ?? []).filter((x) => x !== t);
    chips.push({ key: `tag:${t}`, facet: 'Tag', label: tagLabel(t), remove: { filter: { tagsAll: rest.length ? rest : undefined } } });
  }
  if (s.minPriority !== null) chips.push({ key: 'minPriority', facet: 'Priority', label: `${s.minPriority}+`, remove: { minPriority: null } });
  if (f.updatedInLastPoll) chips.push({ key: 'lastPoll', facet: 'Updated', label: 'in last poll', remove: { filter: { updatedInLastPoll: undefined } } });
  return chips;
}

/** "Segment: Growth", for summaries (the assign dialog). */
export const chipText = (c: ActiveChip) => (c.facet ? `${c.facet}: ${c.label}` : c.label);

/** Clears every facet but keeps scope and sort. */
export function clearedFacets(s: QueueState): QueueState {
  return { scope: s.scope, filter: s.filter.sort ? { sort: s.filter.sort } : {}, counties: [], minPriority: null };
}
