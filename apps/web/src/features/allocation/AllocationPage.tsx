import { ArrowLeft, ChevronDown, ExternalLink, Inbox, Info, SearchX, Undo2, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAllocationSuggestions, useInfiniteLeadSearch, useSignals } from '@/api/queries';
import type { LeadFilter, LeadSummary } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { Avatar, Button, Card, Dialog, EmptyState, ErrorState, Menu, Spinner, useToast } from '@/components/ui';
import { Page, PageHeader } from '@/layout/PageHeader';
import { isOwnEvent } from '@/live/eventMap';
import { useLiveEvent } from '@/live/useEventStream';
import { cn } from '@/lib/cn';
import { leadsHref } from '@/lib/filterUrl';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { AssignDialog, LoadRow } from './AssignDialog';
import { activeChips, chipText, clearedFacets } from './filterOptions';
import { HistoryDrawer } from './HistoryDrawer';
import { firstName, plural } from './lib';
import { DEFAULT_SORT, activeFacetCount, queueFilter, scopeKey, useQueueParams, type QueueScope } from './params';
import { useAllocationLimits } from './api';
import { useAllocationActions, useTeamLoad } from './queries';
import { QueueFilters, type CountyOption } from './QueueFilters';
import { QueueTable } from './QueueTable';
import { SelectionBar } from './SelectionBar';
import { SuggestionsPanel } from './SuggestionsPanel';
import { TeamLoadStrip } from './TeamLoadStrip';

const PAGE_SIZE = 50;
/** A live burst that moved leads to more than one place. */
const MIXED = '\u0000mixed';

type DialogState =
  | { mode: 'ids'; ids: string[]; repId: string | null }
  | { mode: 'filter'; repId: string | null }
  | { mode: 'return'; ids: string[] }
  | null;

export function AllocationPage() {
  const user = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, update] = useQueueParams();
  useDocumentTitle('Allocation');
  const team = useTeamLoad(true);
  const suggestions = useAllocationSuggestions();
  const alloc = useAllocationActions(team.users);
  const limits = useAllocationLimits();
  const [panel, setPanel] = useState<'queue' | 'suggestions'>('queue');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [historyLead, setHistoryLead] = useState<LeadSummary | null>(null);

  const scope = state.scope;
  const ownerId = typeof scope === 'object' ? scope.repId : null;
  const owner = team.reps.find((r) => r.id === ownerId) ?? null;

  // ---- queue data ------------------------------------------------------------------------
  // Everything the queue shows (counties and the priority floor too) is one server filter, so the count,
  // the facet counts and "Assign all N matching" (by-filter) always agree.
  const filter = useMemo(() => queueFilter(state), [state]);
  const q = useInfiniteLeadSearch(useMemo<Omit<LeadFilter, 'cursor'>>(() => ({ ...filter, limit: PAGE_SIZE }), [filter]));
  const pages = q.data?.pages ?? [];
  const rows = useMemo(() => pages.flatMap((p) => p.items ?? []), [pages]);
  const first = pages[0];
  const total = first?.total ?? 0;
  const capped = !!first?.totalCapped;

  // Counties for the County / ZIP filter. The counts are the whole pool's, so they show only while no other
  // facet narrows the queue (the facets API does not count counties).
  const signals = useSignals(scope === 'unallocated' ? 'pool' : 'all');
  const poolCounts = scope === 'unallocated' && activeFacetCount({ ...state, counties: [] }) === 0;
  const countyOptions = useMemo<CountyOption[]>(() => {
    const list = signals.data?.counties ?? [];
    if (list.length) return list.map((c) => ({ fips: c.countyFips, count: poolCounts ? c.leadCount : undefined }));
    return [...new Set(rows.map((l) => l.countyFips).filter((f): f is string => !!f))].map((fips) => ({ fips }));
  }, [signals.data, rows, poolCounts]);

  // ---- selection --------------------------------------------------------------------------
  const [selected, setSelected] = useState<Map<string, LeadSummary | null>>(() => new Map());
  const [handoff, setHandoff] = useState<number | null>(null);
  const lastIndex = useRef<number | null>(null);

  // Leads picked in the Leads list arrive as router state: preselect them once, then drop the state.
  useEffect(() => {
    const ids = (location.state as { companyIds?: unknown } | null)?.companyIds;
    if (Array.isArray(ids)) {
      const valid = ids.filter((x): x is string => typeof x === 'string');
      if (valid.length) {
        setSelected(new Map(valid.map((id) => [id, null])));
        setHandoff(valid.length);
      }
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    }
  }, []); // on mount only

  // Fill in details for selected ids as their rows load.
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const l of rows) {
        if (next.has(l.id) && next.get(l.id) !== l) {
          next.set(l.id, l);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  // A different scope is a different list: start a fresh selection.
  const sk = scopeKey(scope);
  const prevScope = useRef(sk);
  useEffect(() => {
    if (prevScope.current !== sk) {
      setSelected(new Map());
      setHandoff(null);
      lastIndex.current = null;
      prevScope.current = sk;
    }
  }, [sk]);

  const toggle = useCallback((lead: LeadSummary, index: number, checked: boolean, shift: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const range = shift && lastIndex.current !== null ? rows.slice(Math.min(lastIndex.current, index), Math.max(lastIndex.current, index) + 1) : [lead];
      for (const l of range) {
        if (checked) next.set(l.id, l);
        else next.delete(l.id);
      }
      return next;
    });
    lastIndex.current = index;
  }, [rows]);

  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const l of rows) {
        if (checked) next.set(l.id, l);
        else next.delete(l.id);
      }
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Map());
    setHandoff(null);
  };
  const selectedIds = [...selected.keys()];
  const knownSelected = [...selected.values()].filter((l): l is LeadSummary => !!l);

  // ---- live updates from other managers ---------------------------------------------------
  // Bursts (a by-filter move arrives as several events) are summed into one toast; the actor's name comes
  // with the event (payload.actor_name), so it is right even for a manager missing from the users list.
  const liveBuffer = useRef<{ ids: Set<string>; actors: Set<string>; toRep: string | null | undefined; timer: ReturnType<typeof setTimeout> | null }>({
    ids: new Set(), actors: new Set(), toRep: undefined, timer: null,
  });
  const usersRef = useRef(team.users);
  usersRef.current = team.users; // names are looked up when the toast shows, not when the first event came in
  useLiveEvent('lead.allocated', (e) => {
    if (isOwnEvent(e, user.id)) return; // our own writes already toasted (with Undo)
    const b = liveBuffer.current;
    e.companyIds.forEach((id) => b.ids.add(id));
    b.actors.add(actorName(e.payload, team.users));
    const to = (e.payload.assigned_rep_id ?? null) as string | null;
    b.toRep = b.toRep === undefined || b.toRep === to ? to : MIXED; // several destinations: say none
    // Leads someone else just moved should not stay selected for a second move.
    setSelected((prev) => {
      if (!e.companyIds.some((id) => prev.has(id))) return prev;
      const next = new Map(prev);
      e.companyIds.forEach((id) => next.delete(id));
      return next;
    });
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      const n = b.ids.size;
      const who = b.actors.size === 1 ? [...b.actors][0]! : 'Other managers';
      const where = b.toRep === MIXED || b.toRep === undefined ? '' : b.toRep ? `to ${usersRef.current.find((u) => u.id === b.toRep)?.name ?? 'a rep'}` : 'to the pool';
      toast({ id: 'allocation-live', variant: 'info', title: `${who} moved ${plural(n, 'lead')} ${where}`.trim(), description: 'Counts and the queue are up to date.' });
      liveBuffer.current = { ids: new Set(), actors: new Set(), toRep: undefined, timer: null };
    }, 1200);
  });
  useEffect(() => () => { if (liveBuffer.current.timer) clearTimeout(liveBuffer.current.timer); }, []);

  // ---- actions ---------------------------------------------------------------------------
  const confirmIds = async (ids: string[], repId: string) => {
    const out = await alloc.assign(ids, repId);
    if (out) {
      setDialog(null);
      clearSelection();
    }
  };

  const confirmFilter = async (repId: string) => {
    const out = await alloc.assignByFilter(filter, repId);
    if (out) {
      setDialog(null);
      clearSelection();
    }
  };

  const confirmReturn = async (ids: string[]) => {
    const moved = await alloc.returnToPool(ids);
    if (moved) {
      setDialog(null);
      clearSelection();
    }
  };

  const rowAssign = (lead: LeadSummary, repId: string) =>
    void alloc.assign([lead.id], repId).then((out) => {
      if (out) setSelected((prev) => { const n = new Map(prev); n.delete(lead.id); return n; });
    });
  const rowReturn = (lead: LeadSummary) =>
    void alloc.returnToPool([lead.id]).then((moved) => {
      if (moved) setSelected((prev) => { const n = new Map(prev); n.delete(lead.id); return n; });
    });

  const setScope = (next: QueueScope) => {
    if (scopeKey(next) === sk) return;
    update((s) => ({ ...clearedFacets(s), scope: next, filter: s.filter.sort ? { sort: s.filter.sort } : {} }));
    setPanel('queue');
  };

  const sort = state.filter.sort ?? DEFAULT_SORT;
  const onSort = (by: 'priority_score' | 'last_change') => {
    const dir = sort.by === by && sort.dir === 'desc' ? 'asc' : 'desc';
    update({ filter: { sort: by === DEFAULT_SORT.by && dir === DEFAULT_SORT.dir ? undefined : { by, dir } } });
  };

  const facets = activeFacetCount(state);
  const targetReps = team.reps.filter((r) => r.id !== ownerId);
  const countLabel = `${total.toLocaleString('en-US')}${capped ? '+' : ''}`;
  const suggestionCount = (suggestions.data?.suggestions ?? []).length;

  const empty = q.isError ? (
    <ErrorState message="The queue couldn't load. Check your connection and try again." onRetry={() => void q.refetch()} />
  ) : facets > 0 ? (
    <EmptyState
      icon={<SearchX />}
      title="No leads match these filters"
      description="Try removing a filter or widening the ZIP radius."
      action={<Button size="sm" onClick={() => update((s) => clearedFacets(s))}>Clear filters</Button>}
    />
  ) : ownerId ? (
    <EmptyState
      icon={<Inbox />}
      title={`${owner?.name ?? 'This rep'} has no leads yet`}
      description="Assign some from the pool or approve a suggestion."
      action={<Button size="sm" onClick={() => setScope('unallocated')}>Go to the pool</Button>}
    />
  ) : (
    <EmptyState icon={<Inbox />} title="The pool is empty" description="Every lead has an owner. New leads land here after each pipeline run." />
  );

  return (
    <Page wide>
      <PageHeader
        title="Allocation"
        description="Route new leads from the pool to your reps, or rebalance a rep's book."
        actions={
          <Link to={leadsHref(filter)} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">
            Open in Leads <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        }
      />

      {handoff !== null && selected.size > 0 && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft px-4 py-3.5 text-sm text-fg sm:px-5" role="status">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p className="flex-1">
            <span className="font-medium">{plural(handoff, 'lead')} from your Leads list {handoff === 1 ? 'is' : 'are'} selected.</span>{' '}
            <span className="text-muted">Pick a rep with “Assign to…” below.</span>
          </p>
          <button type="button" onClick={() => setHandoff(null)} aria-label="Dismiss" className="rounded p-0.5 text-muted hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      <TeamLoadStrip
        reps={team.reps}
        pool={team.pool}
        maxAllocated={team.maxAllocated}
        scope={scope}
        onSelect={setScope}
        isLoading={team.isLoading}
        error={team.error}
        onRetry={team.refetch}
        kpiRefreshedAt={team.kpiRefreshedAt}
      />

      {/* Below xl the queue and suggestions share the space: a segmented switch picks one. */}
      <div className="mb-4 flex rounded-lg bg-surface-2 p-1 xl:hidden" role="group" aria-label="Show">
        {(['queue', 'suggestions'] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={panel === p}
            onClick={() => setPanel(p)}
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
              panel === p ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {p === 'queue' ? (ownerId ? `${firstName(owner?.name ?? 'Rep')}'s leads` : 'Queue') : 'Suggestions'}
            <span className={cn('rounded-full px-1.5 text-[11px] tabular', panel === p ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted')}>
              {p === 'queue' ? (q.isLoading ? '…' : countLabel) : suggestionCount}
            </span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-7 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-labelledby="queue-heading" className={cn('min-w-0', panel !== 'queue' && 'max-xl:hidden')}>
          <Card className="@container">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-3.5 sm:px-5 sm:py-4">
              <div className="flex min-w-0 items-center gap-3">
                {owner ? <Avatar name={owner.name} size={32} /> : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Inbox className="size-4" aria-hidden /></span>
                )}
                <div className="min-w-0">
                  <h2 id="queue-heading" className="truncate text-sm font-semibold text-fg">
                    {owner ? `${owner.name}'s leads` : 'Unallocated queue'}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted" aria-live="polite">
                    {q.isLoading ? 'Loading…' : q.isError && !pages.length ? 'Unavailable right now' : (
                      <>
                        <span className="font-medium text-fg tabular">{countLabel}</span>{' '}
                        {facets ? 'matching' : total === 1 ? 'lead' : 'leads'}
                        {owner ? ' · reassign or return to the pool' : ' · new leads land here after each pipeline run'}
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                {owner && (
                  <Button size="sm" variant="ghost" leftIcon={<ArrowLeft className="size-3.5" aria-hidden />} onClick={() => setScope('unallocated')}>
                    Pool
                  </Button>
                )}
                <Menu
                  align="end"
                  className="w-64"
                  header={<div className="text-xs font-medium text-muted">{owner ? 'Reassign' : 'Assign'} all {countLabel} to…</div>}
                  items={targetReps.map((r) => ({
                    label: (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="truncate">{r.name}</span>
                        <span className="text-xs text-subtle tabular">{r.allocated} leads</span>
                      </span>
                    ),
                    icon: <UserPlus />,
                    onSelect: () => setDialog({ mode: 'filter', repId: r.id }),
                  }))}
                  trigger={(props) => (
                    <Button
                      {...props}
                      size="sm"
                      variant="secondary"
                      disabled={!total || !targetReps.length || q.isLoading}
                      rightIcon={<ChevronDown className="size-3.5" aria-hidden />}
                    >
                      {owner ? 'Reassign' : 'Assign'} all {q.isLoading || !total ? '' : `${countLabel} `}{facets && total ? 'matching ' : ''}to…
                    </Button>
                  )}
                />
              </div>
            </div>

            <div className="border-b border-border px-4 py-3.5 sm:px-5">
              <QueueFilters state={state} update={update} counties={countyOptions} />
            </div>

            <div className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')} aria-busy={q.isFetching || undefined}>
              <QueueTable
                rows={rows}
                isLoading={q.isLoading}
                selected={selected}
                onToggle={toggle}
                onToggleAll={toggleAll}
                sort={sort}
                onSort={onSort}
                empty={empty}
                actions={{ reps: team.reps, scope, onAssign: rowAssign, onReturnToPool: rowReturn, onHistory: setHistoryLead }}
              />
            </div>

            {rows.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-4 py-3 text-xs text-muted sm:px-5">
                <span>
                  Showing <span className="font-medium text-fg tabular">{rows.length.toLocaleString('en-US')}</span>
                  {' '}of <span className="tabular">{countLabel}</span>
                </span>
                {q.hasNextPage && (
                  <Button size="sm" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                    Load {Math.min(PAGE_SIZE, Math.max(0, total - rows.length)) || PAGE_SIZE} more
                  </Button>
                )}
                {q.isFetching && !q.isFetchingNextPage && !q.isLoading && <Spinner size={14} label="Updating" />}
              </div>
            )}
          </Card>

          {selected.size > 0 && (
            <SelectionBar
              count={selected.size}
              known={knownSelected}
              reps={team.reps}
              ownerId={ownerId}
              pending={alloc.isPending}
              onClear={clearSelection}
              onAssignTo={(repId) => setDialog({ mode: 'ids', ids: selectedIds, repId })}
              onReturnToPool={() => setDialog({ mode: 'return', ids: selectedIds })}
            />
          )}
        </section>

        <SuggestionsPanel
          className={cn('xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)]', panel !== 'suggestions' && 'max-xl:hidden')}
          userId={user.id}
          data={suggestions.data}
          isLoading={suggestions.isLoading}
          error={suggestions.error}
          onRetry={() => void suggestions.refetch()}
          reps={team.reps}
          onApprove={alloc.approve}
          pending={alloc.isPending}
        />
      </div>

      <AssignDialog
        open={dialog?.mode === 'ids' || dialog?.mode === 'filter'}
        onClose={() => setDialog(null)}
        mode={dialog?.mode === 'filter' ? 'filter' : 'ids'}
        reps={targetReps}
        poolSize={team.pool.size}
        maxBulk={limits?.maxBulkAllocation ?? null}
        initialRepId={dialog && dialog.mode !== 'return' ? dialog.repId : null}
        count={dialog?.mode === 'ids' ? dialog.ids.length : total}
        capped={dialog?.mode === 'filter' ? capped : false}
        known={dialog?.mode === 'ids' ? dialog.ids.map((id) => selected.get(id)).filter((l): l is LeadSummary => !!l) : []}
        sourceRepId={ownerId}
        filterChips={[owner ? `${owner.name}'s leads` : 'Unallocated pool', ...activeChips(state).map(chipText)]}
        pending={alloc.isAssigning || alloc.isAssigningByFilter}
        onConfirm={(repId) => {
          if (dialog?.mode === 'ids') void confirmIds(dialog.ids, repId);
          else void confirmFilter(repId);
        }}
      />

      <ReturnDialog
        open={dialog?.mode === 'return'}
        count={dialog?.mode === 'return' ? dialog.ids.length : 0}
        owner={owner}
        poolSize={team.pool.size}
        pending={alloc.isReturning}
        onClose={() => setDialog(null)}
        onConfirm={() => dialog?.mode === 'return' && void confirmReturn(dialog.ids)}
      />

      <HistoryDrawer
        lead={historyLead}
        onClose={() => setHistoryLead(null)}
        reps={team.reps}
        pending={alloc.isPending}
        onAssign={(lead, repId) => { rowAssign(lead, repId); setHistoryLead(null); }}
        onReturnToPool={(lead) => { rowReturn(lead); setHistoryLead(null); }}
      />
    </Page>
  );
}

/** Who made a live change: payload.actor_name, else the users list, else a neutral fallback. */
function actorName(payload: Record<string, unknown>, users: { id: string; name: string }[]): string {
  const named = typeof payload.actor_name === 'string' ? payload.actor_name.trim() : '';
  if (named && named !== 'system') return named;
  return users.find((u) => u.id === payload.actor_id)?.name ?? 'Another manager';
}

function ReturnDialog({ open, count, owner, poolSize, pending, onClose, onConfirm }: {
  open: boolean;
  count: number;
  owner: { name: string; allocated: number } | null;
  poolSize: number | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const rows = [
    ...(owner ? [{ key: 'rep', name: owner.name, before: owner.allocated, after: Math.max(0, owner.allocated - count), highlight: true }] : []),
    ...(poolSize !== null ? [{ key: 'pool', name: 'Unallocated pool', pool: true, before: poolSize, after: poolSize + count, scale: poolSize + count }] : []),
  ];
  const scaleMax = Math.max(1, owner?.allocated ?? 1);
  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      size="sm"
      title={`Return ${plural(count, 'lead')} to the pool?`}
      description={`${owner ? `${firstName(owner.name)} loses access; ` : ''}notes, overrides and tags stay with the leads.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={onConfirm} leftIcon={<Undo2 className="size-4" aria-hidden />}>Return to pool</Button>
        </>
      }
    >
      <ul className="flex flex-col gap-3">
        {rows.map((r) => <LoadRow key={r.key} row={r} scaleMax={scaleMax} />)}
      </ul>
    </Dialog>
  );
}
