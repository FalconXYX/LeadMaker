// Leads list view, a rep's working list: My leads / Unallocated / All (+ any rep for managers), quick sales views,
// a sortable table in sales order (cards on phones) with stage, follow-up and last-contact columns and quick
// actions, the sales filters first in the side panel, saved views, bulk stage / follow-up / tag / allocate, and
// live-update highlights.
import { CloudLightning, Inbox, Layers, ListFilter, SearchX, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '@/api/errors';
import { invalidateLead, useCustomTags, useInfiniteLeadSearch, useUsers } from '@/api/queries';
import type { LeadFilter, LeadSummary, SavedView, SortField } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { Button, EmptyState, ErrorState, useMediaQuery, useToast } from '@/components/ui';
import { LogActivityDialog } from '@/features/tasks';
import { cn } from '@/lib/cn';
import { formatNumber, pluralize } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useLimits, type TaskCreate } from './api';
import { AddTagDialog, BulkBar, FollowUpDialog } from './components/BulkActions';
import { FilterChips, clearFacets, filterChips } from './components/FilterChips';
import { FilterSheet, FilterSidebar, LoadMore } from './components/FilterContainers';
import { FilterPanel } from './components/FilterPanel';
import { LeadCards } from './components/LeadCards';
import { LeadsTable, type SortState } from './components/LeadsTable';
import { ManageTagsDialog } from './components/ManageTagsDialog';
import type { LeadActions } from './components/RowActions';
import { SavedViewsMenu } from './components/SavedViewsMenu';
import { DensityToggle, DisplayMenu, QuickViews, SortMenu, ViewSwitch } from './components/toolbar';
import { useLeadsPrefs, visibleColumns } from './prefs';
import {
  bulkSummary, stageVerb, useBulkAddTag, useBulkFollowUp, useBulkStage, useLeadStateToggle, useSetStage, type StateChange,
} from './queries';
import type { SalesStage } from './sales';
import { queryToView, useSavedViews, useViewMutations, viewToQuery, type MigrationResult } from './savedViews';
import { apiScope, scopeForView, viewLabel, viewOf, type LeadView } from './scope';
import { deriveTagOptions, rememberTagLabels, visibleChips } from './tags';
import { hasAlertBadge, leadTiming, type ListTimingBadge } from './timing';
import { useLeadsUrlState, viewQuery } from './useLeadsUrl';
import { useRowFlash } from './useRowFlash';
import { activePreset, activeViewName, applyPreset, type PresetId } from './views';

const DEFAULT_SORT: SortState = { by: 'priority_score', dir: 'desc' };

export function LeadsPage() {
  const { user, isManager, canWrite } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isPhone = useMediaQuery('(max-width: 639px)');
  // The filter column needs room beside a readable table: below xl it opens as a drawer over the list.
  const sideFilters = useMediaQuery('(min-width: 1280px)');
  const { filter, setFilter, alertOnly } = useLeadsUrlState();
  const [prefs, setPrefs] = useLeadsPrefs(user?.id);
  const [sheetOpen, setSheetOpen] = useState(false);

  const usersQuery = useUsers('rep', { enabled: isManager });
  const reps = useMemo(() => (Array.isArray(usersQuery.data?.items) ? usersQuery.data.items : []), [usersQuery.data]);
  const customTagsQuery = useCustomTags();
  const customTags = useMemo(() => (Array.isArray(customTagsQuery.data?.items) ? customTagsQuery.data.items : []), [customTagsQuery.data]);

  // ---- data ------------------------------------------------------------------------------------------
  const serverFilter = useMemo<LeadFilter>(() => {
    const { scope: _s, ...rest } = filter;
    const scope = apiScope(filter, user);
    return { ...rest, ...(scope ? { scope } : {}), ...(alertOnly ? { limit: 200 } : {}) };
  }, [filter, user, alertOnly]);
  const search = useInfiniteLeadSearch(serverFilter);
  const pages = useMemo(() => search.data?.pages ?? [], [search.data]);
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    const out: LeadSummary[] = [];
    for (const p of pages) {
      for (const l of Array.isArray(p?.items) ? p.items : []) {
        if (l && !seen.has(l.id)) {
          seen.add(l.id);
          out.push(l);
        }
      }
    }
    rememberTagLabels(out);
    return out;
  }, [pages]);
  const total = typeof pages[0]?.total === 'number' ? pages[0].total : undefined;
  const capped = !!pages[0]?.totalCapped;

  // Timing badges come with each lead (LeadSummary.timing); cached per row object for the render.
  const timingCache = useMemo(() => new WeakMap<LeadSummary, ListTimingBadge[]>(), []);
  const timingFor = useCallback((lead: LeadSummary) => {
    let t = timingCache.get(lead);
    if (!t) timingCache.set(lead, (t = leadTiming(lead)));
    return t;
  }, [timingCache]);

  // "Storm alert nearby" is not a LeadFilter facet: load every page of the (server-narrowed) list and keep
  // the leads whose county has a roof-damaging alert.
  const items = useMemo(() => (alertOnly ? loaded.filter((l) => hasAlertBadge(timingFor(l))) : loaded), [alertOnly, loaded, timingFor]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;
  useEffect(() => {
    if (alertOnly && hasNextPage && !isFetchingNextPage && !search.isError) void fetchNextPage();
  }, [alertOnly, hasNextPage, isFetchingNextPage, fetchNextPage, search.isError]);
  const alertScanning = alertOnly && (hasNextPage || search.isFetching);

  const chipsFor = useCallback(
    (lead: LeadSummary) => visibleChips(lead, { groups: prefs.tagGroups, hiddenCustomTags: prefs.hiddenCustomTags }),
    [prefs.tagGroups, prefs.hiddenCustomTags],
  );
  const tagOptions = useMemo(
    () => deriveTagOptions(loaded, [...(filter.tagsAll ?? []), ...(filter.tagsAny ?? [])]),
    [loaded, filter.tagsAll, filter.tagsAny],
  );

  // ---- view / sort -----------------------------------------------------------------------------------------
  const { view, repId } = viewOf(filter, isManager);
  const label = viewLabel(filter, isManager, reps);
  useDocumentTitle(label === 'All leads' ? 'Leads' : `${label} · Leads`);
  const setView = (v: Exclude<LeadView, 'rep'>) => setFilter({ scope: scopeForView(v, isManager) });
  const sort = filter.sort ?? DEFAULT_SORT;
  const onHeaderSort = (by: SortField) => {
    // Soonest follow-up, nearest and longest-uncontacted come first on the first click.
    const firstDir = by === 'distance' || by === 'next_follow_up' || by === 'last_contacted' ? 'asc' : 'desc';
    const next: SortState = sort.by === by
      ? { by, dir: sort.dir === 'desc' ? 'asc' : 'desc' }
      : { by, dir: firstDir };
    setFilter({ sort: next.by === DEFAULT_SORT.by && next.dir === DEFAULT_SORT.dir ? undefined : next });
  };

  const activeChips = filterChips(filter).length + (alertOnly ? 1 : 0);
  const clearAll = () => setFilter(clearFacets, { alert: false });

  // ---- selection ------------------------------------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const filterKey = viewQuery(serverFilter, alertOnly);
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [filterKey]);

  const onSelect = (id: string, checked: boolean, shiftKey: boolean) => {
    // Resolve the range now: the updater runs later, after the anchor has moved.
    const from = anchor.current ? items.findIndex((l) => l.id === anchor.current) : -1;
    const to = items.findIndex((l) => l.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (const l of items.slice(a, b + 1)) {
          if (checked) next.add(l.id);
          else next.delete(l.id);
        }
      } else if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    anchor.current = id;
  };
  const onSelectAll = (checked: boolean) => setSelected(checked ? new Set(items.map((l) => l.id)) : new Set());
  const selectedLeads = useMemo(() => loaded.filter((l) => selected.has(l.id)), [loaded, selected]);
  const writableSelected = selectedLeads.filter((l) => canWrite(l));

  const [tagDialog, setTagDialog] = useState(false);
  useEffect(() => {
    if (!selected.size || tagDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, tagDialog]);

  // ---- mutations -------------------------------------------------------------------------------------------------
  const { flash, markLocalEdit } = useRowFlash(items);
  const stateToggle = useLeadStateToggle({ onLocalEdit: markLocalEdit });
  const onToggleState = useCallback(
    (lead: LeadSummary, change: StateChange) => stateToggle.mutate({ lead, change }),
    [stateToggle],
  );
  const qc = useQueryClient();
  const setStage = useSetStage({ onLocalEdit: markLocalEdit });
  const [logFor, setLogFor] = useState<LeadSummary | null>(null);
  const [followUpFor, setFollowUpFor] = useState<LeadSummary | null>(null);
  const actions = useMemo<LeadActions>(() => ({
    onLogCall: setLogFor,
    onFollowUp: setFollowUpFor,
    onStage: (lead, stage) => setStage.mutate({ lead, stage }),
  }), [setStage]);

  const bulkStage = useBulkStage();
  const onBulkStage = (stage: SalesStage) => {
    const skipped = selectedLeads.length - writableSelected.length;
    bulkStage.mutate({ leads: writableSelected, stage }, {
      onSuccess: (res) => {
        toast(bulkSummary(res, stageVerb(stage), skipped));
        if (res.done.length) setSelected(new Set());
      },
      onError: (e) => toast.error(e),
    });
  };
  const [followUpDialog, setFollowUpDialog] = useState(false);
  const bulkFollowUp = useBulkFollowUp();
  // Managers: each follow-up goes to the lead's rep (unallocated ones to the manager, the default).
  const taskFor = (task: Omit<TaskCreate, 'assigneeId'>) => (lead: LeadSummary): TaskCreate =>
    ({ ...task, ...(isManager && lead.assignedRep ? { assigneeId: lead.assignedRep.id } : {}) });
  const onBulkFollowUp = (task: Omit<TaskCreate, 'assigneeId'>) => {
    const skipped = selectedLeads.length - writableSelected.length;
    bulkFollowUp.mutate({ leads: writableSelected, task: taskFor(task) }, {
      onSuccess: (res) => {
        toast(bulkSummary(res, 'Added a follow-up to', skipped));
        setFollowUpDialog(false);
        if (res.done.length) setSelected(new Set());
      },
      onError: (e) => toast.error(e),
    });
  };
  const onFollowUp = (lead: LeadSummary, task: Omit<TaskCreate, 'assigneeId'>) => {
    bulkFollowUp.mutate({ leads: [lead], task: taskFor(task) }, {
      onSuccess: (res) => {
        if (res.done.length) {
          toast.success(`Follow-up added for ${lead.businessName}`, task.title);
          setFollowUpFor(null);
        } else toast({ variant: 'error', title: 'Couldn’t add the follow-up', description: 'Try again in a moment.' });
      },
      onError: (e) => toast.error(e),
    });
  };
  const limits = useLimits();
  const bulkTag = useBulkAddTag({ maxBulkTag: limits.maxBulkTag });
  const submitTag = (tag: { id: string; name: string } | { name: string }) => {
    const readOnly = selectedLeads.length - writableSelected.length;
    bulkTag.mutate({ tag, leadIds: writableSelected.map((l) => l.id) }, {
      onSuccess: (res) => {
        const done = res.tagged.length + res.alreadyHad.length;
        const skipped = readOnly + res.readOnly.length;
        const notes = [
          skipped ? `${skipped} skipped (read-only)` : '',
          res.alreadyHad.length ? `${res.alreadyHad.length} already had it` : '',
          res.missing.length ? `${res.missing.length} no longer available` : '',
        ].filter(Boolean).join(' · ');
        toast({
          variant: !done ? 'error' : res.readOnly.length || res.missing.length ? 'warning' : 'success',
          title: done ? `Tagged ${pluralize(done, 'lead')} “${res.tag.name}”` : `Couldn’t tag the selected leads`,
          description: notes || undefined,
        });
        // Make sure the tag the user just applied is visible.
        setPrefs((p) => ({
          ...p,
          tagGroups: { ...p.tagGroups, custom: true },
          hiddenCustomTags: p.hiddenCustomTags.filter((n) => n.toLowerCase() !== res.tag.name.toLowerCase()),
        }));
        setTagDialog(false);
        setSelected(new Set());
      },
    });
  };

  // ---- saved views ---------------------------------------------------------------------------------------------------
  const onMigrated = useCallback((res: MigrationResult) => {
    const alertIds = res.moved.filter((m) => m.alert).map((m) => m.view.id);
    if (alertIds.length) setPrefs((p) => ({ ...p, alertViews: [...new Set([...p.alertViews, ...alertIds])] }));
    if (res.moved.length) {
      toast({
        variant: 'info',
        title: `Moved ${pluralize(res.moved.length, 'saved view')} to your account`,
        description: 'They now follow you to any device you sign in on.',
      });
    }
  }, [setPrefs, toast]);
  const savedViews = useSavedViews(user?.id, onMigrated);
  const viewOps = useViewMutations();
  const isAlertView = (v: SavedView) => prefs.alertViews.includes(v.id);
  const savedForMatch = [...savedViews.mine, ...savedViews.shared].map((v) => ({ name: v.name, query: viewToQuery(v, isAlertView(v)) }));
  const activeName = activeViewName(filter, alertOnly, savedForMatch);
  const preset = activePreset(filter, alertOnly);
  const onPreset = (id: PresetId) => {
    const applied = applyPreset(filter, id);
    setFilter(() => applied.filter, { alert: applied.alert });
  };
  const setAlertView = (id: string, on: boolean) => setPrefs((p) => ({
    ...p,
    alertViews: on ? [...new Set([...p.alertViews, id])] : p.alertViews.filter((x) => x !== id),
  }));
  const saveView = async (name: string, isShared: boolean) => {
    const { filter: f, sort, alert } = queryToView(viewQuery(filter, alertOnly));
    const res = await viewOps.create.mutateAsync({ name, filter: f, ...(sort ? { sort } : {}), ...(isShared ? { isShared } : {}) });
    if (alert) setAlertView(res.view.id, true);
    toast.success(`Saved view “${res.view.name}”`, isShared ? 'Shared with your team.' : undefined);
  };
  const renameView = async (view: SavedView, name: string) => {
    const res = await viewOps.update.mutateAsync({ id: view.id, patch: { name } });
    toast({
      variant: 'success',
      title: `Renamed view to “${res.view.name}”`,
      action: {
        label: 'Undo',
        onClick: () => viewOps.update.mutate({ id: view.id, patch: { name: view.name } }, { onError: (e) => toast.error(e) }),
      },
    });
  };
  const shareView = (view: SavedView, isShared: boolean) => {
    viewOps.update.mutate({ id: view.id, patch: { isShared } }, {
      onSuccess: (res) => toast.success(isShared ? `“${res.view.name}” is shared with your team` : `“${res.view.name}” is private again`),
      onError: (e) => toast.error(e),
    });
  };
  const deleteView = (view: SavedView) => {
    const alert = isAlertView(view);
    viewOps.remove.mutate(view, {
      onSuccess: () => {
        if (alert) setAlertView(view.id, false);
        toast({
          title: `Deleted view “${view.name}”`,
          action: {
            label: 'Undo',
            onClick: () => viewOps.create.mutate(
              { name: view.name, filter: view.filter, ...(view.sort ? { sort: view.sort } : {}), ...(view.isShared ? { isShared: true } : {}) },
              { onSuccess: (res) => alert && setAlertView(res.view.id, true), onError: (e) => toast.error(e) },
            ),
          },
        });
      },
      onError: (e) => toast.error(e),
    });
  };

  // ---- custom tag management ---------------------------------------------------------------------------------------------
  const [manageTags, setManageTags] = useState(false);
  const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const onTagRenamed = (from: string, to: string) => {
    if (filter.customTags?.some((c) => sameTag(c, from))) {
      setFilter((f) => ({ ...f, customTags: f.customTags?.map((c) => (sameTag(c, from) ? to : c)) }), { replace: true });
    }
    setPrefs((p) => (p.hiddenCustomTags.some((n) => sameTag(n, from))
      ? { ...p, hiddenCustomTags: p.hiddenCustomTags.map((n) => (sameTag(n, from) ? to : n)) }
      : p));
  };
  const onTagDeleted = (name: string) => {
    if (filter.customTags?.some((c) => sameTag(c, name))) {
      setFilter((f) => {
        const next = (f.customTags ?? []).filter((c) => !sameTag(c, name));
        return { ...f, customTags: next.length ? next : undefined };
      }, { replace: true });
    }
    setPrefs((p) => (p.hiddenCustomTags.some((n) => sameTag(n, name))
      ? { ...p, hiddenCustomTags: p.hiddenCustomTags.filter((n) => !sameTag(n, name)) }
      : p));
  };

  const openLead = useCallback((lead: LeadSummary, newTab?: boolean) => {
    if (newTab) window.open(`/leads/${encodeURIComponent(lead.id)}`, '_blank', 'noopener,noreferrer');
    else navigate(`/leads/${encodeURIComponent(lead.id)}`);
  }, [navigate]);

  // ---- render ----------------------------------------------------------------------------------------------------------
  // Owner says nothing in single-owner views (mine, unallocated, one rep), so it only shows in All.
  const columns = visibleColumns(prefs).filter((c) => c !== 'owner' || view === 'all');
  const initialLoading = search.isPending || (alertOnly && items.length === 0 && alertScanning);
  const refreshing = search.isPlaceholderData && search.isFetching;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const countText = initialLoading
    ? 'Loading…'
    : alertOnly
      ? `${formatNumber(items.length)} with a storm alert${alertScanning ? '…' : ''}`
      : total === undefined ? '' : capped ? `${formatNumber(total)}+ leads` : pluralize(total, 'lead');

  const empty = search.isError ? (
    <ErrorState message={errorMessage(search.error)} onRetry={() => void search.refetch()} />
  ) : activeChips > 0 ? (
    <EmptyState
      icon={alertOnly ? <CloudLightning /> : <SearchX />}
      title={alertOnly ? 'No storm alerts for these leads' : 'No leads match these filters'}
      description={alertOnly
        ? 'No roof-damaging NWS alerts in these leads’ counties in the last 7 days.'
        : 'Try removing a filter, or switch to a wider view.'}
      action={<Button variant="secondary" onClick={clearAll}>Clear filters</Button>}
    />
  ) : view === 'mine' ? (
    <EmptyState
      icon={<Inbox />}
      title="No leads allocated to you yet"
      description="Your manager assigns leads from the unallocated pool. You can browse it in the meantime."
      action={<Button variant="secondary" onClick={() => setView('unallocated')}>Browse unallocated</Button>}
    />
  ) : view === 'unallocated' ? (
    <EmptyState icon={<Inbox />} title="The unallocated pool is empty" description="New leads from each pipeline run land here." />
  ) : view === 'rep' ? (
    <EmptyState icon={<Users />} title="No leads allocated to this rep" description="Allocate leads from the unallocated pool." />
  ) : (
    <EmptyState icon={<Layers />} title="No leads yet" description="Leads appear here after the first pipeline run." />
  );

  const loadMore = (
    <LoadMore
      hasNextPage={!!hasNextPage && !alertOnly}
      fetching={isFetchingNextPage}
      onLoad={() => !isFetchingNextPage && void fetchNextPage()}
      root={isPhone ? null : scroller}
      loaded={items.length}
      total={alertOnly ? items.length : total}
      capped={capped}
    />
  );

  const panel = (
    <FilterPanel
      filter={filter}
      setFilter={setFilter}
      alertOnly={alertOnly}
      tagOptions={tagOptions}
      facetFilter={serverFilter}
      onManageTags={() => setManageTags(true)}
    />
  );

  const overlayFilters = isPhone || !sideFilters;
  const toggleFilters = () => (overlayFilters ? setSheetOpen(true) : setPrefs((p) => ({ ...p, filtersOpen: !p.filtersOpen })));
  const filtersOpen = !overlayFilters && prefs.filtersOpen;

  return (
    // Wider screens: the list fills the window, over the shell's bottom padding (kept clear of the assistant button by
    // the footer's right padding).
    <div className={cn('mx-auto flex w-full max-w-[1680px] flex-col', !isPhone && '-mb-24 h-[calc(100%+6rem)] min-h-0')}>
      <div className="px-4 pt-6 sm:px-8 sm:pt-7">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Leads</h1>
          <span className="text-sm text-muted tabular" aria-live="polite">
            <span className="sr-only">{label}: </span>{countText}
          </span>
          {!isPhone && (
            <ViewSwitch
              view={view}
              repId={repId}
              isManager={isManager}
              reps={reps}
              onView={setView}
              onRep={(id) => setFilter({ scope: { repId: id } })}
              className="ml-4"
            />
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <SavedViewsMenu
              activeName={activeName}
              mine={savedViews.mine}
              shared={savedViews.shared}
              loading={savedViews.loading}
              isManager={isManager}
              onPreset={onPreset}
              onApply={(v) => {
                const q = viewToQuery(v, isAlertView(v));
                navigate({ pathname: '/leads', search: q ? `?${q}` : '' });
              }}
              onSave={saveView}
              onRename={renameView}
              onShare={shareView}
              onDelete={deleteView}
              canSave={activeChips > 0 || !!filter.scope || !!filter.sort}
              compact={isPhone}
            />
            <SortMenu sort={sort} hasNear={!!filter.near} onSort={(s) => setFilter({ sort: s })} compact={isPhone} />
            {!isPhone && <DensityToggle density={prefs.density} onChange={(density) => setPrefs({ density })} />}
            <DisplayMenu prefs={prefs} onPrefs={setPrefs} customTags={customTags} compact={isPhone} onManageTags={() => setManageTags(true)} />
          </div>
        </header>

        {isPhone && (
          <div className="mt-3.5">
            <ViewSwitch
              view={view}
              repId={repId}
              isManager={isManager}
              reps={reps}
              onView={setView}
              onRep={(id) => setFilter({ scope: { repId: id } })}
              fullWidth
            />
          </div>
        )}

        <div className="mt-4 flex min-w-0 items-center gap-2.5 sm:mt-5">
          <button
            type="button"
            onClick={toggleFilters}
            aria-expanded={overlayFilters ? sheetOpen : filtersOpen}
            aria-controls={overlayFilters ? undefined : 'leads-filter-panel'}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
              filtersOpen ? 'border-transparent bg-accent text-accent-fg shadow-sm' : 'border-border-strong bg-surface text-fg hover:bg-hover',
            )}
          >
            <ListFilter className="size-3.5" aria-hidden />
            Filters
            {activeChips > 0 && (
              <span className={cn('rounded-full px-1.5 text-[10px] font-semibold tabular', filtersOpen ? 'bg-surface text-fg' : 'bg-accent text-accent-fg')}>{activeChips}</span>
            )}
          </button>
          <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
          <QuickViews
            active={preset?.id ?? null}
            onPreset={onPreset}
            onClear={() => setFilter((f) => ({ scope: f.scope }), { alert: false })}
            due={filter.followUp === 'overdue' || filter.followUp === 'week' ? filter.followUp : 'today'}
            onDue={(followUp) => setFilter({ followUp }, { replace: true })}
            className="min-w-0 flex-1"
          />
        </div>

        {!preset && <FilterChips filter={filter} setFilter={setFilter} alertOnly={alertOnly} className="mt-3.5" />}
      </div>

      {isPhone ? (
        <div className="px-4 pt-4 pb-24">
          {search.isError && items.length > 0 && <RefreshError onRetry={() => void search.refetch()} />}
          <LeadCards
            items={items}
            loading={initialLoading}
            refreshing={refreshing}
            selected={selected}
            onSelect={onSelect}
            flash={flash}
            user={user}
            actions={actions}
            showOwner={view === 'all'}
            timingFor={timingFor}
            chipsFor={chipsFor}
            onOpen={openLead}
            empty={empty}
            footer={loadMore}
          />
          <FilterSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            activeCount={activeChips}
            onClear={clearAll}
            resultCount={countText && !initialLoading ? countText : null}
            loading={search.isFetching}
          >
            {panel}
          </FilterSheet>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-5 px-4 pt-4 pb-5 sm:px-8 sm:pt-5 sm:pb-7">
          {filtersOpen && (
            <FilterSidebar activeCount={activeChips} onClear={clearAll} onCollapse={() => setPrefs({ filtersOpen: false })}>
              {panel}
            </FilterSidebar>
          )}
          {!sideFilters && (
            <FilterSheet
              side
              open={sheetOpen}
              onClose={() => setSheetOpen(false)}
              activeCount={activeChips}
              onClear={clearAll}
              resultCount={countText && !initialLoading ? countText : null}
              loading={search.isFetching}
            >
              {panel}
            </FilterSheet>
          )}
          <section aria-label="Lead list" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {search.isError && items.length > 0 && <RefreshError onRetry={() => void search.refetch()} />}
            <LeadsTable
              items={items}
              loading={initialLoading}
              refreshing={refreshing}
              columns={columns}
              showDistance={!!filter.near}
              density={prefs.density}
              sort={sort}
              onSort={onHeaderSort}
              selected={selected}
              onSelect={onSelect}
              onSelectAll={onSelectAll}
              flash={flash}
              user={user}
              onToggleState={onToggleState}
              actions={actions}
              timingFor={timingFor}
              chipsFor={chipsFor}
              onOpen={openLead}
              onNearEnd={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
              empty={empty}
              footer={loadMore}
              scrollRef={setScroller}
            />
            <footer className="flex h-10 shrink-0 items-center gap-3.5 border-t border-border bg-surface-2/50 px-4 pr-20 text-xs text-muted">
              <span className="tabular">
                {items.length > 0 && total !== undefined && !alertOnly
                  ? `Showing ${formatNumber(items.length)} of ${capped ? `${formatNumber(total)}+` : formatNumber(total)}`
                  : items.length > 0 ? `Showing ${formatNumber(items.length)}` : ''}
              </span>
              <span className={cn('hidden text-subtle', items.length > 0 && 'lg:inline')} aria-hidden>
                <Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>X</Kbd> select
              </span>
            </footer>
          </section>
        </div>
      )}

      <BulkBar
        count={selectedLeads.length}
        writable={writableSelected.length}
        isManager={isManager}
        onStage={onBulkStage}
        onFollowUp={() => setFollowUpDialog(true)}
        busy={bulkStage.isPending || bulkFollowUp.isPending}
        onTag={() => setTagDialog(true)}
        onAllocate={() => navigate('/allocation', { state: { companyIds: selectedLeads.map((l) => l.id) } })}
        onClear={() => setSelected(new Set())}
        compact={isPhone}
      />
      <AddTagDialog
        open={tagDialog}
        onClose={() => setTagDialog(false)}
        tags={customTags}
        writable={writableSelected.length}
        readOnly={selectedLeads.length - writableSelected.length}
        busy={bulkTag.isPending}
        onSubmit={submitTag}
        onManageTags={() => setManageTags(true)}
        maxPerRequest={limits.maxBulkTag}
      />
      <FollowUpDialog
        open={followUpDialog}
        onClose={() => setFollowUpDialog(false)}
        writable={writableSelected.length}
        readOnly={selectedLeads.length - writableSelected.length}
        busy={bulkFollowUp.isPending}
        isManager={isManager}
        onSubmit={onBulkFollowUp}
      />
      {logFor && (
        <LogActivityDialog
          leadId={logFor.id}
          leadName={logFor.businessName}
          defaultType="call"
          open
          onOpenChange={(open) => !open && setLogFor(null)}
          onDone={() => {
            // Logging a call moves a new lead to Contacted and sets its last contact.
            void invalidateLead(qc, logFor.id);
            setLogFor(null);
          }}
        />
      )}
      <FollowUpDialog
        open={!!followUpFor}
        onClose={() => setFollowUpFor(null)}
        leadName={followUpFor?.businessName}
        writable={1}
        readOnly={0}
        busy={bulkFollowUp.isPending}
        isManager={isManager}
        onSubmit={(task) => followUpFor && onFollowUp(followUpFor, task)}
      />
      <ManageTagsDialog
        open={manageTags}
        onClose={() => setManageTags(false)}
        user={user}
        onRenamed={onTagRenamed}
        onDeleted={onTagDeleted}
      />
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="mx-0.5 rounded border border-border bg-surface px-1 font-sans text-[10px] text-muted">{children}</kbd>;
}

function RefreshError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning-soft px-4 py-2 text-xs text-warning">
      Couldn’t refresh the list; showing the last results.
      <button type="button" onClick={onRetry} className="font-semibold hover:underline">Retry</button>
    </div>
  );
}
