// Runtime copies of the shared enums (packages/shared/src/filter.ts is type-only here); `satisfies`
// fails the typecheck if they drift from the shared types.
import type { AccountStatus, CompanyOverrideField, LeadFilter, SortField, TimingBadge } from '@/api/types';
import type { FollowUp, SalesStage, TaskType } from '@shared/types.ts';

type Segment = NonNullable<LeadFilter['segment']>[number];
type Size = NonNullable<LeadFilter['size']>[number];

export const SEGMENTS = ['strategic', 'growth', 'emerging', 'long_tail'] as const satisfies readonly Segment[];
export const SIZES = ['small', 'medium', 'large'] as const satisfies readonly Size[];
export const ACCOUNT_STATUSES = ['prospect', 'existing_customer', 'lapsed_customer', 'do_not_contact'] as const satisfies readonly AccountStatus[];
export const SORT_FIELDS = [
  'priority_score', 'distance', 'rating', 'review_count', 'years_in_business', 'last_change', 'next_follow_up', 'last_contacted',
] as const satisfies readonly SortField[];
export const SALES_STAGES = ['new', 'contacted', 'interested', 'quoting', 'won', 'lost'] as const satisfies readonly SalesStage[];
export const FOLLOW_UPS = ['overdue', 'today', 'week', 'none'] as const satisfies readonly NonNullable<LeadFilter['followUp']>[];
export const TASK_TYPES = ['call', 'email', 'visit', 'todo'] as const satisfies readonly TaskType[];
export const CERTIFICATIONS = ['gaf:master_elite', 'gaf:certified_plus', 'gaf:certified', 'gaf:none'] as const;
export const MATERIALS = [
  'shingle_roofing', 'metal_roofing', 'slate_roofing', 'tile_roofing', 'flat_roofing', 'tpo_roofing', 'single_ply_roofing',
] as const;
export const SERVICES = [
  'roof_replacement', 'roof_repair', 'storm_damage', 'insurance_claims', 'emergency_service', 'new_construction',
  'commercial_roofing', 'inspections', 'gutters', 'siding', 'windows', 'skylights', 'chimney', 'masonry',
  'waterproofing', 'insulation', 'solar', 'general_contracting',
] as const;

export type { FollowUp, SalesStage, Segment, Size, TaskType };

/** Company fields a rep may override (shared COMPANY_OVERRIDE_FIELDS), in display order. */
export const COMPANY_OVERRIDE_FIELDS = [
  'business_name', 'phone', 'website_url', 'address', 'street', 'city', 'state', 'postal_code',
] as const satisfies readonly CompanyOverrideField[];
type MissingCompanyField = Exclude<CompanyOverrideField, (typeof COMPANY_OVERRIDE_FIELDS)[number]>;
const companyFieldsExhaustive: MissingCompanyField extends never ? true : MissingCompanyField = true;
void companyFieldsExhaustive;

export const SEGMENT_LABELS: Record<Segment, string> = {
  strategic: 'Strategic',
  growth: 'Growth',
  emerging: 'Emerging',
  long_tail: 'Long tail',
};

export const SIZE_LABELS: Record<Size, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  prospect: 'Prospect',
  existing_customer: 'Customer',
  lapsed_customer: 'Lapsed customer',
  do_not_contact: 'Do not contact',
};

export const CERTIFICATION_LABELS: Record<(typeof CERTIFICATIONS)[number], string> = {
  'gaf:master_elite': 'GAF Master Elite',
  'gaf:certified_plus': 'GAF Certified Plus',
  'gaf:certified': 'GAF Certified',
  'gaf:none': 'Not GAF certified',
};

export const SORT_LABELS: Record<SortField, string> = {
  priority_score: 'Priority',
  distance: 'Distance',
  rating: 'Rating',
  review_count: 'Reviews',
  years_in_business: 'Years in business',
  last_change: 'Last change',
  next_follow_up: 'Next follow-up',
  last_contacted: 'Last contacted',
};

export const STAGE_LABELS: Record<SalesStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  quoting: 'Quoting',
  won: 'Won',
  lost: 'Not a fit',
};

export const STAGE_HINTS: Record<SalesStage, string> = {
  new: 'Not worked yet',
  contacted: 'Reached out at least once',
  interested: 'Open to buying from us',
  quoting: 'Pricing a job or an order',
  won: 'Buying from us',
  lost: 'Not a fit for now',
};

/** The API's buckets: overdue (before today), today, week (today and the next 6 days), none (no open task). */
export const FOLLOW_UP_LABELS: Record<FollowUp, string> = { overdue: 'Overdue', today: 'Today', week: 'This week', none: 'None' };

export const TASK_TYPE_LABELS: Record<TaskType, string> = { call: 'Call', email: 'Email', visit: 'Visit', todo: 'To-do' };

export function isSalesStage(v: unknown): v is SalesStage {
  return typeof v === 'string' && (SALES_STAGES as readonly string[]).includes(v);
}

export const TIMING_SEVERITY_LABELS: Record<TimingBadge['severity'], string> = {
  high: 'Act now',
  medium: 'Soon',
  low: 'Watch',
  info: 'Info',
};

export function isSegment(v: string | null | undefined): v is Segment {
  return !!v && (SEGMENTS as readonly string[]).includes(v);
}

// ---- weather text ---------------------------------------------------------------------------------

/** NWS local storm report codes (and NCEI names in capitals) as words. */
export const STORM_REPORT_LABELS: Record<string, string> = {
  'NON-TSTM WND DMG': 'Wind damage',
  'TSTM WND DMG': 'Thunderstorm wind damage',
  'TSTM WND GST': 'Thunderstorm gust',
  'NON-TSTM WND GST': 'Wind gust',
  'HIGH SUST WINDS': 'High winds',
  'FLASH FLOOD': 'Flash flood',
  'COASTAL FLOOD': 'Coastal flood',
  FLOOD: 'Flood',
  HAIL: 'Hail',
  TORNADO: 'Tornado',
  SNOW: 'Snow',
  'HEAVY SNOW': 'Heavy snow',
  'ICE STORM': 'Ice storm',
  'HEAVY RAIN': 'Heavy rain',
};

const REPORT_CODE = new RegExp(
  `\\b(${Object.keys(STORM_REPORT_LABELS).sort((a, b) => b.length - a.length).map((k) => k.replace(/[-]/g, '\\-')).join('|')})\\b`,
  'g',
);
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * Server-written weather reasons quote raw report codes and ISO dates ("latest 2026-09-26 NON-TSTM WND DMG
 * at 3 W Ramsey"): reads them as words ("latest Sep 26: wind damage at 3 W Ramsey").
 */
export function readableWeatherText(text: string): string;
export function readableWeatherText(text: string | null | undefined): string | null | undefined;
export function readableWeatherText(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  const year = new Date().getUTCFullYear();
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b( (?=[A-Z]{3,}))?/g, (_m, y: string, mo: string, d: string, gap?: string) => {
      const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      if (Number.isNaN(date.getTime())) return _m;
      return `${(Number(y) === year ? shortDate : longDate).format(date)}${gap ? ': ' : ''}`;
    })
    .replace(REPORT_CODE, (code: string, _c: string, offset: number, whole: string) => {
      const label = STORM_REPORT_LABELS[code] ?? code;
      const sentenceStart = offset === 0 || /[.!?]\s*$/.test(whole.slice(0, offset));
      return sentenceStart ? label : label.charAt(0).toLowerCase() + label.slice(1);
    });
}
