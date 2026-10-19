// GET /leads/:id/ai-context: what the assistant may tell this user about one lead (LeadAiContext).
// Built from the profile (same visibility check, same cached body) plus the stored website pages, cut to
// AI_CONTEXT_LIMITS. Contact emails and phone numbers never leave here: contacts carry hasEmail / hasPhone, and
// email addresses and phone numbers inside free text (notes, website pages, custom fields, labels) are replaced
// with [email] / [phone]. The assistant fences every value before it reaches a prompt; this endpoint only sizes and
// minimises the data. Not cached: one profile read plus one indexed statement.
import {
  AI_CONTEXT_LIMITS, countyName, SALES_STAGE_LABELS, sql, type ActivityEntry, type LeadAiContext,
  type LeadProfile, type SalesStage, type SystemTag, type TaskActivityDiff, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, pick, type Db } from './db.ts';
import { getProfile } from './profile.ts';

export const AI_CONTEXT_HIDDEN_TAG_CATEGORIES: ReadonlySet<string> = new Set(['geography', 'data_quality']);
export const AI_CONTEXT_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'call', 'email', 'visit', 'stage_changed', 'task_created', 'task_completed', 'task_updated', 'task_deleted',
]);
const WEBSITE_SUMMARY_CHARS = 1000;
const LABEL_CHARS = 200;

const EMAIL = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[A-Za-z]{2,}/g;
// North American numbers as written on sites and in notes: (212) 555-0100, ( 201)436-1011, 212.555.0100,
// 212 - 555 - 0100, +1 212 555 0100, 2125550100.
const PHONE = /(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\b\d{3}\)?)[\s.-]*\d{3}[\s.-]*\d{4}\b/g;

/** Replaces email addresses and phone numbers in free text (data minimisation, SystemDesign §7 / D11). */
export function redactContactData(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

/** At most `max` characters, cut at a word boundary with '…' when shortened. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Redacted, then clipped: the order matters, so a cut can never leave half a phone number behind. */
const safe = (text: string | null | undefined, max: number): string => clip(redactContactData(text ?? ''), max);

// The tagger's match confidences ("Owner, website @ 0.55"): bookkeeping, not something to repeat to a rep.
const CONFIDENCE = /\s*@\s*[01](?:\.\d+)?\b/g;
/** A tag label or reason: confidences dropped, then as safe(). */
export const tagText = (text: string, max = LABEL_CHARS): string => safe(text.replace(CONFIDENCE, ''), max);

/** "Jordan L." for a user; the actor type ('pipeline', 'system') otherwise. */
export function shortName(entry: Pick<ActivityEntry, 'user' | 'actorLabel'>): string {
  if (!entry.user) return entry.actorLabel;
  const parts = entry.user.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.`;
}

function labels(values: unknown[]): string[] {
  return values
    .map((v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        const o = v as { name?: unknown; label?: unknown };
        if (typeof o.name === 'string') return o.name;
        if (typeof o.label === 'string') return o.label;
      }
      return v == null ? '' : JSON.stringify(v);
    })
    .map((s) => safe(s, LABEL_CHARS))
    .filter(Boolean);
}

const stageLabel = (s: unknown) => SALES_STAGE_LABELS[s as SalesStage] ?? String(s);

/** One line for an activity row: the logged text, or what a stage or task change did. */
function activityText(a: ActivityEntry): string | null {
  if (a.type === 'stage_changed') {
    const d = a.fieldDiff as { sales_stage?: [unknown, unknown]; auto?: boolean } | null;
    if (!d?.sales_stage) return a.text ? safe(a.text, AI_CONTEXT_LIMITS.activityChars) : null;
    const [from, to] = d.sales_stage;
    return `stage ${stageLabel(from)} -> ${stageLabel(to)}${d.auto ? ' (automatic, after a logged contact)' : ''}`;
  }
  if (a.type.startsWith('task_')) {
    const d = a.fieldDiff as Partial<TaskActivityDiff> | null;
    if (!d?.title) return null;
    const due = d.due_at ? `, due ${d.due_at.slice(0, 10)}` : '';
    return safe(`task "${d.title}" (${d.type ?? 'todo'}${due})`, AI_CONTEXT_LIMITS.activityChars);
  }
  return a.text ? safe(a.text, AI_CONTEXT_LIMITS.activityChars) : null;
}

function customFields(fields: Record<string, unknown>): Record<string, unknown> {
  const max = AI_CONTEXT_LIMITS.customFieldChars;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') out[key] = safe(value, max);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else {
      const json = redactContactData(JSON.stringify(value));
      // Small structured values stay structured; larger ones become a clipped JSON string.
      out[key] = json.length <= max ? JSON.parse(json) : clip(json, max);
    }
  }
  return out;
}

export interface WebsitePage {
  url?: unknown;
  title?: unknown;
  text?: unknown;
}

/** Stored crawl pages in order, each <= websitePageChars and <= websiteChars in total. */
export function websitePages(pages: unknown): LeadAiContext['website'] {
  if (!Array.isArray(pages)) return [];
  const out: LeadAiContext['website'] = [];
  let left = AI_CONTEXT_LIMITS.websiteChars;
  for (const p of pages as WebsitePage[]) {
    if (left < 80) break;
    const raw = typeof p?.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : '';
    if (!raw) continue;
    const text = safe(raw, Math.min(AI_CONTEXT_LIMITS.websitePageChars, left));
    left -= text.length;
    out.push({
      url: typeof p.url === 'string' ? clip(p.url, 300) : '',
      title: typeof p.title === 'string' ? safe(p.title, 150) : '',
      text,
    });
  }
  return out;
}

function tagValue(tags: SystemTag[], key: string): unknown {
  return tags.find((t) => t.key === key)?.value;
}

export function buildAiContext(
  p: LeadProfile, site: { pages: unknown; site_summary: string | null } | undefined, now = new Date(),
): LeadAiContext {
  const L = AI_CONTEXT_LIMITS;
  const target = p.targetContact;
  const targetPerson = target?.contactId ? p.contacts.find((c) => c.id === target.contactId) : undefined;
  // The target first, so the cap never drops the person to ask for.
  const contacts = [...p.contacts].sort((a, b) => Number(b.isTarget) - Number(a.isTarget)).slice(0, L.contacts);
  const size = tagValue(p.systemTags, 'size');
  const drivers = tagValue(p.systemTags, 'priority_drivers');
  return {
    id: p.id,
    businessName: safe(p.fields.business_name.value ?? p.fields.business_name.scraped ?? '', LABEL_CHARS),
    city: p.fields.city.value,
    state: p.fields.state.value,
    postalCode: p.fields.postal_code.value,
    countyFips: p.details.countyFips,
    countyName: countyName(p.details.countyFips),
    websiteUrl: p.fields.website_url.value,
    gaf: {
      tier: p.details.tier,
      certifications: labels(p.details.certifications),
      rating: p.details.rating,
      reviewCount: p.details.reviewCount,
      yearsInBusiness: p.details.yearsInBusiness,
      employeesRange: p.details.employeesRange,
      specialties: labels(p.details.specialties),
      distinctions: labels(p.details.distinctions),
      presidentsClubStars: p.details.presidentsClubStars,
      description: p.details.description ? safe(p.details.description, L.descriptionChars) : null,
    },
    size: typeof size === 'string' ? size : null,
    segment: p.details.segment,
    priorityScore: p.details.priorityScore,
    priorityDrivers: Array.isArray(drivers) ? labels(drivers) : [],
    accountStatus: p.details.accountStatus,
    salesStage: p.salesStage,
    stageChangedAt: p.stageChangedAt,
    lastContactedAt: p.lastContactedAt,
    assignedRep: p.allocation.current?.rep ?? null,
    canWrite: p.permissions.canWrite,
    tags: p.systemTags
      .filter((t) => !AI_CONTEXT_HIDDEN_TAG_CATEGORIES.has(t.category))
      .slice(0, L.tags)
      .map((t) => ({ key: t.key, label: tagText(t.label), category: t.category })),
    customTags: p.customTags.map((t) => safe(t.name, LABEL_CHARS)),
    customFields: customFields(p.customFields),
    targetContact: target && {
      label: tagText(target.label),
      reason: target.reason ? tagText(target.reason) : null,
      name: targetPerson?.name.value ? safe(targetPerson.name.value, LABEL_CHARS) : null,
      title: targetPerson?.title.value ? safe(targetPerson.title.value, LABEL_CHARS) : null,
    },
    contacts: contacts.map((c) => ({
      name: c.name.value ? safe(c.name.value, LABEL_CHARS) : null,
      title: c.title.value ? safe(c.title.value, LABEL_CHARS) : null,
      hasEmail: !!c.email.value,
      hasPhone: !!c.phone.value,
      doNotContact: !!c.doNotContact.value,
      source: c.source,
    })),
    insights: p.insights,
    timing: p.timing,
    notes: p.notes
      .filter((n) => n.text?.trim())
      .slice(0, L.notes)
      .map((n) => ({ author: shortName(n), at: n.createdAt, text: safe(n.text, L.noteChars) })),
    activity: p.activity
      .filter((a) => AI_CONTEXT_ACTIVITY_TYPES.has(a.type))
      .slice(0, L.activity)
      .map((a) => ({ type: a.type, outcome: a.outcome, author: shortName(a), at: a.createdAt, text: activityText(a) })),
    openTasks: p.tasks
      .filter((t) => t.doneAt === null)
      .slice(0, L.openTasks)
      .map((t) => ({ title: safe(t.title, LABEL_CHARS), type: t.type, dueAt: t.dueAt })),
    website: websitePages(site?.pages),
    websiteSummary: site?.site_summary ? safe(site.site_summary, WEBSITE_SUMMARY_CHARS) : null,
    generatedAt: now.toISOString(),
  };
}

export async function getAiContext(db: Db, cache: Cache, id: string, viewer: Viewer): Promise<LeadAiContext> {
  // Visibility, the 404 and read-your-writes come from the profile read; the site statement uses the same client.
  const { profile, cache: state } = await getProfile(db, cache, id, viewer);
  const site = await one<{ pages: unknown; site_summary: string | null }>(pick(db, state === 'bypass'), sql`
    SELECT (SELECT data->'pages' FROM enrichments
             WHERE company_id = ${profile.id}::uuid AND source = 'website_crawl' AND status = 'ok') AS pages,
           (SELECT data->>'summary' FROM enrichments
             WHERE company_id = ${profile.id}::uuid AND source = 'llm_extract' AND status = 'ok') AS site_summary`);
  return buildAiContext(profile, site);
}
