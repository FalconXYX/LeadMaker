import { Inbox, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Skeleton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import type { RepLoad } from './lib';
import type { QueueScope } from './params';

interface TeamLoadStripProps {
  reps: RepLoad[];
  pool: { size: number | null; updatedInLastPoll: number | null };
  maxAllocated: number;
  scope: QueueScope;
  onSelect: (scope: QueueScope) => void;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  kpiRefreshedAt: string | null;
}

/** One card per rep (allocated, unchecked, unserviced, load bar) plus the pool; a card switches the queue's scope. */
export function TeamLoadStrip({
  reps, pool, maxAllocated, scope, onSelect, isLoading, error, onRetry, kpiRefreshedAt,
}: TeamLoadStripProps) {
  const totalLeads = (pool.size ?? 0) + reps.reduce((n, r) => n + r.allocated, 0);
  return (
    <section aria-labelledby="team-load-heading" className="mb-6 lg:mb-7">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="team-load-heading" className="text-sm font-semibold text-fg">Team load</h2>
        {kpiRefreshedAt && (
          <Tooltip content="Lead counts are live; checked and serviced counts refresh every few minutes.">
            <p className="text-xs text-subtle">Checked / serviced as of {formatRelative(kpiRefreshedAt)}</p>
          </Tooltip>
        )}
      </div>
      {error && !reps.length ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <span className="text-muted">Couldn't load your team's workload.</span>
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
            <RefreshCw className="size-3.5" aria-hidden /> Try again
          </button>
        </div>
      ) : (
        <div
          className={cn(
            '-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0',
            'sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(210px,1fr))]',
          )}
        >
          {isLoading && !reps.length ? (
            Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)
          ) : (
            <>
              <PoolCard
                size={pool.size}
                updated={pool.updatedInLastPoll}
                share={totalLeads ? (pool.size ?? 0) / totalLeads : 0}
                selected={scope === 'unallocated'}
                onClick={() => onSelect('unallocated')}
              />
              {reps.map((r) => (
                <RepCard
                  key={r.id}
                  rep={r}
                  max={maxAllocated}
                  average={reps.reduce((n, x) => n + x.allocated, 0) / reps.length}
                  selected={typeof scope === 'object' && scope.repId === r.id}
                  onClick={() => onSelect({ repId: r.id })}
                />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const cardClasses = (selected: boolean) => cn(
  'group relative flex w-[78vw] max-w-[260px] shrink-0 snap-start flex-col rounded-xl border bg-surface p-4 text-left shadow-sm transition-[border-color,box-shadow] sm:w-auto sm:max-w-none',
  'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
  selected ? 'border-accent ring-1 ring-accent' : 'border-border',
);

/** Shows "+3" / "−2" for a few seconds after a count changes (live refresh feedback). */
function useDelta(value: number | null): number {
  const prev = useRef(value);
  const [delta, setDelta] = useState(0);
  useEffect(() => {
    if (value !== null && prev.current !== null && value !== prev.current) {
      setDelta(value - prev.current);
      const t = setTimeout(() => setDelta(0), 4000);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return delta;
}

function DeltaChip({ delta }: { delta: number }) {
  if (!delta) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'rounded-full px-1.5 py-px text-[11px] font-semibold tabular animate-[lm-pop-in_160ms_ease-out]',
        delta > 0 ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning',
      )}
    >
      {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
    </span>
  );
}

function Meter({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-accent-soft" aria-label={label} role="img">
      <span
        className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${pct > 0 ? Math.max(pct, 3) : 0}%` }}
      />
    </span>
  );
}

function RepCard({ rep, max, average, selected, onClick }: { rep: RepLoad; max: number; average: number; selected: boolean; onClick: () => void }) {
  const delta = useDelta(rep.allocated);
  const share = rep.allocated / max;
  const vsAvg = Math.round(rep.allocated - average);
  const loadLabel = vsAvg === 0 ? 'At the team average' : `${Math.abs(vsAvg)} ${vsAvg > 0 ? 'above' : 'below'} the team average`;
  const stat = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${rep.name}: ${rep.allocated} leads, ${stat(rep.unchecked)} unchecked, ${stat(rep.unserviced)} unserviced. ${loadLabel}. Show their leads.`}
      className={cardClasses(selected)}
    >
      <span className="flex items-center gap-2.5">
        <Avatar name={rep.name} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{rep.name}</span>
          <span className="block truncate text-xs text-muted">{loadLabel}</span>
        </span>
      </span>
      <span className="mt-3 flex items-baseline gap-1.5">
        <span className="text-2xl leading-none font-semibold tracking-tight text-fg">{rep.allocated.toLocaleString('en-US')}</span>
        <span className="text-xs text-muted">{rep.allocated === 1 ? 'lead' : 'leads'}</span>
        <DeltaChip delta={delta} />
      </span>
      <Meter fraction={share} label={loadLabel} />
      <span className="mt-2.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
        <span><span className="font-medium text-fg tabular">{stat(rep.unchecked)}</span> unchecked</span>
        <span><span className="font-medium text-fg tabular">{stat(rep.unserviced)}</span> unserviced</span>
      </span>
    </button>
  );
}

function PoolCard({ size, updated, share, selected, onClick }: {
  size: number | null; updated: number | null; share: number; selected: boolean; onClick: () => void;
}) {
  const delta = useDelta(size);
  const label = `${Math.round(share * 100)}% of all leads are unallocated`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`Unallocated pool: ${size ?? 'unknown'} leads${updated ? `, ${updated} updated in the last poll` : ''}. Show the queue.`}
      className={cardClasses(selected)}
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Inbox className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">Unallocated pool</span>
          <span className="block truncate text-xs text-muted">{label}</span>
        </span>
      </span>
      <span className="mt-3 flex items-baseline gap-1.5">
        <span className="text-2xl leading-none font-semibold tracking-tight text-fg">{size === null ? '—' : size.toLocaleString('en-US')}</span>
        <span className="text-xs text-muted">{size === 1 ? 'lead' : 'leads'}</span>
        <DeltaChip delta={delta} />
      </span>
      <Meter fraction={share} label={label} />
      <span className="mt-2.5 flex flex-wrap gap-x-3 text-xs text-muted">
        {updated !== null
          ? <span><span className="font-medium text-info tabular">{updated.toLocaleString('en-US')}</span> new or changed in last poll</span>
          : <span>Waiting for the next pipeline run</span>}
      </span>
    </button>
  );
}

function CardSkeleton() {
  return (
    <div className="w-[78vw] max-w-[260px] shrink-0 rounded-xl border border-border bg-surface p-3.5 shadow-sm sm:w-auto sm:max-w-none" aria-hidden="true">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-[30px] rounded-full" />
        <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-24" /><Skeleton className="h-2.5 w-32" /></div>
      </div>
      <Skeleton className="mt-3 h-6 w-14" />
      <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      <Skeleton className="mt-2.5 h-2.5 w-36" />
    </div>
  );
}
