// apply_filter support: sanitize the model's LeadFilter (untrusted) into what the list URL can carry,
// compare filters, and describe one as short chips for the "Applied filters" card.
import type { CustomFieldCondition, LeadFilter } from '@/api/types';
import { isRecord } from '@/api/errors';
import { FOLLOW_UP_LABELS, notContactedDays } from '@/features/leads/sales';
import { viewLabel } from '@/features/leads/scope';
import { tagRefLabel, taxonomyLabel } from '@/features/leads/tags';
import { countyPlaceShort } from '@/lib/counties';
import { filterToSearchParams, searchParamsToFilter } from '@/lib/filterUrl';
import {
  ACCOUNT_STATUS_LABELS, CERTIFICATION_LABELS, SEGMENT_LABELS, SIZE_LABELS, SORT_LABELS, STAGE_LABELS,
} from '@/lib/labels';

const ARRAY_KEYS = [
  'tagsAll', 'tagsAny', 'customTags', 'certifications', 'materials', 'services', 'segment', 'size', 'accountStatus',
  'stages', 'counties',
] as const;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The model's filter (+ optional separate sort) as a clean LeadFilter, or null when nothing usable is left.
 * Only keys the list URL understands survive (the same lenient parser the list itself uses), so whatever
 * the card shows is exactly what the list applies.
 */
export function coerceFilter(raw: unknown, sort?: unknown): LeadFilter | null {
  if (!isRecord(raw)) return null;
  const f: Record<string, unknown> = {};
  for (const k of ARRAY_KEYS) {
    const v = raw[k];
    if (Array.isArray(v)) f[k] = v.filter(isStr).slice(0, 50);
  }
  if (Array.isArray(raw.customFields)) {
    f.customFields = raw.customFields
      .filter((c): c is CustomFieldCondition => isRecord(c) && isStr(c.key) && isStr(c.op)
        && (c.value === undefined || isStr(c.value) || isNum(c.value) || typeof c.value === 'boolean'))
      .slice(0, 20);
  }
  const scope = raw.scope;
  if (scope === 'mine' || scope === 'unallocated' || scope === 'all') f.scope = scope;
  else if (isRecord(scope) && isStr(scope.repId)) f.scope = { repId: scope.repId };
  if (isStr(raw.followUp)) f.followUp = raw.followUp;
  if (isStr(raw.notContactedSince)) f.notContactedSince = raw.notContactedSince;
  if (isNum(raw.minPriority)) f.minPriority = raw.minPriority;
  if (isNum(raw.minRating)) f.minRating = raw.minRating;
  if (isNum(raw.minYearsInBusiness)) f.minYearsInBusiness = raw.minYearsInBusiness;
  if (isRecord(raw.near) && isStr(raw.near.zip) && isNum(raw.near.radiusMiles)) {
    f.near = { zip: raw.near.zip, radiusMiles: raw.near.radiusMiles };
  }
  if (raw.unchecked === 'me' || raw.unchecked === 'team') f.unchecked = raw.unchecked;
  if (raw.unserviced === 'me' || raw.unserviced === 'team') f.unserviced = raw.unserviced;
  if (isStr(raw.updatedSince)) f.updatedSince = raw.updatedSince;
  if (raw.updatedInLastPoll === true) f.updatedInLastPoll = true;
  if (isStr(raw.text)) f.text = raw.text;
  const s = sort ?? raw.sort;
  if (isRecord(s) && isStr(s.by) && (s.dir === 'asc' || s.dir === 'desc')) f.sort = { by: s.by, dir: s.dir };

  try {
    return searchParamsToFilter(filterToSearchParams(f as LeadFilter));
  } catch {
    return null;
  }
}

/** Order-insensitive equality, as the list URL sees it. */
export function sameFilter(a: LeadFilter, b: LeadFilter): boolean {
  return canonical(a) === canonical(b);
}

function canonical(f: LeadFilter): string {
  return [...filterToSearchParams(f).entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
}

export interface FilterChipInfo {
  id: string;
  facet: string;
  label: string;
}

const OP_LABELS: Record<CustomFieldCondition['op'], string> = { eq: '=', gte: '≥', lte: '≤', contains: 'contains', exists: 'has a value' };

/**
 * One chip per value; includes scope and sort (unlike the list's removable chips) since both were applied. Facet
 * names and labels match the list's own chips (features/leads FilterChips) and its view switch, so the card and the
 * list say the same thing ("Never contacted: by me", "My leads").
 */
export function describeFilter(f: LeadFilter, opts: { isManager?: boolean } = {}): FilterChipInfo[] {
  const chips: FilterChipInfo[] = [];
  const each = <K extends keyof LeadFilter>(key: K, facet: string, label: (v: string) => string) => {
    for (const v of (f[key] as string[] | undefined) ?? []) chips.push({ id: `${String(key)}:${v}`, facet, label: label(v) });
  };
  if (f.scope) chips.push({ id: 'scope', facet: 'View', label: viewLabel({ scope: f.scope }, !!opts.isManager) });
  if (f.text) chips.push({ id: 'text', facet: 'Name', label: `“${f.text}”` });
  each('segment', 'Segment', (v) => SEGMENT_LABELS[v as keyof typeof SEGMENT_LABELS] ?? v);
  each('certifications', 'GAF', (v) => CERTIFICATION_LABELS[v as keyof typeof CERTIFICATION_LABELS]?.replace(/^GAF /, '') ?? v);
  each('size', 'Size', (v) => SIZE_LABELS[v as keyof typeof SIZE_LABELS] ?? v);
  each('materials', 'Material', taxonomyLabel);
  each('services', 'Service', taxonomyLabel);
  each('tagsAll', 'Tag', tagRefLabel);
  each('tagsAny', 'Any tag', tagRefLabel);
  each('customTags', 'Custom tag', (v) => v);
  each('accountStatus', 'Status', (v) => ACCOUNT_STATUS_LABELS[v as keyof typeof ACCOUNT_STATUS_LABELS] ?? v);
  each('stages', 'Stage', (v) => STAGE_LABELS[v as keyof typeof STAGE_LABELS] ?? v);
  // County names come from the territory table (and the names /api/signals registered); unknown codes show as FIPS.
  each('counties', 'County', countyPlaceShort);
  if (f.followUp) chips.push({ id: 'followUp', facet: 'Follow-up', label: FOLLOW_UP_LABELS[f.followUp]?.toLowerCase() ?? f.followUp });
  if (f.notContactedSince) {
    const days = notContactedDays(f.notContactedSince);
    chips.push({ id: 'notContactedSince', facet: 'Not contacted', label: days ? `${days}+ days` : `since ${shortDate(f.notContactedSince)}` });
  }
  if (f.minPriority !== undefined) chips.push({ id: 'minPriority', facet: 'Priority', label: `${f.minPriority}+` });
  (f.customFields ?? []).forEach((c, i) => chips.push({
    id: `cf:${i}`,
    facet: 'Field',
    label: c.op === 'exists' ? `${c.key} ${OP_LABELS.exists}` : `${c.key} ${OP_LABELS[c.op]} ${String(c.value)}`,
  }));
  if (f.minRating !== undefined) chips.push({ id: 'minRating', facet: 'Rating', label: `${f.minRating}+ ★` });
  if (f.minYearsInBusiness !== undefined) chips.push({ id: 'minYears', facet: 'In business', label: `${f.minYearsInBusiness}+ yrs` });
  if (f.near) chips.push({ id: 'near', facet: 'Near', label: `${f.near.zip} · ${f.near.radiusMiles} mi` });
  if (f.unchecked) chips.push({ id: 'unchecked', facet: 'Unchecked', label: f.unchecked === 'me' ? 'by me' : 'by team' });
  if (f.unserviced) chips.push({ id: 'unserviced', facet: 'Never contacted', label: f.unserviced === 'me' ? 'by me' : 'by anyone' });
  if (f.updatedSince) chips.push({ id: 'since', facet: 'Changed since', label: shortDate(f.updatedSince) });
  if (f.updatedInLastPoll) chips.push({ id: 'new', facet: 'Updated', label: 'in last poll' });
  if (f.sort) chips.push({ id: 'sort', facet: 'Sort', label: `${SORT_LABELS[f.sort.by]} ${f.sort.dir === 'asc' ? '↑' : '↓'}` });
  return chips;
}


function shortDate(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
