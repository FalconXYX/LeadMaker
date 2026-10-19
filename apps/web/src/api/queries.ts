// TanStack Query keys + hooks for the main reads. Convention: every key starts with its resource
// (['leads', ...], ['kpis'], ...) so live events and mutations can invalidate by prefix.
import {
  keepPreviousData, useInfiniteQuery, useQuery, type QueryClient, type QueryKey,
} from '@tanstack/react-query';
import * as ep from './endpoints';
import { registerCountyNames } from '@/lib/counties';
import type { LeadFilter, LeadMapScope, Role, SignalScope, SignalsResponse } from './types';

export const qk = {
  me: ['me'] as const,
  /** GET /api/config (service limits). */
  config: ['config'] as const,
  views: ['views'] as const,
  preferences: ['preferences'] as const,
  leads: {
    all: ['leads'] as const,
    lists: ['leads', 'list'] as const,
    list: (filter: LeadFilter) => ['leads', 'list', filter] as const,
    infinite: (filter: LeadFilter) => ['leads', 'list', 'infinite', filter] as const,
    /** Facet counts and map points change with the lists, so they live under the same prefix. */
    facets: (filter: LeadFilter) => ['leads', 'list', 'facets', filter] as const,
    map: (scope: LeadMapScope | 'default') => ['leads', 'list', 'map', scope] as const,
    details: ['leads', 'detail'] as const,
    detail: (leadId: string) => ['leads', 'detail', leadId] as const,
    activity: (leadId: string, type?: string) => ['leads', 'activity', leadId, type ?? 'all'] as const,
    activityAll: (leadId: string) => ['leads', 'activity', leadId] as const,
  },
  kpis: ['kpis'] as const,
  /** Follow-up task lists (features/tasks and the dashboard key theirs under this prefix). */
  tasks: ['tasks'] as const,
  signals: (scope?: SignalScope) => ['signals', scope ?? 'default'] as const,
  signalsAll: ['signals'] as const,
  customTags: ['custom-tags'] as const,
  customFieldKeys: ['custom-fields', 'keys'] as const,
  users: (role?: Role) => ['users', role ?? 'all'] as const,
  usersAll: ['users'] as const,
  allocationSuggestions: (limit?: number) => ['allocations', 'suggestions', limit ?? 'default'] as const,
  allocationsAll: ['allocations'] as const,
  notifications: {
    all: ['notifications'] as const,
    list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly ? 'unread' : 'all'] as const,
    preferences: ['notifications', 'preferences'] as const,
  },
  /** GET /api/territory-brief?scope= (the dashboard's one-paragraph briefing). */
  territoryBrief: (scope: string) => ['territory-brief', scope] as const,
  territoryBriefAll: ['territory-brief'] as const,
  /** GET /api/assistant/status (the assistant panel's status line). */
  assistantStatus: ['assistant', 'status'] as const,
} satisfies Record<string, unknown>;

// ---- leads ---------------------------------------------------------------------

/** One page of a lead search. Keeps the previous page on screen while a new filter loads. */
export function useLeadSearch(filter: LeadFilter, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.leads.list(filter),
    queryFn: ({ signal }) => ep.searchLeads(filter, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

/** Cursor-paginated lead search ("Load more" / infinite scroll). */
export function useInfiniteLeadSearch(filter: Omit<LeadFilter, 'cursor'>, opts: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: qk.leads.infinite(filter),
    queryFn: ({ pageParam, signal }) => ep.searchLeads({ ...filter, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

/** POST /api/leads/facets: how many matching leads have each facet value (cursor, limit and sort ignored). */
export function useLeadFacets(filter: LeadFilter, opts: { enabled?: boolean } = {}) {
  const { cursor: _c, limit: _l, sort: _s, ...rest } = filter;
  return useQuery({
    queryKey: qk.leads.facets(rest),
    queryFn: ({ signal }) => ep.getLeadFacets(rest, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

/** GET /api/leads/map: every lead in the scope as a map point (no paging). */
export function useLeadMap(scope?: LeadMapScope, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.leads.map(scope ?? 'default'),
    queryFn: ({ signal }) => ep.getLeadMap(scope, { signal }),
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

export function useLead(leadId: string | undefined) {
  return useQuery({
    queryKey: qk.leads.detail(leadId ?? ''),
    queryFn: ({ signal }) => ep.getLead(leadId!, { signal }),
    enabled: !!leadId,
    staleTime: 30_000,
  });
}

/** Older activity beyond LeadProfile.activity: start from profile.activityNextCursor. `type`: one or a comma-separated list. */
export function useLeadActivity(leadId: string, opts: { type?: string; startCursor?: string | null; enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: [...qk.leads.activity(leadId, opts.type), opts.startCursor ?? 'head'] as QueryKey,
    queryFn: ({ pageParam, signal }) =>
      ep.getLeadActivity(leadId, { before: pageParam ?? undefined, type: opts.type }, { signal }),
    initialPageParam: (opts.startCursor ?? null) as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: opts.enabled ?? true,
  });
}

// ---- dashboard -------------------------------------------------------------------

export function useKpis() {
  return useQuery({ queryKey: qk.kpis, queryFn: ({ signal }) => ep.getKpis({ signal }), staleTime: 30_000 });
}

/**
 * GET /api/signals with every list present (a partial body never breaks a page), and the county names it
 * carries registered for countyName() and friends.
 */
export async function fetchSignals(scope: SignalScope | undefined, signal?: AbortSignal): Promise<SignalsResponse> {
  const raw = (await ep.getSignals(scope, { signal })) as Partial<SignalsResponse> | undefined;
  const list = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  const res: SignalsResponse = {
    scope: raw?.scope ?? scope ?? 'all',
    counties: list(raw?.counties),
    alerts: list(raw?.alerts),
    stormHistory: list(raw?.stormHistory),
    news: list(raw?.news),
    generatedAt: typeof raw?.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
  };
  registerCountyNames(res.counties);
  return res;
}

export function useSignals(scope?: SignalScope, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.signals(scope),
    queryFn: ({ signal }) => fetchSignals(scope, signal),
    staleTime: 5 * 60_000,
    enabled: opts.enabled,
  });
}

// ---- catalogs ------------------------------------------------------------------------

/** GET /api/config: the services' limits; they change only with a deploy. */
export function useConfig(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.config,
    queryFn: ({ signal }) => ep.getConfig({ signal }),
    staleTime: 5 * 60_000,
    enabled: opts.enabled,
  });
}

export function useCustomTags() {
  return useQuery({ queryKey: qk.customTags, queryFn: ({ signal }) => ep.getCustomTags({ signal }), staleTime: 60_000 });
}

export function useCustomFieldKeys() {
  return useQuery({
    queryKey: qk.customFieldKeys,
    queryFn: ({ signal }) => ep.getCustomFieldKeys({ signal }),
    staleTime: 5 * 60_000,
  });
}

// ---- managers ----------------------------------------------------------------------------

/** Managers only: pass enabled = isManager(user). */
export function useUsers(role?: Role, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.users(role),
    queryFn: ({ signal }) => ep.getUsers(role, { signal }),
    staleTime: 60_000,
    enabled: opts.enabled,
  });
}

export function useAllocationSuggestions(limit?: number, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.allocationSuggestions(limit),
    queryFn: ({ signal }) => ep.getAllocationSuggestions(limit, { signal }),
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

// ---- notifications ----------------------------------------------------------------------

export function useNotifications(opts: { unreadOnly?: boolean; limit?: number; enabled?: boolean } = {}) {
  const unreadOnly = opts.unreadOnly ?? false;
  return useInfiniteQuery({
    queryKey: qk.notifications.list(unreadOnly),
    queryFn: ({ pageParam, signal }) =>
      ep.getNotifications({ unread: unreadOnly, before: pageParam, limit: opts.limit }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

export function useNotificationPreferences(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.notifications.preferences,
    queryFn: ({ signal }) => ep.getNotificationPreferences({ signal }),
    enabled: opts.enabled,
  });
}

// ---- invalidation helpers (use in mutation onSuccess/onSettled) ---------------------------

/** After any write to one lead: its profile + activity, every list, the KPIs. */
export function invalidateLead(qc: QueryClient, leadId: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.leads.detail(leadId) }),
    qc.invalidateQueries({ queryKey: qk.leads.activityAll(leadId) }),
    qc.invalidateQueries({ queryKey: qk.leads.lists }),
    qc.invalidateQueries({ queryKey: qk.kpis }),
  ]).then(() => undefined);
}

/** After allocation changes: lists, KPIs, suggestions, users' allocated counts, and the touched profiles. */
export function invalidateAllocation(qc: QueryClient, leadIds: string[] = []): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.leads.lists }),
    qc.invalidateQueries({ queryKey: qk.kpis }),
    qc.invalidateQueries({ queryKey: qk.allocationsAll }),
    qc.invalidateQueries({ queryKey: qk.usersAll }),
    ...leadIds.map((leadId) => qc.invalidateQueries({ queryKey: qk.leads.detail(leadId) })),
  ]).then(() => undefined);
}
