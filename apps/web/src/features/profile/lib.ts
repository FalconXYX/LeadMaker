// Pure helpers for the lead profile: field labels, value formatting, priority drivers, the target-contact
// rule, activity descriptions and profile diffs (live highlights). No React here, so it is unit-tested.
import type {
  AccountStatus, ActivityEntry, CompanyOverrideField, ContactOverrideField, EffectiveField, LeadContact, LeadProfile,
  SystemTag, TimingBadge,
} from '@/api/types';
import type { BadgeVariant } from '@/components/ui';
import { humanize } from '@/lib/format';
import { COMPANY_OVERRIDE_FIELDS } from '@/lib/labels';
import { isSalesStage } from '@/lib/labels';
import { dayWord, salesOf, stageLabel } from './sales';

// ---- override fields ----------------------------------------------------------------------------------------

export const CONTACT_TEXT_FIELDS = ['name', 'title', 'email', 'phone'] as const satisfies readonly ContactOverrideField[];

const FIELD_LABELS: Record<string, string> = {
  business_name: 'Business name',
  phone: 'Phone',
  website_url: 'Website',
  website: 'Website',
  address: 'Full address',
  street: 'Street',
  city: 'City',
  state: 'State',
  postal_code: 'ZIP code',
  tier: 'GAF tier',
  certifications: 'Certifications',
  rating: 'Rating',
  review_count: 'Reviews',
  contacts: 'Contacts',
  name: 'Name',
  title: 'Title',
  email: 'Email',
  do_not_contact: 'Do not contact',
  delisted: 'Listing',
  latitude: 'Latitude',
  longitude: 'Longitude',
  sales_stage: 'Stage',
  tasks: 'Follow-ups',
};

export function fieldLabel(key: string): string {
  if (key.startsWith('custom_fields.')) return humanize(key.slice('custom_fields.'.length));
  return FIELD_LABELS[key] ?? humanize(key);
}

const SOURCE_LABELS: Record<string, string> = {
  gaf: 'GAF',
  bbb: 'BBB',
  fmcsa: 'FMCSA',
  ny_dos: 'NY DOS',
  website: 'Company website',
  website_discovery: 'Web search',
  rep: 'Added by rep',
  derived: 'Derived',
  crm: 'CRM import',
  fallback: 'Main line',
  noaa_storm_events: 'NOAA storm reports',
  nws: 'National Weather Service',
  calendar: 'Season calendar',
  local_rss: 'Local news',
  google: 'Google',
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'Unknown source';
  return SOURCE_LABELS[source] ?? humanize(source);
}

/** Where a company field's scraped value comes from, for "GAF now says …". */
export function fieldSource(profile: Pick<LeadProfile, 'details'>, field: string): string {
  if (field === 'website_url' && profile.details.websiteSource) return sourceLabel(profile.details.websiteSource);
  return sourceLabel(profile.details.sourceIds[0]?.source ?? 'gaf');
}

// ---- values -------------------------------------------------------------------------------------------------

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Short display text for any JSON value (diffs, conflicts, custom fields). */
export function formatValue(v: unknown): string {
  if (isBlank(v)) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length ? v.map(formatValue).join(', ') : '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string') return [o.name, o.title].filter((x) => typeof x === 'string' && x).join(' · ');
    return JSON.stringify(v);
  }
  return String(v);
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Scraped descriptions sometimes carry HTML entities (&quot;1930&quot;); decode them as text, never as HTML. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Keyless Google Maps link (place id when known, else the address, else the coordinates). */
export function mapsUrl(opts: { address?: string | null; lat: number; lng: number; placeId?: string | null }): string {
  const query = opts.address?.trim() || `${opts.lat},${opts.lng}`;
  const qs = new URLSearchParams({ api: '1', query });
  if (opts.placeId) qs.set('query_place_id', opts.placeId);
  return `https://www.google.com/maps/search/?${qs}`;
}

// ---- field validation ---------------------------------------------------------------------------------------

export function validateCompanyField(field: CompanyOverrideField, raw: string): string | null {
  const v = raw.trim();
  if (field === 'business_name' && !v) return 'Business name is required.';
  if (!v) return null;
  const max: Record<CompanyOverrideField, number> = {
    business_name: 255, phone: 32, website_url: 2048, address: 512, street: 255, city: 128, state: 8, postal_code: 16,
  };
  if (v.length > max[field]) return `Keep it under ${max[field]} characters.`;
  if (field === 'website_url' && !isHttpUrl(normalizeUrl(v))) return 'Enter a web address like https://example.com.';
  if (field === 'phone' && !isPhone(v)) return 'Enter a phone number (digits, spaces, + ( ) - .).';
  return null;
}

export function validateContactField(field: (typeof CONTACT_TEXT_FIELDS)[number], raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > (field === 'phone' ? 64 : 255)) return 'That is too long.';
  if (field === 'email' && !isEmail(v)) return 'Enter a valid email address.';
  if (field === 'phone' && !isPhone(v)) return 'Enter a phone number (digits, spaces, + ( ) - .).';
  return null;
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

export function isPhone(v: string): boolean {
  const s = v.trim();
  return /^[+()\d\s.\-x/]+$/i.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7;
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Custom field keys: lowercase letters, digits and _; starts with a letter (crm-write's rule). */
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/;

/** "Crew size (est.)" -> "crew_size_est". */
export function slugifyKey(label: string): string {
  const s = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '');
  return s.slice(0, 63);
}

// ---- tags, priority, target contact -------------------------------------------------------------------------

export function tagByKey(tags: readonly SystemTag[], key: string): SystemTag | undefined {
  return tags.find((t) => t.key === key);
}

export interface PriorityDriver {
  label: string;
  points: number | null;
}

/** The priority_drivers tag: value ['GAF tier', ...], reason 'GAF tier +25; Review volume +20; ...'. */
export function priorityDrivers(tags: readonly SystemTag[]): PriorityDriver[] {
  const tag = tagByKey(tags, 'priority_drivers');
  if (!tag) return [];
  const fromReason = (tag.reason ?? '')
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*?)\s*([+-]\s*\d+(?:\.\d+)?)\s*(?:pts?)?$/i.exec(part);
      return m ? { label: m[1]!.trim(), points: Number(m[2]!.replace(/\s+/g, '')) } : { label: part, points: null };
    });
  if (fromReason.length) return fromReason;
  return Array.isArray(tag.value) ? tag.value.filter((v): v is string => typeof v === 'string').map((label) => ({ label, points: null })) : [];
}

export type CompanySize = 'small' | 'medium' | 'large';

export function companySize(tags: readonly SystemTag[]): CompanySize | null {
  const v = tagByKey(tags, 'size')?.value;
  return v === 'small' || v === 'medium' || v === 'large' ? v : null;
}

export interface TargetTagContact {
  name: string | null;
  role_label?: string;
  phone?: string | null;
  email?: string | null;
  title?: string | null;
  named?: boolean;
  phone_is_main_line?: boolean;
  fallback?: boolean;
}

/** The target_contact tag carries the chosen person (name, role label, main-line phone). */
export function targetTagContact(tags: readonly SystemTag[]): TargetTagContact | null {
  const tag = tagByKey(tags, 'target_contact') as (SystemTag & { contact?: TargetTagContact }) | undefined;
  return tag?.contact && typeof tag.contact === 'object' ? tag.contact : null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  purchasing: 'Purchasing manager',
  office: 'Office manager',
  operations: 'Operations manager',
  project_manager: 'Project manager',
};

export function roleLabel(role: string | null | undefined): string {
  return role ? ROLE_LABELS[role] ?? humanize(role) : 'Owner';
}

/** Small shops: the owner buys. Larger companies: purchasing/office first, owner as the fallback. */
export function targetRule(size: CompanySize | null): 'small' | 'larger' | null {
  if (!size) return null;
  return size === 'small' ? 'small' : 'larger';
}

export interface AskFor {
  contactId: string | null;
  name: string | null;
  role: string;
  title: string | null;
  phone: string | null;
  /** True when the phone is the company's main line, not the person's own. */
  mainLine: boolean;
  email: string | null;
  doNotContact: boolean;
}

/** Who to ask for: the target contact (or the pipeline's snapshot of them) with the best phone and email. */
export function askFor(profile: Pick<LeadProfile, 'contacts' | 'targetContact' | 'systemTags' | 'fields'>): AskFor {
  const target = profile.targetContact;
  const contact = profile.contacts.find((c) => c.isTarget)
    ?? (target?.contactId ? profile.contacts.find((c) => c.id === target.contactId) : undefined);
  const snapshot = targetTagContact(profile.systemTags);
  const direct = contact?.phone.value ?? null;
  return {
    contactId: contact?.id ?? null,
    name: contact?.name.value ?? snapshot?.name ?? null,
    role: roleLabel(target?.role ?? snapshot?.role_label ?? 'owner'),
    title: contact?.title.value ?? snapshot?.title ?? null,
    phone: direct ?? profile.fields.phone.value ?? snapshot?.phone ?? null,
    mainLine: !direct,
    email: contact?.email.value ?? snapshot?.email ?? null,
    doNotContact: !!contact?.doNotContact.value,
  };
}

const CATEGORY_ORDER = [
  'certification', 'work_type', 'services', 'size', 'reputation', 'maturity', 'contactability', 'digital',
  'geography', 'account', 'compliance', 'data_quality', 'priority',
];
const CATEGORY_LABELS: Record<string, string> = {
  certification: 'Certifications & programs',
  work_type: 'Work type',
  services: 'Services & materials',
  size: 'Size',
  reputation: 'Reputation',
  maturity: 'Maturity',
  contactability: 'Contactability',
  digital: 'Digital presence',
  geography: 'Geography',
  account: 'Account',
  compliance: 'Registration',
  data_quality: 'Data quality',
  priority: 'Priority',
};

export function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? humanize(c);
}

export function groupTags(tags: readonly SystemTag[]): { category: string; label: string; tags: SystemTag[] }[] {
  const groups = new Map<string, SystemTag[]>();
  for (const t of tags) {
    const list = groups.get(t.category) ?? [];
    list.push(t);
    groups.set(t.category, list);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, list]) => ({ category, label: categoryLabel(category), tags: list }));
}

// ---- status & timing ----------------------------------------------------------------------------------------

export const ACCOUNT_STATUS_VARIANT: Record<AccountStatus, BadgeVariant> = {
  prospect: 'info',
  existing_customer: 'success',
  lapsed_customer: 'warning',
  do_not_contact: 'danger',
};

const SEVERITY_RANK: Record<TimingBadge['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };

export function sortTiming(badges: readonly TimingBadge[]): TimingBadge[] {
  return [...badges].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export interface WhyNow {
  badge: TimingBadge;
  /** What it means for this contractor, when their work type makes it relevant. */
  implication: string | null;
}

/** The strongest timing signal plus what it means for the contractor's work type. */
export function whyNow(profile: Pick<LeadProfile, 'timing' | 'systemTags'>): WhyNow | null {
  const sorted = sortTiming(profile.timing);
  const top = sorted[0];
  if (!top) return null;
  const storm = sorted.some((b) => b.key !== 'season' && b.severity !== 'info');
  const has = (...keys: string[]) => profile.systemTags.some((t) => keys.includes(t.key));
  let implication: string | null = null;
  if (storm && has('work_type:storm_emergency', 'storm_insurance')) {
    implication = 'They do storm and emergency repair, so expect demand for repair materials.';
  } else if (storm) {
    implication = 'Storm damage nearby can bring repair and replacement jobs.';
  } else if (top.key === 'season' && has('service:new_construction', 'work_type:new_construction')) {
    implication = 'New-build work follows the season; help them plan stock ahead of it.';
  }
  return { badge: top, implication };
}

// ---- state ---------------------------------------------------------------------------------------------------

export interface StateActor {
  name: string;
  at: string;
  isMe: boolean;
}

/** Who checked / serviced the lead most recently (team view). */
export function lastStateActor(
  profile: Pick<LeadProfile, 'state'>, kind: 'checked' | 'serviced', meId: string | undefined,
): StateActor | null {
  const key = kind === 'checked' ? 'checkedAt' : 'servicedAt';
  const rows = profile.state.team.byUser
    .filter((u) => u[key])
    .sort((a, b) => Date.parse(b[key]!) - Date.parse(a[key]!));
  const top = rows[0];
  if (!top) return null;
  return { name: top.user.name, at: top[key]!, isMe: top.user.id === meId };
}

// ---- activity feed --------------------------------------------------------------------------------------------

export interface DiffRow {
  field: string;
  label: string;
  from: string;
  to: string;
}

export type ActivityKind =
  | 'note' | 'call' | 'email' | 'visit' | 'state' | 'edit' | 'contact' | 'tag' | 'field' | 'allocation' | 'pipeline'
  | 'stage' | 'task' | 'other';

export interface ActivityView {
  kind: ActivityKind;
  /** Who did it, for display. */
  actor: string;
  /** Verb phrase after the actor: "added a note", "edited Phone". */
  action: string;
  outcome: string | null;
  body: string | null;
  diffs: DiffRow[];
}

export interface ActivityContext {
  contactName: (id: string) => string | null;
  userName: (id: string) => string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pair = (v: unknown): [unknown, unknown] | null => (Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : null);

export function actorName(e: Pick<ActivityEntry, 'user' | 'actorType' | 'actorLabel'>): string {
  if (e.user?.name) return e.user.name;
  if (e.actorType === 'pipeline') return 'Data pipeline';
  if (e.actorType === 'system') return 'System';
  return e.actorLabel || 'Someone';
}

function diffRow(field: string, from: unknown, to: unknown): DiffRow {
  return { field, label: fieldLabel(field), from: formatValue(from), to: formatValue(to) };
}

function contactsDiff(from: unknown, to: unknown): DiffRow[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  const key = (c: Record<string, unknown>) => `${c.name ?? ''}|${c.title ?? ''}`;
  const before = list(from);
  const after = list(to);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const removed = before.filter((c) => !afterKeys.has(key(c)));
  const added = after.filter((c) => !beforeKeys.has(key(c)));
  const rows: DiffRow[] = [];
  for (const c of added) rows.push({ field: 'contacts', label: 'New contact', from: '—', to: formatValue(c) });
  for (const c of removed) rows.push({ field: 'contacts', label: 'Removed contact', from: formatValue(c), to: '—' });
  if (!rows.length && (before.length || after.length)) {
    rows.push({ field: 'contacts', label: 'Contacts', from: `${before.length} listed`, to: `${after.length} listed` });
  }
  return rows;
}

const article = (type: string) => (type === 'email' ? 'an email' : `a ${type}`);

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Title, type and due date of a task_* row (TaskActivityDiff: the task after the change, `changes` [before, after]). */
function taskOf(fd: Record<string, unknown>): { title: string | null; type: string | null; dueAt: string | null; prevDueAt: string | null } {
  const changes = isRecord(fd.changes) ? fd.changes : {};
  return {
    title: text(fd.title),
    type: text(fd.type),
    dueAt: text(fd.due_at),
    prevDueAt: text(pair(changes.due_at)?.[0]),
  };
}

/** What one timeline row says. Unknown shapes degrade to a generic line, never a crash. */
export function activityView(e: ActivityEntry, ctx: ActivityContext): ActivityView {
  const actor = actorName(e);
  const fd = isRecord(e.fieldDiff) ? e.fieldDiff : {};
  const base: ActivityView = { kind: 'other', actor, action: humanize(e.type).toLowerCase(), outcome: e.outcome, body: e.text, diffs: [] };

  switch (e.type) {
    case 'note':
      return { ...base, kind: 'note', action: 'added a note' };
    case 'call':
    case 'email':
    case 'visit':
      return { ...base, kind: e.type, action: `logged ${article(e.type)}` };
    case 'checked':
    case 'serviced': {
      const p = pair(fd[`${e.type}_at`]);
      const on = p ? p[1] !== null : true;
      return { ...base, kind: 'state', action: on ? `marked this lead ${e.type}` : `cleared ${e.type}` };
    }
    case 'override': {
      const field = Object.keys(fd).find((k) => k !== 'contact_id' && k !== 'cleared') ?? 'field';
      const p = pair(fd[field]) ?? [null, null];
      const cleared = fd.cleared === true;
      const contactId = typeof fd.contact_id === 'string' ? fd.contact_id : null;
      const who = contactId ? ctx.contactName(contactId) : null;
      const label = fieldLabel(field);
      const target = contactId ? `${who ? `${who}’s` : 'a contact’s'} ${label.toLowerCase()}` : label;
      return {
        ...base,
        kind: 'edit',
        action: cleared ? `reverted ${target} to the source value` : `edited ${target}`,
        diffs: [diffRow(field, p[0], p[1])],
      };
    }
    case 'contact': {
      const p = pair(fd.contact) ?? [null, null];
      const [before, after] = p;
      if (before === null && isRecord(after)) {
        const details = [after.title, after.email, after.phone].filter((x) => typeof x === 'string' && x).join(' · ');
        return { ...base, kind: 'contact', action: `added contact ${formatValue(after.name)}`, body: details || null };
      }
      if (isRecord(before) && after === null) {
        return { ...base, kind: 'contact', action: `deleted contact ${formatValue(before.name)}` };
      }
      return { ...base, kind: 'contact', action: 'updated a contact' };
    }
    case 'custom_tag': {
      const p = pair(fd.custom_tag) ?? [null, null];
      const name = (v: unknown) => (isRecord(v) && typeof v.name === 'string' ? v.name : 'a tag');
      return p[1] !== null
        ? { ...base, kind: 'tag', action: `added tag “${name(p[1])}”` }
        : { ...base, kind: 'tag', action: `removed tag “${name(p[0])}”` };
    }
    case 'custom_field': {
      const key = Object.keys(fd).find((k) => k.startsWith('custom_fields.')) ?? Object.keys(fd)[0] ?? 'custom_fields.field';
      const p = pair(fd[key]) ?? [null, null];
      const label = fieldLabel(key);
      return {
        ...base,
        kind: 'field',
        action: p[1] === null ? `removed ${label}` : p[0] === null ? `added ${label}` : `updated ${label}`,
        diffs: [{ field: key, label, from: formatValue(p[0]), to: formatValue(p[1]) }],
      };
    }
    case 'allocation': {
      const p = pair(fd.assigned_rep_id) ?? [null, null];
      const name = (id: unknown) => (typeof id === 'string' ? ctx.userName(id) ?? 'another rep' : null);
      const from = name(p[0]);
      const to = name(p[1]);
      const action = to
        ? from ? `reassigned this lead from ${from} to ${to}` : `assigned this lead to ${to}`
        : `moved this lead to the unallocated pool${from ? ` (was ${from})` : ''}`;
      return { ...base, kind: 'allocation', action };
    }
    case 'stage_changed': {
      // StageChangeDiff; auto: a logged call, email or visit moved a new lead to contacted.
      const p = pair(fd.sales_stage) ?? [null, null];
      const to = stageLabel(p[1]);
      const action = p[0] ? `moved this lead from ${stageLabel(p[0])} to ${to}` : `set the stage to ${to}`;
      return { ...base, kind: 'stage', action, outcome: fd.auto === true ? 'Automatically, when contact was logged' : null };
    }
    case 'task_created':
    case 'task_completed':
    case 'task_updated':
    case 'task_deleted': {
      const t = taskOf(fd);
      const due = t.dueAt ? dayWord(t.dueAt) : null;
      const what = t.type === 'call' || t.type === 'visit' ? `a ${t.type} follow-up` : t.type === 'email' ? 'an email follow-up' : 'a follow-up';
      const action = e.type === 'task_created' ? `added ${what}${due ? ` for ${due}` : ''}`
        : e.type === 'task_completed' ? `completed ${what}`
        : e.type === 'task_deleted' ? `removed ${what}`
        : t.prevDueAt && due ? `moved ${what} to ${due}` : `updated ${what}`;
      const note = e.text && e.text !== t.title ? e.text : null;
      return { ...base, kind: 'task', action, body: [t.title, note].filter(Boolean).join('\n') || null };
    }
    case 'scraped_change': {
      const fields = Array.isArray(fd.fields) ? fd.fields.filter((f): f is string => typeof f === 'string') : null;
      const from = isRecord(fd.from) ? fd.from : {};
      const to = isRecord(fd.to) ? fd.to : {};
      if (fields?.includes('delisted')) {
        const area = typeof fd.area === 'string' ? fd.area : null;
        const relisted = to.delisted === false;
        return {
          ...base,
          kind: 'pipeline',
          action: relisted ? 'saw this contractor listed again' : 'found this contractor delisted',
          body: relisted ? null : `No longer in the source listing${area ? ` for ${area.replace('@', ' within ')}` : ''}.`,
        };
      }
      let diffs: DiffRow[];
      if (fields) {
        diffs = fields.flatMap((f) => (f === 'contacts' ? contactsDiff(from.contacts, to.contacts) : [diffRow(f, from[f], to[f])]));
      } else {
        // Older rows: {field: [old, new]}.
        diffs = Object.entries(fd)
          .filter(([k, v]) => k !== 'run_id' && pair(v))
          .map(([k, v]) => diffRow(k, pair(v)![0], pair(v)![1]));
      }
      const names = [...new Set(diffs.map((d) => (d.field === 'contacts' ? 'contacts' : d.label.toLowerCase())))];
      const action = names.length === 0 ? 'refreshed this lead from its sources'
        : names.length <= 2 ? `updated ${names.join(' and ')} from the source`
        : `updated ${names.length} fields from the source`;
      return { ...base, kind: 'pipeline', action, diffs };
    }
    default:
      return base;
  }
}

export interface FeedFilter {
  key: string;
  label: string;
  /** Sent as ?type=a,b so the server pages through only these (complete across pages); null = everything. */
  types: readonly string[] | null;
}

export const FEED_FILTERS: readonly FeedFilter[] = [
  { key: 'all', label: 'All', types: null },
  { key: 'activities', label: 'Calls & visits', types: ['call', 'email', 'visit'] },
  { key: 'notes', label: 'Notes', types: ['note'] },
  { key: 'followups', label: 'Follow-ups', types: ['task_created', 'task_completed', 'task_updated', 'task_deleted'] },
  {
    key: 'changes',
    label: 'Changes',
    types: ['stage_changed', 'override', 'contact', 'custom_field', 'custom_tag', 'allocation', 'checked', 'serviced', 'scraped_change'],
  },
];

/** Names of everyone the profile mentions, for resolving ids (allocations, edits, state, tags, activity). */
export function knownUsers(profile: LeadProfile): Map<string, string> {
  const m = new Map<string, string>();
  const add = (u: { id: string; name: string } | null | undefined) => {
    if (u?.id && u.name) m.set(u.id, u.name);
  };
  for (const a of profile.allocation.history) {
    add(a.rep);
    add(a.allocatedBy);
    add(a.endedBy);
  }
  add(profile.allocation.current?.rep);
  add(profile.allocation.current?.allocatedBy);
  for (const e of [...profile.activity, ...profile.notes]) add(e.user);
  for (const u of profile.state.team.byUser) add(u.user);
  for (const t of profile.customTags) add(t.addedBy);
  for (const f of Object.values(profile.fields)) add(f.editedBy);
  for (const c of profile.contacts) for (const f of [c.name, c.title, c.email, c.phone, c.doNotContact]) add(f.editedBy);
  for (const t of salesOf(profile).tasks) {
    add(t.assignee);
    add(t.createdBy);
  }
  return m;
}

// ---- live diffs ------------------------------------------------------------------------------------------------

const changed = (a: EffectiveField, b: EffectiveField) =>
  !sameValue(a.value, b.value) || a.overridden !== b.overridden || a.sourceChangedSinceEdit !== b.sourceChangedSinceEdit;

/** Highlight keys for what differs between two versions of a profile ('field:phone', 'contact:<id>', 'cf:<key>', ...). */
export function profileChanges(prev: LeadProfile, next: LeadProfile): Set<string> {
  const out = new Set<string>();
  for (const f of COMPANY_OVERRIDE_FIELDS) if (changed(prev.fields[f], next.fields[f])) out.add(`field:${f}`);
  const prevContacts = new Map(prev.contacts.map((c) => [c.id, c]));
  for (const c of next.contacts) {
    const p = prevContacts.get(c.id);
    if (!p || contactChanged(p, c)) out.add(`contact:${c.id}`);
  }
  const keys = new Set([...Object.keys(prev.customFields), ...Object.keys(next.customFields)]);
  for (const k of keys) if (!sameValue(prev.customFields[k], next.customFields[k])) out.add(`cf:${k}`);
  // Names too: a rename keeps the id.
  const tagIds = (p: LeadProfile) => p.customTags.map((t) => `${t.id}:${t.name}`).sort().join(',');
  if (tagIds(prev) !== tagIds(next)) out.add('tags');
  if (JSON.stringify(prev.state.team) !== JSON.stringify(next.state.team)) out.add('state');
  if ((prev.allocation.current?.rep.id ?? null) !== (next.allocation.current?.rep.id ?? null)) out.add('owner');
  const a = salesOf(prev);
  const b = salesOf(next);
  if (a.salesStage !== b.salesStage) out.add('stage');
  const taskKey = (ts: typeof a.tasks) => ts.map((t) => `${t.id}:${t.version}:${t.doneAt ?? ''}:${t.dueAt}`).sort().join(',');
  if (taskKey(a.tasks) !== taskKey(b.tasks)) out.add('tasks');
  const seen = new Set(prev.activity.map((e) => e.id));
  for (const e of next.activity) if (!seen.has(e.id)) out.add(`activity:${e.id}`);
  return out;
}

function contactChanged(a: LeadContact, b: LeadContact): boolean {
  return a.version !== b.version || a.isTarget !== b.isTarget
    || CONTACT_TEXT_FIELDS.some((f) => changed(a[f], b[f])) || changed(a.doNotContact, b.doNotContact);
}

/**
 * The profile with a tags.changed rename or delete applied to its chips (unchanged otherwise, same object). Adds and
 * per-lead removals wait for the refetch, which carries who added the tag and when.
 */
export function applyTagEvent(profile: LeadProfile, payload: Record<string, unknown>): LeadProfile {
  const tagId = typeof payload.tag_id === 'string' ? payload.tag_id : null;
  if (!tagId || !profile.customTags.some((t) => t.id === tagId)) return profile;
  if (payload.deleted === true) return { ...profile, customTags: profile.customTags.filter((t) => t.id !== tagId) };
  const name = typeof payload.tag_name === 'string' ? payload.tag_name : null;
  if (payload.renamed === true && name) {
    if (profile.customTags.every((t) => t.id !== tagId || t.name === name)) return profile;
    return { ...profile, customTags: profile.customTags.map((t) => (t.id === tagId ? { ...t, name } : t)) };
  }
  return profile;
}

/** A live event, described for the "Updated by …" toast. */
export function describeLiveEvent(type: string, payload: Record<string, unknown>): string {
  const field = typeof payload.field === 'string' ? fieldLabel(payload.field) : null;
  switch (type) {
    case 'note.added':
      return 'Added a note';
    case 'override.set':
      return field ? `${payload.cleared ? 'Reverted' : 'Edited'} ${payload.contact_id ? `a contact’s ${field.toLowerCase()}` : field}` : 'Edited a field';
    case 'state.changed':
      if (typeof payload.activity_type === 'string') return `Logged ${article(payload.activity_type)}`;
      return 'Updated checked / serviced';
    case 'tags.changed': {
      const name = typeof payload.tag_name === 'string' ? payload.tag_name : null;
      if (!name) return 'Changed tags';
      if (payload.renamed) {
        return typeof payload.previous_name === 'string' ? `Renamed tag “${payload.previous_name}” to “${name}”` : `Renamed a tag to “${name}”`;
      }
      if (payload.deleted) return `Deleted tag “${name}” for everyone`;
      return `${payload.added === false ? 'Removed' : 'Added'} tag “${name}”`;
    }
    case 'lead.allocated':
      return payload.assigned_rep_id ? 'Changed who owns this lead' : 'Moved this lead to the unallocated pool';
    case 'lead.updated': {
      const fields = Array.isArray(payload.fields) ? payload.fields.filter((f): f is string => typeof f === 'string') : [];
      if (payload.delisted) return 'Lead was delisted by its source';
      if (fields.includes('tasks')) {
        const title = typeof payload.task_title === 'string' ? ` “${payload.task_title}”` : '';
        const verb: Record<string, string> = { created: 'Added', completed: 'Completed', deleted: 'Removed', updated: 'Updated' };
        return `${verb[String(payload.task_action)] ?? 'Updated'} a follow-up${title}`;
      }
      if (fields.includes('sales_stage')) {
        return isSalesStage(payload.sales_stage) ? `Moved this lead to ${stageLabel(payload.sales_stage)}` : 'Changed the stage';
      }
      if (fields.includes('contacts')) return payload.deleted ? 'Removed a contact' : 'Updated contacts';
      const cf = fields.find((f) => f.startsWith('custom_fields.'));
      if (cf) return `Updated ${fieldLabel(cf)}`;
      return fields.length ? `Updated ${fields.map(fieldLabel).join(', ')}` : 'Updated this lead';
    }
    default:
      return 'Updated this lead';
  }
}
