import { Check, ChevronDown, Lightbulb, MapPin, Undo2, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { AllocationSuggestion, AllocationSuggestionsResponse } from '@/api/types';
import { Avatar, Badge, Button, Dialog, EmptyState, ErrorState, Select, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { safeStorage } from '@/lib/storage';
import { LoadRow } from './AssignDialog';
import { countyPlace, humanizeCountyRefs } from '@/lib/counties';

const countyLabel = (fips: string | null | undefined) => countyPlace(fips, { state: true });
import { firstName, plural, type RepLoad } from './lib';

export const suggestionKey = (s: Pick<AllocationSuggestion, 'basis' | 'key' | 'repId'>) => `${s.basis}|${s.key ?? '-'}|${s.repId}`;
const dismissedStorageKey = (userId: string) => `leadmaker.allocation.dismissed.${userId}`;

/** Dismissed suggestion keys, kept per user in localStorage (safeStorage). */
export function useDismissedSuggestions(userId: string) {
  const [keys, setKeys] = useState<string[]>(() => safeStorage.getJson<string[]>(dismissedStorageKey(userId)) ?? []);
  const save = useCallback((next: string[]) => {
    const capped = next.slice(-500);
    setKeys(capped);
    safeStorage.setJson(dismissedStorageKey(userId), capped);
  }, [userId]);
  return {
    dismissed: useMemo(() => new Set(keys), [keys]),
    dismiss: (k: string) => save([...keys.filter((x) => x !== k), k]),
    restore: (k: string) => save(keys.filter((x) => x !== k)),
    restoreAll: () => save([]),
  };
}

interface SuggestionsPanelProps {
  userId: string;
  data: AllocationSuggestionsResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  reps: RepLoad[];
  onApprove: (groups: { companyIds: string[]; repId: string }[], label: string) => Promise<unknown>;
  pending: boolean;
  className?: string;
}

type SortMode = 'priority' | 'size';

/** Suggested allocations grouped by ZIP / county: approve, change the rep, dismiss, or approve all. */
export function SuggestionsPanel({ userId, data, isLoading, error, onRetry, reps, onApprove, pending, className }: SuggestionsPanelProps) {
  const { dismissed, dismiss, restoreAll } = useDismissedSuggestions(userId);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortMode>('priority');
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const all = data?.suggestions ?? [];
  const visible = useMemo(() => {
    const list = all.filter((s) => !dismissed.has(suggestionKey(s)));
    return sort === 'size' ? [...list].sort((a, b) => b.companyIds.length - a.companyIds.length) : list;
  }, [all, dismissed, sort]);
  const hiddenCount = all.length - visible.length;
  const visibleLeads = visible.reduce((n, s) => n + s.companyIds.length, 0);
  const repOf = (s: AllocationSuggestion) => overrides[suggestionKey(s)] ?? s.repId;

  const approveOne = async (s: AllocationSuggestion) => {
    const k = suggestionKey(s);
    setBusyKey(k);
    try {
      await onApprove([{ companyIds: s.companyIds, repId: repOf(s) }], `Approved ${groupTitle(s)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const approveAll = async () => {
    setBusyKey('*');
    try {
      await onApprove(visible.map((s) => ({ companyIds: s.companyIds, repId: repOf(s) })), `Approved ${plural(visible.length, 'suggestion')}`);
      setConfirmAll(false);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section aria-labelledby="suggestions-heading" className={cn('flex min-h-0 flex-col rounded-xl border border-border bg-surface shadow-sm', className)}>
      <header className="border-b border-border px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Lightbulb className="size-4 shrink-0 text-warning" aria-hidden />
            <h2 id="suggestions-heading" className="truncate text-sm font-semibold text-fg">Suggestions</h2>
            {visible.length > 0 && <Badge variant="accent">{visible.length}</Badge>}
          </div>
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Check className="size-3.5" aria-hidden />}
            disabled={!visible.length || pending}
            onClick={() => setConfirmAll(true)}
          >
            Approve all
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Grouped by ZIP and county so each rep's territory stays together.
          {data && data.considered < data.unallocatedTotal && <> Covers the top {data.considered.toLocaleString('en-US')} of {data.unallocatedTotal.toLocaleString('en-US')} pool leads.</>}
        </p>
        {visible.length > 1 && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{plural(visibleLeads, 'lead')} in {plural(visible.length, 'group')}</span>
            <Select<SortMode>
              aria-label="Sort suggestions"
              selectSize="sm"
              className="w-36"
              value={sort}
              onValueChange={setSort}
              options={[{ value: 'priority', label: 'Top priority' }, { value: 'size', label: 'Most leads' }]}
            />
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3.5 sm:p-4">
        {isLoading ? (
          <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading suggestions">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="rounded-lg border border-border p-3.5">
                <Skeleton className="h-3.5 w-40" />
                <div className="mt-3 flex items-center gap-2"><Skeleton className="size-6 rounded-full" /><Skeleton className="h-3 w-28" /></div>
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-3 h-7 w-32" />
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorState message="Suggestions are unavailable right now." onRetry={onRetry} />
        ) : visible.length === 0 ? (
          all.length === 0 ? (
            <EmptyState
              compact
              icon={<Check />}
              title={data?.unallocatedTotal ? 'No suggestions right now' : 'The pool is empty'}
              description={data?.unallocatedTotal ? 'Assign leads from the queue instead.' : 'Every lead has an owner. New leads land here after each pipeline run.'}
            />
          ) : (
            <EmptyState
              compact
              icon={<Undo2 />}
              title="You dismissed every suggestion"
              action={<Button size="sm" onClick={restoreAll}>Show {plural(hiddenCount, 'dismissed suggestion')}</Button>}
            />
          )
        ) : (
          <ul className="flex flex-col gap-3.5">
            {visible.map((s) => {
              const k = suggestionKey(s);
              return (
                <SuggestionCard
                  key={k}
                  suggestion={s}
                  reps={reps}
                  repId={repOf(s)}
                  onChangeRep={(id) => setOverrides((o) => ({ ...o, [k]: id }))}
                  onResetRep={() => setOverrides(({ [k]: _drop, ...rest }) => rest)}
                  onApprove={() => void approveOne(s)}
                  onDismiss={() => dismiss(k)}
                  busy={busyKey === k}
                  disabled={pending}
                />
              );
            })}
          </ul>
        )}
        {hiddenCount > 0 && visible.length > 0 && (
          <p className="mt-3 text-center text-xs text-muted">
            {plural(hiddenCount, 'suggestion')} dismissed.{' '}
            <button type="button" onClick={restoreAll} className="font-medium text-accent hover:underline">Show again</button>
          </p>
        )}
      </div>

      <ApproveAllDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        groups={visible.map((s) => ({ repId: repOf(s), n: s.companyIds.length }))}
        reps={reps}
        onConfirm={() => void approveAll()}
        pending={busyKey === '*'}
      />
    </section>
  );
}

export function groupTitle(s: Pick<AllocationSuggestion, 'basis' | 'key' | 'leads'>): string {
  const county = s.leads.find((l) => l.countyFips)?.countyFips ?? null;
  if (s.basis === 'postal_code') return `ZIP ${s.key ?? '—'}`;
  if (s.basis === 'county') return countyLabel(s.key);
  // balance: the key is the county FIPS (or a ZIP when the lead has no county)
  if (s.key && county === s.key) return countyLabel(s.key);
  return s.key ? `ZIP ${s.key}` : 'Mixed area';
}

const BASIS_LABEL: Record<AllocationSuggestion['basis'], string> = {
  postal_code: 'Same ZIP',
  county: 'Same county',
  balance: 'Balances load',
};

function SuggestionCard({ suggestion: s, reps, repId, onChangeRep, onResetRep, onApprove, onDismiss, busy, disabled }: {
  suggestion: AllocationSuggestion;
  reps: RepLoad[];
  repId: string;
  onChangeRep: (id: string) => void;
  onResetRep: () => void;
  onApprove: () => void;
  onDismiss: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rep = reps.find((r) => r.id === repId);
  const changed = repId !== s.repId;
  const n = s.companyIds.length;
  const county = s.leads.find((l) => l.countyFips)?.countyFips ?? null;
  const subtitle = s.basis === 'postal_code' && county ? countyLabel(county) : null;
  const leads = [...s.leads].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  const shown = expanded ? leads : leads.slice(0, 3);
  const title = groupTitle(s);
  const before = rep?.allocated ?? 0;

  return (
    <li className="rounded-lg border border-border bg-surface p-3.5 transition-colors hover:border-border-strong sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <MapPin className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="truncate">{title}</span>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={s.basis === 'balance' ? 'neutral' : 'info'}>{BASIS_LABEL[s.basis]}</Badge>
            {subtitle && <span className="truncate text-xs text-muted">{subtitle}</span>}
          </div>
        </div>
        <span className="shrink-0 text-right">
          <span className="block text-lg leading-none font-semibold text-fg">{n}</span>
          <span className="text-[11px] text-muted">{n === 1 ? 'lead' : 'leads'}</span>
        </span>
      </div>

      <div className="mt-3.5 flex items-center gap-2.5 rounded-md bg-surface-2 px-2.5 py-2">
        <Avatar name={rep?.name ?? s.repName} size={24} />
        <div className="min-w-0 flex-1 text-sm leading-tight">
          <label className="relative block">
            <span className="sr-only">Rep for {title}</span>
            <select
              value={repId}
              onChange={(e) => (e.target.value === s.repId ? onResetRep() : onChangeRep(e.target.value))}
              className="w-full cursor-pointer appearance-none truncate rounded bg-transparent pr-5 font-medium text-fg hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
            >
              {reps.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-0 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          </label>
          <div className="text-xs text-muted tabular">
            {changed ? 'Your pick' : 'Suggested'} · {before.toLocaleString('en-US')} → <span className="font-medium text-fg">{(before + n).toLocaleString('en-US')}</span> leads
            {changed && <> · <button type="button" onClick={onResetRep} className="text-accent hover:underline">undo</button></>}
          </div>
        </div>
      </div>

      <p className="mt-2.5 text-xs text-muted">
        {changed && <>Suggested {firstName(s.repName)}: </>}
        {humanizeCountyRefs(s.reason)}
      </p>

      <ul className="mt-2.5 flex flex-col gap-1" aria-label={`Leads in ${title}`}>
        {shown.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-fg">{l.businessName}</span>
            <span className="shrink-0 text-muted tabular">{l.priorityScore != null ? Math.round(l.priorityScore) : '—'}</span>
          </li>
        ))}
      </ul>
      {leads.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="mt-1 text-xs font-medium text-accent hover:underline"
        >
          {expanded ? 'Show fewer' : `Show all ${leads.length}`}
        </button>
      )}

      <div className="mt-3.5 flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          leftIcon={<Check className="size-3.5 text-success" aria-hidden />}
          loading={busy}
          disabled={disabled && !busy}
          onClick={onApprove}
          aria-label={`Approve: assign ${title} (${n} ${n === 1 ? 'lead' : 'leads'}) to ${rep?.name ?? s.repName}`}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<X className="size-3.5" aria-hidden />}
          onClick={onDismiss}
          disabled={busy}
          aria-label={`Dismiss suggestion for ${title}`}
        >
          Dismiss
        </Button>
      </div>
    </li>
  );
}

function ApproveAllDialog({ open, onClose, groups, reps, onConfirm, pending }: {
  open: boolean;
  onClose: () => void;
  groups: { repId: string; n: number }[];
  reps: RepLoad[];
  onConfirm: () => void;
  pending: boolean;
}) {
  const perRep = new Map<string, number>();
  for (const g of groups) perRep.set(g.repId, (perRep.get(g.repId) ?? 0) + g.n);
  const total = groups.reduce((n, g) => n + g.n, 0);
  const rows = reps
    .filter((r) => perRep.has(r.id))
    .map((r) => ({ key: r.id, name: r.name, before: r.allocated, after: r.allocated + (perRep.get(r.id) ?? 0), highlight: true }));
  const scaleMax = Math.max(1, ...rows.map((r) => r.after));
  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      title={`Approve all ${plural(groups.length, 'suggestion')}?`}
      description={`${plural(total, 'lead')} leave the pool and go to ${plural(rows.length, 'rep')}. You can undo right after.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={onConfirm}>Approve and assign {total.toLocaleString('en-US')}</Button>
        </>
      }
    >
      <h3 className="mb-2 text-xs font-medium text-muted">Load before → after</h3>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => <LoadRow key={r.key} row={r} scaleMax={scaleMax} />)}
      </ul>
    </Dialog>
  );
}
