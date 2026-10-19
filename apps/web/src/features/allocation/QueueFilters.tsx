import { ChevronDown, Search, SlidersHorizontal, Sparkle } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFacetCounts, type FacetCounts } from '@/api/facets';
import { Button, ClearFiltersButton, Drawer, FilterChip, Input, Popover, Select, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SEGMENT_LABELS, SEGMENTS } from '@/lib/labels';
import { countyPlace } from '@/lib/counties';
import {
  PRIORITY_FLOORS, RADIUS_OPTIONS, SORT_OPTIONS, TAG_OPTIONS, activeChips, clearedFacets,
} from './filterOptions';
import { DEFAULT_SORT, activeFacetCount, queueFilter, type QueueState, type QueueUpdate } from './params';

export interface CountyOption {
  fips: string;
  count?: number;
}

interface QueueFiltersProps {
  state: QueueState;
  update: (patch: QueueUpdate | ((s: QueueState) => QueueState), opts?: { replace?: boolean }) => void;
  counties: CountyOption[];
}

/** Compact filter bar: search, segment, county/ZIP, tags, min priority, last poll, sort; a drawer on phones. */
export function QueueFilters({ state, update, counties }: QueueFiltersProps) {
  const [drawer, setDrawer] = useState(false);
  const facets = activeFacetCount(state);
  const chips = activeChips(state);
  const f = state.filter;
  const sortValue = `${(f.sort ?? DEFAULT_SORT).by}:${(f.sort ?? DEFAULT_SORT).dir}`;
  const sortOptions = SORT_OPTIONS.some((o) => o.value === sortValue)
    ? SORT_OPTIONS
    : [...SORT_OPTIONS, { value: sortValue, label: 'Custom sort', sort: f.sort ?? DEFAULT_SORT }];
  const setSort = (v: string) => {
    const opt = sortOptions.find((o) => o.value === v);
    const isDefault = v === `${DEFAULT_SORT.by}:${DEFAULT_SORT.dir}`;
    update({ filter: { sort: isDefault ? undefined : opt?.sort } });
  };

  const segCount = f.segment?.length ?? 0;
  const locCount = state.counties.length + (f.near ? 1 : 0);
  const tagCount = f.tagsAll?.length ?? 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={f.text ?? ''} onChange={(text) => update({ filter: { text: text || undefined } }, { replace: true })} />

        {/* Phones: one button opens every facet */}
        <Button
          size="md"
          className="md:hidden"
          leftIcon={<SlidersHorizontal className="size-4" aria-hidden />}
          onClick={() => setDrawer(true)}
          aria-label={facets ? `Filters, ${facets} active` : 'Filters'}
        >
          Filters{facets > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent tabular">{facets}</span>}
        </Button>

        <Select
          aria-label="Sort leads"
          selectSize="sm"
          className="w-[11.5rem] max-md:flex-1 max-md:[&_select]:h-9 md:ml-auto"
          options={sortOptions.map(({ value, label }) => ({ value, label }))}
          value={sortValue}
          onValueChange={setSort}
        />
      </div>

      {/* md and up: facet popovers on their own row */}
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <FilterPopover label="Segment" count={segCount}>
          <SegmentOptions state={state} update={update} />
        </FilterPopover>
        <FilterPopover label="County / ZIP" count={locCount} wide>
          <LocationOptions state={state} update={update} counties={counties} />
        </FilterPopover>
        <FilterPopover label="Tags" count={tagCount}>
          <TagOptions state={state} update={update} />
        </FilterPopover>
        <PrioritySelect state={state} update={update} />
        <LastPollToggle state={state} update={update} />
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((c) => <FilterChip key={c.key} facet={c.facet} label={c.label} onRemove={() => update(c.remove)} />)}
          <ClearFiltersButton onClick={() => update((s) => clearedFacets(s))} />
        </div>
      )}

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Filter the queue"
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => update((s) => clearedFacets(s))} disabled={!facets}>Clear all</Button>
            <Button variant="primary" onClick={() => setDrawer(false)}>Done</Button>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <DrawerSection title="Segment"><SegmentOptions state={state} update={update} /></DrawerSection>
          <DrawerSection title="County / ZIP"><LocationOptions state={state} update={update} counties={counties} /></DrawerSection>
          <DrawerSection title="Tags (all of)"><TagOptions state={state} update={update} /></DrawerSection>
          <DrawerSection title="Priority & freshness">
            <div className="flex flex-col gap-3">
              <PrioritySelect state={state} update={update} full />
              <LastPollToggle state={state} update={update} />
            </div>
          </DrawerSection>
        </div>
      </Drawer>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const typed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow the URL (back/forward, "Clear all") but not our own debounced echo, which is trimmed:
  // re-applying it would eat the space the user just typed between two words.
  useEffect(() => {
    if (value !== typed.current.trim()) {
      typed.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const change = (v: string) => {
    typed.current = v;
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v.trim()), 300);
  };
  return (
    <Input
      type="search"
      aria-label="Search by business name"
      placeholder="Search business name…"
      value={text}
      onChange={(e) => change(e.target.value)}
      leftIcon={<Search />}
      inputSize="sm"
      className="min-w-0 flex-1 max-md:basis-full md:max-w-80 max-md:[&_input]:h-9"
    />
  );
}

const chipButton = (active: boolean) => cn(
  'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium whitespace-nowrap shadow-sm transition-colors',
  active ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-2',
);

/** A filter button with a small non-modal panel (the shared Popover): Esc or a click outside closes it. */
function FilterPopover({ label, count, children, wide }: { label: string; count: number; children: ReactNode; wide?: boolean }) {
  return (
    <Popover
      label={`${label} filter`}
      align="start"
      panelClassName={cn('p-2', wide ? 'w-72' : 'w-60')}
      trigger={(p) => (
        <button {...p} type="button" className={chipButton(count > 0)}>
          {label}
          {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-4 text-accent-fg tabular">{count}</span>}
          <ChevronDown className={cn('size-3.5 transition-transform', p['aria-expanded'] && 'rotate-180')} aria-hidden />
        </button>
      )}
    >
      {() => children}
    </Popover>
  );
}

function CheckRow({ checked, onChange, label, count }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; count?: number }) {
  // An option that would match nothing is dimmed and inert (unless it is already on, so it can be cleared).
  const dead = count === 0 && !checked;
  return (
    <label className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', dead ? 'cursor-not-allowed text-subtle' : 'cursor-pointer text-fg hover:bg-surface-2')}>
      <input type="checkbox" checked={checked} disabled={dead} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 accent-accent disabled:cursor-not-allowed" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-xs text-muted tabular">{count.toLocaleString('en-US')}</span>}
    </label>
  );
}

/** Matching-lead counts for the segment and tag options (POST /api/leads/facets), counties and priority floor included. */
function useQueueFacets(state: QueueState): FacetCounts | null {
  const filter = useMemo(() => queueFilter(state), [state]);
  const facets = useFacetCounts(filter, { facets: ['segment', 'services', 'certifications'] });
  return facets.ready ? facets : null;
}

/** Counts for the tag options that map onto a facet: services and GAF tiers. */
function tagCount(facets: FacetCounts | null, ref: string): number | undefined {
  if (!facets) return undefined;
  if (ref.startsWith('service:')) return facets.count('services', ref.slice('service:'.length));
  if (ref.startsWith('gaf_tier=')) return facets.count('certifications', `gaf:${ref.slice('gaf_tier='.length)}`);
  return undefined;
}

const toggle = <T,>(list: T[] | undefined, v: T, on: boolean): T[] | undefined => {
  const next = on ? [...new Set([...(list ?? []), v])] : (list ?? []).filter((x) => x !== v);
  return next.length ? next : undefined;
};

function SegmentOptions({ state, update }: { state: QueueState; update: QueueFiltersProps['update'] }) {
  const facets = useQueueFacets(state);
  return (
    <div role="group" aria-label="Segment">
      {SEGMENTS.map((s) => (
        <CheckRow
          key={s}
          label={SEGMENT_LABELS[s]}
          count={facets?.count('segment', s)}
          checked={!!state.filter.segment?.includes(s)}
          onChange={(on) => update({ filter: { segment: toggle(state.filter.segment, s, on) } })}
        />
      ))}
    </div>
  );
}

function LocationOptions({ state, update, counties }: { state: QueueState; update: QueueFiltersProps['update']; counties: CountyOption[] }) {
  const [zip, setZip] = useState(state.filter.near?.zip ?? '');
  const [radius, setRadius] = useState(String(state.filter.near?.radiusMiles ?? 5));
  const zipId = useId();
  useEffect(() => setZip(state.filter.near?.zip ?? ''), [state.filter.near?.zip]);
  const sorted = [...counties].sort((a, b) => countyPlace(a.fips).localeCompare(countyPlace(b.fips)));
  const applyZip = (z: string, r: string) => {
    if (/^\d{5}$/.test(z)) update({ filter: { near: { zip: z, radiusMiles: Number(r) } } });
    else if (!z) update({ filter: { near: undefined } });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 pt-1">
        <label htmlFor={zipId} className="mb-1 block text-xs font-medium text-muted">Near ZIP code</label>
        <div className="flex gap-1.5">
          <Input
            id={zipId}
            inputMode="numeric"
            maxLength={5}
            placeholder="e.g. 11201"
            value={zip}
            invalid={zip.length > 0 && zip.length < 5}
            onChange={(e) => {
              const z = e.target.value.replace(/\D/g, '').slice(0, 5);
              setZip(z);
              if (z.length === 5 || z.length === 0) applyZip(z, radius);
            }}
            inputSize="sm"
            className="flex-1"
          />
          <Select
            aria-label="Radius"
            selectSize="sm"
            className="w-24"
            options={RADIUS_OPTIONS.map((r) => ({ value: String(r), label: `${r} mi` }))}
            value={radius}
            onValueChange={(r) => {
              setRadius(r);
              applyZip(zip, r);
            }}
          />
        </div>
      </div>
      <div className="border-t border-border pt-1.5">
        <p className="px-2 pb-1 text-xs font-medium text-muted">County</p>
        {sorted.length === 0 ? (
          <p className="px-2 py-2 text-xs text-subtle">No counties to show yet.</p>
        ) : (
          <div role="group" aria-label="County" className="max-h-56 overflow-y-auto">
            {sorted.map((c) => (
              <CheckRow
                key={c.fips}
                label={countyPlace(c.fips)}
                count={c.count}
                checked={state.counties.includes(c.fips)}
                onChange={(on) => update({ counties: toggle(state.counties, c.fips, on) ?? [] })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TagOptions({ state, update }: { state: QueueState; update: QueueFiltersProps['update'] }) {
  const facets = useQueueFacets(state);
  return (
    <div role="group" aria-label="Tags" className="max-h-72 overflow-y-auto">
      <p className="px-2 pt-0.5 pb-1 text-xs text-subtle">Leads must have every selected tag.</p>
      {TAG_OPTIONS.map((t) => (
        <CheckRow
          key={t.ref}
          label={t.label}
          count={tagCount(facets, t.ref)}
          checked={!!state.filter.tagsAll?.includes(t.ref)}
          onChange={(on) => update({ filter: { tagsAll: toggle(state.filter.tagsAll, t.ref, on) } })}
        />
      ))}
    </div>
  );
}

function PrioritySelect({ state, update, full }: { state: QueueState; update: QueueFiltersProps['update']; full?: boolean }) {
  return (
    <Select
      aria-label="Minimum priority score"
      selectSize="sm"
      className={cn(full ? 'w-full' : 'w-[9.5rem]', state.minPriority !== null && '[&_select]:border-accent/40 [&_select]:bg-accent-soft [&_select]:text-accent [&_select]:font-medium')}
      placeholder="Any priority"
      options={PRIORITY_FLOORS.map((p) => ({ value: String(p), label: `Priority ${p}+` }))}
      value={state.minPriority === null ? '' : String(state.minPriority)}
      onValueChange={(v) => update({ minPriority: v ? Number(v) : null })}
    />
  );
}

function LastPollToggle({ state, update }: { state: QueueState; update: QueueFiltersProps['update'] }) {
  return (
    <Tooltip content="Only leads that are new or changed in the latest pipeline run">
      <button
        type="button"
        aria-pressed={!!state.filter.updatedInLastPoll}
        onClick={() => update({ filter: { updatedInLastPoll: state.filter.updatedInLastPoll ? undefined : true } })}
        className={chipButton(!!state.filter.updatedInLastPoll)}
      >
        <Sparkle className="size-3.5" aria-hidden />
        Last poll
      </button>
    </Tooltip>
  );
}
