// Desktop lead table, in sales order: company, stage, next follow-up, last contacted, priority, why, tags, owner.
// Sticky header and name column, sortable headers, row selection, quick actions on row hover / focus, roving
// keyboard focus (arrows / j k, Enter opens, x selects), density and live-update flashes.
import { Tag } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { LeadSummary, SessionUser, SortField } from '@/api/types';
import { readOnlyReason } from '@/auth/permissions';
import { Badge, Checkbox, SegmentBadge, Skeleton, TH, Tooltip, UpdatedBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { ACCOUNT_STATUS_LABELS } from '@/lib/labels';
import type { ColumnId, Density } from '../prefs';
import type { StateChange } from '../queries';
import { lastContactedOf, nextTaskOf, stageOf, type SalesStage } from '../sales';
import type { ChipTag } from '../tags';
import type { ListTimingBadge } from '../timing';
import type { FlashState } from '../useRowFlash';
import {
  CompanyMeta, GafTier, LastContacted, NextFollowUp, Owner, PriorityScore, Rating, SegmentLabel, StateToggles, TagChips, Why,
} from './cells';
import { RowActions, type LeadActions } from './RowActions';
import { StageSelect } from './stage';

export interface SortState {
  by: SortField;
  dir: 'asc' | 'desc';
}

interface ColumnDef {
  id: ColumnId | 'distance';
  header: string;
  /** Header tooltip. */
  hint?: string;
  sort?: SortField;
  /** Fixed column width (px, padding included); the company column takes the rest. */
  width: number;
  /**
   * Narrow tables fold this column into another cell: level 1 moves the tags, GAF and rating under the name and
   * the segment under the score; level 2 also moves the owner under the name and last contacted under the
   * follow-up.
   */
  foldLevel?: 1 | 2;
  /** Width once anything is folded (the table is narrow). */
  foldedWidth?: number;
  align?: 'left' | 'right' | 'center';
  render: (lead: LeadSummary) => ReactNode;
}

export interface LeadsTableProps {
  items: LeadSummary[];
  loading: boolean;
  /** A new filter is loading while the previous rows stay on screen. */
  refreshing: boolean;
  columns: readonly ColumnId[];
  showDistance: boolean;
  density: Density;
  sort: SortState;
  onSort: (by: SortField) => void;
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean, shiftKey: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  flash: ReadonlyMap<string, FlashState>;
  user: Pick<SessionUser, 'id' | 'role'> | null;
  onToggleState: (lead: LeadSummary, change: StateChange) => void;
  actions: LeadActions;
  timingFor: (lead: LeadSummary) => ListTimingBadge[];
  chipsFor: (lead: LeadSummary) => ChipTag[];
  onOpen: (lead: LeadSummary, newTab?: boolean) => void;
  /** Keyboard focus reached the last rows: load the next page. */
  onNearEnd: () => void;
  empty?: ReactNode;
  footer?: ReactNode;
  scrollRef?: (el: HTMLDivElement | null) => void;
}

const COMPANY_MIN = 240;
/** Folded: tags, GAF tier and rating move into the company cell, so it needs a little more room. */
const COMPANY_MIN_FOLDED = 250;
/** Divider + soft shadow on the sticky name column once the table scrolls sideways. */
const STICKY_EDGE = 'shadow-[inset_-1px_0_0_var(--c-border),6px_0_8px_-6px_color-mix(in_srgb,var(--c-text)_22%,transparent)]';
const INTERACTIVE = 'a,button,input,label,select,textarea,[role="switch"],[data-no-row-click]';

export function LeadsTable(props: LeadsTableProps) {
  const {
    items, loading, refreshing, columns, showDistance, density, sort, onSort, selected, onSelect, onSelectAll,
    flash, user, onToggleState, actions, timingFor, chipsFor, onOpen, onNearEnd, empty, footer, scrollRef,
  } = props;
  const [active, setActive] = useState(0);
  const [scrolledX, setScrolledX] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    scrollRef?.(el);
    if (!el || typeof ResizeObserver === 'undefined') return;
    setWidth(el.clientWidth);
    observer.current = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    observer.current.observe(el);
  }, [scrollRef]);
  useEffect(() => () => observer.current?.disconnect(), []);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const compact = density === 'compact';
  const showUpdatedInline = !columns.includes('updated');

  useEffect(() => {
    if (active >= items.length && items.length > 0) setActive(items.length - 1);
  }, [items.length, active]);

  const setStage = (lead: LeadSummary) => (stage: SalesStage) => actions.onStage(lead, stage);
  const defs: ColumnDef[] = [
    {
      id: 'stage', header: 'Stage', width: 132,
      render: (l) => <StageSelect stage={stageOf(l)} leadName={l.businessName} readOnlyReason={readOnlyReason(user, l)} onChange={setStage(l)} />,
    },
    {
      id: 'followUp', header: 'Next follow-up', hint: 'The next open follow-up; red when overdue', sort: 'next_follow_up', width: 156,
      render: (l) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <NextFollowUp task={nextTaskOf(l)} showTitle={!compact} />
          {folded.has('lastContacted') && (
            <span className="text-xs text-muted">Last: <LastContacted at={lastContactedOf(l)} className="text-xs text-muted" /></span>
          )}
        </div>
      ),
    },
    { id: 'lastContacted', header: 'Last contacted', hint: 'Last call, email or visit logged', sort: 'last_contacted', width: 116, foldLevel: 2, render: (l) => <LastContacted at={lastContactedOf(l)} /> },
    { id: 'priority', header: 'Priority', hint: 'Priority score (0-100); the bar colour is the segment', sort: 'priority_score', width: 96, foldedWidth: 92, render: (l) => <PriorityScore score={l.priorityScore} segment={l.segment} /> },
    { id: 'reasons', header: 'Why', hint: 'Top ranking reasons behind the priority score, and weather worth a call', width: 220, foldedWidth: 196, render: (l) => <Why lead={l} badges={timingFor(l)} compact={compact} /> },
    { id: 'tags', header: 'Tags', width: 200, foldLevel: 1, render: (l) => <TagChips chips={chipsFor(l)} max={compact ? 1 : 3} nowrap={compact} /> },
    { id: 'owner', header: 'Owner', width: 132, foldLevel: 2, render: (l) => <Owner rep={l.assignedRep} userId={user?.id} /> },
    { id: 'segment', header: 'Segment', width: 92, foldLevel: 1, render: (l) => <SegmentBadge segment={l.segment} /> },
    { id: 'gaf', header: 'GAF', hint: 'GAF residential certification tier', width: 120, foldLevel: 1, render: (l) => <GafTier tier={l.tier} /> },
    { id: 'rating', header: 'Rating', sort: 'rating', width: 96, foldLevel: 1, render: (l) => <Rating rating={l.rating} reviews={l.reviewCount} /> },
    { id: 'state', header: 'Checked', hint: 'Checked (reviewed since its last material change) and serviced (call, email or visit logged) by you', width: 84, render: (l) => <StateToggles lead={l} user={user} onToggle={onToggleState} /> },
    {
      id: 'updated', header: 'Updated', sort: 'last_change', width: 92,
      render: (l) => (l.updatedInLastPoll ? <UpdatedBadge /> : (
        <Tooltip content={`Last change ${formatDateTime(l.lastChangeAt)}`}><span className="text-xs text-subtle">—</span></Tooltip>
      )),
    },
  ];
  if (showDistance) {
    defs.unshift({
      id: 'distance', header: 'Distance', sort: 'distance', width: 88, align: 'right',
      render: (l) => (l.distanceMiles == null ? <span className="text-subtle">—</span> : <span className="tabular">{l.distanceMiles.toFixed(1)} mi</span>),
    });
  }
  const enabled = defs.filter((d) => d.id === 'distance' || columns.includes(d.id));
  // Too narrow for every column (the filter panel is open, a small laptop): fold the low-value ones into
  // other cells, one level at a time, rather than squeezing the company names or scrolling sideways.
  const columnsAt = (level: number) => enabled.filter((d) => !d.foldLevel || d.foldLevel > level);
  const colWidth = (d: ColumnDef, level: number) => (level ? d.foldedWidth ?? d.width : d.width);
  const widthAt = (level: number) => 40 + (level ? COMPANY_MIN_FOLDED : COMPANY_MIN) + columnsAt(level).reduce((n, d) => n + colWidth(d, level), 0);
  const level = width === null ? 0 : [0, 1, 2].find((l) => widthAt(l) <= width) ?? 2;
  const visible = columnsAt(level);
  const folded = new Set(enabled.filter((d) => d.foldLevel && d.foldLevel <= level).map((d) => d.id));
  const fold = folded.size > 0;
  const colCount = visible.length + 3;
  const minWidth = widthAt(level);

  const allSelected = items.length > 0 && items.every((l) => selected.has(l.id));
  const someSelected = items.some((l) => selected.has(l.id));

  const focusRow = (index: number) => {
    const lead = items[index];
    if (!lead) return;
    setActive(index);
    const el = rows.current.get(lead.id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest' });
    if (index >= items.length - 3) onNearEnd();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if ((e.target as HTMLElement).tagName !== 'TR' || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = active;
    const lead = items[i];
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        focusRow(Math.min(items.length - 1, i + 1));
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        focusRow(Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(items.length - 1);
        break;
      case 'Enter':
        if (lead) {
          e.preventDefault();
          onOpen(lead);
        }
        break;
      case ' ':
      case 'x':
        if (lead) {
          e.preventDefault();
          onSelect(lead.id, !selected.has(lead.id), e.shiftKey);
        }
        break;
    }
  };

  const onRowClick = (e: MouseEvent, lead: LeadSummary, index: number) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // let people copy a phone number or name
    setActive(index);
    onOpen(lead, e.metaKey || e.ctrlKey);
  };

  const cellY = compact ? 'py-1.5' : 'py-3';

  return (
    <div
      ref={setScroller}
      className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
      data-testid="leads-scroller"
      onScroll={(e) => {
        const x = e.currentTarget.scrollLeft > 0;
        if (x !== scrolledX) setScrolledX(x);
      }}
    >
      {refreshing && (
        <div className="pointer-events-none sticky top-0 left-0 z-40 -mb-0.5 h-0.5 w-full animate-pulse bg-accent" aria-hidden />
      )}
      <table
        className={cn('w-full table-fixed border-separate border-spacing-0 text-sm', refreshing && 'opacity-60 transition-opacity')}
        style={{ minWidth }}
        data-folded={fold || undefined}
      >
        <colgroup>
          <col style={{ width: 40 }} />
          <col />
          {visible.map((d) => <col key={d.id} style={{ width: colWidth(d, level) }} />)}
          <col style={{ width: 0 }} />
        </colgroup>
        <caption className="sr-only">
          Leads. Use the arrow keys to move between rows, Enter to open a lead, and X to select it.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 left-0 z-30 h-11 border-b border-border bg-table-head pr-1 pl-4">
              <Checkbox
                label={allSelected ? 'Deselect all loaded leads' : 'Select all loaded leads'}
                checked={allSelected}
                indeterminate={someSelected}
                onChange={(c) => onSelectAll(c)}
                disabled={!items.length}
              />
            </th>
            <TH className={cn('sticky top-0 left-10 z-30 bg-table-head', scrolledX && STICKY_EDGE)}>Company</TH>
            {/* Data columns have fixed widths, so their cells keep the tighter inset; the header keeps its 12px. */}
            {visible.map((d) => (
              <TH
                key={d.id}
                align={d.align}
                className="sticky top-0 z-20 bg-table-head px-3!"
                hint={d.id === 'priority' && fold ? 'Priority score (0-100) and segment' : d.hint}
                sortable={!!d.sort}
                sortDirection={d.sort && sort.by === d.sort ? sort.dir : null}
                onSort={d.sort ? () => onSort(d.sort!) : undefined}
              >
                {d.header}
              </TH>
            ))}
            <th aria-hidden className="sticky top-0 right-0 z-20 w-0 border-b border-border bg-table-head p-0" />
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {loading && items.length === 0 && <SkeletonRows count={10} columns={visible.length} compact={compact} />}
          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={colCount} className="p-0">{empty}</td>
            </tr>
          )}
          {items.map((lead, index) => {
            const isSelected = selected.has(lead.id);
            const fl = flash.get(lead.id);
            const chips = chipsFor(lead);
            return (
              <tr
                key={lead.id}
                ref={(el) => {
                  if (el) rows.current.set(lead.id, el);
                  else rows.current.delete(lead.id);
                }}
                tabIndex={index === active ? 0 : -1}
                aria-label={`${lead.businessName}${isSelected ? ', selected' : ''}`}
                data-lead-id={lead.id}
                data-flash={fl}
                onClick={(e) => onRowClick(e, lead, index)}
                onFocus={(e) => e.target === e.currentTarget && setActive(index)}
                className={cn(
                  'group scroll-mt-10 cursor-pointer outline-none [&>td]:border-b [&>td]:border-divider',
                  fl === 'on' ? 'bg-warning-soft' : isSelected ? 'bg-accent-soft' : 'bg-surface hover:bg-hover',
                  'focus-visible:[&>td:first-child]:shadow-[inset_3px_0_0_var(--c-accent)]',
                )}
                style={{ transition: fl === 'on' ? 'none' : fl === 'fading' ? 'background-color 900ms ease-out' : 'background-color 120ms' }}
              >
                <td className={cn('sticky left-0 z-[2] bg-inherit pr-1 pl-4 align-middle', cellY)}>
                  <Checkbox
                    label={`Select ${lead.businessName}`}
                    checked={isSelected}
                    onChange={(c, shift) => onSelect(lead.id, c, shift)}
                  />
                </td>
                <td className={cn('sticky left-10 z-[2] overflow-hidden bg-inherit px-3.5 align-middle', cellY, scrolledX && STICKY_EDGE)}>
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      to={`/leads/${lead.id}`}
                      tabIndex={-1}
                      className={cn(
                        'font-semibold text-fg underline-offset-2 hover:underline',
                        // Comfortable rows wrap long names onto a second line instead of cutting them off.
                        compact ? 'min-w-0 truncate' : 'line-clamp-2 leading-snug break-words',
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                          e.preventDefault();
                          onOpen(lead);
                        }
                      }}
                    >
                      {lead.businessName}
                    </Link>
                    {showUpdatedInline && lead.updatedInLastPoll && (
                      <Tooltip content="New or changed in the latest pipeline run" describe={false}>
                        <span className="inline-flex shrink-0 items-center">
                          <span aria-hidden className="size-2 rounded-full bg-info" />
                          <span className="sr-only">Updated</span>
                        </span>
                      </Tooltip>
                    )}
                    {lead.accountStatus !== 'prospect' && (
                      <Badge variant={lead.accountStatus === 'do_not_contact' ? 'danger' : lead.accountStatus === 'lapsed_customer' ? 'warning' : 'success'} className="shrink-0">
                        {ACCOUNT_STATUS_LABELS[lead.accountStatus]}
                      </Badge>
                    )}
                    {compact && folded.has('tags') && chips.length > 0 && <TagCount chips={chips} />}
                  </div>
                  {!compact && (
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                      <CompanyMeta lead={lead} className="max-w-full" />
                      {folded.has('rating') && lead.rating != null && <Rating rating={lead.rating} reviews={lead.reviewCount} size="xs" />}
                      {/* The Why column often says "GAF Master Elite" already. */}
                      {folded.has('gaf') && lead.tier && !(columns.includes('reasons') && reasonsMentionGaf(lead)) && <GafTier tier={lead.tier} size="xs" />}
                      {folded.has('owner') && <Owner rep={lead.assignedRep} userId={user?.id} size="xs" />}
                    </div>
                  )}
                  {!compact && folded.has('tags') && chips.length > 0 && <TagChips chips={chips} max={2} className="mt-2" />}
                </td>
                {visible.map((d) => (
                  <td
                    key={d.id}
                    className={cn(
                      'overflow-hidden px-2.5 align-middle',
                      cellY,
                      d.align === 'right' ? 'text-right' : d.align === 'center' ? 'text-center' : 'text-left',
                    )}
                  >
                    {d.id === 'priority' && folded.has('segment') ? (
                      <div className="flex flex-col gap-1">
                        {d.render(lead)}
                        <SegmentLabel segment={lead.segment} />
                      </div>
                    ) : d.render(lead)}
                  </td>
                ))}
                <td className="sticky right-0 z-[3] w-0 p-0 align-middle">
                  <div
                    className={cn(
                      'absolute top-1/2 right-3 -translate-y-1/2 transition-opacity',
                      'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
                      'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                      'has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100',
                      '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
                    )}
                  >
                    <RowActions lead={lead} readOnlyReason={readOnlyReason(user, lead)} actions={actions} variant="table" />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

/** The first two ranking reasons (what the Why column shows) include the GAF tier. */
const reasonsMentionGaf = (lead: LeadSummary) => (lead.priorityDrivers ?? []).slice(0, 2).includes('GAF tier');

/** Compact rows have no room for chips: one quiet count, the names in the tooltip. */
function TagCount({ chips }: { chips: readonly ChipTag[] }) {
  const custom = chips.some((c) => c.kind === 'custom');
  return (
    <Tooltip content={chips.map((c) => c.label).join(', ')} describe={false}>
      <span
        className={cn(
          'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium tabular',
          custom ? 'border-accent/20 bg-accent-soft text-accent' : 'border-border bg-surface text-muted',
        )}
      >
        <Tag className="size-3" aria-hidden />
        {chips.length}
        <span className="sr-only">{chips.length === 1 ? 'tag' : 'tags'}: {chips.map((c) => c.label).join(', ')}</span>
      </span>
    </Tooltip>
  );
}

function SkeletonRows({ count, columns, compact }: { count: number; columns: number; compact: boolean }) {
  const widths = ['w-20', 'w-16', 'w-36', 'w-24', 'w-20', 'w-16', 'w-24', 'w-14', 'w-12', 'w-12'];
  return (
    <>
      {Array.from({ length: count }, (_, r) => (
        <tr key={r} aria-hidden="true" className="[&>td]:border-b [&>td]:border-divider">
          <td className="py-3.5 pr-1 pl-4"><Skeleton className="size-4 rounded" /></td>
          <td className={cn('px-3.5', compact ? 'py-2' : 'py-3.5')}>
            <Skeleton className="h-3.5 w-44" style={{ width: `${55 + ((r * 37) % 35)}%` }} />
            {!compact && <Skeleton className="mt-2 h-2.5 w-24" />}
          </td>
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className="px-2.5 py-3.5"><Skeleton className={cn('h-3.5 max-w-full', widths[c % widths.length])} /></td>
          ))}
          <td className="p-0" />
        </tr>
      ))}
    </>
  );
}
