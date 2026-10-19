// One typed function per public API route (gateway http://localhost:8080, proxied at /api and /auth).
import { api } from './client';
import type {
  ActivityKind, ActivityLogged, ActivityPage, ActivityType, AllocationByFilterResult, AllocationResult,
  AllocationSuggestionsResponse, BulkTagAttachResult, BulkUnallocateResult, CompanyOverrideField, ConfigResponse,
  ContactCreated, ContactDeleted, ContactInput, ContactOverrideField, CustomFieldKeysResponse, CustomFieldSet,
  CustomTagCreated, CustomTagDeleted, CustomTagsResponse, CustomTagUpdated, DashboardScope, DevLoginResponse,
  InsightsRefreshResult, KpiResponse, LeadFacetsResponse, LeadFilter, LeadMapResponse, LeadMapScope, LeadProfile, LeadSearchResult,
  LeadTagAdded, LeadTagRemoved, MarkNotificationsRead, NoteCreated, NotificationPreferences, NotificationsPage,
  NotificationsReadResult, NotificationType, OverrideResult, RefreshResult, Role, SalesDashboard, SalesStage,
  SavedViewCreate, SavedViewDeleted, SavedViewsResponse, SavedViewUpdate, SavedViewWritten, SessionUser, SignalScope,
  SignalsResponse, StageChanged, StageUpdate, StateChanged, TaskCreate, TaskDeleted, TaskDue, TaskScope, TasksPage,
  TaskStatus, TaskUpdate, TaskWritten, TerritoryBriefResponse, UnallocateResult, UserPreferences, UsersResponse,
} from './types';

const id = encodeURIComponent;
type Opts = { signal?: AbortSignal };

// ---- auth ------------------------------------------------------------------
export const devLogin = (email: string) =>
  api.post<DevLoginResponse>('/auth/dev-login', { email }, { anonymous: true });
export const getMe = (o?: Opts) => api.get<SessionUser>('/api/me', o);
/** The limits the services enforce (bulk sizes, refresh rate): any signed-in user. */
export const getConfig = (o?: Opts) => api.get<ConfigResponse>('/api/config', o);

// ---- reads (query service) ---------------------------------------------------
export const searchLeads = (filter: LeadFilter, o?: Opts) =>
  api.post<LeadSearchResult>('/api/leads/search', { filter }, { ...o, busyRetries: 2 });
/** Facet counts over the leads the filter matches (cursor, limit and sort ignored). */
export const getLeadFacets = (filter: LeadFilter, o?: Opts) =>
  api.post<LeadFacetsResponse>('/api/leads/facets', { filter }, { ...o, busyRetries: 2 });
/** Every lead the caller may see in the scope, as map points. */
export const getLeadMap = (scope?: LeadMapScope, o?: Opts) =>
  api.get<LeadMapResponse>('/api/leads/map', { ...o, query: { scope } });
export const getLead = (leadId: string, o?: Opts) => api.get<LeadProfile>(`/api/leads/${id(leadId)}`, o);
/** `type` filters on the server: one type, a comma-separated list, or a list of ACTIVITY_TYPES (paging stays complete). */
export const getLeadActivity = (
  leadId: string,
  params: { before?: string | null; limit?: number; type?: string | readonly ActivityType[] } = {},
  o?: Opts,
) => api.get<ActivityPage>(`/api/leads/${id(leadId)}/activity`, {
  ...o,
  query: { ...params, type: typeof params.type === 'string' || !params.type ? params.type : params.type.join(',') },
});
export const getKpis = (o?: Opts) => api.get<KpiResponse>('/api/kpis', o);
export const getSignals = (scope?: SignalScope, o?: Opts) =>
  api.get<SignalsResponse>('/api/signals', { ...o, query: { scope } });
export const getCustomTags = (o?: Opts) => api.get<CustomTagsResponse>('/api/custom-tags', o);
export const getCustomFieldKeys = (o?: Opts) => api.get<CustomFieldKeysResponse>('/api/custom-fields/keys', o);
/** Managers only. */
export const getUsers = (role?: Role, o?: Opts) => api.get<UsersResponse>('/api/users', { ...o, query: { role } });
/** Managers only. */
export const getAllocationSuggestions = (limit?: number, o?: Opts) =>
  api.get<AllocationSuggestionsResponse>('/api/allocations/suggestions', { ...o, query: { limit } });

// ---- lead writes (crm-write) -------------------------------------------------
/** Regenerate this lead's AI insight now (any viewer of the lead): 202 {jobId, requestedAt, merged}. */
export const refreshLeadInsights = (leadId: string) =>
  api.post<InsightsRefreshResult>(`/api/leads/${id(leadId)}/insights/refresh`, {});
export const addNote = (leadId: string, text: string) =>
  api.post<NoteCreated>(`/api/leads/${id(leadId)}/notes`, { text });
export const logActivity = (leadId: string, body: { type: ActivityKind; outcome?: string; note?: string }) =>
  api.post<ActivityLogged>(`/api/leads/${id(leadId)}/activities`, body);
export const setLeadState = (leadId: string, change: { checked?: boolean; serviced?: boolean }) =>
  api.post<StateChanged>(`/api/leads/${id(leadId)}/state`, change);

export const setLeadOverride = (leadId: string, field: CompanyOverrideField, value: unknown, version: number) =>
  api.put<OverrideResult>(`/api/leads/${id(leadId)}/overrides/${field}`, { value, version });
export const clearLeadOverride = (leadId: string, field: CompanyOverrideField, version: number) =>
  api.delete<OverrideResult>(`/api/leads/${id(leadId)}/overrides/${field}`, { query: { version } });
export const setContactOverride = (contactId: string, field: ContactOverrideField, value: unknown, version: number) =>
  api.put<OverrideResult>(`/api/contacts/${id(contactId)}/overrides/${field}`, { value, version });
export const clearContactOverride = (contactId: string, field: ContactOverrideField, version: number) =>
  api.delete<OverrideResult>(`/api/contacts/${id(contactId)}/overrides/${field}`, { query: { version } });

export const addContact = (leadId: string, body: ContactInput) =>
  api.post<ContactCreated>(`/api/leads/${id(leadId)}/contacts`, body);
/** Rep-added contacts only; `version` is the contact's (409 when someone edited it meanwhile). */
export const deleteContact = (contactId: string, version: number) =>
  api.delete<ContactDeleted>(`/api/contacts/${id(contactId)}`, { query: { version } });

export const createCustomTag = (name: string) => api.post<CustomTagCreated>('/api/custom-tags', { name });
export const addLeadCustomTag = (leadId: string, tagId: string) =>
  api.post<LeadTagAdded>(`/api/leads/${id(leadId)}/custom-tags`, { tagId });
/** Tags up to 500 leads at once; leads the caller cannot write are skipped and reported. */
export const attachCustomTagToLeads = (tagId: string, companyIds: string[]) =>
  api.post<BulkTagAttachResult>(`/api/custom-tags/${id(tagId)}/leads`, { companyIds });
/** Renames a tag everywhere (its creator or a manager); 409 name_taken when another tag has the name, ignoring case. */
export const renameCustomTag = (tagId: string, name: string) =>
  api.patch<CustomTagUpdated>(`/api/custom-tags/${id(tagId)}`, { name });
/** Unlinks a tag from every lead, then deletes it (its creator or a manager). */
export const deleteCustomTag = (tagId: string) => api.delete<CustomTagDeleted>(`/api/custom-tags/${id(tagId)}`);
export const removeLeadCustomTag = (leadId: string, tagId: string) =>
  api.delete<LeadTagRemoved>(`/api/leads/${id(leadId)}/custom-tags/${id(tagId)}`);
export const setCustomField = (leadId: string, key: string, value: unknown, version: number) =>
  api.put<CustomFieldSet>(`/api/leads/${id(leadId)}/custom-fields/${id(key)}`, { value, version });

// ---- sales: stages, follow-up tasks, dashboard ---------------------------------
/** The scope defaults to team for managers and mine for reps; team and other reps' scopes are managers only. */
export const getSalesDashboard = (scope?: DashboardScope, o?: Opts) =>
  api.get<SalesDashboard>('/api/dashboard', { ...o, query: { scope } });
/** The territory briefing (a digest of the latest poll and weather, or its AI rewrite): mine, team or rep:<id>. */
export const getTerritoryBrief = (scope: DashboardScope, o?: Opts) =>
  api.get<TerritoryBriefResponse>('/api/territory-brief', { ...o, query: { scope } });
/** Open tasks soonest first, done ones most recently completed first; keyset paged by `cursor`. */
export const getTasks = (
  params: { scope?: TaskScope; due?: TaskDue; status?: TaskStatus; limit?: number; cursor?: string | null } = {},
  o?: Opts,
) => api.get<TasksPage>('/api/tasks', { ...o, query: params });
/** 409 (VersionConflictError) when the lead changed since `version`. */
export const setLeadStage = (leadId: string, stage: SalesStage, version: number) =>
  api.put<StageChanged>(`/api/leads/${id(leadId)}/stage`, { stage, version } satisfies StageUpdate);
/** Reps: on their own leads, for themselves; managers may assign anyone who can open the lead. */
export const createTask = (leadId: string, body: TaskCreate) =>
  api.post<TaskWritten>(`/api/leads/${id(leadId)}/tasks`, body);
/** Each task has its own version (409 when stale); `done` completes or reopens it. */
export const updateTask = (taskId: string, patch: TaskUpdate) =>
  api.patch<TaskWritten>(`/api/tasks/${id(taskId)}`, patch);
export const deleteTask = (taskId: string, version: number) =>
  api.delete<TaskDeleted>(`/api/tasks/${id(taskId)}`, { query: { version } });

// ---- allocation (managers only) ---------------------------------------------
export const allocateLeads = (companyIds: string[], repId: string) =>
  api.post<AllocationResult>('/api/allocations', { companyIds, repId });
export const allocateByFilter = (filter: LeadFilter, repId: string) =>
  api.post<AllocationByFilterResult>('/api/allocations/by-filter', { filter, repId });
export const unallocateLead = (companyId: string) => api.delete<UnallocateResult>(`/api/allocations/${id(companyId)}`);
/** Back to the pool in one transaction (at most ConfigResponse.maxBulkUnallocate). */
export const unallocateLeads = (companyIds: string[]) =>
  api.delete<BulkUnallocateResult>('/api/allocations', { body: { companyIds } });

// ---- saved views and preferences ------------------------------------------------
/** The caller's own views, then the team's shared ones, each by name. */
export const getViews = (o?: Opts) => api.get<SavedViewsResponse>('/api/views', o);
/** 409 when the caller already has a view with the name; isShared is for managers only. */
export const createView = (body: SavedViewCreate) => api.post<SavedViewWritten>('/api/views', body);
export const updateView = (viewId: string, patch: SavedViewUpdate) =>
  api.patch<SavedViewWritten>(`/api/views/${id(viewId)}`, patch);
export const deleteView = (viewId: string) => api.delete<SavedViewDeleted>(`/api/views/${id(viewId)}`);
export const getPreferences = (o?: Opts) => api.get<UserPreferences>('/api/preferences', o);
/** Replaces every key; 409 (VersionConflictError) when `version` is stale. */
export const putPreferences = (prefs: Record<string, unknown>, version: number) =>
  api.put<UserPreferences>('/api/preferences', { prefs, version });

// ---- pipeline refresh ----------------------------------------------------------
/** 429 (RateLimitedError) when the user's hourly refresh limit is hit. */
export const requestRefresh = (postalCode: string, radiusMiles: number) =>
  api.post<RefreshResult>('/api/refresh', { postal_code: postalCode, radius_miles: radiusMiles });

// ---- notifications ---------------------------------------------------------------
export const getNotifications = (params: { unread?: boolean; before?: string | null; limit?: number } = {}, o?: Opts) =>
  api.get<NotificationsPage>('/api/notifications', {
    ...o,
    query: { unread: params.unread ? 1 : undefined, before: params.before, limit: params.limit },
  });
export const markNotificationsRead = (body: MarkNotificationsRead) =>
  api.post<NotificationsReadResult>('/api/notifications/read', body);
export const getNotificationPreferences = (o?: Opts) =>
  api.get<NotificationPreferences>('/api/notifications/preferences', o);
/** Sends only the types to change. */
export const putNotificationPreferences = (items: { type: NotificationType; enabled: boolean }[]) =>
  api.put<NotificationPreferences>('/api/notifications/preferences', { items } satisfies NotificationPreferences);

/** SSE URL (EventSource cannot send headers, so the token goes in the query string). */
export const eventsUrl = (token: string, lastEventId?: string | null) => {
  const qs = new URLSearchParams({ access_token: token });
  if (lastEventId) qs.set('lastEventId', lastEventId);
  return `/api/events?${qs}`;
};
