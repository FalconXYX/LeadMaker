// System tag grouping, labels and filter options for the lead list. LeadSummary.tags carry key/value/label/
// category (no reasons), so everything here is derived from those plus the known taxonomy in lib/labels.
import type { LeadSummary } from '@/api/types';
import { humanize } from '@/lib/format';
import { CERTIFICATION_LABELS, MATERIALS, SERVICES } from '@/lib/labels';

export type SummaryTag = LeadSummary['tags'][number];

/** Tag groups for the filter panel and the "show as chips" toggles. */
export const TAG_GROUPS = ['work_type', 'size', 'certification', 'services', 'other'] as const;
export type TagGroup = (typeof TAG_GROUPS)[number];

export const TAG_GROUP_LABELS: Record<TagGroup, string> = {
  work_type: 'Work types',
  size: 'Size',
  certification: 'Certification',
  services: 'Materials & services',
  other: 'Other',
};

export const TAG_GROUP_HINTS: Record<TagGroup, string> = {
  work_type: 'Storm / emergency repair, new-build work',
  size: 'Company size, employees, review volume',
  certification: 'GAF tier, President’s Club, GAF Leads',
  services: 'Roof materials and services offered',
  other: 'Reputation, maturity, digital presence, contactability',
};

/** Tags never shown as chips: priority_drivers has its own column, the rest are noise in a list. */
const CHIP_EXCLUDED = new Set(['priority_drivers', 'account_status', 'data_completeness', 'state']);

export function tagGroupOf(tag: Pick<SummaryTag, 'key' | 'category'>): TagGroup | null {
  if (CHIP_EXCLUDED.has(tag.key)) return null;
  if (tag.key.startsWith('work_type:')) return 'work_type';
  if (tag.key.startsWith('service:') || tag.key.startsWith('specialty:') || tag.category === 'services') return 'services';
  if (tag.category === 'size') return 'size';
  if (tag.category === 'certification') return 'certification';
  return 'other';
}

/** A tag counts as present when its value is not false/null/empty (the API's "key" match). */
export function tagPresent(tag: Pick<SummaryTag, 'value'>): boolean {
  const v = tag.value;
  if (v === false || v === null || v === undefined || v === '') return false;
  return !(Array.isArray(v) && v.length === 0);
}

// ---- tag refs ("key" or "key=value") ---------------------------------------------------------

export function parseRef(ref: string): { key: string; value?: string } {
  const i = ref.indexOf('=');
  return i < 0 ? { key: ref } : { key: ref.slice(0, i), value: ref.slice(i + 1) };
}

/** Short names for presence refs ("key"): the tag's own label often carries a specific value. */
const PRESENCE_LABELS: Record<string, string> = {
  'work_type:storm_emergency': 'Storm / emergency repair',
  'work_type:new_construction': 'New-build work',
  presidents_club: 'President’s Club',
  gaf_leads: 'GAF Leads programme',
  gaf_recommended: 'GAF top pick',
  gaf_tier: 'Any GAF tier',
  employees: 'Employee count known',
  review_volume: 'Has reviews',
  size: 'Size known',
  reputation: 'Rated',
  recent_reviews: 'Reviewed in last 6 months',
  maturity: 'Years in business known',
  advertises: 'Runs paid ads',
  competitor_brands: 'Shows competitor brands',
  marketing_sophistication: 'Marketing score',
  offers_financing: 'Offers homeowner financing',
  social: 'On social media',
  website: 'Website found',
  direct_email: 'Email available',
  decision_maker: 'Decision-maker identified',
  target_contact: 'Target contact known',
  nyc_hic_license: 'NYC HIC license on file',
  registered_entity: 'Registered NY entity',
  focus: 'Commercial focus known',
  multi_trade: 'Multi-trade exterior contractor',
  premium_materials: 'Slate / metal / tile',
  storm_insurance: 'Storm / insurance work',
  distance_band: 'Distance known',
  region: 'Region known',
  'specialty:fortified': 'FORTIFIED roofs',
};

/** Keys whose (string) values are a small enumeration worth filtering by exact value. */
const ENUM_KEYS = new Set([
  'review_volume', 'reputation', 'maturity', 'employees', 'distance_band', 'focus', 'nyc_hic_license', 'region',
  'target_contact', 'size', 'gaf_tier',
]);

const VALUE_LABELS: Record<string, (value: string) => string> = {
  target_contact: (v) => `Ask for: ${humanize(v)}`,
  size: (v) => `Size: ${v}`,
  gaf_tier: (v) => CERTIFICATION_LABELS[`gaf:${v}` as keyof typeof CERTIFICATION_LABELS] ?? humanize(v),
  nyc_hic_license: (v) => `NYC HIC license: ${v}`,
};

/** Every label seen in loaded results, so chips for "key=value" refs read like the table does. */
const seenLabels = new Map<string, string>();

export function rememberTagLabels(items: readonly LeadSummary[]): void {
  for (const item of items) {
    for (const t of item.tags ?? []) {
      if (typeof t.value === 'string' && ENUM_KEYS.has(t.key)) seenLabels.set(`${t.key}=${t.value}`, t.label);
      else if (tagPresent(t) && !seenLabels.has(t.key) && !PRESENCE_LABELS[t.key]) seenLabels.set(t.key, t.label);
    }
  }
}

export function tagRefLabel(ref: string): string {
  const seen = seenLabels.get(ref);
  if (seen) return seen;
  const { key, value } = parseRef(ref);
  if (value === undefined) {
    if (PRESENCE_LABELS[key]) return PRESENCE_LABELS[key]!;
    if (key.startsWith('service:') || key.startsWith('specialty:')) return humanize(key);
    return humanize(key);
  }
  const fmt = VALUE_LABELS[key];
  return fmt ? fmt(value) : `${humanize(key)}: ${value}`;
}

// ---- filter options ----------------------------------------------------------------------------

export interface TagOption {
  ref: string;
  label: string;
  group: TagGroup;
}

/** Facets with their own controls (size, certification, materials/services): not repeated as tags. */
function coveredByFacet(key: string): boolean {
  return key === 'size' || key === 'gaf_tier' || key.startsWith('service:') || key === 'priority_drivers'
    || key === 'account_status';
}

const KNOWN_OPTIONS: TagOption[] = [
  { ref: 'work_type:storm_emergency', label: PRESENCE_LABELS['work_type:storm_emergency']!, group: 'work_type' },
  { ref: 'work_type:new_construction', label: PRESENCE_LABELS['work_type:new_construction']!, group: 'work_type' },
  { ref: 'storm_insurance', label: PRESENCE_LABELS.storm_insurance!, group: 'services' },
  { ref: 'multi_trade', label: PRESENCE_LABELS.multi_trade!, group: 'services' },
  { ref: 'premium_materials', label: PRESENCE_LABELS.premium_materials!, group: 'services' },
  { ref: 'presidents_club', label: PRESENCE_LABELS.presidents_club!, group: 'certification' },
  { ref: 'gaf_leads', label: PRESENCE_LABELS.gaf_leads!, group: 'certification' },
  { ref: 'gaf_recommended', label: PRESENCE_LABELS.gaf_recommended!, group: 'certification' },
];

/**
 * System tag filter options: known keys plus every tag seen in the loaded results. Enumerated string tags
 * become exact "key=value" options; everything else is a presence ("key") option.
 */
export function deriveTagOptions(items: readonly LeadSummary[], selected: readonly string[] = []): TagOption[] {
  const byRef = new Map<string, TagOption>();
  const add = (o: TagOption) => {
    if (!byRef.has(o.ref)) byRef.set(o.ref, o);
  };
  KNOWN_OPTIONS.forEach(add);
  for (const item of items) {
    for (const t of item.tags ?? []) {
      if (coveredByFacet(t.key) || !tagPresent(t)) continue;
      const group = tagGroupOf(t) ?? 'other';
      if (typeof t.value === 'string' && ENUM_KEYS.has(t.key)) {
        add({ ref: `${t.key}=${t.value}`, label: t.label, group });
      } else {
        add({ ref: t.key, label: PRESENCE_LABELS[t.key] ?? (typeof t.value === 'boolean' ? t.label : humanize(t.key)), group });
      }
    }
  }
  // Selected refs stay visible even when the loaded page no longer contains them.
  for (const ref of selected) {
    if (!byRef.has(ref)) {
      const { key } = parseRef(ref);
      add({ ref, label: tagRefLabel(ref), group: tagGroupOf({ key, category: '' }) ?? 'other' });
    }
  }
  return [...byRef.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
}

// ---- chips shown in the table ---------------------------------------------------------------------

export interface ChipTag {
  id: string;
  label: string;
  kind: 'custom' | 'system';
}

export interface TagVisibility {
  /** Which system tag groups (and custom tags) show as chips. */
  groups: Record<TagGroup | 'custom', boolean>;
  /** Custom tag names hidden even when custom tags are shown. */
  hiddenCustomTags: readonly string[];
}

export function visibleChips(lead: Pick<LeadSummary, 'tags' | 'customTags'>, vis: TagVisibility): ChipTag[] {
  const chips: ChipTag[] = [];
  if (vis.groups.custom) {
    const hidden = new Set(vis.hiddenCustomTags.map((n) => n.toLowerCase()));
    for (const t of lead.customTags ?? []) {
      if (!hidden.has(t.name.toLowerCase())) chips.push({ id: `c:${t.id}`, label: t.name, kind: 'custom' });
    }
  }
  for (const t of lead.tags ?? []) {
    const g = tagGroupOf(t);
    if (g && vis.groups[g] && tagPresent(t)) chips.push({ id: `s:${t.key}`, label: t.label, kind: 'system' });
  }
  return chips;
}

// ---- ranking reasons -----------------------------------------------------------------------------------

export { rankingReasons, type Reason } from '@/lib/reasons';

// ---- certification -------------------------------------------------------------------------------------

export const TIER_LABELS: Record<string, string> = {
  master_elite: 'Master Elite',
  certified_plus: 'Certified Plus',
  certified: 'Certified',
};

export const MATERIAL_KEYS: readonly string[] = MATERIALS;
export const SERVICE_KEYS: readonly string[] = SERVICES;

/** Taxonomy labels that read better than humanize(). */
export const TAXONOMY_LABELS: Record<string, string> = {
  shingle_roofing: 'Shingles',
  metal_roofing: 'Metal',
  slate_roofing: 'Slate',
  tile_roofing: 'Tile',
  flat_roofing: 'Flat / low-slope',
  tpo_roofing: 'TPO',
  single_ply_roofing: 'Single-ply (EPDM / PVC)',
  roof_replacement: 'Roof replacement',
  roof_repair: 'Roof repair',
  storm_damage: 'Storm damage',
  insurance_claims: 'Insurance claims',
  emergency_service: 'Emergency service',
  new_construction: 'New construction',
  commercial_roofing: 'Commercial roofing',
  general_contracting: 'General contracting',
};

export const taxonomyLabel = (key: string) => TAXONOMY_LABELS[key] ?? humanize(key);
