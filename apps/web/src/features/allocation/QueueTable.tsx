import { ArrowRightLeft, ExternalLink, History, MoreHorizontal, Undo2, UserPlus } from 'lucide-react';
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { LeadSummary } from '@/api/types';
import {
  Badge, Menu, PriorityMeter, SegmentBadge, SkeletonRows, SystemTagBadge, TBody, TD, TH, THead, TR, Tooltip, UpdatedBadge,
  type MenuItem,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { rankingReasons } from '@/lib/reasons';
import { countyPlace, countyPlaceShort } from '@/lib/counties';
import type { RepLoad } from './lib';
import type { QueueScope } from './params';

export interface RowActions {
  reps: RepLoad[];
  scope: QueueScope;
  onAssign: (lead: LeadSummary, repId: string) => void;
  onReturnToPool: (lead: LeadSummary) => void;
  onHistory: (lead: LeadSummary) => void;
}

interface QueueTableProps {
  rows: LeadSummary[];
  isLoading: boolean;
  selected: ReadonlyMap<string, unknown>;
  onToggle: (lead: LeadSummary, index: number, checked: boolean, shiftKey: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  sort: { by: string; dir: 'asc' | 'desc' };
  onSort: (by: 'priority_score' | 'last_change') => void;
  actions: RowActions;
  /** Rendered in place of the rows (empty / error states). */
  empty?: ReactNode;
}

const isInteractive = (el: EventTarget | null) =>
  el instanceof Element && !!el.closest('a,button,input,label,select,textarea,[role="menu"]');

/** The queue as a table (md and up) or a card list (phones). Clicking a row toggles it. */
export function QueueTable({ rows, isLoading, selected, onToggle, onToggleAll, sort, onSort, actions, empty }: QueueTableProps) {
  const repScope = typeof actions.scope === 'object';
  const visibleSelected = rows.filter((r) => selected.has(r.id)).length;
  const all = rows.length > 0 && visibleSelected === rows.length;
  const some = visibleSelected > 0 && !all;
  const sortDir = (by: string) => (sort.by === by ? sort.dir : null);
  const cols = repScope ? 7 : 6;

  return (
    <>
      {/* md and up: table */}
      <table className="hidden w-full border-collapse text-sm md:table">
        <caption className="sr-only">{repScope ? 'Leads allocated to this rep' : 'Unallocated leads'}; click a row to select it.</caption>
        <THead>
          <tr>
            <TH className="w-10 pr-0 pl-5">
              <HeaderCheckbox checked={all} indeterminate={some} disabled={!rows.length} onChange={onToggleAll} />
            </TH>
            <TH>Lead</TH>
            <TH sortable sortDirection={sortDir('priority_score')} onSort={() => onSort('priority_score')} className="w-[7.5rem]">Priority</TH>
            <TH className="w-[8.5rem]">County / ZIP</TH>
            <TH className="hidden @3xl:table-cell">Top reasons</TH>
            {repScope && <TH className="hidden w-28 @4xl:table-cell">Rep activity</TH>}
            <TH className="w-12 pr-4"><span className="sr-only">Actions</span></TH>
          </tr>
        </THead>
        <TBody>
          {isLoading ? (
            <SkeletonRows rows={8} columns={cols - 1} />
          ) : rows.length === 0 ? (
            <tr><td colSpan={cols}>{empty}</td></tr>
          ) : (
            rows.map((lead, i) => {
              const isSel = selected.has(lead.id);
              return (
                <TR
                  key={lead.id}
                  selected={isSel}
                  interactive
                  // TR's own bg-surface can outrank its selected colour in the generated CSS order.
                  className={isSel ? 'bg-accent-soft! hover:bg-accent-soft!' : undefined}
                  onClick={(e: MouseEvent) => {
                    if (isInteractive(e.target)) return;
                    onToggle(lead, i, !isSel, e.shiftKey);
                  }}
                >
                  <TD className="pr-0 pl-5">
                    <RowCheckbox lead={lead} checked={isSel} onChange={(c, shift) => onToggle(lead, i, c, shift)} />
                  </TD>
                  <TD className="max-w-0 min-w-[13rem]">
                    <Link to={`/leads/${lead.id}`} className="line-clamp-2 leading-snug font-medium break-words text-fg hover:text-accent hover:underline">
                      {lead.businessName}
                    </Link>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      <span className="min-w-0 truncate">
                        {[lead.city, lead.state].filter(Boolean).join(', ') || '—'}
                        {lead.rating != null && <> · {lead.rating.toFixed(1)}★ ({lead.reviewCount})</>}
                      </span>
                      {lead.updatedInLastPoll && <UpdatedBadge className="shrink-0" />}
                    </div>
                    <Reasons lead={lead} max={2} className="mt-1.5 @3xl:hidden" />
                  </TD>
                  <TD><Priority lead={lead} /></TD>
                  <TD>
                    <Tooltip content={countyPlace(lead.countyFips, { state: true })} describe={false}>
                      <div className="truncate text-fg">{countyPlaceShort(lead.countyFips)}</div>
                    </Tooltip>
                    <div className="text-xs text-muted tabular">{lead.postalCode ?? '—'}</div>
                  </TD>
                  <TD className="hidden @3xl:table-cell"><Reasons lead={lead} /></TD>
                  {repScope && <TD className="hidden @4xl:table-cell"><RepActivity lead={lead} /></TD>}
                  <TD className="pr-4 text-right"><RowMenu lead={lead} actions={actions} /></TD>
                </TR>
              );
            })
          )}
        </TBody>
      </table>

      {/* Phones: cards */}
      <div className="md:hidden">
        {isLoading ? (
          <ul className="divide-y divide-border" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="flex gap-3 px-4 py-3.5">
                <div className="mt-0.5 size-4 rounded bg-surface-3" />
                <div className="flex-1 space-y-2"><div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-3" /><div className="h-3 w-1/2 animate-pulse rounded bg-surface-3" /></div>
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          empty
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-border bg-surface-2 px-4 py-2.5 text-xs font-medium text-muted">
              <HeaderCheckbox checked={all} indeterminate={some} disabled={!rows.length} onChange={onToggleAll} />
              <span>{all ? 'Deselect all' : 'Select all'} ({rows.length} shown)</span>
            </div>
            <ul className="divide-y divide-border">
              {rows.map((lead, i) => {
                const isSel = selected.has(lead.id);
                return (
                  <li
                    key={lead.id}
                    className={cn('flex gap-3 px-4 py-3.5 transition-colors', isSel ? 'bg-accent-soft' : 'bg-surface active:bg-surface-2')}
                    onClick={(e) => {
                      if (isInteractive(e.target)) return;
                      onToggle(lead, i, !isSel, false);
                    }}
                  >
                    <div className="pt-0.5"><RowCheckbox lead={lead} checked={isSel} onChange={(c) => onToggle(lead, i, c, false)} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <Link to={`/leads/${lead.id}`} className="min-w-0 flex-1 truncate font-medium text-fg">{lead.businessName}</Link>
                        <span className="shrink-0 font-semibold text-fg tabular">{lead.priorityScore != null ? Math.round(lead.priorityScore) : '—'}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <SegmentBadge segment={lead.segment} />
                        {lead.updatedInLastPoll && <UpdatedBadge />}
                        <span>{countyPlaceShort(lead.countyFips)} · {lead.postalCode ?? '—'}</span>
                        {repScope && <RepActivity lead={lead} />}
                      </div>
                      <Reasons lead={lead} max={2} className="mt-1.5" />
                    </div>
                    <div className="-mr-1.5 -mt-1"><RowMenu lead={lead} actions={actions} /></div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function HeaderCheckbox({ checked, indeterminate, disabled, onChange }: { checked: boolean; indeterminate: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={checked ? 'Deselect all shown leads' : 'Select all shown leads'}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 cursor-pointer align-middle accent-accent disabled:cursor-not-allowed"
    />
  );
}

function RowCheckbox({ lead, checked, onChange }: { lead: LeadSummary; checked: boolean; onChange: (checked: boolean, shiftKey: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${lead.businessName}`}
      checked={checked}
      // onClick (not onChange) so shift-click can select a range; Space also fires click.
      onClick={(e) => onChange(e.currentTarget.checked, e.shiftKey)}
      onChange={() => {}}
      className="size-4 cursor-pointer align-middle accent-accent"
    />
  );
}

export function Priority({ lead }: { lead: Pick<LeadSummary, 'priorityScore' | 'segment'> }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <PriorityMeter score={lead.priorityScore} segment={lead.segment} />
      <SegmentBadge segment={lead.segment} />
    </div>
  );
}

/** The same phrasing as the lead list's Why column ("GAF Master Elite", "200+ reviews"). */
function Reasons({ lead, max = 3, className }: { lead: Pick<LeadSummary, 'priorityDrivers' | 'tags'>; max?: number; className?: string }) {
  const reasons = rankingReasons(lead, max);
  if (!reasons.length) return <span className={cn('text-xs text-subtle', className)}>—</span>;
  return (
    <ul className={cn('flex flex-wrap gap-1', className)} aria-label="Top ranking reasons">
      {reasons.map((r) => <li key={r.driver} className="min-w-0 max-w-full"><SystemTagBadge label={r.label} reason={`Ranking reason: ${r.driver}`} /></li>)}
    </ul>
  );
}

function RepActivity({ lead }: { lead: LeadSummary }) {
  // Same colours as the checked / serviced toggles everywhere else: checked green, serviced blue.
  if (lead.team?.serviced) return <Badge variant="accent">Serviced</Badge>;
  if (lead.team?.checked) return <Badge variant="success">Checked</Badge>;
  return <Badge variant="neutral">Not started</Badge>;
}

function RowMenu({ lead, actions }: { lead: LeadSummary; actions: RowActions }) {
  const ownerId = typeof actions.scope === 'object' ? actions.scope.repId : lead.assignedRep?.id ?? null;
  const items: MenuItem[] = [
    ...actions.reps
      .filter((r) => r.id !== ownerId)
      .map((r) => ({
        label: (
          <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
            <span className="truncate">{ownerId ? 'Reassign to' : 'Assign to'} {r.name}</span>
            <span className="text-xs text-subtle tabular">{r.allocated}</span>
          </span>
        ),
        icon: ownerId ? <ArrowRightLeft /> : <UserPlus />,
        onSelect: () => actions.onAssign(lead, r.id),
      })),
    ...(ownerId ? [{ label: 'Return to pool', icon: <Undo2 />, onSelect: () => actions.onReturnToPool(lead) }] : []),
    { label: 'Allocation history', icon: <History />, onSelect: () => actions.onHistory(lead) },
  ];
  return (
    <Menu
      align="end"
      className="w-64 text-left"
      items={items}
      header={<div className="truncate text-xs font-medium text-muted">{lead.businessName}</div>}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`Actions for ${lead.businessName}`}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      )}
    />
  );
}

export function OpenProfileLink({ id }: { id: string }) {
  return (
    <Link to={`/leads/${id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
      Open full profile <ExternalLink className="size-3.5" aria-hidden />
    </Link>
  );
}
