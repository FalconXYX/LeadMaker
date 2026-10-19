// Phone layout (< 640 px): one card per lead with what a rep needs on the road: stage, the next follow-up, when
// they last spoke, why it matters, and one-tap call / log / follow-up.
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { LeadSummary, SessionUser } from '@/api/types';
import { readOnlyReason } from '@/auth/permissions';
import { Badge, Checkbox, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ACCOUNT_STATUS_LABELS } from '@/lib/labels';
import { lastContactedOf, nextTaskOf, stageOf, type SalesStage } from '../sales';
import type { ChipTag } from '../tags';
import type { ListTimingBadge } from '../timing';
import type { FlashState } from '../useRowFlash';
import { CompanyMeta, LastContacted, NextFollowUp, Owner, PriorityScore, TagChips, Why } from './cells';
import { RowActions, type LeadActions } from './RowActions';
import { StageSelect } from './stage';

export interface LeadCardsProps {
  items: LeadSummary[];
  loading: boolean;
  refreshing: boolean;
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean, shiftKey: boolean) => void;
  flash: ReadonlyMap<string, FlashState>;
  user: Pick<SessionUser, 'id' | 'role'> | null;
  actions: LeadActions;
  showOwner: boolean;
  timingFor: (lead: LeadSummary) => ListTimingBadge[];
  chipsFor: (lead: LeadSummary) => ChipTag[];
  onOpen: (lead: LeadSummary) => void;
  empty?: ReactNode;
  footer?: ReactNode;
}

export function LeadCards(props: LeadCardsProps) {
  const { items, loading, refreshing, selected, onSelect, flash, user, actions, showOwner, timingFor, chipsFor, onOpen, empty, footer } = props;

  if (loading && items.length === 0) {
    return (
      <ul className="flex flex-col gap-3" aria-label="Loading leads">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="rounded-xl border border-border bg-surface p-4" aria-hidden>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/3" />
            <div className="mt-4 flex gap-2"><Skeleton className="h-6 w-24" /><Skeleton className="h-5 w-20" /></div>
          </li>
        ))}
      </ul>
    );
  }
  if (items.length === 0) return <div className="rounded-xl border border-border bg-surface">{empty}</div>;

  const open = (e: MouseEvent | KeyboardEvent, lead: LeadSummary) => {
    if ((e.target as HTMLElement).closest('a,button,input,label,[data-no-row-click]')) return;
    onOpen(lead);
  };

  return (
    <>
      <ul className={cn('flex flex-col gap-3', refreshing && 'opacity-60 transition-opacity')} aria-label="Leads">
        {items.map((lead) => {
          const fl = flash.get(lead.id);
          const isSelected = selected.has(lead.id);
          const chips = chipsFor(lead);
          const reason = readOnlyReason(user, lead);
          return (
            <li
              key={lead.id}
              data-lead-id={lead.id}
              className={cn(
                'rounded-xl border p-4 shadow-sm',
                fl === 'on' ? 'border-warning/40 bg-warning-soft' : isSelected ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
              )}
              style={{ transition: fl === 'on' ? 'none' : 'background-color 900ms ease-out, border-color 900ms ease-out' }}
            >
              <div
                role="link"
                tabIndex={0}
                aria-label={`Open ${lead.businessName}`}
                onClick={(e) => open(e, lead)}
                onKeyDown={(e) => e.key === 'Enter' && open(e, lead)}
                className="-m-1 cursor-pointer rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    label={`Select ${lead.businessName}`}
                    checked={isSelected}
                    onChange={(c, shift) => onSelect(lead.id, c, shift)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 text-[15px] leading-snug font-semibold text-fg">{lead.businessName}</p>
                      <PriorityScore score={lead.priorityScore} segment={lead.segment} className="shrink-0" />
                    </div>
                    <CompanyMeta lead={lead} className="mt-0.5" />
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <StageSelect
                        stage={stageOf(lead)}
                        leadName={lead.businessName}
                        readOnlyReason={reason}
                        onChange={(s: SalesStage) => actions.onStage(lead, s)}
                      />
                      {lead.accountStatus !== 'prospect' && (
                        <Badge variant={lead.accountStatus === 'do_not_contact' ? 'danger' : lead.accountStatus === 'lapsed_customer' ? 'warning' : 'success'}>
                          {ACCOUNT_STATUS_LABELS[lead.accountStatus]}
                        </Badge>
                      )}
                      {showOwner && <Owner rep={lead.assignedRep} userId={user?.id} size="xs" className="ml-auto" />}
                    </div>
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <div className="min-w-0">
                        <dt className="text-subtle">Next follow-up</dt>
                        <dd className="mt-0.5"><NextFollowUp task={nextTaskOf(lead)} showTitle={false} /></dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-subtle">Last contacted</dt>
                        <dd className="mt-0.5"><LastContacted at={lastContactedOf(lead)} /></dd>
                      </div>
                    </dl>
                    <Why lead={lead} badges={timingFor(lead)} className="mt-2.5" />
                    {chips.length > 0 && <TagChips chips={chips} className="mt-2" />}
                  </div>
                </div>
              </div>
              <div className="mt-3 border-t border-divider pt-3">
                <RowActions lead={lead} readOnlyReason={reason} actions={actions} variant="card" />
              </div>
            </li>
          );
        })}
      </ul>
      {footer}
    </>
  );
}
