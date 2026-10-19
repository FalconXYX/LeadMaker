// Today's call list: a deterministic ranking built only from data. Follow-ups first (overdue, then due today),
// then leads that need a touch: open quotes and interested leads gone quiet, new leads from the latest poll, and
// strategic accounts nobody has called. Each lead appears once, in its most urgent group.
import type { LeadProfile, LeadSummary, SalesStage, Task, TimingBadge } from '@/api/types';
import { CERTIFICATION_LABELS } from '@/lib/labels';
import { actionableBadge } from './hazards';
import { daysBetween } from './sales';

export type BriefingKind = 'overdue' | 'today' | 'quote' | 'interested' | 'new' | 'strategic';

/** Interested / quoting leads count as gone quiet after this many days without a call, email or visit. */
export const QUIET_DAYS = 7;

export interface BriefingRow {
  key: string;
  kind: BriefingKind;
  leadId: string;
  leadName: string;
  task: Task | null;
  lead: LeadSummary | null;
  /** Why this lead, today, in sales language. */
  why: string;
  /** A second line: the follow-up's title or the lead's strongest selling point. */
  detail: string | null;
  /** The first sentence of the lead's AI pitch, when the server sends it; else read from the lead's profile. */
  aiPitch?: string | null;
}

export interface BriefingInput {
  overdue: readonly Task[];
  today: readonly Task[];
  /** Interested and quoting leads not contacted in QUIET_DAYS. */
  quiet: readonly LeadSummary[];
  /** New-stage leads that arrived or changed in the latest poll. */
  fresh: readonly LeadSummary[];
  /** Strategic leads still in the New stage. */
  strategic: readonly LeadSummary[];
  now: number;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const priority = (l: LeadSummary) => l.priorityScore ?? 0;
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function dueTodayText(dueAt: string): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime()) || (d.getHours() === 0 && d.getMinutes() === 0)) return 'Follow-up due today';
  return `Follow-up due today at ${timeFmt.format(d)}`;
}

/** The lead's strongest facts for an opener: certification, reviews, years in business. */
function sellingPoint(lead: LeadSummary): string | null {
  const parts: string[] = [];
  const cert = lead.certifications?.find((c): c is keyof typeof CERTIFICATION_LABELS => c !== 'gaf:none' && c in CERTIFICATION_LABELS);
  if (cert) parts.push(CERTIFICATION_LABELS[cert]);
  if (lead.rating != null && lead.reviewCount >= 10) parts.push(`Rated ${lead.rating.toFixed(1)} (${lead.reviewCount} reviews)`);
  if (lead.yearsInBusiness != null && lead.yearsInBusiness >= 10) parts.push(`${lead.yearsInBusiness} years in business`);
  if (parts.length) return parts.slice(0, 2).join(' · ');
  const d = lead.priorityDrivers?.filter(Boolean) ?? [];
  return d.length ? d.slice(0, 2).join(' · ') : null;
}

function quietDays(lead: LeadSummary, now: number): number | null {
  return lead.lastContactedAt ? daysBetween(lead.lastContactedAt, now) : null;
}

export function buildBriefing(input: BriefingInput): BriefingRow[] {
  const { now } = input;
  const rows: BriefingRow[] = [];
  const seen = new Set<string>();
  const push = (row: BriefingRow) => {
    if (seen.has(row.leadId)) return;
    seen.add(row.leadId);
    rows.push(row);
  };
  const taskRow = (kind: 'overdue' | 'today', t: Task): BriefingRow => {
    const late = daysBetween(t.dueAt, now);
    return {
      key: `task:${t.id}`, kind, leadId: t.companyId, leadName: t.companyName, task: t, lead: null,
      why: kind === 'overdue' ? (late > 0 ? `Follow-up ${plural(late, 'day')} overdue` : 'Follow-up overdue') : dueTodayText(t.dueAt),
      detail: t.title || null,
    };
  };

  const open = (t: Task) => !t.doneAt;
  [...input.overdue].filter(open).sort((a, b) => time(a.dueAt) - time(b.dueAt) || byId(a, b)).forEach((t) => push(taskRow('overdue', t)));
  [...input.today].filter(open).sort((a, b) => time(a.dueAt) - time(b.dueAt) || byId(a, b)).forEach((t) => push(taskRow('today', t)));

  // A lead with a follow-up already planned is handled by that follow-up.
  const workable = (l: LeadSummary) => !l.nextTask && l.accountStatus !== 'do_not_contact';

  const quiet = input.quiet
    .filter((l) => workable(l) && (l.salesStage === 'quoting' || l.salesStage === 'interested'))
    .filter((l) => { const d = quietDays(l, now); return d === null || d >= QUIET_DAYS; })
    .sort((a, b) => {
      const stage = (l: LeadSummary) => (l.salesStage === 'quoting' ? 0 : 1);
      const qa = quietDays(a, now) ?? Infinity;
      const qb = quietDays(b, now) ?? Infinity;
      return stage(a) - stage(b) || (qb === qa ? 0 : qb > qa ? 1 : -1) || priority(b) - priority(a) || byId(a, b);
    });
  for (const l of quiet) {
    const d = quietDays(l, now);
    const kind = l.salesStage === 'quoting' ? 'quote' : 'interested';
    const why = kind === 'quote'
      ? d === null ? 'Quote out and no contact logged yet' : `Quote out, no contact in ${plural(d, 'day')}`
      : d === null ? 'Interested but never contacted' : `Interested, no contact in ${plural(d, 'day')}`;
    push({
      key: `lead:${l.id}`, kind, leadId: l.id, leadName: l.businessName, task: null, lead: l, why,
      detail: kind === 'quote' ? 'Check whether they’re ready to order' : 'Keep it warm: ask about upcoming jobs',
    });
  }

  const byPriority = (a: LeadSummary, b: LeadSummary) => priority(b) - priority(a) || byId(a, b);
  for (const l of input.fresh.filter((x) => workable(x) && (x.salesStage ?? 'new') === 'new').sort(byPriority)) {
    push({
      key: `lead:${l.id}`, kind: 'new', leadId: l.id, leadName: l.businessName, task: null, lead: l,
      why: 'New in the latest data: make the first call', detail: sellingPoint(l),
    });
  }
  for (const l of input.strategic.filter((x) => workable(x) && (x.salesStage ?? 'new') === 'new' && !x.lastContactedAt).sort(byPriority)) {
    push({
      key: `lead:${l.id}`, kind: 'strategic', leadId: l.id, leadName: l.businessName, task: null, lead: l,
      why: 'Strategic account nobody has called yet', detail: sellingPoint(l),
    });
  }
  return rows;
}

export function countKinds(rows: readonly BriefingRow[]): Record<BriefingKind, number> {
  const out: Record<BriefingKind, number> = { overdue: 0, today: 0, quote: 0, interested: 0, new: 0, strategic: 0 };
  for (const r of rows) out[r.kind]++;
  return out;
}

// ---- contact + facts for a row ---------------------------------------------------------------

export interface BestContact {
  name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  /** Without a named contact: who to ask for on the main line ("Owner"). */
  askFor: string | null;
}

/** Who to ask for: the tagger's target contact, else a reachable contact with a phone, else the company line. */
export function bestContact(profile: LeadProfile | undefined, lead: LeadSummary | null): BestContact {
  const companyPhone = profile?.fields.phone.value ?? lead?.phone ?? null;
  const reachable = (profile?.contacts ?? []).filter((c) => !c.doNotContact.value && c.name.value);
  const targetId = profile?.targetContact?.contactId;
  const pick = reachable.find((c) => c.id === targetId)
    ?? reachable.find((c) => c.isTarget)
    ?? [...reachable].sort((a, b) => Number(!!b.phone.value) - Number(!!a.phone.value) || b.confidence - a.confidence)[0];
  return {
    name: pick?.name.value ?? null,
    title: pick?.title.value ?? null,
    phone: pick?.phone.value ?? companyPhone,
    email: pick?.email.value ?? null,
    askFor: pick ? null : profile?.targetContact?.label.replace(/\s*\([^)]*\)/g, '').trim() || null,
  };
}

/** The lead's stage from whichever source has it. */
export function stageOf(profile: LeadProfile | undefined, lead: LeadSummary | null): SalesStage | null {
  return profile?.salesStage ?? lead?.salesStage ?? null;
}

export function cityOf(profile: LeadProfile | undefined, lead: LeadSummary | null): string | null {
  const city = profile?.fields.city.value ?? lead?.city ?? null;
  const state = profile?.fields.state.value ?? lead?.state ?? null;
  return [city, state].filter(Boolean).join(', ') || null;
}

/**
 * A weather chip only when it asks for action soon (high / medium). County-wide storm history reads the same on
 * every lead there, so it never earns a chip.
 */
export function weatherChip(profile: LeadProfile | undefined, lead: LeadSummary | null): TimingBadge | null {
  const b = actionableBadge((profile?.timing ?? lead?.timing)?.filter((t) => t.key !== 'recent_storm'));
  return b && (b.severity === 'high' || b.severity === 'medium') ? b : null;
}

export const toTel = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

/** "8623901888" -> "(862) 390-1888"; anything else as written. */
export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 && !/[a-z]/i.test(phone) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : phone;
}

// ---- the header's one sentence ----------------------------------------------------------------

const listJoin = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/**
 * Today's priorities in one plain sentence. `subject` is null for your own book, else "The team" or a rep's
 * first name; `behind` counts reps behind their weekly pace (team view).
 */
export function prioritiesSentence(input: {
  subject: string | null;
  overdue: number;
  today: number;
  kinds: Record<BriefingKind, number>;
  behind?: { count: number; of: number };
}): string {
  const { subject, overdue, today, kinds, behind } = input;
  const quiet = kinds.quote + kinds.interested;
  const parts: string[] = [];
  if (overdue) parts.push(`${plural(overdue, 'overdue follow-up')}`);
  if (today) parts.push(`${today} due today`);
  if (quiet) parts.push(`${plural(quiet, 'warm deal')} gone quiet`);
  const pace = !behind?.count ? ''
    : behind.count === behind.of ? `; ${behind.of === 1 ? 'the rep is' : `all ${behind.of} reps are`} behind their weekly activity pace`
    : `; ${behind.count} of ${behind.of} reps are behind their weekly activity pace`;
  if (subject) {
    if (!parts.length) return `${subject} has nothing overdue or due today${pace}.`;
    return `${subject} has ${listJoin(parts)}${pace}.`;
  }
  if (parts.length) return `Start with ${listJoin(parts)}.`;
  if (kinds.new) return `Nothing due today: ${plural(kinds.new, 'new lead')} from the latest data ${kinds.new === 1 ? 'is' : 'are'} ready for a first call.`;
  if (kinds.strategic) return 'Nothing due today. A good day to book first calls with your strategic accounts.';
  return 'Nothing due today. Log your calls as you go and book the next step for each one.';
}
