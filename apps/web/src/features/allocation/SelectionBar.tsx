import { ArrowRightLeft, ChevronUp, Undo2, UserPlus, X } from 'lucide-react';
import type { LeadSummary } from '@/api/types';
import { Badge, Button, Menu, segmentVariant } from '@/components/ui';
import { segmentBreakdown, type RepLoad } from './lib';

interface SelectionBarProps {
  count: number;
  known: LeadSummary[];
  reps: RepLoad[];
  /** The rep whose list is shown (rep scope), else null. */
  ownerId: string | null;
  onAssignTo: (repId: string) => void;
  onReturnToPool: () => void;
  onClear: () => void;
  pending: boolean;
}

/** Floating bar for the current selection: Assign to… (rep menu), Return to pool, Clear. */
export function SelectionBar({ count, known, reps, ownerId, onAssignTo, onReturnToPool, onClear, pending }: SelectionBarProps) {
  const segments = known.length === count ? segmentBreakdown(known) : [];
  const anyAssigned = !!ownerId || known.some((l) => l.assignedRep);
  const verb = anyAssigned ? 'Reassign' : 'Assign';
  return (
    <div
      role="region"
      aria-label="Selected leads"
      className="sticky bottom-2 z-20 mt-3 mr-14 flex items-center gap-2 rounded-xl border border-border bg-surface py-2 pr-2 pl-2.5 shadow-lg animate-[lm-pop-in_140ms_ease-out] md:bottom-4 md:mr-0"
    >
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg" aria-live="polite">
          <span className="tabular">{count.toLocaleString('en-US')}</span> selected
        </p>
        {segments.length > 0 && (
          <div className="mt-0.5 hidden flex-wrap gap-1 sm:flex">
            {segments.map((s) => <Badge key={s.label} variant={s.segment ? segmentVariant(s.segment) : 'neutral'}>{s.count} {s.label}</Badge>)}
          </div>
        )}
      </div>
      {ownerId && (
        <Button size="sm" variant="ghost" leftIcon={<Undo2 className="size-3.5" aria-hidden />} onClick={onReturnToPool} disabled={pending} className="max-sm:px-2">
          <span className="max-sm:sr-only">Return to pool</span>
        </Button>
      )}
      <Menu
        align="end"
        // The bar sits at the bottom of the screen: open the menu upwards.
        className="top-auto! bottom-full! mt-0! mb-1.5 w-64"
        header={<div className="text-xs font-medium text-muted">{verb} {count === 1 ? 'this lead' : `${count} leads`} to…</div>}
        items={reps
          .filter((r) => r.id !== ownerId)
          .map((r) => ({
            label: (
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate">{r.name}</span>
                <span className="text-xs text-subtle tabular">{r.allocated} leads</span>
              </span>
            ),
            icon: anyAssigned ? <ArrowRightLeft /> : <UserPlus />,
            onSelect: () => onAssignTo(r.id),
          }))}
        trigger={(props) => (
          <Button {...props} size="sm" variant="primary" disabled={pending || !reps.length} rightIcon={<ChevronUp className="size-3.5" aria-hidden />}>
            {verb} to…
          </Button>
        )}
      />
    </div>
  );
}
