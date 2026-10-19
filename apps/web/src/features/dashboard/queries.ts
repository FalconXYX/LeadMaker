// Dashboard reads and the briefing's two writes. Lead-derived keys sit under ['leads', 'list', ...] so every lead
// event refreshes them; task keys start with ['tasks'] so the tasks feature's invalidation reaches them.
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { ActivityEntry, LeadFilter, LeadProfile, LeadSummary, TaskType } from '@/api/types';
import { getSalesDashboard, getTasks, type DashboardScope } from './api';
import { QUIET_DAYS, buildBriefing, type BriefingRow } from './callList';
import { daysAgoDate, leadScope } from './sales';

const BY_PRIORITY = { by: 'priority_score', dir: 'desc' } as const;
export const BRIEFING_TASK_LIMIT = 50;
export const BRIEFING_LEAD_LIMIT = 20;
export const RECENT_LIMIT = 8;

export const dashboardKeys = {
  sales: (scope: DashboardScope) => [...qk.leads.lists, 'dashboard', 'sales', scope] as const,
  leads: (scope: DashboardScope, which: string, filter: LeadFilter) => [...qk.leads.lists, 'dashboard', which, scope, filter] as const,
  tasks: (scope: DashboardScope, due: string) => ['tasks', 'dashboard', scope, due] as const,
  lastTouch: (leadId: string) => [...qk.leads.activity(leadId, 'call,email,visit,note'), 'latest'] as const,
};

export function useSalesDashboard(scope: DashboardScope) {
  return useQuery({
    queryKey: dashboardKeys.sales(scope),
    queryFn: ({ signal }) => getSalesDashboard(scope, { signal }),
    staleTime: 30_000,
  });
}

function useSalesLeads(scope: DashboardScope, which: string, filter: LeadFilter, enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.leads(scope, which, filter),
    queryFn: async ({ signal }) => {
      const res = await ep.searchLeads(filter, { signal });
      return Array.isArray(res?.items) ? res.items : [];
    },
    staleTime: 30_000,
    enabled,
  });
}

const NO_TASKS: never[] = [];
const NO_LEADS: LeadSummary[] = [];

/** Every source of today's call list, ranked; `rows` fills in as each source arrives. */
export function useBriefing(scope: DashboardScope, now: number) {
  const day = daysAgoDate(0, now);
  const sc = leadScope(scope);
  const [overdue, today] = useQueries({
    queries: (['overdue', 'today'] as const).map((due) => ({
      queryKey: dashboardKeys.tasks(scope, due),
      queryFn: ({ signal }: { signal: AbortSignal }) => getTasks({ scope, due, status: 'open', limit: BRIEFING_TASK_LIMIT }, { signal }),
      staleTime: 30_000,
    })),
  });
  const filters = useMemo(() => ({
    quiet: { scope: sc, stages: ['interested', 'quoting'], notContactedSince: daysAgoDate(QUIET_DAYS, now), limit: BRIEFING_LEAD_LIMIT, sort: BY_PRIORITY },
    fresh: { scope: sc, stages: ['new'], updatedInLastPoll: true, limit: BRIEFING_LEAD_LIMIT, sort: BY_PRIORITY },
    strategic: { scope: sc, stages: ['new'], segment: ['strategic'], limit: BRIEFING_LEAD_LIMIT, sort: BY_PRIORITY },
  } satisfies Record<string, LeadFilter>), [day, scope]);
  const quiet = useSalesLeads(scope, 'quiet', filters.quiet);
  const fresh = useSalesLeads(scope, 'fresh', filters.fresh);
  const strategic = useSalesLeads(scope, 'strategic', filters.strategic);

  const sources = [overdue!, today!, quiet, fresh, strategic];
  const rows = useMemo<BriefingRow[]>(() => buildBriefing({
    overdue: overdue!.data ?? NO_TASKS,
    today: today!.data ?? NO_TASKS,
    quiet: quiet.data ?? NO_LEADS,
    fresh: fresh.data ?? NO_LEADS,
    strategic: strategic.data ?? NO_LEADS,
    now,
  }), [overdue!.data, today!.data, quiet.data, fresh.data, strategic.data, now]);

  return {
    rows,
    /** Follow-ups decide the top of the list: wait for them (or their failure) before showing anything. */
    isLoading: overdue!.isPending || today!.isPending,
    /** Still filling in below the follow-ups. */
    isFetchingMore: sources.some((q) => q.isLoading),
    error: sources.every((q) => q.isError) ? sources[0]!.error : null,
    partialError: sources.some((q) => q.isError),
    refetch: () => { for (const q of sources) void q.refetch(); },
  };
}

/** The next few follow-ups after today, for the scorecard. */
export function useUpcomingTasks(scope: DashboardScope) {
  return useQuery({
    queryKey: dashboardKeys.tasks(scope, 'upcoming'),
    queryFn: ({ signal }) => getTasks({ scope, due: 'upcoming', status: 'open', limit: 3 }, { signal }),
    staleTime: 30_000,
  });
}

/** Profiles of the visible rows (shares the profile page's cache, so opening a lead is instant). */
export function useLeadDetails(ids: readonly string[]) {
  return useQueries({
    queries: ids.map((leadId) => ({
      queryKey: qk.leads.detail(leadId),
      queryFn: ({ signal }: { signal: AbortSignal }) => ep.getLead(leadId, { signal }),
      staleTime: 60_000,
    })),
    combine: (results) => new Map<string, { data: LeadProfile | undefined; isLoading: boolean }>(
      ids.map((leadId, i) => [leadId, { data: results[i]?.data, isLoading: !!results[i]?.isLoading }]),
    ),
  });
}

export interface RecentTouch {
  lead: LeadSummary;
  entry: ActivityEntry | null;
  isLoading: boolean;
}

/** The leads contacted most recently, each with its latest call / email / visit / note. */
export function useRecentActivity(scope: DashboardScope, enabled: boolean, limit = RECENT_LIMIT) {
  const filter = useMemo<LeadFilter>(
    () => ({ scope: leadScope(scope), sort: { by: 'last_contacted', dir: 'desc' }, limit }),
    [scope, limit],
  );
  const leads = useSalesLeads(scope, 'recent', filter, enabled);
  const contacted = useMemo(() => (leads.data ?? NO_LEADS).filter((l) => l.lastContactedAt), [leads.data]);
  const entries = useQueries({
    queries: contacted.map((l) => ({
      queryKey: dashboardKeys.lastTouch(l.id),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await ep.getLeadActivity(l.id, { type: 'call,email,visit,note', limit: 1 }, { signal })).items[0] ?? null,
      staleTime: 60_000,
    })),
  });
  const items: RecentTouch[] = contacted.map((lead, i) => ({ lead, entry: entries[i]?.data ?? null, isLoading: !!entries[i]?.isLoading }));
  return { items, isLoading: leads.isLoading, error: leads.error, refetch: () => void leads.refetch() };
}

function invalidateSales(qc: ReturnType<typeof useQueryClient>, leadId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.tasks }),
    qc.invalidateQueries({ queryKey: qk.leads.lists }),
    qc.invalidateQueries({ queryKey: qk.leads.detail(leadId) }),
    qc.invalidateQueries({ queryKey: qk.leads.activityAll(leadId) }),
  ]);
}

export function useRescheduleTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; leadId: string; dueAt: string; version: number }) =>
      ep.updateTask(v.taskId, { dueAt: v.dueAt, version: v.version }),
    onSettled: (_d, _e, v) => invalidateSales(qc, v.leadId),
  });
}

export function useScheduleFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { leadId: string; title: string; type: TaskType; dueAt: string }) =>
      ep.createTask(v.leadId, { title: v.title, type: v.type, dueAt: v.dueAt }),
    onSettled: (_d, _e, v) => invalidateSales(qc, v.leadId),
  });
}

export function useRefreshAfterActivity() {
  const qc = useQueryClient();
  return (leadId: string) => void invalidateSales(qc, leadId);
}
