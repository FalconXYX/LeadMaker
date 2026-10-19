// The sales dashboard, in titled sections rather than a grid of cards: the AI briefing banner (territory brief, weather,
// Ask AI), Today (the call list beside follow-ups and this week's activity), New leads worth a call (AI picks), Your
// pipeline (sales stages beside the book at a glance), the Team table for managers, and the territory map. Reps see
// their own book; managers see the team, or one rep (?rep=<id>).
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as ep from '@/api/endpoints';
import { qk, useConfig, useLeadMap, useSignals, useUsers } from '@/api/queries';
import type { LeadMapPoint, LeadMapScope, SessionUser, UserRef } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { errorMessage } from '@/api/errors';
import { Button, Card, Select, Toggle, buttonClasses } from '@/components/ui';
import { Page } from '@/layout/PageHeader';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { AiHero } from './AiHero';
import { AiPicksCard } from './AiPicks';
import { DEFAULT_WEEKLY_GOAL, type DashboardData, type DashboardScope } from './api';
import { BookOverviewCard } from './BookHealth';
import { Briefing } from './Briefing';
import { countKinds, prioritiesSentence } from './callList';
import { useInView, useNow, useStoredState } from './hooks';
import { LeadMapCard, type MapLead } from './LeadMap';
import { useBriefing, useRecentActivity, useSalesDashboard, useUpcomingTasks } from './queries';
import { SectionHeading } from './parts';
import { RecentActivityList } from './RecentActivity';
import { firstName, salesLeadsHref, weekPace } from './sales';
import { PipelineCard, TodaySidePanel } from './Scorecard';
import { TeamTable } from './TeamTable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_POINTS: LeadMapPoint[] = [];
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const leadsWord = (k: number) => `${formatNumber(k)} ${k === 1 ? 'lead' : 'leads'}`;

/** The banner's plain summary when there is no territory brief worth showing: built from the dashboard's numbers. */
export function heroFallback(d: DashboardData | undefined, whose: string): string | null {
  if (!d) return null;
  const out = [`${leadsWord(d.newSinceLastPoll)} in ${whose} book ${d.newSinceLastPoll === 1 ? 'is' : 'are'} new or updated in the latest data, and ${formatNumber(d.neverContacted)} ${d.neverContacted === 1 ? 'has' : 'have'} never been called.`];
  const top = d.aiPicks[0];
  if (top) out.push(`The best of the new ones is ${top.name}${top.city ? ` in ${top.city}` : ''}: see the AI picks below.`);
  const warm = d.pipeline.interested + d.pipeline.quoting;
  if (warm > 0) out.push(`${formatNumber(warm)} warm ${warm === 1 ? 'deal is' : 'deals are'} still open.`);
  return out.join(' ');
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

  // The banner's weather line and the latest touches sit near the top; the map loads once scrolled near.
  const signals = useSignals(scope === 'mine' ? 'mine' : 'all');
  const recent = useRecentActivity(scope, true, 3);
  const [briefOpen, setBriefOpen] = useState(false);
  const [lowerRef, lowerInView] = useInView<HTMLDivElement>('800px');
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

      <AiHero
        className="mb-9 lg:mb-11"
        scope={scope}
        fallback={heroFallback(dash.data, whose)}
        signals={signals.data}
        signalsLoading={signals.isLoading}
        signalsError={signals.error}
        who={scope === 'mine' ? 'your' : 'the team’s'}
        now={now}
      />

      <section aria-labelledby="today-heading">
        <SectionHeading id="today-heading" title="Today" subtitle="Who to call and what to say" />
        {/* Desktop: the call list (3/5) beside one column of Follow-ups and This week (2/5). Collapsed, both columns end
            at the same height; opened ("Show more"), the list grows and the column stays at the top. */}
        <div className={cn('grid gap-6 lg:grid-cols-5 lg:gap-7', briefOpen ? 'items-start' : 'items-stretch')}>
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
            pitches={dash.data?.callPitches}
            expanded={briefOpen}
            onExpandedChange={setBriefOpen}
          />
          <TodaySidePanel
            {...cardProps}
            className="lg:col-span-2"
            upcoming={upcoming.data}
            showOwner={scope === 'team'}
            now={now}
            recent={(
              <RecentActivityList
                scope={scope}
                items={recent.items.slice(0, 3)}
                isLoading={recent.isLoading}
                error={recent.error}
                onRetry={recent.refetch}
                viewerId={user.id}
                now={now}
              />
            )}
          />
        </div>
      </section>

      <section aria-labelledby="picks-heading" className="mt-10 lg:mt-12">
        <SectionHeading id="picks-heading" title="New leads worth a call" subtitle="Found by LeadMaker and ranked by AI" />
        <AiPicksCard scope={scope} data={dash.data} error={dash.error} onRetry={cardProps.onRetry} />
      </section>

      <section aria-labelledby="pipeline-heading" className="mt-10 lg:mt-12">
        <SectionHeading
          id="pipeline-heading"
          title={scope === 'mine' ? 'Your pipeline' : scope === 'team' ? 'Team pipeline' : `${viewedRep ? firstName(viewedRep) : 'This rep'}’s pipeline`}
          subtitle={`Where ${whose} deals stand, and what ${whose} leads look like`}
        />
        {dash.error && !dash.data ? (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6 sm:py-5">
            <p className="text-sm text-fg">
              <span className="font-semibold">The pipeline didn’t load.</span>{' '}
              <span className="text-muted">{errorMessage(dash.error)}</span>
            </p>
            <Button size="sm" onClick={() => void dash.refetch()}>Try again</Button>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-7">
            <PipelineCard {...cardProps} now={now} />
            <BookOverviewCard scope={scope} data={dash.data} error={dash.error} onRetry={cardProps.onRetry} />
          </div>
        )}
      </section>

      {scope === 'team' && (
        <section aria-labelledby="team-heading" className="mt-10 lg:mt-12">
          <SectionHeading id="team-heading" title="Team" subtitle="How each rep is doing: leads, stages, this week’s activity and overdue follow-ups" />
          <TeamTable
            reps={dash.data?.reps}
            goalPerWeek={repGoal}
            poolSize={kpis.data?.team?.unallocated.allocated}
            isLoading={dash.isLoading}
            error={dash.error}
            onRetry={() => void dash.refetch()}
            onSelectRep={selectRep}
            now={now}
          />
        </section>
      )}
      <div ref={lowerRef} aria-hidden />

      <section aria-labelledby="map-heading" className="mt-10 lg:mt-12">
        <SectionHeading id="map-heading" title="Territory map" subtitle={`Where ${whose} leads are. Bigger dots are higher priority.`} />
      <LeadMapCard
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
            <Toggle size="sm" checked={showPool} onCheckedChange={setShowPool} label={<span className="text-xs font-medium">Show unassigned leads</span>} className="items-center" />
          </div>
        )}
      />
      </section>
    </Page>
  );
}

