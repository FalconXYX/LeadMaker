// Response shapes of the public API (gateway /api/* -> services). Timestamps are ISO strings.
import type { ACCOUNT_STATUSES, FOLLOW_UPS, LeadFilter, SALES_STAGES, SEGMENTS } from './filter.ts';
import type { ActorType } from './events.ts';
import type { Role } from './visibility.ts';

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type SalesStage = (typeof SALES_STAGES)[number];
export type FollowUp = (typeof FOLLOW_UPS)[number];
export type Segment = (typeof SEGMENTS)[number];

export const SALES_STAGE_LABELS: Record<SalesStage, string> = {
  new: 'New', contacted: 'Contacted', interested: 'Interested', quoting: 'Quoting', won: 'Won', lost: 'Not a fit',
};

/** Company fields a rep may override (field_overrides.field with contact_id NULL). */
export const COMPANY_OVERRIDE_FIELDS = [
  'business_name', 'phone', 'website_url', 'address', 'street', 'city', 'state', 'postal_code',
] as const;
export type CompanyOverrideField = (typeof COMPANY_OVERRIDE_FIELDS)[number];

/** Contact fields a rep may override (field_overrides.field with contact_id set). */
export const CONTACT_OVERRIDE_FIELDS = ['name', 'title', 'email', 'phone', 'do_not_contact'] as const;
export type ContactOverrideField = (typeof CONTACT_OVERRIDE_FIELDS)[number];

export interface UserRef {
  id: string;
  name: string;
}

export interface SystemTag {
  key: string;
  value: unknown;
  label: string;
  category: string;
  reason?: string;
  source?: string;
}

export interface CustomTagRef {
  id: string;
  name: string;
}

export interface LeadStateFlags {
  /** Reviewed after the lead's last material change. */
  checked: boolean;
  /** A call, email or visit was logged. */
  serviced: boolean;
  checkedAt: string | null;
  servicedAt: string | null;
}

export interface LeadSummary {
  id: string;
  businessName: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  websiteUrl: string | null;
  latitude: number;
  longitude: number;
  countyFips: string | null;
  rating: number | null;
  reviewCount: number;
  tier: string | null;
  yearsInBusiness: number | null;
  segment: string | null;
  priorityScore: number | null;
  /** The top ranking reasons (priority_drivers tag). */
  priorityDrivers: string[];
  accountStatus: AccountStatus;
  assignedRep: UserRef | null;
  /** System tags without reasons; the profile has the full tags. */
  tags: Omit<SystemTag, 'reason' | 'source'>[];
  customTags: CustomTagRef[];
  updatedInLastPoll: boolean;
  lastChangeAt: string;
  mine: LeadStateFlags;
  team: LeadStateFlags;
  /** Only with filter.near. */
  distanceMiles: number | null;
  canWrite: boolean;
  version: number;
  /** The size tag's value (small | medium | large); null without one. */
  size?: string | null;
  /** Certification levels as LeadFilter.certifications names them, e.g. ['gaf:master_elite']; empty without any. */
  certifications?: string[];
  /** The profile's timing badges (weather, storms, season), most severe first. */
  timing?: TimingBadge[];
  salesStage: SalesStage;
  /** The latest call, email or visit by anyone; null if never contacted. */
  lastContactedAt: string | null;
  /** The lead's earliest-due open task, whoever it is assigned to. */
  nextTask: NextTask | null;
}

export interface NextTask {
  id: string;
  title: string;
  type: TaskType;
  dueAt: string;
}

export interface FacetCount {
  value: string;
  count: number;
}

/**
 * POST /api/leads/facets {filter}: of the leads the filter matches (cursor, limit and sort ignored), how many have
 * each value, most first. Values are the ones LeadFilter takes for the same facet.
 */
export interface LeadFacetsResponse {
  total: number;
  segment: FacetCount[];
  size: FacetCount[];
  /** 'gaf:master_elite', ...; 'gaf:none' counts leads without a GAF tier. */
  certifications: FacetCount[];
  /** Taxonomy keys from service:<key> / specialty:<key> tags. */
  services: FacetCount[];
  /** The services that are roof materials (LeadFilter.materials). */
  materials: FacetCount[];
  /** value is the tag's name. */
  customTags: (FacetCount & { id: string })[];
  accountStatus: FacetCount[];
  /** Every stage in SALES_STAGES order, zeros included. */
  stages: FacetCount[];
}

/** Map scope: as LeadFilter.scope, with 'rep:{id}' for {repId}; omitted, everything the caller may view. */
export type LeadMapScope = 'mine' | 'unallocated' | 'all' | `rep:${string}`;

/** One lead on the map (GET /api/leads/map). */
export interface LeadMapPoint {
  id: string;
  /** The effective business name (an override, else the scraped one). */
  name: string;
  latitude: number;
  longitude: number;
  segment: string | null;
  priorityScore: number | null;
  assignedRepId: string | null;
  countyFips: string | null;
  /** Severity of the lead's most severe timing badge; null without any. */
  timing: TimingBadge['severity'] | null;
}

/** GET /api/leads/map?scope=: every lead the caller may see in the scope, highest priority first. */
export interface LeadMapResponse {
  items: LeadMapPoint[];
}

export interface LeadSearchResult {
  items: LeadSummary[];
  nextCursor: string | null;
  total: number;
  /** More leads match than the count stops at; total is then that cap. */
  totalCapped: boolean;
}

export interface EffectiveField<T = unknown> {
  /** The override when one is active, else the scraped value. */
  value: T;
  scraped: T;
  overridden: boolean;
  /** The scraped value changed after the rep's edit. */
  sourceChangedSinceEdit: boolean;
  editedBy: UserRef | null;
  editedAt: string | null;
}

export interface LeadContact {
  id: string;
  name: EffectiveField<string | null>;
  title: EffectiveField<string | null>;
  email: EffectiveField<string | null>;
  phone: EffectiveField<string | null>;
  doNotContact: EffectiveField<boolean>;
  source: string;
  sourceUrl: string | null;
  confidence: number;
  emailVerifiedAt: string | null;
  /** The size-appropriate person to ask for (target_contact tag). */
  isTarget: boolean;
  version: number;
}

export interface TargetContact {
  role: string;
  label: string;
  reason: string | null;
  contactId: string | null;
}

export interface TimingBadge {
  key: string;
  label: string;
  reason: string;
  source: string;
  severity: 'high' | 'medium' | 'low' | 'info';
}

export interface InsightFactRef { id: string; text: string }

/** Latest status='ok' company_insights row. salesRecommendation is the pitch angle (one sentence). */
export interface LeadInsight {
  businessSummary: string;
  salesRecommendation: string;
  talkingPoints: string[];
  targetContact: { name: string; title: string; why: string } | null;
  productFocus: string[];
  citedFacts: InsightFactRef[];
  model: string;
  promptVersion: string;
  generatedAt: string;
}

/** activity_logs.action_type values: GET /api/leads/:id/activity?type= takes a comma-separated list of them. */
export const ACTIVITY_TYPES = [
  'note', 'call', 'email', 'visit', 'checked', 'serviced', 'override', 'contact', 'allocation', 'custom_tag',
  'custom_field', 'scraped_change', 'stage_changed', 'task_created', 'task_completed', 'task_updated', 'task_deleted',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityEntry {
  id: string;
  /** note | call | email | visit | checked | serviced | override | allocation | custom_tag | custom_field | scraped_change */
  type: string;
  actorType: ActorType;
  /** null for pipeline and system rows (actorLabel then names the actor type). */
  user: UserRef | null;
  /** Who did it, for display: the user's name, else 'pipeline' or 'system'. */
  actorLabel: string;
  outcome: string | null;
  text: string | null;
  /**
   * Pipeline rows (scraped_change): {fields, from, to, run_id}; a delisting is
   * {fields: ['delisted'], from: {delisted: false}, to: {delisted: true}, area, run_id}.
   * stage_changed: StageChangeDiff; task_*: TaskActivityDiff.
   */
  fieldDiff: unknown;
  createdAt: string;
}

/** fieldDiff of a stage_changed row. auto: a logged call, email or visit (activity_id) moved a new lead to contacted. */
export interface StageChangeDiff {
  sales_stage: [SalesStage, SalesStage];
  auto?: true;
  activity_id?: string;
}

/** fieldDiff of a task_created / task_completed / task_updated / task_deleted row: the task after the change. */
export interface TaskActivityDiff {
  task_id: string;
  title: string;
  type: TaskType;
  due_at: string;
  assignee_id: string;
  /** task_updated and task_completed: {field: [before, after]} of title, type, due_at, note, done_at, assignee_id. */
  changes?: Record<string, [unknown, unknown]>;
}

/** GET /api/leads/:id/activity?before={nextCursor}&type=call,email: older entries, newest first. */
export interface ActivityPage {
  items: ActivityEntry[];
  /** Pass as ?before= for the next older page; null at the end. */
  nextCursor: string | null;
}

export interface AllocationEntry {
  rep: UserRef;
  allocatedBy: UserRef;
  allocatedAt: string;
  endedAt: string | null;
  endedBy: UserRef | null;
}

export interface LeadProfile {
  id: string;
  version: number;
  updatedAt: string;
  fields: Record<CompanyOverrideField, EffectiveField<string | null>>;
  details: {
    industry: string;
    dba: string | null;
    legalName: string | null;
    contractorType: string | null;
    latitude: number;
    longitude: number;
    countyFips: string | null;
    rating: number | null;
    reviewCount: number;
    profileUrl: string | null;
    imageUrl: string | null;
    tier: string | null;
    certifications: unknown[];
    specialties: unknown[];
    distinctions: unknown[];
    presidentsClubStars: number;
    gafLeadsEnrolled: boolean;
    googlePlaceId: string | null;
    description: string | null;
    inBusinessSince: number | null;
    yearsInBusiness: number | null;
    employeesRange: string | null;
    websiteSource: string | null;
    segment: string | null;
    priorityScore: number | null;
    accountStatus: AccountStatus;
    updatedInLastPoll: boolean;
    lastMaterialChangeAt: string | null;
    firstSeenAt: string;
    sourceIds: { source: string; externalId: string }[];
  };
  contacts: LeadContact[];
  targetContact: TargetContact | null;
  systemTags: SystemTag[];
  customTags: (CustomTagRef & { addedBy: UserRef; addedAt: string })[];
  customFields: Record<string, unknown>;
  /** Latest pre-generated insight; null until the pipeline generates one. */
  insights: LeadInsight | null;
  timing: TimingBadge[];
  notes: ActivityEntry[];
  /** The most recent entries; older ones via GET /api/leads/:id/activity?before={activityNextCursor}. */
  activity: ActivityEntry[];
  activityNextCursor: string | null;
  allocation: { current: AllocationEntry | null; history: AllocationEntry[] };
  state: {
    mine: LeadStateFlags;
    team: LeadStateFlags & { byUser: (LeadStateFlags & { user: UserRef })[] };
  };
  permissions: { canWrite: boolean; canAllocate: boolean };
  salesStage: SalesStage;
  /** When salesStage last changed; null while it is still the initial 'new'. */
  stageChangedAt: string | null;
  lastContactedAt: string | null;
  /** Open tasks, earliest due first, then the most recently completed ones. */
  tasks: Task[];
}

export interface KpiCounts {
  allocated: number;
  unchecked: number;
  unserviced: number;
  updated_in_last_poll: number;
}

export interface RepKpis extends KpiCounts {
  repId: string;
  name: string;
  email: string;
  /** Checked/serviced by anyone, not only the rep. */
  teamUnchecked: number;
  teamUnserviced: number;
}

export interface TeamKpis {
  /** When team_dashboard_kpis was last refreshed (every 5 min and after each pipeline run). */
  refreshedAt: string | null;
  /** Every lead, the unallocated pool included (allocated is the lead count); assigned: those with a rep. */
  totals: KpiCounts & { assigned?: number };
  unallocated: KpiCounts;
  reps: RepKpis[];
}

export interface KpiResponse {
  mine: KpiCounts;
  team?: TeamKpis;
}

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: Role;
  allocatedCount: number;
}

export interface AllocationSuggestion {
  repId: string;
  repName: string;
  /** postal_code / county: the rep already works leads there; balance: the least-loaded rep. */
  basis: 'postal_code' | 'county' | 'balance';
  key: string | null;
  reason: string;
  companyIds: string[];
  leads: { id: string; businessName: string; postalCode: string | null; countyFips: string | null; priorityScore: number | null }[];
}

export interface AllocationSuggestionsResponse {
  suggestions: AllocationSuggestion[];
  /** Unallocated leads considered (highest priority first, up to the limit). */
  considered: number;
  unallocatedTotal: number;
}

export type SignalKind = 'active_alert' | 'storm_history' | 'news';

/** One regional_signals row (payload as the pipeline wrote it: NWS alert, storm summary or news article). */
export interface RegionalSignal {
  id: string;
  countyFips: string;
  kind: SignalKind;
  source: string;
  payload: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  fetchedAt: string;
  /** In effect now: an alert or news item inside its validity window, or a county's storm summary. */
  active: boolean;
  /** Its valid_to has passed (alerts, news); storm summaries never expire (see fetchedAt). */
  expired: boolean;
}

/** mine: my allocated leads; pool: unallocated; all: everything the caller may see. */
export type SignalScope = 'mine' | 'pool' | 'all';

/** GET /api/signals: the weather/news layer for the counties of the caller's leads, newest first. */
export interface SignalsResponse {
  scope: SignalScope;
  /** name: the Census county name with its state ("Bergen County, NJ"); null outside the shipped table. */
  counties: { countyFips: string; leadCount: number; name?: string | null }[];
  /** Alerts in effect, upcoming, or ended in the last 7 days. */
  alerts: RegionalSignal[];
  /** One rolling summary per county (counts, last and notable events, recent_events). */
  stormHistory: RegionalSignal[];
  /** Local roofing news from the last 30 days. */
  news: RegionalSignal[];
  generatedAt: string;
}

export interface CustomTagListItem {
  id: string;
  name: string;
  createdBy: UserRef;
  createdAt: string;
  /** Leads carrying the tag among those the caller may see. */
  leadCount: number;
}

/** GET /api/custom-tags */
export interface CustomTagsResponse {
  items: CustomTagListItem[];
}

/** 'date' is a string that starts with an ISO date; 'mixed' means more than one type across leads. */
export type CustomFieldValueType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'mixed';

export interface CustomFieldKey {
  key: string;
  /** Visible leads with a non-null value for the key. */
  leadCount: number;
  valueType: CustomFieldValueType;
}

/** GET /api/custom-fields/keys: most used first. */
export interface CustomFieldKeysResponse {
  items: CustomFieldKey[];
}

/** 409 body for a stale optimistic-lock version. */
export interface VersionConflict {
  current: unknown;
  changedBy: UserRef | null;
  changedAt: string | null;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ---- crm-write responses -----------------------------------------------------------------------

/** POST /api/leads/:id/notes (201). */
export interface NoteCreated {
  note: { id: string; companyId: string; text: string; userId: string; userName: string; createdAt: string };
}

export type ActivityKind = 'call' | 'email' | 'visit';

/** companies.team_last_checked_at / team_last_serviced_at after a state write (any rep's latest). */
export interface TeamStateTimes {
  lastCheckedAt: string | null;
  lastServicedAt: string | null;
}

/**
 * POST /api/leads/:id/activities (201); the activity also marks the lead serviced, sets lastContactedAt and moves a
 * 'new' lead to 'contacted' (version then moves too).
 */
export interface ActivityLogged {
  activity: {
    id: string;
    companyId: string;
    type: ActivityKind;
    outcome: string | null;
    note: string | null;
    userId: string;
    userName: string;
    createdAt: string;
  };
  state: LeadStateFlags;
  team: TeamStateTimes;
  salesStage: SalesStage;
  stageChangedAt: string | null;
  lastContactedAt: string;
  /** The lead's version after the activity. */
  version: number;
}

/** POST /api/leads/:id/state {checked?, serviced?}. */
export interface StateChanged {
  state: LeadStateFlags;
  team: TeamStateTimes;
}

/** The active override a write created. */
export interface FieldOverride {
  id: string;
  companyId: string;
  contactId: string | null;
  field: string;
  value: unknown;
  scrapedValueAtEdit: unknown;
  userId: string;
  userName: string;
  createdAt: string;
}

/** PUT /api/leads/:id/overrides/:field and /api/contacts/:id/overrides/:field, and the DELETEs that clear them. */
export interface OverrideResult {
  field: string;
  /** The field's value now: the override, or the scraped value after a clear. */
  value: unknown;
  /** null after a clear. */
  override: FieldOverride | null;
  /** The contact's version for a contact override, else the company's: send it with the next edit. */
  version: number;
  companyVersion: number;
  /** Contact overrides only. */
  contactVersion?: number;
}

/** A contact a rep added (source 'rep'). */
export interface RepContact {
  id: string;
  companyId: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  doNotContact: boolean;
  source: string;
  confidence: number;
  version: number;
  createdAt: string;
}

/** POST /api/leads/:id/contacts (201); version is the lead's. */
export interface ContactCreated {
  contact: RepContact;
  version: number;
}

/** DELETE /api/contacts/:id; version is the lead's. */
export interface ContactDeleted {
  deleted: true;
  contactId: string;
  version: number;
}

export interface CustomTagRecord {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** POST /api/custom-tags: 201 created, 200 when the name (ignoring case) exists. */
export interface CustomTagCreated {
  tag: CustomTagRecord;
  created: boolean;
}

/** POST /api/leads/:id/custom-tags: 201 linked, 200 when it already was; version is the lead's. */
export interface LeadTagAdded {
  tag: CustomTagRecord;
  added: boolean;
  version: number;
}

/** POST /api/custom-tags/:id/leads {companyIds} (at most 500): tags the leads the caller may write, skips the rest. */
export interface BulkTagAttachResult {
  tag: CustomTagRecord;
  /** Newly tagged, with each lead's new version. */
  attached: { companyId: string; version: number }[];
  /** Writable and already tagged: left alone. */
  alreadyTagged: string[];
  /** Visible but not the caller's to write (for a rep: unallocated leads). */
  skippedReadOnly: string[];
  /** Not visible to the caller, or no such lead. */
  skippedInvisible: string[];
}

/** DELETE /api/leads/:id/custom-tags/:tagId. */
export interface LeadTagRemoved {
  removed: true;
  tagId: string;
  version: number;
}

/** A lead a tag rename or delete changed, with its new version. */
export interface TagLeadVersion {
  companyId: string;
  version: number;
}

/**
 * PATCH /api/custom-tags/:id {name} (the tag's creator or a manager; 409 when another tag has the name, ignoring
 * case). Links stay; every tagged lead's version moves, since profiles show tag names.
 */
export interface CustomTagUpdated {
  tag: CustomTagRecord;
  previousName: string;
  /** Tagged leads the caller may see. */
  leads: TagLeadVersion[];
}

/** DELETE /api/custom-tags/:id (the tag's creator or a manager): unlinks it from every lead, then deletes it. */
export interface CustomTagDeleted {
  deleted: true;
  tagId: string;
  name: string;
  /** Untagged leads the caller may see. */
  leads: TagLeadVersion[];
}

/** PUT /api/leads/:id/custom-fields/:key {value, version}; value null removes the key. */
export interface CustomFieldSet {
  key: string;
  value: string | number | boolean | null;
  customFields: Record<string, unknown>;
  version: number;
}

/** A lead an allocation moved, and its rep before (null: the pool). */
export interface AllocatedLead {
  companyId: string;
  previousRepId: string | null;
  version: number;
}

/** POST /api/allocations {companyIds, repId}. */
export interface AllocationResult {
  repId: string;
  allocated: AllocatedLead[];
  /** Already with the rep: left alone. */
  unchanged: string[];
}

/** POST /api/allocations/by-filter {filter, repId}. */
export interface AllocationByFilterResult extends AllocationResult {
  /** Always empty: the filter is resolved and its leads moved in one transaction. */
  missing: string[];
  /** Leads the filter matched (allocated + unchanged). */
  matched: number;
}

/** DELETE /api/allocations/:companyId: back to the unallocated pool. */
export interface UnallocateResult {
  companyId: string;
  previousRepId: string | null;
  version: number;
}

/** DELETE /api/allocations {companyIds} (managers; at most ConfigResponse.maxBulkUnallocate): back to the pool. */
export interface BulkUnallocateResult {
  /** Returned to the pool, each with its rep before; ordered by id. */
  unallocated: UnallocateResult[];
  /** Already in the pool: left alone. */
  unchanged: string[];
}

/** PUT /api/leads/:id/stage body; a stale version is 409 (VersionConflict, current {version, stage}). */
export interface StageUpdate {
  stage: SalesStage;
  version: number;
}

/** PUT /api/leads/:id/stage: unchanged (same version) when the lead already had the stage. */
export interface StageChanged {
  stage: SalesStage;
  version: number;
  stageChangedAt: string | null;
}

/**
 * POST /api/leads/:id/insights/refresh (no body): regenerate this lead's AI insight now, from its current facts
 * (tags, notes, activity, overrides, contacts, stage), even when they look unchanged. Any viewer of the lead may ask
 * (404 otherwise). 202 with the queued job, or the open one it merged into (merged: true). The new insight has a
 * generatedAt later than requestedAt and arrives as a lead.updated {fields: ['insights']} event. Errors:
 * 409 'insights_unavailable' (a do-not-contact lead never gets one), 429 'try_again_later' (+ Retry-After).
 */
export interface InsightsRefreshResult {
  jobId: number;
  /** When the job was queued (server clock); compare with LeadInsight.generatedAt. */
  requestedAt: string;
  merged: boolean;
}

export const INSIGHTS_REFRESH_ERRORS = ['insights_unavailable', 'try_again_later'] as const;
export type InsightsRefreshError = (typeof INSIGHTS_REFRESH_ERRORS)[number];

/** POST /api/refresh {postal_code, radius_miles}: 202 queued, 200 merged into the open job for the same area. */
export interface RefreshResult {
  merged: boolean;
  job: { id: number; kind: 'scrape'; status: string; dedupeKey: string; createdAt: string };
}

// ---- saved views and preferences ---------------------------------------------------------------

/** A saved lead list: a LeadFilter (cursor dropped) and its sort, private or shared with the team by a manager. */
export interface SavedView {
  id: string;
  name: string;
  filter: LeadFilter;
  sort: LeadFilter['sort'] | null;
  isShared: boolean;
  owner: UserRef;
  /** The caller owns it. */
  mine: boolean;
  /** The caller may change or delete it: its owner, or any manager for a shared view. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/views: the caller's views, then the team's shared ones, by name. */
export interface SavedViewsResponse {
  items: SavedView[];
}

/** POST /api/views body (names are unique per owner; 409 on a clash). isShared: managers only. */
export interface SavedViewCreate {
  name: string;
  filter: LeadFilter;
  sort?: LeadFilter['sort'] | null;
  isShared?: boolean;
}

/** PATCH /api/views/:id body: the fields to change. */
export type SavedViewUpdate = Partial<SavedViewCreate>;

/** POST /api/views (201) and PATCH /api/views/:id. */
export interface SavedViewWritten {
  view: SavedView;
}

/** DELETE /api/views/:id. */
export interface SavedViewDeleted {
  deleted: true;
  id: string;
}

/** GET /api/preferences, and PUT /api/preferences {prefs, version}: the caller's UI preferences. */
export interface UserPreferences {
  prefs: Record<string, unknown>;
  /** 0 until first saved; PUT sends the version it read and gets 409 (VersionConflict) when it is stale. */
  version: number;
  updatedAt: string | null;
}

/** PUT /api/preferences body: replaces prefs. */
export interface UserPreferencesUpdate {
  prefs: Record<string, unknown>;
  version: number;
}

/** GET /api/config: limits the services enforce, for any signed-in user. */
export interface ConfigResponse {
  /** Most leads one POST /api/allocations or /api/allocations/by-filter may move. */
  maxBulkAllocation: number;
  /** Most leads one POST /api/custom-tags/:id/leads may tag. */
  maxBulkTag: number;
  /** Most leads one DELETE /api/allocations may return to the pool. */
  maxBulkUnallocate: number;
  /** POST /api/refresh jobs per user per rolling hour; 0 = unlimited. */
  refreshPerHour: number;
  /** The longest a role change takes to apply (the gateway's role cache). */
  userRoleTtlSeconds: number;
  /** Calls, emails and visits each rep aims for per week (the dashboard's goal line). */
  weeklyActivityGoal: number;
}

// ---- notifications (services/notifier) ---------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'allocated', 'reassigned_away', 'storm_alert', 'source_changed', 'refresh_done', 'refresh_failed', 'manager_note',
  'pool_grew', 'task_assigned', 'task_due',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** One in-app notification. A repeat merges into the unread row: count + 1, a new title and body, updatedAt moves. */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** The lead to open; null without one, or once the viewer can no longer open it. */
  companyId: string | null;
  countyFips: string | null;
  /**
   * Per type, e.g. allocated {company_ids, latest}; refresh_done / refresh_failed {job_id, status, postal_code, new, changed};
   * task_assigned {task_ids, latest, company, by}; task_due {task_id, title, company, due_at}.
   */
  data: Record<string, unknown>;
  count: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
}

/** GET /api/notifications?unread=1&before={nextCursor}&limit=: latest activity first. */
export interface NotificationsPage {
  items: Notification[];
  nextCursor: string | null;
  unreadCount: number;
}

/** POST /api/notifications/read {ids} | {all: true}. */
export interface NotificationsReadResult {
  updated: number;
  unreadCount: number;
}

/** GET and PUT /api/notifications/preferences (PUT sends the items to change): every type, enabled unless turned off. */
export interface NotificationPreferences {
  items: { type: NotificationType; enabled: boolean }[];
}

/** Payload of the 'notification.created' event (outbox, then SSE to user_id only), one per notification written. */
export interface NotificationCreatedPayload {
  user_id: string;
  notification_id: string;
  type: NotificationType;
  count: number;
  /** The notification's title and body as written (after a merge, the merged ones); absent on older events. */
  title?: string;
  body?: string;
  actor_type: 'system';
  actor_id: null;
  actor_name?: 'system';
}

// ---- tasks (written by crm-write, listed by query) ----------------------------------------------

export const TASK_TYPES = ['call', 'email', 'visit', 'todo'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * A follow-up on a lead. Reps create tasks for themselves on their own leads; managers on any lead, for anyone who
 * can open it. Edits send the version they read (409 VersionConflict, current = the Task, when stale).
 */
export interface Task {
  id: string;
  companyId: string;
  /** The effective business name (an override, else the scraped one). */
  companyName: string;
  title: string;
  type: TaskType;
  dueAt: string;
  /** null while open. */
  doneAt: string | null;
  note: string | null;
  assignee: UserRef;
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** POST /api/leads/:id/tasks body; assigneeId defaults to the caller. */
export interface TaskCreate {
  title: string;
  type: TaskType;
  dueAt: string;
  note?: string;
  assigneeId?: string;
}

/** PATCH /api/tasks/:id body: the fields to change; done true completes the task, false reopens it. */
export interface TaskUpdate {
  title?: string;
  type?: TaskType;
  dueAt?: string;
  /** null clears it. */
  note?: string | null;
  done?: boolean;
  /** Reassign: same rule as TaskCreate.assigneeId. */
  assigneeId?: string;
  version: number;
}

/** POST /api/leads/:id/tasks (201) and PATCH /api/tasks/:id. */
export interface TaskWritten {
  task: Task;
}

/** DELETE /api/tasks/:id?version=. */
export interface TaskDeleted {
  deleted: true;
  id: string;
}

/** Whose tasks (GET /api/tasks?scope=) or dashboard: the caller's, the whole team (managers), or one rep's. */
export type SalesScope = 'mine' | 'team' | `rep:${string}`;
export type TaskScope = SalesScope;
/**
 * GET /api/tasks?due=: overdue (due before today), today, week (today and the next 6 days), upcoming (after today),
 * all. Days are in SALES_TIME_ZONE.
 */
export const TASK_DUE = ['overdue', 'today', 'week', 'upcoming', 'all'] as const;
export type TaskDue = (typeof TASK_DUE)[number];
export type TaskStatus = 'open' | 'done';

/**
 * GET /api/tasks?scope=mine|team|rep:<id>&due=&status=open|done&limit=&cursor=: open tasks earliest due first, done ones
 * most recently completed first; only tasks on leads the caller may open.
 */
export interface TasksPage {
  items: Task[];
  nextCursor: string | null;
}

// ---- sales dashboard (query) --------------------------------------------------------------------

export type DashboardScope = SalesScope;

export interface ActivityCounts {
  calls: number;
  emails: number;
  visits: number;
  notes: number;
}

export interface StageCount {
  stage: SalesStage;
  count: number;
}

/** One rep's row of the team dashboard. */
export interface RepDashboardRow {
  rep: UserRef;
  /** Leads allocated to the rep. */
  assigned: number;
  /** Every stage in SALES_STAGES order, zeros included. */
  pipeline: StageCount[];
  /** Calls, emails and visits the rep logged this week. */
  activityThisWeek: number;
  /** The rep's open tasks due before today. */
  overdue: number;
  /** The rep's leads moved to won this calendar month. */
  wonThisMonth: number;
}

/**
 * GET /api/dashboard?scope=mine|team|rep:<id>: the leads in scope (mine: allocated to the caller; team: every allocated
 * lead, managers only; rep:<id>: that rep's, managers or the rep). Weeks start on Monday and days are in SALES_TIME_ZONE.
 */
export interface SalesDashboard {
  scope: DashboardScope;
  /** Every stage in SALES_STAGES order, zeros included. */
  pipeline: StageCount[];
  /** Open tasks on the scope's leads: overdue (due before today), due today, due this week (today and the next 6 days). */
  followUps: { overdue: number; today: number; week: number };
  activity: {
    /** Calls, emails, visits and notes logged on the scope's leads, Monday to now. */
    thisWeek: ActivityCounts;
    lastWeek: ActivityCounts;
    /** Calls + emails + visits aimed for per week: ConfigResponse.weeklyActivityGoal per rep in scope. */
    goalPerWeek: number;
    /** The last 14 days, oldest first, every day present (zeros included); date is YYYY-MM-DD. */
    daily: (ActivityCounts & { date: string })[];
  };
  accounts: Record<AccountStatus, number>;
  coverage: {
    total: number;
    /** With a contact matching the lead's target contact role, or titled owner / president / principal. */
    withDecisionMaker: number;
    withEmail: number;
    withPhone: number;
  };
  /** Leads without any call, email or visit. */
  neverContacted: number;
  /** Leads last contacted 30 days ago or more (never contacted excluded). */
  notContacted30d: number;
  /** Leads new or changed in the latest pipeline run (updated_in_last_poll). */
  newSinceLastPoll: number;
  /** Most common tags on the scope's leads; kind says whether key is a system tag ref or a custom tag id. */
  topTags: { key: string; label: string; count: number; kind: 'system' | 'custom' }[];
  /** Every segment in SEGMENTS order, zeros included. */
  segments: { segment: Segment; count: number }[];
  /** team only: one row per rep, by name. */
  reps?: RepDashboardRow[];
  /**
   * New leads worth a call (at most 5): leads the scope's rep may work (unallocated or their own; team:
   * unallocated) that the rep never called, emailed or visited (team: nobody did) and that are not on today's call
   * list. First those first seen in the last 14 days ('new'), then the highest priority ones with an
   * AI insight ('top_match').
   */
  aiPicks: AiPick[];
  /**
   * The AI pitch (first sentence of the lead's insight pitch) for each lead on today's call list as the dashboard
   * builds it (open follow-ups due by today, quiet interested / quoting leads, fresh and strategic new leads), keyed by
   * lead id; leads without one are left out. A call-list row's aiPitch is callPitches[leadId] ?? null.
   */
  callPitches: Record<string, string>;
  generatedAt: string;
}

/** SalesDashboard.aiPicks: a lead LeadMaker found, ranked with its AI insight. */
export interface AiPick {
  id: string;
  /** The effective business name (a rep's correction, else the scraped one). */
  name: string;
  city: string | null;
  /** "Bergen County, NJ"; null outside the county table. */
  county: string | null;
  priorityScore: number | null;
  /** First sentence of the insight's business summary. */
  aiSummary: string | null;
  /** First sentence of the insight's pitch (sales recommendation). */
  aiPitch: string | null;
  /** When the pipeline first found the lead (ISO). */
  foundAt: string | null;
  label: 'new' | 'top_match';
}

// ---- AI (Section 4: query read API for the assistant and the dashboard brief) ----------------------

/** GET /api/leads/:id/ai-context: what the assistant may tell this user about one lead. Visibility-checked like the
 *  profile; never contains contact emails or phone numbers (hasEmail / hasPhone only). Sizes: AI_CONTEXT_LIMITS. */
export interface LeadAiContext {
  id: string;
  businessName: string;
  city: string | null; state: string | null; postalCode: string | null;
  countyFips: string | null; countyName: string | null;
  websiteUrl: string | null;
  gaf: {
    tier: string | null; certifications: string[]; rating: number | null; reviewCount: number;
    yearsInBusiness: number | null; employeesRange: string | null; specialties: string[]; distinctions: string[];
    presidentsClubStars: number; description: string | null;
  };
  size: string | null; segment: string | null; priorityScore: number | null; priorityDrivers: string[];
  accountStatus: AccountStatus; salesStage: SalesStage; stageChangedAt: string | null; lastContactedAt: string | null;
  assignedRep: UserRef | null; canWrite: boolean;
  tags: { key: string; label: string; category: string }[];
  customTags: string[];
  customFields: Record<string, unknown>;
  targetContact: { label: string; reason: string | null; name: string | null; title: string | null } | null;
  contacts: { name: string | null; title: string | null; hasEmail: boolean; hasPhone: boolean; doNotContact: boolean; source: string }[];
  insights: LeadInsight | null;
  timing: TimingBadge[];
  notes: { author: string; at: string; text: string }[];
  activity: { type: string; outcome: string | null; author: string; at: string; text: string | null }[];
  openTasks: { title: string; type: TaskType; dueAt: string }[];
  website: { url: string; title: string; text: string }[];
  websiteSummary: string | null;
  generatedAt: string;
}
export const AI_CONTEXT_LIMITS = {
  notes: 15, noteChars: 600, activity: 10, activityChars: 300, contacts: 8, tags: 40, openTasks: 5,
  websiteChars: 6000, websitePageChars: 2500, descriptionChars: 900, customFieldChars: 300,
} as const;

/** GET /api/filter-vocabulary: values the AI filter tool may use, for this viewer. */
export interface FilterVocabulary {
  /** Counties of leads the viewer can see, most leads first. */
  counties: { fips: string; name: string | null; leadCount: number }[];
  /** Top 50 custom tags by visible leads. */
  customTags: { id: string; name: string; leadCount: number }[];
  /** Top 30 custom field keys. */
  customFieldKeys: { key: string; valueType: CustomFieldValueType }[];
  /** Managers: every rep (for scope {repId}); [] for reps. */
  reps: UserRef[];
  generatedAt: string;
}

export type BriefScope = 'team' | `rep:${string}`;
/** GET /api/territory-brief?scope=mine|team|rep:<id> */
export interface TerritoryBrief {
  scope: BriefScope;
  /** What to show: the AI rewrite when one matches the current digest, else the deterministic digest text. */
  text: string;
  source: 'ai' | 'digest';
  /** Nothing worth saying: render nothing. */
  quiet: boolean;
  /** computedAt is more than 36 h ago (the worker isn't running): render nothing. */
  stale: boolean;
  digestText: string;
  computedAt: string;
  generatedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  pollFinishedAt: string | null;
  /** Companies named in the text that the viewer can still see. */
  leads: { id: string; name: string }[];
}
export interface TerritoryBriefResponse { brief: TerritoryBrief | null }
