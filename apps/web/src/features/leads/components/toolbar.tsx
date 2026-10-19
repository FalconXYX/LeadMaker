// List toolbar controls: view switch, quick views, sort, density, display settings (columns + tag chips). Saved
// views: SavedViewsMenu.
import {
  ArrowDownWideNarrow, CalendarClock, Check, ChevronDown, CloudLightning, Handshake, Inbox, Layers, PhoneOff, RotateCcw, Rows3,
  Rows4, Settings2, Sparkles, Tags, UserRound, X,
} from 'lucide-react';
import type { CustomTagListItem, SortField, UserListItem } from '@/api/types';
import { Menu, Popover, Segmented, Select, Toggle, Tooltip, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SORT_LABELS } from '@/lib/labels';
import { COLUMN_IDS, COLUMN_LABELS, isExtraColumn, visibleColumns, type ColumnId, type Density, type LeadsPrefs } from '../prefs';
import type { LeadView } from '../scope';
import { TAG_GROUPS, TAG_GROUP_HINTS, TAG_GROUP_LABELS, type TagGroup } from '../tags';
import { DUE_BUCKETS, PRESETS, type DueBucket, type PresetId } from '../views';
import type { SortState } from './LeadsTable';

// ---- view switch ------------------------------------------------------------------------------------

export function ViewSwitch({
  view, repId, isManager, reps, onView, onRep, fullWidth, className,
}: {
  view: LeadView;
  repId?: string;
  isManager: boolean;
  reps: readonly UserListItem[];
  onView: (v: Exclude<LeadView, 'rep'>) => void;
  onRep: (repId: string) => void;
  fullWidth?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', fullWidth && 'w-full', className)}>
      <Segmented
        label="Lead view"
        value={view === 'rep' ? null : view}
        onChange={onView}
        fullWidth={fullWidth}
        options={[
          { value: 'mine', label: <><UserRound aria-hidden />My leads</> },
          { value: 'unallocated', label: <><Inbox aria-hidden />Unallocated</> },
          { value: 'all', label: <><Layers aria-hidden />All</>, title: isManager ? 'Every lead on the team' : 'Your leads plus the unallocated pool' },
        ]}
      />
      {isManager && (
        <Select
          aria-label="Show one rep’s leads"
          selectSize="sm"
          className={cn('w-44', view === 'rep' && '[&_select]:border-accent [&_select]:bg-accent-soft [&_select]:text-accent', fullWidth && 'flex-1')}
          value={view === 'rep' && repId ? repId : ''}
          placeholder="By rep…"
          onValueChange={(v) => v && onRep(v)}
          options={reps.filter((r) => r.role === 'rep').map((r) => ({ value: r.id, label: `${r.name} (${r.allocatedCount})` }))}
        />
      )}
    </div>
  );
}

// ---- sort -------------------------------------------------------------------------------------------------

const SORT_CHOICES: { by: SortField; dir: 'asc' | 'desc'; label: string }[] = [
  { by: 'priority_score', dir: 'desc', label: 'Priority: high to low' },
  { by: 'next_follow_up', dir: 'asc', label: 'Next follow-up: soonest' },
  { by: 'last_contacted', dir: 'asc', label: 'Last contacted: longest ago' },
  { by: 'last_contacted', dir: 'desc', label: 'Last contacted: most recent' },
  { by: 'priority_score', dir: 'asc', label: 'Priority: low to high' },
  { by: 'rating', dir: 'desc', label: 'Rating: high to low' },
  { by: 'review_count', dir: 'desc', label: 'Most reviews' },
  { by: 'years_in_business', dir: 'desc', label: 'Longest in business' },
  { by: 'last_change', dir: 'desc', label: 'Recently changed' },
  { by: 'distance', dir: 'asc', label: 'Nearest first' },
];

export function SortMenu({ sort, onSort, hasNear, compact }: { sort: SortState; onSort: (s: SortState | undefined) => void; hasNear: boolean; compact?: boolean }) {
  const current = SORT_CHOICES.find((c) => c.by === sort.by && c.dir === sort.dir);
  const name = sort.by === 'next_follow_up' ? 'Next follow-up' : sort.by === 'last_contacted' ? 'Last contacted' : SORT_LABELS[sort.by];
  const label = current?.label ?? `${name} ${sort.dir === 'asc' ? '↑' : '↓'}`;
  return (
    <Menu
      align="end"
      trigger={(p) => (
        <Tooltip content={`Sort: ${label}`} describe={false}>
          <button
            {...p}
            type="button"
            aria-label={`Sort: ${label}`}
            className={buttonClasses('secondary', 'sm', cn('h-8', compact && 'w-8 px-0!'))}
          >
            <ArrowDownWideNarrow className="size-3.5" aria-hidden />
            {!compact && <span className="hidden xl:inline">{label}</span>}
            {!compact && <span className="xl:hidden">Sort</span>}
            {!compact && <ChevronDown className="size-3.5 text-subtle" aria-hidden />}
          </button>
        </Tooltip>
      )}
      items={SORT_CHOICES.filter((c) => c.by !== 'distance' || hasNear).map((c) => {
        const on = c.by === sort.by && c.dir === sort.dir;
        return {
          label: <span className={cn('flex-1', on && 'font-medium')}>{c.label}</span>,
          icon: on ? <Check className="text-accent" /> : <span className="inline-block size-4" />,
          onSelect: () => onSort(c.by === 'priority_score' && c.dir === 'desc' ? undefined : { by: c.by, dir: c.dir }),
        };
      })}
    />
  );
}

// ---- density ------------------------------------------------------------------------------------------------

export function DensityToggle({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
  return (
    <Segmented
      label="Row density"
      size="sm"
      value={density}
      onChange={onChange}
      className="h-8"
      options={[
        { value: 'comfortable', label: <Rows3 aria-hidden />, ariaLabel: 'Comfortable rows', title: 'Comfortable rows' },
        { value: 'compact', label: <Rows4 aria-hidden />, ariaLabel: 'Compact rows', title: 'Compact rows' },
      ]}
    />
  );
}

// ---- display: columns + tag chips -----------------------------------------------------------------------------

export function DisplayMenu({
  prefs, onPrefs, customTags, compact, onManageTags,
}: {
  prefs: LeadsPrefs;
  onPrefs: (update: Partial<LeadsPrefs> | ((p: LeadsPrefs) => LeadsPrefs)) => void;
  customTags: readonly CustomTagListItem[];
  compact?: boolean;
  onManageTags?: () => void;
}) {
  const setGroup = (g: TagGroup | 'custom', on: boolean) => onPrefs((p) => ({ ...p, tagGroups: { ...p.tagGroups, [g]: on } }));
  const setColumn = (c: ColumnId, on: boolean) => onPrefs((p) => {
    const key = isExtraColumn(c) ? 'extraColumns' : 'hiddenColumns';
    const add = isExtraColumn(c) ? on : !on;
    return { ...p, [key]: add ? [...new Set([...p[key], c])] : p[key].filter((x) => x !== c) };
  });
  const shown = visibleColumns(prefs);
  const setCustomTag = (name: string, on: boolean) =>
    onPrefs((p) => ({
      ...p,
      hiddenCustomTags: on ? p.hiddenCustomTags.filter((n) => n.toLowerCase() !== name.toLowerCase()) : [...p.hiddenCustomTags, name],
    }));
  const shownGroups = TAG_GROUPS.filter((g) => prefs.tagGroups[g]).length + (prefs.tagGroups.custom ? 1 : 0);

  return (
    <Popover
      label="Display settings"
      align="end"
      panelClassName="w-[min(340px,calc(100vw-2rem))]"
      trigger={(p) => (
        <Tooltip content="Columns and tag chips" describe={false}>
          <button {...p} type="button" aria-label="Display settings" className={buttonClasses('secondary', 'sm', cn('h-8', compact && 'w-8 px-0!'))}>
            <Settings2 className="size-3.5" aria-hidden />
            {!compact && 'Display'}
          </button>
        </Tooltip>
      )}
    >
      {(close) => (
        <div className="max-h-[min(560px,70vh)] overflow-y-auto">
          <div className="border-b border-border px-4 py-3.5">
            <p className="text-[13px] font-semibold text-fg">Tag chips</p>
            <p className="mt-1 text-xs text-muted">Choose which tags show under each lead. {shownGroups === 0 && 'All hidden.'}</p>
            <div className="mt-3.5 flex flex-col gap-3">
              <Toggle
                size="sm"
                checked={prefs.tagGroups.custom}
                onCheckedChange={(on) => setGroup('custom', on)}
                label="Custom tags"
                description="Tags your team created"
              />
              {prefs.tagGroups.custom && customTags.length > 0 && (
                <ul className="ml-9 flex flex-col gap-1.5 border-l border-border pl-3" aria-label="Custom tags shown">
                  {customTags.map((t) => {
                    const on = !prefs.hiddenCustomTags.some((n) => n.toLowerCase() === t.name.toLowerCase());
                    return (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-fg">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => setCustomTag(t.name, e.target.checked)}
                            className="size-3.5 accent-[var(--c-accent)]"
                          />
                          <span className="truncate">{t.name}</span>
                          <span className="ml-auto text-subtle tabular">{t.leadCount}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {prefs.tagGroups.custom && customTags.length > 0 && onManageTags && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onManageTags();
                  }}
                  className="ml-9 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-accent hover:underline"
                >
                  <Tags className="size-3.5" aria-hidden />Manage tags…
                </button>
              )}
              {TAG_GROUPS.map((g) => (
                <Toggle
                  key={g}
                  size="sm"
                  checked={prefs.tagGroups[g]}
                  onCheckedChange={(on) => setGroup(g, on)}
                  label={TAG_GROUP_LABELS[g]}
                  description={TAG_GROUP_HINTS[g]}
                />
              ))}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[13px] font-semibold text-fg">Columns</p>
            <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
              {COLUMN_IDS.map((c) => (
                <label key={c} className="flex cursor-pointer items-center gap-2 text-xs text-fg">
                  <input
                    type="checkbox"
                    checked={shown.includes(c)}
                    onChange={(e) => setColumn(c, e.target.checked)}
                    className="size-3.5 accent-[var(--c-accent)]"
                  />
                  {COLUMN_LABELS[c]}
                </label>
              ))}
            </div>
            <p className="mt-2.5 text-[11px] leading-snug text-subtle">
              Owner shows in the All view. Narrow screens move Tags, Owner and Last contacted into the name and
              follow-up cells.
            </p>
          </div>
        </div>
      )}
    </Popover>
  );
}

// ---- quick views (the presets) --------------------------------------------------------------------------------

const PRESET_ICONS: Record<PresetId, typeof CalendarClock> = {
  'follow-ups-due': CalendarClock,
  'never-contacted': PhoneOff,
  'interested-quoting': Handshake,
  'win-back': RotateCcw,
  'updated-last-poll': Sparkles,
  'storm-ready': CloudLightning,
};

const DUE_LABELS: Record<DueBucket, string> = { overdue: 'Overdue', today: 'Today', week: 'This week' };

/** One-click sales views over whichever lead view is open; the active one is filled. */
export function QuickViews({ active, onPreset, onClear, due, onDue, className }: {
  active: PresetId | null;
  onPreset: (id: PresetId) => void;
  onClear: () => void;
  /** Follow-ups due: which window is showing. */
  due?: DueBucket;
  onDue: (bucket: DueBucket) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Quick views" className={cn('flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]', className)}>
      {PRESETS.map((p) => {
        const on = active === p.id;
        const Icon = PRESET_ICONS[p.id];
        const chip = (
          <Tooltip key={p.id} content={p.description} describe={false}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => (on ? onClear() : onPreset(p.id))}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium whitespace-nowrap transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
                on ? 'border-transparent bg-accent text-accent-fg shadow-sm' : 'border-border bg-surface text-fg hover:border-border-strong hover:bg-hover',
              )}
            >
              <Icon className={cn('size-3.5', on ? 'text-accent-fg' : 'text-muted')} aria-hidden />
              {p.short}
              {on && <X className="-mr-1 size-3.5" aria-hidden />}
            </button>
          </Tooltip>
        );
        if (!(on && p.id === 'follow-ups-due')) return chip;
        return (
          <span key={p.id} className="flex shrink-0 items-center gap-1.5">
            {chip}
            <Segmented
              label="Follow-ups due"
              size="sm"
              value={due ?? 'today'}
              onChange={onDue}
              options={DUE_BUCKETS.map((b) => ({ value: b, label: DUE_LABELS[b] }))}
            />
          </span>
        );
      })}
    </div>
  );
}
