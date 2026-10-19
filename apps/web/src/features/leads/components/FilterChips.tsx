// Active filters as removable chips above the list, with "Clear all". Scope (the view switch) and sort
// are not chips: they have their own controls.
import { CloudLightning } from 'lucide-react';
import type { LeadFilter } from '@/api/types';
import { ClearFiltersButton, FilterChip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyPlaceShort } from '@/lib/counties';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  ACCOUNT_STATUS_LABELS, CERTIFICATION_LABELS, SEGMENT_LABELS, SIZE_LABELS,
} from '@/lib/labels';
import { FOLLOW_UP_LABELS, STAGE_LABELS, notContactedDays, type SalesStage } from '../sales';
import { tagRefLabel, taxonomyLabel } from '../tags';
import type { SetLeadFilter } from '../useLeadsUrl';
import { describeCondition } from './FilterPanel';

export interface FilterChip {
  id: string;
  /** Facet name ("Segment"), shown muted before the value. */
  facet: string;
  label: string;
  remove: (f: LeadFilter) => LeadFilter;
  icon?: 'alert';
}

const without = <T,>(values: readonly T[] | undefined, v: T): T[] | undefined => {
  const next = (values ?? []).filter((x) => x !== v);
  return next.length ? next : undefined;
};

/** One chip per value (array facets) or per scalar facet. */
export function filterChips(f: LeadFilter): FilterChip[] {
  const chips: FilterChip[] = [];
  const each = <K extends keyof LeadFilter>(key: K, facet: string, label: (v: string) => string) => {
    for (const v of (f[key] as string[] | undefined) ?? []) {
      chips.push({ id: `${String(key)}:${v}`, facet, label: label(v), remove: (p) => ({ ...p, [key]: without(p[key] as string[] | undefined, v) }) });
    }
  };
  if (f.text) chips.push({ id: 'text', facet: 'Name', label: `“${f.text}”`, remove: (p) => ({ ...p, text: undefined }) });
  each('stages', 'Stage', (v) => STAGE_LABELS[v as SalesStage] ?? v);
  if (f.followUp) {
    chips.push({ id: 'followUp', facet: 'Follow-up', label: FOLLOW_UP_LABELS[f.followUp].toLowerCase(), remove: (p) => ({ ...p, followUp: undefined }) });
  }
  if (f.notContactedSince) {
    const days = notContactedDays(f.notContactedSince);
    const since = f.notContactedSince;
    chips.push({
      id: 'notContactedSince',
      facet: 'Not contacted',
      label: days ? `${days}+ days` : `since ${/^\d{4}-\d{2}-\d{2}$/.test(since) ? formatDate(`${since}T12:00:00`) : formatDate(since)}`,
      remove: (p) => ({ ...p, notContactedSince: undefined }),
    });
  }
  if (f.unserviced) {
    chips.push({ id: 'unserviced', facet: 'Never contacted', label: f.unserviced === 'me' ? 'by me' : 'by anyone', remove: (p) => ({ ...p, unserviced: undefined }) });
  }
  each('accountStatus', 'Status', (v) => ACCOUNT_STATUS_LABELS[v as keyof typeof ACCOUNT_STATUS_LABELS] ?? v);
  each('segment', 'Segment', (v) => SEGMENT_LABELS[v as keyof typeof SEGMENT_LABELS] ?? v);
  each('certifications', 'GAF', (v) => CERTIFICATION_LABELS[v as keyof typeof CERTIFICATION_LABELS]?.replace(/^GAF /, '') ?? v);
  each('size', 'Size', (v) => SIZE_LABELS[v as keyof typeof SIZE_LABELS] ?? v);
  each('materials', 'Material', taxonomyLabel);
  each('services', 'Service', taxonomyLabel);
  each('tagsAll', 'Tag', tagRefLabel);
  each('tagsAny', 'Any tag', tagRefLabel);
  each('customTags', 'Custom tag', (v) => v);
  each('counties', 'County', countyPlaceShort);
  (f.customFields ?? []).forEach((c, i) => chips.push({
    id: `cf:${i}:${c.key}`,
    facet: 'Field',
    label: describeCondition(c),
    remove: (p) => {
      const next = (p.customFields ?? []).filter((_, j) => j !== i);
      return { ...p, customFields: next.length ? next : undefined };
    },
  }));
  if (f.unchecked) chips.push({ id: 'unchecked', facet: 'Unchecked', label: f.unchecked === 'me' ? 'by me' : 'by team', remove: (p) => ({ ...p, unchecked: undefined }) });
  if (f.updatedInLastPoll) {
    chips.push({ id: 'updatedInLastPoll', facet: 'Updated', label: 'in last poll', remove: (p) => ({ ...p, updatedInLastPoll: undefined }) });
  }
  if (f.updatedSince) {
    chips.push({
      id: 'updatedSince',
      facet: 'Changed since',
      label: /^\d{4}-\d{2}-\d{2}$/.test(f.updatedSince) ? formatDate(`${f.updatedSince}T12:00:00`) : formatDateTime(f.updatedSince),
      remove: (p) => ({ ...p, updatedSince: undefined }),
    });
  }
  if (f.minPriority !== undefined) chips.push({ id: 'minPriority', facet: 'Priority', label: `${f.minPriority}+`, remove: (p) => ({ ...p, minPriority: undefined }) });
  if (f.minRating !== undefined) chips.push({ id: 'minRating', facet: 'Rating', label: `${f.minRating}+ ★`, remove: (p) => ({ ...p, minRating: undefined }) });
  if (f.minYearsInBusiness !== undefined) {
    chips.push({ id: 'minYears', facet: 'In business', label: `${f.minYearsInBusiness}+ yrs`, remove: (p) => ({ ...p, minYearsInBusiness: undefined }) });
  }
  if (f.near) {
    chips.push({
      id: 'near',
      facet: 'Near',
      label: `${f.near.zip} · ${f.near.radiusMiles} mi`,
      remove: (p) => ({ ...p, near: undefined, sort: p.sort?.by === 'distance' ? undefined : p.sort }),
    });
  }
  return chips;
}

/** Clears every facet; keeps the view (scope) and the sort. */
export function clearFacets(f: LeadFilter): LeadFilter {
  return { scope: f.scope, sort: f.sort?.by === 'distance' ? undefined : f.sort };
}

export function FilterChips({
  filter, setFilter, alertOnly, className,
}: {
  filter: LeadFilter;
  setFilter: SetLeadFilter;
  alertOnly: boolean;
  className?: string;
}) {
  const chips = filterChips(filter);
  if (!chips.length && !alertOnly) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} role="group" aria-label="Active filters">
      {chips.map((c) => (
        <FilterChip key={c.id} facet={c.facet} label={c.label} onRemove={() => setFilter((f) => c.remove(f))} />
      ))}
      {alertOnly && (
        <FilterChip
          facet="Weather"
          label="storm alert nearby"
          icon={<CloudLightning className="size-3 text-timing-high" aria-hidden />}
          onRemove={() => setFilter((f) => f, { alert: false })}
        />
      )}
      <ClearFiltersButton onClick={() => setFilter(clearFacets, { alert: false })} />
    </div>
  );
}
