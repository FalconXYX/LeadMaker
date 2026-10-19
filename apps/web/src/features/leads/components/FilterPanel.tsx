// Every LeadFilter facet the list API supports, as collapsible sections. Changes go straight to the URL
// (typing is debounced and replaces the history entry).
import { ChevronDown, CloudLightning, Plus, Search, Settings2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useFacetCounts, type FacetKey } from '@/api/facets';
import { useCustomFieldKeys, useCustomTags, useLeadFacets, useSignals } from '@/api/queries';
import type { CustomFieldCondition, CustomFieldKey, LeadFilter } from '@/api/types';
import { Button, Input, Pill, Segmented, Select, Toggle } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyFullName, countyPlaceShort } from '@/lib/counties';
import { formatNumber } from '@/lib/format';
import {
  ACCOUNT_STATUSES, ACCOUNT_STATUS_LABELS, CERTIFICATIONS, CERTIFICATION_LABELS, SEGMENTS, SEGMENT_LABELS, SIZES, SIZE_LABELS,
} from '@/lib/labels';
import {
  MATERIAL_KEYS, SERVICE_KEYS, TAG_GROUPS, TAG_GROUP_LABELS, taxonomyLabel, type TagGroup, type TagOption,
} from '../tags';
import {
  FOLLOW_UPS, FOLLOW_UP_LABELS, SALES_STAGES, STAGE_LABELS, STAGE_TONE, daysAgoDate, isStage, notContactedDays,
  type FollowUp, type SalesStage,
} from '../sales';
import type { SetLeadFilter } from '../useLeadsUrl';

export interface FilterPanelProps {
  filter: LeadFilter;
  setFilter: SetLeadFilter;
  alertOnly: boolean;
  tagOptions: readonly TagOption[];
  /** The filter as the list sends it (scope resolved), for the facet counts. */
  facetFilter: LeadFilter;
  /** Opens the Manage tags dialog. */
  onManageTags?: () => void;
}

type ArrayKey = 'segment' | 'size' | 'certifications' | 'materials' | 'services' | 'accountStatus' | 'customTags' | 'tagsAll' | 'tagsAny' | 'stages';

export function toggleValue(values: readonly string[] | undefined, v: string): string[] | undefined {
  const set = new Set(values ?? []);
  if (set.has(v)) set.delete(v);
  else set.add(v);
  return set.size ? [...set] : undefined;
}

const SEGMENT_DOTS: Record<string, string> = {
  strategic: 'bg-seg-strategic',
  growth: 'bg-seg-growth',
  emerging: 'bg-seg-emerging',
  long_tail: 'bg-seg-long-tail',
};

const RATING_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: '3.5', label: '3.5+' },
  { value: '4', label: '4+' },
  { value: '4.5', label: '4.5+' },
  { value: '4.8', label: '4.8+' },
] as const;

const YEARS_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: '2', label: '2+' },
  { value: '5', label: '5+' },
  { value: '10', label: '10+' },
  { value: '25', label: '25+' },
] as const;

const STATE_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'me', label: 'By me' },
  { value: 'team', label: 'By team' },
] as const;

const FOLLOW_UP_OPTIONS = [{ value: 'any', label: 'Any' }, ...FOLLOW_UPS.map((v) => ({ value: v, label: FOLLOW_UP_LABELS[v] }))] as const;

type ContactChoice = 'any' | 'never' | '7' | '30';
const CONTACT_OPTIONS: readonly { value: ContactChoice; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'never', label: 'Never' },
  { value: '7', label: '7+ days' },
  { value: '30', label: '30+ days' },
];

const PRIORITY_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: '40', label: '40+' },
  { value: '60', label: '60+' },
  { value: '75', label: '75+' },
  { value: '90', label: '90+' },
] as const;

const RADII = ['5', '10', '25', '50', '100'] as const;

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

export function FilterPanel({ filter, setFilter, alertOnly, tagOptions, facetFilter, onManageTags }: FilterPanelProps) {
  const customTags = useCustomTags();
  const fieldKeys = useCustomFieldKeys();
  const facets = useFacetCounts(facetFilter);
  const stageCount = useStageCounts(facetFilter);
  /** Matching leads per option (undefined until the counts arrive). */
  const n = (facet: FacetKey, v: string) => facets.count(facet, v);
  /** Short lists keep every option, but one that would match nothing is dimmed and inert. */
  const dead = (facet: ArrayKey & FacetKey, v: string) => n(facet, v) === 0 && !has(facet, v);
  /** Long lists drop the options that would match nothing (selected ones stay), most common first. */
  const live = <T extends { pressed: boolean; count?: number }>(items: T[]): T[] => (facets.ready
    ? items.filter((it) => it.pressed || (it.count ?? 0) > 0).sort((a, b) => Number(b.pressed) - Number(a.pressed) || (b.count ?? 0) - (a.count ?? 0))
    : items);

  const toggle = (key: ArrayKey, v: string) => setFilter((f) => ({ ...f, [key]: toggleValue(f[key] as string[] | undefined, v) }));
  const has = (key: ArrayKey, v: string) => ((filter[key] as string[] | undefined) ?? []).includes(v);
  const count = (...keys: (keyof LeadFilter)[]) =>
    (keys as (keyof LeadFilter)[]).reduce((n, k) => {
      const v = filter[k];
      return n + (Array.isArray(v) ? v.length : v !== undefined ? 1 : 0);
    }, 0);

  // System tags: one match mode for the whole section ("all" -> tagsAll, "any" -> tagsAny).
  const tagMode: 'all' | 'any' = filter.tagsAny?.length && !filter.tagsAll?.length ? 'any' : 'all';
  const selectedTags = new Set([...(filter.tagsAll ?? []), ...(filter.tagsAny ?? [])]);
  const toggleTag = (ref: string) => setFilter((f) => {
    if (f.tagsAll?.includes(ref)) return { ...f, tagsAll: toggleValue(f.tagsAll, ref) };
    if (f.tagsAny?.includes(ref)) return { ...f, tagsAny: toggleValue(f.tagsAny, ref) };
    return tagMode === 'any' ? { ...f, tagsAny: toggleValue(f.tagsAny, ref) } : { ...f, tagsAll: toggleValue(f.tagsAll, ref) };
  });
  const setTagMode = (mode: 'all' | 'any') => setFilter((f) => {
    const refs = [...new Set([...(f.tagsAll ?? []), ...(f.tagsAny ?? [])])];
    return { ...f, tagsAll: mode === 'all' && refs.length ? refs : undefined, tagsAny: mode === 'any' && refs.length ? refs : undefined };
  });
  const tagsByGroup = useMemo(() => {
    const m = new Map<TagGroup, TagOption[]>();
    for (const o of tagOptions) m.set(o.group, [...(m.get(o.group) ?? []), o]);
    return m;
  }, [tagOptions]);

  return (
    <div className="flex flex-col divide-y divide-border">
      <TextSection filter={filter} setFilter={setFilter} />

      <Section title="Sales" count={count('stages', 'followUp', 'notContactedSince', 'unserviced', 'accountStatus')} defaultOpen>
        <Labeled label="Stage">
          <Pills>
            {SALES_STAGES.map((st) => (
              <Pill
                key={st}
                pressed={has('stages', st)}
                onToggle={() => toggle('stages', st)}
                dotClassName={STAGE_TONE[st].dot}
                count={stageCount(st)}
                disabled={stageCount(st) === 0 && !has('stages', st)}
              >
                {STAGE_LABELS[st]}
              </Pill>
            ))}
          </Pills>
        </Labeled>
        <Labeled label="Follow-up">
          <Segmented
            label="Follow-up"
            size="sm"
            fullWidth
            value={filter.followUp ?? 'any'}
            onChange={(v) => setFilter({ followUp: v === 'any' ? undefined : (v as FollowUp) })}
            options={FOLLOW_UP_OPTIONS}
          />
        </Labeled>
        <LastContactedChoice filter={filter} setFilter={setFilter} />
        <Labeled label="Account status">
          <Pills>
            {ACCOUNT_STATUSES.map((st) => (
              <Pill key={st} pressed={has('accountStatus', st)} onToggle={() => toggle('accountStatus', st)} count={n('accountStatus', st)} disabled={dead('accountStatus', st)}>{ACCOUNT_STATUS_LABELS[st]}</Pill>
            ))}
          </Pills>
        </Labeled>
      </Section>

      <Section title="Fit" count={count('minPriority', 'segment', 'certifications', 'size')}>
        <Labeled label="Minimum priority">
          <Segmented
            label="Minimum priority"
            size="sm"
            fullWidth
            value={filter.minPriority !== undefined ? (PRIORITY_OPTIONS.find((o) => Number(o.value) === filter.minPriority)?.value ?? null) : 'any'}
            onChange={(v) => setFilter({ minPriority: v === 'any' ? undefined : Number(v) })}
            options={PRIORITY_OPTIONS}
          />
        </Labeled>
        {filter.minPriority !== undefined && !PRIORITY_OPTIONS.some((o) => Number(o.value) === filter.minPriority) && (
          <p className="text-xs text-muted">Showing {filter.minPriority}+ (set by a link or saved view).</p>
        )}
        <Labeled label="Segment">
          <Pills>
            {SEGMENTS.map((sg) => (
              <Pill key={sg} pressed={has('segment', sg)} onToggle={() => toggle('segment', sg)} dotClassName={SEGMENT_DOTS[sg]} count={n('segment', sg)} disabled={dead('segment', sg)}>
                {SEGMENT_LABELS[sg]}
              </Pill>
            ))}
          </Pills>
        </Labeled>
        <Labeled label="GAF certification">
          <Pills>
            {CERTIFICATIONS.map((c) => (
              <Pill key={c} pressed={has('certifications', c)} onToggle={() => toggle('certifications', c)} count={n('certifications', c)} disabled={dead('certifications', c)}>
                {CERTIFICATION_LABELS[c].replace(/^GAF /, '')}
              </Pill>
            ))}
          </Pills>
        </Labeled>
        <Labeled label="Company size">
          <Pills>
            {SIZES.map((sz) => (
              <Pill key={sz} pressed={has('size', sz)} onToggle={() => toggle('size', sz)} count={n('size', sz)} disabled={dead('size', sz)}>{SIZE_LABELS[sz]}</Pill>
            ))}
          </Pills>
        </Labeled>
      </Section>

      <Section title="Roof materials" count={count('materials')}>
        <ExpandablePills
          items={live(MATERIAL_KEYS.map((m) => ({ key: m, label: taxonomyLabel(m), pressed: has('materials', m), count: n('materials', m), onToggle: () => toggle('materials', m) })))}
          initial={8}
          empty="No roof materials listed for these leads."
        />
      </Section>

      <Section title="Services" count={count('services')}>
        <ExpandablePills
          items={live(SERVICE_KEYS.map((s) => ({ key: s, label: taxonomyLabel(s), pressed: has('services', s), count: n('services', s), onToggle: () => toggle('services', s) })))}
          initial={8}
          empty="No services listed for these leads."
        />
      </Section>

      <Section title="System tags" count={selectedTags.size}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">Match</span>
          <Segmented
            label="Match system tags"
            size="sm"
            value={tagMode}
            onChange={setTagMode}
            options={[{ value: 'all', label: 'All selected' }, { value: 'any', label: 'Any selected' }]}
          />
        </div>
        {TAG_GROUPS.map((g) => {
          const opts = tagsByGroup.get(g) ?? [];
          if (!opts.length) return null;
          return (
            <div key={g} className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{TAG_GROUP_LABELS[g]}</p>
              <ExpandablePills
                items={opts.map((o) => ({ key: o.ref, label: o.label, pressed: selectedTags.has(o.ref), onToggle: () => toggleTag(o.ref) }))}
                initial={g === 'other' ? 8 : 10}
              />
            </div>
          );
        })}
        <p className="text-xs text-subtle">Options come from the leads loaded in this list.</p>
      </Section>

      <Section
        title="Custom tags"
        count={count('customTags')}
        defaultOpen={!!filter.customTags?.length}
        action={onManageTags && (customTags.data?.items ?? []).length > 0 ? (
          <button
            type="button"
            onClick={onManageTags}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
          >
            <Settings2 className="size-3.5" aria-hidden />Manage
          </button>
        ) : undefined}
      >
        {customTags.isLoading ? (
          <p className="text-xs text-muted">Loading tags…</p>
        ) : (customTags.data?.items ?? []).length === 0 ? (
          <p className="text-xs text-muted">No custom tags yet. Select leads in the list and choose <b className="font-medium">Add tag</b> to create one.</p>
        ) : (
          <ExpandablePills
            items={live((customTags.data?.items ?? []).map((t) => ({
              key: t.id,
              label: t.name,
              count: facets.ready ? n('customTags', t.name) : t.leadCount,
              pressed: (filter.customTags ?? []).some((c) => c.toLowerCase() === t.name.toLowerCase() || c === t.id),
              onToggle: () => setFilter((f) => {
                const cur = f.customTags ?? [];
                const match = cur.find((c) => c.toLowerCase() === t.name.toLowerCase() || c === t.id);
                const next = match ? cur.filter((c) => c !== match) : [...cur, t.name];
                return { ...f, customTags: next.length ? next : undefined };
              }),
            })))}
            initial={12}
            empty="None of these leads has a custom tag yet."
          />
        )}
      </Section>

      <Section title="Custom fields" count={count('customFields')} defaultOpen={!!filter.customFields?.length}>
        <CustomFields filter={filter} setFilter={setFilter} keys={fieldKeys.data?.items ?? []} loading={fieldKeys.isLoading} />
      </Section>

      <Section title="Rating & experience" count={count('minRating', 'minYearsInBusiness')} defaultOpen={filter.minRating !== undefined || filter.minYearsInBusiness !== undefined}>
        <Labeled label="Minimum rating">
          <Segmented
            label="Minimum rating"
            size="sm"
            fullWidth
            value={filter.minRating !== undefined ? (RATING_OPTIONS.find((o) => Number(o.value) === filter.minRating)?.value ?? null) : 'any'}
            onChange={(v) => setFilter({ minRating: v === 'any' ? undefined : Number(v) })}
            options={RATING_OPTIONS}
          />
        </Labeled>
        <Labeled label="Years in business">
          <Segmented
            label="Years in business"
            size="sm"
            fullWidth
            value={filter.minYearsInBusiness !== undefined ? (YEARS_OPTIONS.find((o) => Number(o.value) === filter.minYearsInBusiness)?.value ?? null) : 'any'}
            onChange={(v) => setFilter({ minYearsInBusiness: v === 'any' ? undefined : Number(v) })}
            options={YEARS_OPTIONS}
          />
        </Labeled>
      </Section>

      <Section title="Location" count={count('counties', 'near')} defaultOpen={!!filter.near || !!filter.counties?.length}>
        <Counties filter={filter} setFilter={setFilter} />
        <NearZip filter={filter} setFilter={setFilter} />
      </Section>

      <Section title="Pipeline updates" count={count('unchecked', 'updatedSince', 'updatedInLastPoll')}>
        <Labeled label="Unchecked">
          <Segmented
            label="Unchecked"
            size="sm"
            fullWidth
            value={filter.unchecked ?? 'any'}
            onChange={(v) => setFilter({ unchecked: v === 'any' ? undefined : v })}
            options={STATE_OPTIONS}
          />
        </Labeled>
        <UpdatedSince filter={filter} setFilter={setFilter} />
        <Toggle
          size="sm"
          checked={!!filter.updatedInLastPoll}
          onCheckedChange={(on) => setFilter({ updatedInLastPoll: on || undefined })}
          label="New in last poll"
          description="New or materially changed in the latest pipeline run"
        />
      </Section>

      <Section title="Weather" count={alertOnly ? 1 : 0}>
        <Toggle
          size="sm"
          checked={alertOnly}
          onCheckedChange={(on) => setFilter((f) => f, { alert: on })}
          label={<span className="inline-flex items-center gap-1.5"><CloudLightning className="size-3.5 text-timing-high" aria-hidden />Storm alert nearby</span>}
          description="NWS roof-damaging alert in the lead’s county, active or in the last 7 days"
        />
      </Section>
    </div>
  );
}

// ---- sales ---------------------------------------------------------------------------------------------------

/** Leads per stage (disjunctive, like the other facets: the stage selection itself is left out of the count). */
function useStageCounts(filter: LeadFilter): (stage: SalesStage) => number | undefined {
  const { stages: _s, ...rest } = filter;
  const q = useLeadFacets(rest);
  const raw = q.data as unknown as Record<string, unknown> | undefined;
  const list = [raw?.stages, raw?.stage, raw?.salesStage].find(Array.isArray) as { value?: unknown; stage?: unknown; count?: unknown }[] | undefined;
  return (stage) => {
    if (!list || typeof raw?.total !== 'number') return undefined;
    const hit = list.find((r) => (isStage(r.value) ? r.value : r.stage) === stage);
    return typeof hit?.count === 'number' ? hit.count : 0;
  };
}

/** Never (no call, email or visit logged) / not in 7 or 30 days. */
function LastContactedChoice({ filter, setFilter }: Pick<FilterPanelProps, 'filter' | 'setFilter'>) {
  const days = notContactedDays(filter.notContactedSince);
  const value: ContactChoice | null = filter.unserviced === 'team' && !filter.notContactedSince ? 'never'
    : days && !filter.unserviced ? (String(days) as ContactChoice)
    : !filter.unserviced && !filter.notContactedSince ? 'any' : null;
  const choose = (v: ContactChoice) => setFilter({
    unserviced: v === 'never' ? 'team' : undefined,
    notContactedSince: v === '7' || v === '30' ? daysAgoDate(Number(v)) : undefined,
  });
  return (
    <Labeled label="Last contacted">
      <Segmented label="Last contacted" size="sm" fullWidth value={value} onChange={choose} options={CONTACT_OPTIONS} />
      {value === null && <p className="text-xs text-muted">Set by a link or saved view; pick an option to replace it.</p>}
    </Labeled>
  );
}

// ---- layout bits ------------------------------------------------------------------------------------

function Section({
  title, count, defaultOpen = false, action, children,
}: { title: string; count: number; defaultOpen?: boolean; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen || count > 0);
  const id = useId();
  return (
    <section className="py-1.5">
      <h3 className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-4 py-2.5 text-left text-[13px] font-semibold text-fg hover:bg-hover"
        >
          <span className="flex-1">{title}</span>
          {count > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold tabular text-accent">{count}</span>}
          <ChevronDown className={cn('size-4 text-subtle transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {action && <span className="mr-2 shrink-0">{action}</span>}
      </h3>
      {open && <div id={id} className="flex flex-col gap-3.5 px-4 pt-1.5 pb-4">{children}</div>}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function Pills({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function ExpandablePills({
  items, initial, empty,
}: { items: { key: string; label: string; title?: string; pressed: boolean; count?: number; onToggle: () => void }[]; initial: number; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length && empty) return <p className="text-xs text-muted">{empty}</p>;
  // Selected options always stay visible.
  const shown = all ? items : items.filter((it, i) => i < initial || it.pressed);
  const hidden = items.length - shown.length;
  return (
    <Pills>
      {shown.map((it) => <Pill key={it.key} pressed={it.pressed} onToggle={it.onToggle} count={it.count} title={it.title}>{it.label}</Pill>)}
      {(hidden > 0 || all) && items.length > initial && (
        <button type="button" onClick={() => setAll((a) => !a)} className="h-7 px-1.5 text-xs font-medium text-accent hover:underline">
          {all ? 'Show fewer' : `+${hidden} more`}
        </button>
      )}
    </Pills>
  );
}

// ---- text --------------------------------------------------------------------------------------------------

function TextSection({ filter, setFilter }: { filter: LeadFilter; setFilter: SetLeadFilter }) {
  const [text, setText] = useState(filter.text ?? '');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setText(filter.text ?? '');
  }, [filter.text, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      setFilter({ text: text.trim() || undefined }, { replace: true });
      setDirty(false);
    }, 300);
    return () => clearTimeout(t);
  }, [text, dirty, setFilter]);
  return (
    <div className="px-4 pt-4 pb-3.5">
      <label htmlFor="leads-filter-text" className="mb-2 block text-xs font-medium text-muted">Business name</label>
      <Input
        id="leads-filter-text"
        inputSize="sm"
        leftIcon={<Search />}
        placeholder="Contains…"
        value={text}
        maxLength={200}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        rightSlot={text ? (
          <button
            type="button"
            aria-label="Clear business name"
            className="rounded p-1 text-subtle hover:text-fg"
            onClick={() => {
              setText('');
              setDirty(false);
              setFilter({ text: undefined }, { replace: true });
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : undefined}
      />
    </div>
  );
}

// ---- updated since -------------------------------------------------------------------------------------------

function UpdatedSince({ filter, setFilter }: Pick<FilterPanelProps, 'filter' | 'setFilter'>) {
  const since = filter.updatedSince;
  const quick = [
    { label: 'Today', value: daysAgo(0) },
    { label: '7 days', value: daysAgo(7) },
    { label: '30 days', value: daysAgo(30) },
  ];
  const dateValue = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : since ? localDate(new Date(since)) : '';
  return (
    <Labeled label="Changed since">
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <Pill key={q.label} pressed={since === q.value} onToggle={() => setFilter({ updatedSince: since === q.value ? undefined : q.value })}>
            {q.label}
          </Pill>
        ))}
      </div>
      <Input
        type="date"
        inputSize="sm"
        aria-label="Changed since date"
        value={dateValue}
        max={localDate(new Date())}
        onChange={(e) => setFilter({ updatedSince: e.target.value || undefined })}
      />
    </Labeled>
  );
}

// ---- counties ------------------------------------------------------------------------------------------------

/** County facet (LeadFilter.counties, FIPS): the counties the user's leads are in, most leads first. */
function Counties({ filter, setFilter }: { filter: LeadFilter; setFilter: SetLeadFilter }) {
  const signals = useSignals();
  const selected = filter.counties ?? [];
  const items = useMemo(() => {
    const known = new Map<string, number>();
    for (const c of signals.data?.counties ?? []) if (c?.countyFips) known.set(c.countyFips, c.leadCount ?? 0);
    for (const f of selected) if (!known.has(f)) known.set(f, 0);
    return [...known.entries()]
      .map(([fips, leads]) => ({ fips, leads, pressed: selected.includes(fips) }))
      .filter((c) => c.pressed || c.leads > 0)
      .sort((a, b) => Number(b.pressed) - Number(a.pressed) || b.leads - a.leads || countyPlaceShort(a.fips).localeCompare(countyPlaceShort(b.fips)));
  }, [signals.data, selected.join(',')]);
  const toggle = (fips: string) => setFilter((f) => ({ ...f, counties: toggleValue(f.counties, fips) }));

  return (
    <Labeled label="County">
      {signals.isPending && !items.length ? (
        <p className="text-xs text-muted">Loading counties…</p>
      ) : (
        <ExpandablePills
          items={items.map((c) => ({
            key: c.fips,
            label: countyPlaceShort(c.fips),
            title: countyFullName(c.fips),
            pressed: c.pressed,
            count: c.leads || undefined,
            onToggle: () => toggle(c.fips),
          }))}
          initial={10}
          empty="No counties for your leads yet."
        />
      )}
    </Labeled>
  );
}

// ---- near ZIP -------------------------------------------------------------------------------------------------

function NearZip({ filter, setFilter }: { filter: LeadFilter; setFilter: SetLeadFilter }) {
  const [zip, setZip] = useState(filter.near?.zip ?? '');
  const [radius, setRadius] = useState(String(filter.near?.radiusMiles ?? 25));
  useEffect(() => {
    setZip(filter.near?.zip ?? '');
    if (filter.near) setRadius(String(filter.near.radiusMiles));
  }, [filter.near?.zip, filter.near?.radiusMiles]);

  const valid = /^\d{5}$/.test(zip);
  const apply = (z = zip, r = radius) => {
    if (/^\d{5}$/.test(z)) setFilter({ near: { zip: z, radiusMiles: Number(r) } });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="leads-near-zip" className="text-xs font-medium text-muted">Near ZIP</label>
          <Input
            id="leads-near-zip"
            inputSize="sm"
            inputMode="numeric"
            placeholder="e.g. 07026"
            maxLength={5}
            value={zip}
            invalid={zip.length > 0 && !valid}
            onChange={(e) => {
              const z = e.target.value.replace(/\D/g, '').slice(0, 5);
              setZip(z);
              if (/^\d{5}$/.test(z)) apply(z);
            }}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="flex w-28 flex-col gap-1.5">
          <label htmlFor="leads-near-radius" className="text-xs font-medium text-muted">Within</label>
          <Select
            id="leads-near-radius"
            selectSize="sm"
            value={radius}
            onValueChange={(r) => {
              setRadius(r);
              apply(zip, r);
            }}
            options={RADII.map((r) => ({ value: r, label: `${r} miles` }))}
          />
        </div>
      </div>
      {filter.near && (
        <div className="flex items-center justify-between gap-2 text-xs">
          {filter.sort?.by === 'distance' ? (
            <span className="text-muted">Sorted nearest first</span>
          ) : (
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setFilter({ sort: { by: 'distance', dir: 'asc' } })}>
              Sort nearest first
            </button>
          )}
          <button
            type="button"
            className="font-medium text-muted hover:text-fg"
            onClick={() => setFilter((f) => ({ ...f, near: undefined, sort: f.sort?.by === 'distance' ? undefined : f.sort }))}
          >
            Clear location
          </button>
        </div>
      )}
    </div>
  );
}

// ---- custom fields ----------------------------------------------------------------------------------------------

const OP_LABELS: Record<CustomFieldCondition['op'], string> = {
  eq: 'is',
  gte: 'is at least',
  lte: 'is at most',
  contains: 'contains',
  exists: 'has any value',
};

function opsFor(type: CustomFieldKey['valueType'] | undefined): CustomFieldCondition['op'][] {
  switch (type) {
    case 'number':
    case 'date':
      return ['eq', 'gte', 'lte', 'exists'];
    case 'boolean':
      return ['eq', 'exists'];
    case 'array':
      return ['contains', 'exists'];
    default:
      return ['eq', 'contains', 'exists'];
  }
}

export function describeCondition(c: CustomFieldCondition): string {
  if (c.op === 'exists') return `${c.key} has a value`;
  return `${c.key} ${OP_LABELS[c.op]} ${String(c.value)}`;
}

function CustomFields({ filter, setFilter, keys, loading }: { filter: LeadFilter; setFilter: SetLeadFilter; keys: CustomFieldKey[]; loading: boolean }) {
  const [key, setKey] = useState('');
  const [op, setOp] = useState<CustomFieldCondition['op']>('eq');
  const [value, setValue] = useState('');
  const meta = keys.find((k) => k.key === key);
  const ops = opsFor(meta?.valueType);
  const current = filter.customFields ?? [];

  useEffect(() => {
    if (!ops.includes(op)) setOp(ops[0]!);
  }, [key]);

  if (loading) return <p className="text-xs text-muted">Loading fields…</p>;

  const add = () => {
    if (!key) return;
    let cond: CustomFieldCondition;
    if (op === 'exists') cond = { key, op };
    else {
      const raw = value.trim();
      if (!raw) return;
      const parsed = meta?.valueType === 'number' && Number.isFinite(Number(raw)) ? Number(raw)
        : meta?.valueType === 'boolean' ? raw === 'true'
        : raw;
      cond = { key, op, value: parsed };
    }
    setFilter((f) => ({ ...f, customFields: [...(f.customFields ?? []), cond].slice(0, 20) }));
    setValue('');
  };

  return (
    <div className="flex flex-col gap-2">
      {current.length > 0 && (
        <ul className="flex flex-col gap-1">
          {current.map((c, i) => (
            <li key={`${c.key}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs">
              <span className="min-w-0 truncate text-fg">{describeCondition(c)}</span>
              <button
                type="button"
                aria-label={`Remove condition ${describeCondition(c)}`}
                className="rounded p-0.5 text-subtle hover:text-fg"
                onClick={() => setFilter((f) => {
                  const next = (f.customFields ?? []).filter((_, j) => j !== i);
                  return { ...f, customFields: next.length ? next : undefined };
                })}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {keys.length === 0 ? (
        <p className="text-xs text-muted">No custom fields yet. Reps add them on a lead’s profile.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Select
            aria-label="Custom field"
            selectSize="sm"
            value={key}
            placeholder="Choose a field…"
            onValueChange={setKey}
            options={keys.map((k) => ({ value: k.key, label: `${k.key} (${formatNumber(k.leadCount)})` }))}
          />
          {key && (
            <div className="flex gap-2">
              <Select
                aria-label="Condition"
                selectSize="sm"
                className="w-36 shrink-0"
                value={op}
                onValueChange={(v) => setOp(v as CustomFieldCondition['op'])}
                options={ops.map((o) => ({ value: o, label: OP_LABELS[o] }))}
              />
              {op !== 'exists' && (meta?.valueType === 'boolean' ? (
                <Select
                  aria-label="Value"
                  selectSize="sm"
                  className="min-w-0 flex-1"
                  value={value}
                  placeholder="Choose…"
                  onValueChange={setValue}
                  options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
                />
              ) : (
                <Input
                  aria-label="Value"
                  inputSize="sm"
                  className="min-w-0 flex-1"
                  type={meta?.valueType === 'number' ? 'number' : meta?.valueType === 'date' ? 'date' : 'text'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                />
              ))}
            </div>
          )}
          {key && (
            <Button size="sm" variant="secondary" leftIcon={<Plus className="size-3.5" />} onClick={add} disabled={op !== 'exists' && !value.trim()}>
              Add condition
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
