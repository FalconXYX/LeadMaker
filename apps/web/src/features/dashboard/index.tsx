// The sales dashboard: today's call list first, with Follow-ups beside it on desktop, then the scorecard, book health
// and recent activity; weather and the territory map sit at the bottom. Reps see their own book; managers see the team,
// or one rep (?rep=<id>).
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as ep from '@/api/endpoints';
import { qk, useConfig, useLeadMap, useSignals, useUsers } from '@/api/queries';
import type { LeadMapPoint, LeadMapScope, SessionUser, UserRef } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { errorMessage } from '@/api/errors';
import { Button, Card, Select, Toggle, buttonClasses } from '@/components/ui';
import { Page } from '@/layout/PageHeader';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { DEFAULT_WEEKLY_GOAL, type DashboardScope } from './api';
import { BookHealthCard, BookMixCard } from './BookHealth';
import { Briefing } from './Briefing';
import { countKinds, prioritiesSentence } from './callList';
import { useInView, useNow, useStoredState } from './hooks';
import { LeadMapCard, type MapLead } from './LeadMap';
import { useBriefing, useRecentActivity, useSalesDashboard, useUpcomingTasks } from './queries';
import { RecentActivityCard } from './RecentActivity';
import { firstName, salesLeadsHref, weekPace } from './sales';
import { AccountsCard, ActivityCard, FollowUpsCard, PipelineCard } from './Scorecard';
import { TeamTable } from './TeamTable';
import { TerritoryBrief } from './TerritoryBrief';
import { WeatherCard } from './WeatherCard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_POINTS: LeadMapPoint[] = [];
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function toMapLeads(points: readonly LeadMapPoint[], ownerName: (id: string) => string): MapLead[] {
  return points.map((p) => ({
    id: p.id, name: p.name, latitude: p.latitude, longitude: p.longitude, segment: p.segment, priorityScore: p.priorityScore,
    owner: p.assignedRepId ? ({ id: p.assignedRepId, name: ownerName(p.assignedRepId) } satisfies UserRef) : null,
    countyFips: p.countyFips, severity: p.timing ?? null,
  }));
}

export function DashboardPage() {
  const { user, isManager } = useAuth();
  useDocumentTitle('Dashboard');
  if (!user) return null;
  return <SalesDashboardView user={user} isManager={isManager} />;
}

function SalesDashboardView({ user, isManager }: { user: SessionUser; isManager: boolean }) {
  const now = useNow(60_000);
  const [params, setParams] = useSearchParams();
  const repParam = params.get('rep');
  const scope: DashboardScope = !isManager ? 'mine' : repParam && UUID.test(repParam) ? `rep:${repParam}` : 'team';
  const selectRep = (repId: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (repId) next.set('rep', repId);
    else next.delete('rep');
    return next;
  });

  const users = useUsers('rep', { enabled: isManager });
  const config = useConfig();
  const dash = useSalesDashboard(scope);
  const briefing = useBriefing(scope, now);
  const upcoming = useUpcomingTasks(scope);
  const kpis = useQuery({ queryKey: qk.kpis, queryFn: ({ signal }) => ep.getKpis({ signal }), staleTime: 30_000, enabled: isManager });

  const reps = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users.data?.items ?? []) if (u.role === 'rep') m.set(u.id, u.name);
    for (const r of dash.data?.reps ?? []) if (!m.has(r.rep.id)) m.set(r.rep.id, r.rep.name);
    return m;
  }, [users.data, dash.data]);
  const viewedRep = scope.startsWith('rep:') ? reps.get(scope.slice(4)) ?? 'This rep' : null;
  const subject = scope === 'team' ? 'The team' : viewedRep ? firstName(viewedRep) : null;
  const whose = scope === 'mine' ? 'your' : scope === 'team' ? 'the team’s' : `${viewedRep ?? 'this rep'}’s`;

  // goalPerWeek covers every rep in scope; the per-rep goal is the configured one.
  const teamReps = dash.data?.reps ?? [];
  const repGoal = config.data?.weeklyActivityGoal
    ?? (dash.data && teamReps.length ? Math.round(dash.data.activity.goalPerWeek / teamReps.length) : dash.data?.activity.goalPerWeek)
    ?? DEFAULT_WEEKLY_GOAL;
  const kinds = countKinds(briefing.rows);
  const sentence = (dash.data || !briefing.isLoading) ? prioritiesSentence({
    subject,
    overdue: dash.data?.followUps.overdue ?? kinds.overdue,
    today: dash.data?.followUps.today ?? kinds.today,
    kinds,
    behind: scope === 'team' && teamReps.length
      ? { count: teamReps.filter((r) => r.activityThisWeek < weekPace(repGoal, now)).length, of: teamReps.length }
      : undefined,
  }) : null;

  // Lower sections load once scrolled near.
  const [lowerRef, lowerInView] = useInView<HTMLDivElement>('800px');
  const recent = useRecentActivity(scope, lowerInView);
  const signals = useSignals(scope === 'mine' ? 'mine' : 'all', { enabled: lowerInView });
  const [mapOpen, setMapOpen] = useStoredState<boolean>('leadmaker.dashboard.mapOpen', true);
  const [showPool, setShowPool] = useStoredState<boolean>('leadmaker.dashboard.showPool', false);
  const mapScope: LeadMapScope = scope === 'mine' ? 'mine' : scope === 'team' ? 'all' : scope;
  const map = useLeadMap(mapScope, { enabled: lowerInView && mapOpen });
  const poolMap = useLeadMap('unallocated', { enabled: lowerInView && mapOpen && scope === 'mine' && showPool });
  const mapLeads = useMemo(() => toMapLeads(
    [...(map.data?.items ?? NO_POINTS), ...(scope === 'mine' && showPool ? poolMap.data?.items ?? NO_POINTS : NO_POINTS)],
    (id) => (id === user.id ? user.name : reps.get(id) ?? 'A rep'),
  ), [map.data, poolMap.data, scope, showPool, user.id, user.name, reps]);

  const repOptions = useMemo(
    () => [{ value: 'team', label: 'Whole team' }, ...[...reps].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ value: id, label: name }))],
    [reps],
  );
  const cardProps = {
    scope,
    data: dash.data,
    error: dash.error,
    onRetry: () => void dash.refetch(),
  };

  return (
    <Page wide>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 lg:mb-7">
        <div className="min-w-0">
          <p className="text-sm text-muted">{dateFmt.format(now)}{viewedRep && <> · Viewing {viewedRep}’s book</>}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{greeting(now)}, {firstName(user.name)}</h1>
          <p className="mt-1.5 max-w-3xl text-[15px] text-fg" aria-live="polite">
            {sentence ?? <span className="text-muted">Getting today’s priorities…</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {isManager && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="whitespace-nowrap">Viewing</span>
              <Select
                aria-label="Whose dashboard"
                className="min-w-44"
                value={scope === 'team' ? 'team' : scope.slice(4)}
                onValueChange={(v) => selectRep(v === 'team' ? null : v)}
                options={repOptions}
              />
            </label>
          )}
          {scope === 'mine' && (
            <Link to="/tasks" className={buttonClasses('secondary', 'md')}>
              <ListChecks className="size-4" aria-hidden />My follow-ups
            </Link>
          )}
        </div>
      </header>

      {/* Desktop: the briefing (3/5) with Follow-ups beside it (2/5), both top-aligned. Phones and tablets stack them. */}
      <div className="grid items-start gap-6 lg:grid-cols-5 lg:gap-7">
        <Briefing
          className="lg:col-span-3"
          scope={scope}
          rows={briefing.rows}
          isLoading={briefing.isLoading}
          isFetchingMore={briefing.isFetchingMore}
          error={briefing.error}
          partialError={briefing.partialError}
          onRetry={briefing.refetch}
          showOwner={scope === 'team'}
          intro={<TerritoryBrief scope={scope} className="mx-4 mb-4" />}
        />
        <FollowUpsCard {...cardProps} className="lg:col-span-2" upcoming={upcoming.data} showOwner={scope === 'team'} />
      </div>

      {scope === 'team' && (
        <TeamTable
          className="mt-6 lg:mt-7"
          reps={dash.data?.reps}
          goalPerWeek={repGoal}
          poolSize={kpis.data?.team?.unallocated.allocated}
          isLoading={dash.isLoading}
          error={dash.error}
          onRetry={() => void dash.refetch()}
          onSelectRep={selectRep}
          now={now}
        />
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2 lg:mt-7 lg:gap-7 xl:grid-cols-3">
        {dash.error && !dash.data ? (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-4 self-start px-5 py-4 sm:px-6 sm:py-5 md:col-span-2">
            <p className="text-sm text-fg">
              <span className="font-semibold">The scorecard didn’t load.</span>{' '}
              <span className="text-muted">{errorMessage(dash.error)}</span>
            </p>
            <Button size="sm" onClick={() => void dash.refetch()}>Try again</Button>
          </Card>
        ) : (
          <>
            {/* Follow-ups moved up beside the briefing; Activity takes its place so the 3-column grid has no gap. */}
            <ActivityCard {...cardProps} now={now} className="xl:col-span-2" />
            <AccountsCard {...cardProps} />
            <PipelineCard {...cardProps} className="xl:col-span-2" />
            <BookHealthCard scope={scope} data={dash.data} error={dash.error} onRetry={cardProps.onRetry} now={now} />
            <BookMixCard scope={scope} data={dash.data} error={dash.error} onRetry={cardProps.onRetry} className="md:col-span-2" />
          </>
        )}
        <RecentActivityCard
          className="md:col-span-2 xl:col-span-1"
          scope={scope}
          items={recent.items}
          isLoading={!lowerInView || recent.isLoading}
          error={recent.error}
          onRetry={recent.refetch}
          viewerId={user.id}
          now={now}
        />
      </div>
      <div ref={lowerRef} aria-hidden />

      <WeatherCard
        className="mt-6 lg:mt-7"
        signals={signals.data}
        isLoading={!lowerInView || signals.isLoading}
        error={signals.error}
        who={scope === 'mine' ? 'your' : 'the team’s'}
        now={now}
      />

      <LeadMapCard
        className="mt-6 lg:mt-7"
        leads={mapLeads}
        variant={scope === 'team' ? 'manager' : 'rep'}
        isLoading={!lowerInView || map.isLoading}
        poolLoading={scope === 'mine' && showPool && poolMap.isLoading}
        error={map.error ?? poolMap.error}
        onRetry={() => { void map.refetch(); if (showPool) void poolMap.refetch(); }}
        open={mapOpen}
        onOpenChange={setMapOpen}
        whose={whose}
        listHref={salesLeadsHref(scope)}
        controls={scope === 'mine' && (
          <div className="inline-flex h-8 items-center rounded-full border border-border bg-surface pr-3 pl-2">
            <Toggle size="sm" checked={showPool} onCheckedChange={setShowPool} label={<span className="text-xs font-medium">Show pool</span>} className="items-center" />
          </div>
        )}
      />
    </Page>
  );
}

