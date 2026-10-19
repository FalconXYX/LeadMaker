import { ArrowRightLeft, Inbox, Undo2, UserPlus } from 'lucide-react';
import { useLead } from '@/api/queries';
import type { AllocationEntry, LeadSummary } from '@/api/types';
import { Avatar, Badge, Button, Drawer, ErrorState, SegmentBadge, Skeleton, Tooltip } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { countyPlace } from '@/lib/counties';
import type { RepLoad } from './lib';
import { OpenProfileLink } from './QueueTable';

interface HistoryDrawerProps {
  lead: LeadSummary | null;
  onClose: () => void;
  reps: RepLoad[];
  onAssign: (lead: LeadSummary, repId: string) => void;
  onReturnToPool: (lead: LeadSummary) => void;
  pending: boolean;
}

/** Quick view of one lead's ownership: who has it now, every past allocation, and reassign actions. */
export function HistoryDrawer({ lead, onClose, reps, onAssign, onReturnToPool, pending }: HistoryDrawerProps) {
  const { data, isLoading, error, refetch } = useLead(lead?.id);
  const current = data?.allocation?.current ?? null;
  const history = [...(data?.allocation?.history ?? [])]
    .filter((h) => !current || h.allocatedAt !== current.allocatedAt || h.rep.id !== current.rep.id)
    .sort((a, b) => b.allocatedAt.localeCompare(a.allocatedAt));
  const ownerId = current?.rep.id ?? lead?.assignedRep?.id ?? null;

  return (
    <Drawer
      open={!!lead}
      onClose={onClose}
      width="sm"
      title={lead?.businessName ?? ''}
      description={lead ? [`${[lead.city, lead.state].filter(Boolean).join(', ')} ${lead.postalCode ?? ''}`.trim(), countyPlace(lead.countyFips)].filter(Boolean).join(' · ') : undefined}
    >
      {lead && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentBadge segment={lead.segment} />
            {lead.priorityScore != null && <Badge variant="neutral">Priority {Math.round(lead.priorityScore)}</Badge>}
            <span className="ml-auto"><OpenProfileLink id={lead.id} /></span>
          </div>

          <section aria-labelledby="hist-owner">
            <h3 id="hist-owner" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Current owner</h3>
            {isLoading ? (
              <Skeleton className="h-14 w-full rounded-lg" />
            ) : current ? (
              <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                <Avatar name={current.rep.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{current.rep.name}</div>
                  <div className="text-xs text-muted">
                    Since {formatRelative(current.allocatedAt)} · by {current.allocatedBy.name}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-sm text-muted">
                <Inbox className="size-4" aria-hidden /> In the unallocated pool
              </div>
            )}
          </section>

          <section aria-labelledby="hist-actions">
            <h3 id="hist-actions" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
              {ownerId ? 'Reassign' : 'Assign'}
            </h3>
            <div className="flex flex-wrap gap-2">
              {reps.filter((r) => r.id !== ownerId).map((r) => (
                <Button
                  key={r.id}
                  size="sm"
                  disabled={pending}
                  leftIcon={ownerId ? <ArrowRightLeft className="size-3.5" aria-hidden /> : <UserPlus className="size-3.5" aria-hidden />}
                  onClick={() => onAssign(lead, r.id)}
                  aria-label={`${ownerId ? 'Reassign' : 'Assign'} to ${r.name}`}
                >
                  {r.name}
                </Button>
              ))}
              {ownerId && (
                <Button size="sm" variant="ghost" disabled={pending} leftIcon={<Undo2 className="size-3.5" aria-hidden />} onClick={() => onReturnToPool(lead)}>
                  Return to pool
                </Button>
              )}
            </div>
          </section>

          <section aria-labelledby="hist-timeline">
            <h3 id="hist-timeline" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Allocation history</h3>
            {isLoading ? (
              <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
            ) : error ? (
              <ErrorState message="Couldn't load this lead's history." onRetry={() => void refetch()} className="py-4" />
            ) : !current && history.length === 0 ? (
              <p className="text-sm text-muted">Never allocated. Notes, overrides and tags stay with the lead when it moves.</p>
            ) : (
              <ol className="relative ml-3 border-l border-border">
                {current && <TimelineItem entry={current} active />}
                {history.map((h, i) => <TimelineItem key={`${h.allocatedAt}-${i}`} entry={h} />)}
              </ol>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function TimelineItem({ entry, active }: { entry: AllocationEntry; active?: boolean }) {
  return (
    <li className="relative pb-4 pl-5 last:pb-0">
      <span
        className={active ? 'absolute top-1 -left-[5px] size-2.5 rounded-full bg-accent ring-4 ring-surface' : 'absolute top-1 -left-[4px] size-2 rounded-full bg-border-strong ring-4 ring-surface'}
        aria-hidden="true"
      />
      <div className="text-sm text-fg">
        <span className="font-medium">{entry.rep.name}</span>
        {active && <Badge variant="accent" className="ml-2">Current</Badge>}
      </div>
      <div className="mt-0.5 text-xs text-muted">
        Allocated by {entry.allocatedBy.name} · <Tooltip content={formatDateTime(entry.allocatedAt)} describe={false}><time dateTime={entry.allocatedAt}>{formatRelative(entry.allocatedAt)}</time></Tooltip>
      </div>
      {entry.endedAt && (
        <div className="text-xs text-subtle">
          Ended {formatRelative(entry.endedAt)}{entry.endedBy ? ` by ${entry.endedBy.name}` : ''}
        </div>
      )}
    </li>
  );
}
