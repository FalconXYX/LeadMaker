// GET /leads/:id. Two statements:
//  - head (every request): visibility check, version, and what changes without a version bump
//    (per-user and team state, notes/activity, allocation history, the county's signals, enrichments, the sales
//    stage and last contact, tasks, and the latest AI insight: the insight writer does not bump companies.version);
//  - body (cached as 'lead:{id}:v{version}', shared by every viewer, so nothing user-specific): company
//    fields with overrides, contacts, tags, custom tags/fields, source ids.
// Timing badges are computed per request from body tags + head signals and enrichments, so they follow the
// clock and an enrichment refresh (which does not bump companies.version).
import {
  cacheKeys, canAllocate, canonicalJson, canWrite, COMPANY_OVERRIDE_FIELDS, FOUNDED_YEAR, isUuid, LEAD_PROFILE_TTL_SECONDS, raw, sql,
  TASK_SELECT, taskOut, visibilitySql, type ActivityEntry, type ActivityPage, type AllocationEntry, type EffectiveField,
  type LeadContact, type LeadInsight, type LeadProfile, type LeadStateFlags, type SalesStage, type Sql, type SystemTag, type TargetContact,
  type TaskRow, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';
import { badRequest, notFound } from './errors.ts';
import { iso, yearsSince } from './search.ts';
import { timingBadges, type SignalRow } from './timing.ts';

export const ACTIVITY_LIMIT = 100;
export const NOTES_LIMIT = 100;
export const ALLOCATION_HISTORY_LIMIT = 20;
export const OPEN_TASKS_LIMIT = 100;
export const DONE_TASKS_LIMIT = 20;

interface StateRow {
  checked_at: string | null;
  serviced_at: string | null;
  checked: boolean;
}

interface ActivityRow {
  id: string;
  action_type: string;
  actor_type: ActivityEntry['actorType'];
  user_id: string | null;
  user_name: string | null;
  outcome: string | null;
  note_text: string | null;
  field_diff: unknown;
  created_at: string;
}

interface AllocationRow {
  rep_id: string;
  rep_name: string;
  allocated_by: string;
  allocated_by_name: string;
  allocated_at: string;
  ended_at: string | null;
  ended_by: string | null;
  ended_by_name: string | null;
}

export interface HeadDoc {
  id: string;
  version: number;
  assigned_rep_id: string | null;
  team_last_checked_at: string | null;
  team_last_serviced_at: string | null;
  team_checked: boolean;
  my_state: StateRow | null;
  team_states: (StateRow & { user_id: string; name: string })[];
  allocations: AllocationRow[];
  /** Up to ACTIVITY_LIMIT + 1 rows: the extra one only says that older entries exist. */
  activity: ActivityRow[];
  notes: ActivityRow[];
  signals: SignalRow[];
  enrichment: Record<string, { status: string; data: { services: unknown[] } }>;
  sales_stage: SalesStage;
  stage_changed_at: string | null;
  last_contacted_at: string | null;
  /** Every task on the lead, whoever it is assigned to (as LeadSummary.nextTask): open ones earliest due first, then
   *  the latest done ones. */
  tasks: TaskRow[];
  /** The latest status='ok' company_insights row (error rows are never served). */
  insight: InsightRow | null;
}

/** company_insights columns the profile serves (Section 4 batch insights). */
export interface InsightRow {
  business_summary: string;
  sales_recommendation: string;
  talking_points: unknown;
  target_contact: unknown;
  product_focus: unknown;
  cited_facts: unknown;
  model: string;
  prompt_version: string;
  generated_at: string;
}

interface OverrideRow {
  contact_id: string | null;
  field: string;
  value: unknown;
  scraped_value_at_edit: unknown;
  user_id: string;
  user_name: string;
  created_at: string;
}

interface ContactRow {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  source_url: string | null;
  confidence: number;
  email_verified_at: string | null;
  do_not_contact: boolean;
  version: number;
}

export interface BodyDoc {
  id: string;
  version: number;
  updated_at: string;
  industry: string;
  business_name: string;
  dba: string | null;
  legal_name: string | null;
  contractor_type: string | null;
  address: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  website_url: string | null;
  website_source: string | null;
  latitude: number;
  longitude: number;
  county_fips: string | null;
  rating: number | null;
  review_count: number;
  profile_url: string | null;
  image_url: string | null;
  tier: string | null;
  certifications: unknown[];
  specialties: unknown[];
  distinctions: unknown[];
  presidents_club_stars: number;
  gaf_leads_enrolled: boolean;
  google_place_id: string | null;
  description: string | null;
  in_business_since: number | null;
  founded_year: number | null;
  employees_range: string | null;
  segment: string | null;
  priority_score: number | null;
  account_status: LeadProfile['details']['accountStatus'];
  updated_in_last_poll: boolean;
  last_material_change_at: string | null;
  first_seen_at: string;
  system_tags: SystemTag[];
  custom_fields: Record<string, unknown>;
  source_ids: { source: string; externalId: string }[];
  overrides: OverrideRow[];
  contacts: ContactRow[];
  custom_tags: { id: string; name: string; added_by: string; added_by_name: string; added_at: string }[];
}

// LEFT JOIN: pipeline and system rows have no user.
const activityRows = (where: Sql, limit: number) => sql`
  SELECT COALESCE(json_agg(l ORDER BY l.created_at DESC, l.id DESC), '[]'::json) FROM (
    SELECT al.id, al.action_type, al.actor_type, al.user_id, u.name AS user_name, al.outcome, al.note_text,
           al.field_diff, al.created_at
    FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.company_id = c.id ${where}
    ORDER BY al.created_at DESC, al.id DESC LIMIT ${limit}::int) l`;

const CHECKED = (col: string) => `(${col} IS NOT NULL AND (c.last_material_change_at IS NULL OR ${col} >= c.last_material_change_at))`;

export function headQuery(id: string, viewer: Viewer) {
  return sql`
    SELECT row_to_json(h) AS doc FROM (
      SELECT c.id, c.version, c.assigned_rep_id, c.team_last_checked_at, c.team_last_serviced_at,
        ${raw(CHECKED('c.team_last_checked_at'))} AS team_checked,
        (SELECT row_to_json(s) FROM (
           SELECT st.checked_at, st.serviced_at, ${raw(CHECKED('st.checked_at'))} AS checked
           FROM lead_rep_state st WHERE st.company_id = c.id AND st.user_id = ${viewer.id}::uuid) s) AS my_state,
        (SELECT COALESCE(json_agg(s ORDER BY s.name, s.user_id), '[]'::json) FROM (
           SELECT st.user_id, u.name, st.checked_at, st.serviced_at, ${raw(CHECKED('st.checked_at'))} AS checked
           FROM lead_rep_state st JOIN users u ON u.id = st.user_id WHERE st.company_id = c.id) s) AS team_states,
        (SELECT COALESCE(json_agg(a ORDER BY a.allocated_at DESC), '[]'::json) FROM (
           SELECT la.rep_id, r.name AS rep_name, la.allocated_by, b.name AS allocated_by_name, la.allocated_at,
                  la.ended_at, la.ended_by, e.name AS ended_by_name
           FROM lead_allocations la JOIN users r ON r.id = la.rep_id JOIN users b ON b.id = la.allocated_by
           LEFT JOIN users e ON e.id = la.ended_by
           WHERE la.company_id = c.id ORDER BY la.allocated_at DESC LIMIT ${ALLOCATION_HISTORY_LIMIT}::int) a) AS allocations,
        (${activityRows(sql``, ACTIVITY_LIMIT + 1)}) AS activity,
        (${activityRows(sql`AND al.action_type = 'note'`, NOTES_LIMIT)}) AS notes,
        (SELECT COALESCE(json_agg(r ORDER BY r.valid_from DESC NULLS LAST, r.id), '[]'::json) FROM (
           SELECT rs.id, rs.county_fips, rs.kind, rs.source, rs.payload, rs.valid_from, rs.valid_to
           FROM regional_signals rs
           WHERE rs.county_fips = c.county_fips AND rs.kind IN ('active_alert', 'storm_history')
             AND (rs.kind = 'storm_history' OR rs.valid_to IS NULL OR rs.valid_to > now() - interval '8 days')) r) AS signals,
        (SELECT COALESCE(json_object_agg(e.source, json_build_object(
                  'status', e.status, 'data', json_build_object('services', COALESCE(e.data->'services', '[]'::jsonb)))), '{}'::json)
           FROM enrichments e WHERE e.company_id = c.id AND e.source IN ('website_crawl', 'llm_extract')) AS enrichment,
        c.sales_stage, c.stage_changed_at, c.last_contacted_at,
        (SELECT COALESCE(json_agg(k ORDER BY k.done_at IS NOT NULL, CASE WHEN k.done_at IS NULL THEN k.due_at END,
                                  k.done_at DESC, k.id), '[]'::json) FROM (
           (${TASK_SELECT} WHERE t.company_id = ${id}::uuid AND t.done_at IS NULL
            ORDER BY t.due_at, t.id LIMIT ${OPEN_TASKS_LIMIT}::int)
           UNION ALL
           (${TASK_SELECT} WHERE t.company_id = ${id}::uuid AND t.done_at IS NOT NULL
            ORDER BY t.done_at DESC, t.id DESC LIMIT ${DONE_TASKS_LIMIT}::int)) k) AS tasks,
        -- Per request (one row of company_insights_ok_latest_idx): the insight writer does not bump companies.version,
        -- so the cached body must not hold it (a body cached before this change may; it is ignored).
        (SELECT row_to_json(i) FROM (
           SELECT business_summary, sales_recommendation, talking_points, target_contact, product_focus, cited_facts,
                  model, prompt_version, generated_at
           FROM company_insights WHERE company_id = c.id AND status = 'ok'
           ORDER BY generated_at DESC, id LIMIT 1) i) AS insight
      FROM companies c
      WHERE c.id = ${id}::uuid AND ${visibilitySql(viewer, 'view', 'c')}) h`;
}

export function bodyQuery(id: string) {
  return sql`
    SELECT row_to_json(b) AS doc FROM (
      SELECT c.id, c.version, c.updated_at, c.industry, c.business_name, c.dba, c.legal_name, c.contractor_type,
        c.address, c.street, c.city, c.state, c.postal_code, c.phone, c.website_url, c.website_source,
        c.latitude, c.longitude, c.county_fips, c.rating, c.review_count, c.profile_url, c.image_url, c.tier,
        c.certifications, c.specialties, c.distinctions, c.presidents_club_stars, c.gaf_leads_enrolled,
        c.google_place_id, c.description, c.in_business_since, ${FOUNDED_YEAR} AS founded_year, c.employees_range,
        c.segment, c.priority_score::float8 AS priority_score, c.account_status, c.updated_in_last_poll,
        c.last_material_change_at, c.first_seen_at, c.system_tags, c.custom_fields,
        (SELECT COALESCE(json_agg(json_build_object('source', s.source, 'externalId', s.external_id)
                                  ORDER BY s.source, s.external_id), '[]'::json)
           FROM company_source_ids s WHERE s.company_id = c.id) AS source_ids,
        (SELECT COALESCE(json_agg(o ORDER BY o.created_at), '[]'::json) FROM (
           SELECT fo.contact_id, fo.field, fo.value, fo.scraped_value_at_edit, fo.user_id, u.name AS user_name, fo.created_at
           FROM field_overrides fo JOIN users u ON u.id = fo.user_id
           WHERE fo.company_id = c.id AND fo.superseded_at IS NULL) o) AS overrides,
        (SELECT COALESCE(json_agg(k ORDER BY k.confidence DESC, k.id), '[]'::json) FROM (
           SELECT ct.id, ct.name, ct.title, ct.email, ct.phone, ct.source, ct.source_url, ct.confidence,
                  ct.email_verified_at, ct.do_not_contact, ct.version
           FROM contacts ct WHERE ct.company_id = c.id) k) AS contacts,
        (SELECT COALESCE(json_agg(t ORDER BY lower(t.name), t.id), '[]'::json) FROM (
           SELECT tg.id, tg.name, x.added_by, u.name AS added_by_name, x.added_at
           FROM company_custom_tags x JOIN custom_tags tg ON tg.id = x.tag_id JOIN users u ON u.id = x.added_by
           WHERE x.company_id = c.id) t) AS custom_tags
      FROM companies c WHERE c.id = ${id}::uuid) b`;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** A company_insights row as LeadInsight; JSON columns are read defensively (they are written by the Python batch). */
export function insightOut(r: InsightRow | null | undefined): LeadInsight | null {
  if (!r) return null;
  const tc = r.target_contact as { name?: unknown; title?: unknown; why?: unknown } | null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    businessSummary: r.business_summary,
    salesRecommendation: r.sales_recommendation,
    talkingPoints: strings(r.talking_points),
    targetContact: tc && typeof tc === 'object' && str(tc.name) ? { name: str(tc.name), title: str(tc.title), why: str(tc.why) } : null,
    productFocus: strings(r.product_focus),
    citedFacts: Array.isArray(r.cited_facts)
      ? r.cited_facts
        .filter((f): f is { id: string; text: string } =>
          !!f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string' && typeof (f as { text?: unknown }).text === 'string')
        .map((f) => ({ id: f.id, text: f.text }))
      : [],
    model: r.model,
    promptVersion: r.prompt_version,
    generatedAt: iso(r.generated_at)!,
  };
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function field<T>(scraped: T, o: OverrideRow | undefined): EffectiveField<T> {
  if (!o) return { value: scraped, scraped, overridden: false, sourceChangedSinceEdit: false, editedBy: null, editedAt: null };
  return {
    value: o.value as T,
    scraped,
    overridden: true,
    sourceChangedSinceEdit: !sameJson(o.scraped_value_at_edit, scraped),
    editedBy: { id: o.user_id, name: o.user_name },
    editedAt: iso(o.created_at),
  };
}

function activityEntry(r: ActivityRow): ActivityEntry {
  return {
    id: r.id,
    type: r.action_type,
    actorType: r.actor_type,
    user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
    actorLabel: r.user_id ? r.user_name ?? '' : r.actor_type,
    outcome: r.outcome,
    text: r.note_text,
    fieldDiff: r.field_diff ?? null,
    createdAt: iso(r.created_at)!,
  };
}

function allocationEntry(r: AllocationRow): AllocationEntry {
  return {
    rep: { id: r.rep_id, name: r.rep_name },
    allocatedBy: { id: r.allocated_by, name: r.allocated_by_name },
    allocatedAt: iso(r.allocated_at)!,
    endedAt: iso(r.ended_at),
    endedBy: r.ended_by ? { id: r.ended_by, name: r.ended_by_name ?? '' } : null,
  };
}

function flags(checked: boolean, checkedAt: string | null, servicedAt: string | null): LeadStateFlags {
  return { checked, serviced: servicedAt !== null, checkedAt: iso(checkedAt), servicedAt: iso(servicedAt) };
}

function targetContact(tags: SystemTag[], contacts: LeadContact[]): TargetContact | null {
  const tag = tags.find((t) => t.key === 'target_contact') as (SystemTag & { contact?: { name?: string | null } }) | undefined;
  if (!tag) return null;
  const name = tag.contact?.name?.trim().toLowerCase();
  // The tagger named the scraped contact; a rep's correction of that name must not lose the match.
  const same = (v: string | null) => (v ?? '').trim().toLowerCase() === name;
  const match = name ? contacts.find((c) => same(c.name.scraped) || same(c.name.value)) : undefined;
  return { role: String(tag.value ?? ''), label: tag.label, reason: tag.reason ?? null, contactId: match?.id ?? null };
}

export function assembleProfile(head: HeadDoc, body: BodyDoc, viewer: Viewer, now = new Date()): LeadProfile {
  const companyOverrides = new Map(body.overrides.filter((o) => o.contact_id === null).map((o) => [o.field, o]));
  const fields = Object.fromEntries(COMPANY_OVERRIDE_FIELDS.map((f) =>
    [f, field(body[f] as string | null, companyOverrides.get(f))])) as LeadProfile['fields'];
  const contacts: LeadContact[] = body.contacts.map((c) => {
    const ov = (f: string) => body.overrides.find((o) => o.contact_id === c.id && o.field === f);
    return {
      id: c.id,
      name: field(c.name, ov('name')),
      title: field(c.title, ov('title')),
      email: field(c.email, ov('email')),
      phone: field(c.phone, ov('phone')),
      doNotContact: field(c.do_not_contact, ov('do_not_contact')),
      source: c.source,
      sourceUrl: c.source_url,
      confidence: c.confidence,
      emailVerifiedAt: iso(c.email_verified_at),
      isTarget: false,
      version: c.version,
    };
  });
  const target = targetContact(body.system_tags, contacts);
  for (const c of contacts) c.isTarget = c.id === target?.contactId;
  const allocations = head.allocations.map(allocationEntry);
  const timing = timingBadges(
    { state: body.state, county_fips: body.county_fips, latitude: body.latitude, longitude: body.longitude,
      tags: body.system_tags, enrichment: head.enrichment },
    head.signals, now);
  const mine = head.my_state;
  const activity = head.activity.slice(0, ACTIVITY_LIMIT).map(activityEntry);
  return {
    id: body.id,
    version: body.version,
    updatedAt: iso(body.updated_at)!,
    fields,
    details: {
      industry: body.industry,
      dba: body.dba,
      legalName: body.legal_name,
      contractorType: body.contractor_type,
      latitude: body.latitude,
      longitude: body.longitude,
      countyFips: body.county_fips,
      rating: body.rating,
      reviewCount: body.review_count,
      profileUrl: body.profile_url,
      imageUrl: body.image_url,
      tier: body.tier,
      certifications: body.certifications,
      specialties: body.specialties,
      distinctions: body.distinctions,
      presidentsClubStars: body.presidents_club_stars,
      gafLeadsEnrolled: body.gaf_leads_enrolled,
      googlePlaceId: body.google_place_id,
      description: body.description,
      inBusinessSince: body.founded_year ?? body.in_business_since,
      yearsInBusiness: yearsSince(body.founded_year ?? body.in_business_since, now),
      employeesRange: body.employees_range,
      websiteSource: body.website_source,
      segment: body.segment,
      priorityScore: body.priority_score,
      accountStatus: body.account_status,
      updatedInLastPoll: body.updated_in_last_poll,
      lastMaterialChangeAt: iso(body.last_material_change_at),
      firstSeenAt: iso(body.first_seen_at)!,
      sourceIds: body.source_ids,
    },
    contacts,
    targetContact: target,
    systemTags: body.system_tags,
    customTags: body.custom_tags.map((t) => ({
      id: t.id, name: t.name, addedBy: { id: t.added_by, name: t.added_by_name }, addedAt: iso(t.added_at)!,
    })),
    customFields: body.custom_fields,
    insights: insightOut(head.insight),
    timing,
    notes: head.notes.map(activityEntry),
    activity,
    activityNextCursor: head.activity.length > ACTIVITY_LIMIT ? activity.at(-1)!.id : null,
    allocation: { current: allocations.find((a) => a.endedAt === null) ?? null, history: allocations },
    state: {
      mine: flags(mine?.checked ?? false, mine?.checked_at ?? null, mine?.serviced_at ?? null),
      team: {
        ...flags(head.team_checked, head.team_last_checked_at, head.team_last_serviced_at),
        byUser: head.team_states.map((s) => ({
          user: { id: s.user_id, name: s.name }, ...flags(s.checked, s.checked_at, s.serviced_at),
        })),
      },
    },
    permissions: { canWrite: canWrite(viewer, head.assigned_rep_id), canAllocate: canAllocate(viewer) },
    salesStage: head.sales_stage,
    stageChangedAt: iso(head.stage_changed_at),
    lastContactedAt: iso(head.last_contacted_at),
    tasks: head.tasks.map(taskOut),
  };
}

export async function getProfile(
  db: Db, cache: Cache, id: string, viewer: Viewer,
): Promise<{ profile: LeadProfile; cache: 'hit' | 'miss' | 'bypass' }> {
  if (!isUuid(id)) throw notFound();
  const fresh = await cache.recentlyWrote(viewer.id);
  const client = pick(db, fresh);
  const head = (await one<{ doc: HeadDoc }>(client, headQuery(id, viewer)))?.doc;
  if (!head) throw notFound();
  let body = fresh ? undefined : await cache.getJson<BodyDoc>(cacheKeys.leadProfile(head.id, head.version));
  const hit = body !== undefined;
  if (!body) {
    body = (await one<{ doc: BodyDoc }>(client, bodyQuery(head.id)))?.doc;
    if (!body) throw notFound();
    // Keyed by the version the body statement itself read, so a concurrent write can't mislabel it.
    await cache.setJson(cacheKeys.leadProfile(body.id, body.version), body, LEAD_PROFILE_TTL_SECONDS);
  }
  return { profile: assembleProfile(head, body, viewer), cache: hit ? 'hit' : fresh ? 'bypass' : 'miss' };
}

/**
 * GET /leads/:id/activity: entries older than the `before` entry (the previous page's nextCursor, an activity
 * id of this lead), newest first; `type` narrows to one action type (e.g. note).
 */
export async function getActivity(
  db: Db, cache: Cache, id: string, viewer: Viewer, opts: { before?: string; types?: string[]; limit: number },
): Promise<ActivityPage> {
  if (!isUuid(id)) throw notFound();
  if (opts.before !== undefined && !isUuid(opts.before)) throw badRequest('invalid cursor');
  const where = sql`
    ${opts.before ? sql`AND (al.created_at, al.id) < (SELECT b.created_at, b.id FROM activity_logs b
                              WHERE b.id = ${opts.before}::uuid AND b.company_id = c.id)` : raw('')}
    ${opts.types?.length ? sql`AND al.action_type = ANY(${opts.types}::text[])` : raw('')}`;
  const anchored = opts.before
    ? sql`EXISTS (SELECT 1 FROM activity_logs b WHERE b.id = ${opts.before}::uuid AND b.company_id = c.id)`
    : raw('TRUE');
  const res = await one<{ items: ActivityRow[]; anchored: boolean }>(pick(db, await cache.recentlyWrote(viewer.id)), sql`
    SELECT (${activityRows(where, opts.limit + 1)}) AS items, ${anchored} AS anchored
    FROM companies c WHERE c.id = ${id}::uuid AND ${visibilitySql(viewer, 'view', 'c')}`);
  if (!res) throw notFound();
  if (!res.anchored) throw badRequest('invalid cursor');
  const items = res.items.slice(0, opts.limit).map(activityEntry);
  return { items, nextCursor: res.items.length > opts.limit ? items.at(-1)!.id : null };
}
