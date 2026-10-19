// Untrusted text -> prompt data (Section 4 spec §4.6; the Python batch uses the same rules). Website text, rep
// notes, custom fields and business names are data: after fence() they cannot open or close a prompt block,
// carry invisible characters, or run past their cap. renderLeadContext / renderVocabulary build the fenced
// blocks of the final user turn (§7.4).
import {
  ACCOUNT_STATUSES, CERTIFICATIONS, FOLLOW_UPS, MATERIALS, SALES_STAGES, SEGMENTS, SERVICES, SIZES,
  type FilterVocabulary, type LeadAiContext, type Role,
} from '@leadmaker/shared';

// C0/C1 controls except \t and \n (\r is folded into \n first).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Zero-width and bidi controls: U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF.
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** §4.6: NFKC, drop controls and invisibles, < > -> ‹ ›, collapse 3+ newlines, cap at a word boundary with …. */
export function fence(value: unknown, maxChars: number): string {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(s, maxChars);
}

/** fence() on one line: newlines become spaces. */
export function fenceLine(value: unknown, maxChars: number): string {
  return truncate(fence(value, Number.MAX_SAFE_INTEGER).replace(/\s*\n\s*/g, ' '), maxChars);
}

/** Data must not forge the model's citation tags either: "[src:x]" inside data is defused. */
function data(value: unknown, maxChars: number, line = true): string {
  const s = line ? fenceLine(value, maxChars) : fence(value, maxChars);
  return s.replace(/\[\s*src\s*:/gi, '(src:');
}

/** An attribute value (inside double quotes). */
function attr(value: unknown, maxChars = 200): string {
  return data(value, maxChars).replace(/"/g, "'");
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  const cut = s.slice(0, maxChars - 1);
  const ws = cut.search(/\s\S*$/);
  const at = ws > maxChars * 0.6 ? ws : cut.length;
  return `${cut.slice(0, at).trimEnd()}…`;
}

const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);
const lower = (s: string) => s.replace(/_/g, ' ');

const TIER_LABELS: Record<string, string> = {
  master_elite: 'GAF Master Elite', certified_plus: 'GAF Certified Plus', certified: 'GAF Certified',
};
/** companies.tier ('master_elite') -> 'GAF Master Elite'; labels pass through. */
export function tierLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return TIER_LABELS[tier] ?? lower(tier);
}

// ---- lead context ---------------------------------------------------------------------------------

export const CONTEXT_MAX_CHARS = 40_000;

export interface RenderedSection { src: string; body: string }

function detailsSection(c: LeadAiContext): string {
  const parts: string[] = [];
  const push = (label: string, value: unknown, max = 200) => {
    if (value === null || value === undefined || value === '') return;
    parts.push(`${label}: ${data(value, max)}`);
  };
  push('business', c.businessName);
  const place = [c.city, [c.state, c.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const county = c.countyName ? data(c.countyName, 80) : '';
  if (place || county) parts.push(`location: ${[data(place, 120), county ? `(${county})` : ''].filter(Boolean).join(' ')}`);
  push('GAF tier', tierLabel(c.gaf.tier) ?? 'none listed');
  if (c.gaf.certifications.length) push('certifications', c.gaf.certifications.join(', '), 300);
  if (c.gaf.distinctions.length) push('distinctions', c.gaf.distinctions.join(', '), 300);
  if (c.gaf.presidentsClubStars > 0) push("President's Club stars", c.gaf.presidentsClubStars);
  if (c.gaf.rating !== null) parts.push(`rating ${c.gaf.rating} (${c.gaf.reviewCount} reviews)`);
  else if (c.gaf.reviewCount) parts.push(`${c.gaf.reviewCount} reviews`);
  if (c.gaf.yearsInBusiness !== null) parts.push(`years in business: ${c.gaf.yearsInBusiness}`);
  push('employees', c.gaf.employeesRange);
  if (c.gaf.specialties.length) push('GAF specialties', c.gaf.specialties.join(', '), 300);
  push('size', c.size);
  push('segment', c.segment);
  if (c.priorityScore !== null) {
    const drivers = c.priorityDrivers.length ? ` (drivers: ${data(c.priorityDrivers.join(', '), 300)})` : '';
    parts.push(`priority ${Math.round(c.priorityScore)}${drivers}`);
  }
  parts.push(`account: ${lower(c.accountStatus)}`);
  parts.push(`stage: ${c.salesStage === 'lost' ? 'lost (not a fit)' : c.salesStage}${c.stageChangedAt ? ` since ${day(c.stageChangedAt)}` : ''}`);
  parts.push(`last contacted: ${day(c.lastContactedAt) ?? 'never'}`);
  parts.push(`owner: ${c.assignedRep ? data(c.assignedRep.name, 100) : 'unallocated (pool)'}`);
  if (c.openTasks.length) {
    push('open follow-ups', c.openTasks.map((t) => `${day(t.dueAt)} ${t.type}: ${t.title}`).join(' | '), 600);
  }
  push('website', c.websiteUrl, 200);
  push('GAF description', c.gaf.description, 900);
  return parts.join('; ');
}

function insightsSection(c: LeadAiContext): string | null {
  const i = c.insights;
  if (!i || (!i.businessSummary && !i.salesRecommendation)) return null;
  const parts: string[] = [];
  if (i.businessSummary) parts.push(`summary: ${data(i.businessSummary, 400)}`);
  if (i.salesRecommendation) parts.push(`pitch: ${data(i.salesRecommendation, 300)}`);
  if (i.talkingPoints.length) parts.push(`talking points: ${data(i.talkingPoints.join(' | '), 700)}`);
  if (i.targetContact) parts.push(`ask for: ${data(`${i.targetContact.name}, ${i.targetContact.title} (${i.targetContact.why})`, 250)}`);
  if (i.productFocus.length) parts.push(`product focus: ${data(i.productFocus.map(lower).join(', '), 200)}`);
  parts.push(`generated ${day(i.generatedAt)}`);
  return parts.join('; ');
}

function timingSection(c: LeadAiContext): string {
  if (!c.timing.length) return 'none (no active weather alerts or timing signals)';
  return c.timing.slice(0, 6).map((t) => `${data(t.label, 80)} (${t.severity}): ${data(t.reason, 300)}`).join('\n');
}

function contactsSection(c: LeadAiContext): string | null {
  const lines: string[] = [];
  if (c.targetContact) {
    const who = [c.targetContact.name, c.targetContact.title].filter(Boolean).join(', ');
    const reason = c.targetContact.reason ? ` - ${data(c.targetContact.reason, 200)}` : '';
    lines.push(`target: ${data(c.targetContact.label, 80)}${who ? ` - ${data(who, 160)}` : ''}${reason}`);
  }
  for (const p of c.contacts.slice(0, 8)) {
    const on = [p.hasEmail ? 'email on file' : null, p.hasPhone ? 'phone on file' : null].filter(Boolean).join(', ');
    const dnc = p.doNotContact ? '; DO NOT CONTACT' : '';
    lines.push(`${data(p.name ?? 'unnamed', 100)}${p.title ? `, ${data(p.title, 100)}` : ''} (${on || 'no email or phone on file'}${dnc})`);
  }
  return lines.length ? lines.join('\n') : null;
}

function notesSection(c: LeadAiContext, limit: number): string | null {
  if (!c.notes.length || limit <= 0) return null;
  return c.notes.slice(0, limit).map((n) => `${day(n.at)} ${data(n.author, 60)}: ${data(n.text, 600)}`).join('\n');
}

function activitySection(c: LeadAiContext): string | null {
  if (!c.activity.length) return null;
  return c.activity.slice(0, 10).map((a) => {
    const outcome = a.outcome ? ` (${data(a.outcome, 40)})` : '';
    return `${day(a.at)} ${data(lower(a.type), 30)}${outcome} ${data(a.author, 60)}${a.text ? `: ${data(a.text, 300)}` : ''}`;
  }).join('\n');
}

function tagsSection(c: LeadAiContext): string | null {
  const tags = c.tags.slice(0, 40).map((t) => data(t.label, 80));
  const custom = c.customTags.map((t) => data(t, 80));
  const parts = [tags.join('; '), custom.length ? `custom tags: ${custom.join('; ')}` : ''].filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

function customFieldsSection(c: LeadAiContext): string | null {
  const entries = Object.entries(c.customFields ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return null;
  return entries.slice(0, 40).map(([k, v]) => `${data(k, 100)} = ${data(typeof v === 'string' ? v : JSON.stringify(v), 300)}`).join('; ');
}

function websiteSection(c: LeadAiContext, budget: number): string | null {
  const lines: string[] = [];
  let left = budget;
  if (c.websiteSummary && left > 0) {
    const s = data(c.websiteSummary, Math.min(600, left));
    lines.push(`summary: ${s}`);
    left -= s.length;
  }
  for (const p of c.website) {
    if (left < 80) break;
    const head = `page "${attr(p.title || 'untitled', 100)}" (${data(p.url, 200)}): `;
    const body = data(p.text, Math.min(2500, left - head.length));
    lines.push(head + body);
    left -= head.length + body.length;
  }
  return lines.length ? lines.join('\n') : null;
}

/** The <lead_context> block: every value fenced, at most maxChars (website trimmed first, then notes). */
export function renderLeadContext(c: LeadAiContext, maxChars = CONTEXT_MAX_CHARS): string {
  const build = (websiteBudget: number, notes: number): string => {
    const sections: [string, string | null][] = [
      ['details', detailsSection(c)],
      ['insights', insightsSection(c)],
      ['timing', timingSection(c)],
      ['contacts', contactsSection(c)],
      ['notes', notesSection(c, notes)],
      ['activity', activitySection(c)],
      ['tags', tagsSection(c)],
      ['customFields', customFieldsSection(c)],
      ['website', websiteBudget > 0 ? websiteSection(c, websiteBudget) : null],
    ];
    const body = sections.filter(([, s]) => s).map(([src, s]) => `<section src="${src}">${s}</section>`).join('\n');
    return `<lead_context id="${attr(c.id, 64)}" name="${attr(c.businessName)}">\n${body}\n</lead_context>`;
  };
  let website = 6000;
  let notes = 15;
  let out = build(website, notes);
  while (out.length > maxChars && website > 0) {
    website = Math.max(0, website - Math.max(500, out.length - maxChars));
    out = build(website, notes);
  }
  while (out.length > maxChars && notes > 0) {
    notes -= 1;
    out = build(website, notes);
  }
  return out.length > maxChars ? truncate(out, maxChars) : out;
}

// ---- vocabulary ---------------------------------------------------------------------------------------

const BASE_SERVICES = SERVICES.filter((s) => !(MATERIALS as readonly string[]).includes(s));

/** The <vocabulary> block: values the filter tool may use, for this user. Static lists when the query call failed. */
export function renderVocabulary(vocab: FilterVocabulary | null, role: Role): string {
  const lines: string[] = [];
  if (vocab) {
    const counties = vocab.counties.slice(0, 80)
      .map((c) => `${data(c.name ?? c.fips, 80)} -> ${data(c.fips, 5)} (${c.leadCount})`);
    lines.push(`counties (name -> FIPS, leads you can see): ${counties.join('; ') || 'none'}`);
    if (vocab.customTags.length) {
      lines.push(`custom tags: ${vocab.customTags.slice(0, 50).map((t) => `${data(t.name, 100)} (${t.leadCount})`).join('; ')}`);
    }
    if (vocab.customFieldKeys.length) {
      lines.push(`custom fields: ${vocab.customFieldKeys.slice(0, 30).map((k) => `${data(k.key, 100)} (${k.valueType})`).join('; ')}`);
    }
    if (role === 'manager' && vocab.reps.length) {
      lines.push(`reps (managers only): ${vocab.reps.map((r) => `${data(r.name, 100)} -> ${data(r.id, 36)}`).join('; ')}`);
    }
  } else {
    lines.push('counties, custom tags, custom fields and reps: unavailable right now (do not use those filters)');
  }
  lines.push(`materials: ${MATERIALS.join(', ')}`);
  lines.push(`services: ${BASE_SERVICES.join(', ')}`);
  lines.push(`certifications: ${CERTIFICATIONS.join(', ')}`);
  lines.push(`stages: ${SALES_STAGES.join(', ')} (lost = "not a fit"); follow-up: ${FOLLOW_UPS.join(', ')}`);
  lines.push(`segments: ${SEGMENTS.join(', ')}; sizes: ${SIZES.join(', ')}`);
  lines.push(`account statuses: ${ACCOUNT_STATUSES.join(', ')}`);
  return `<vocabulary>\n${lines.join('\n')}\n</vocabulary>`;
}
