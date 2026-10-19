// The one LeadFilter (SystemDesign §5): list API, saved views, bulk allocation and the AI filter tool.
// Facet semantics: values inside one facet are OR'ed (size: ['small', 'medium'] = small or medium),
// facets are AND'ed, except tagsAll (every tag) and customFields (every condition).
import { z } from 'zod';

export const SIZES = ['small', 'medium', 'large'] as const;
export const SEGMENTS = ['strategic', 'growth', 'emerging', 'long_tail'] as const;
export const ACCOUNT_STATUSES = ['prospect', 'existing_customer', 'lapsed_customer', 'do_not_contact'] as const;
/** companies.sales_stage in pipeline order (labels: SALES_STAGE_LABELS; 'lost' reads "Not a fit"). */
export const SALES_STAGES = ['new', 'contacted', 'interested', 'quoting', 'won', 'lost'] as const;
/** LeadFilter.followUp: the lead's open tasks (filter-sql followUpCondition). */
export const FOLLOW_UPS = ['overdue', 'today', 'week', 'none'] as const;
export const SORT_FIELDS = [
  'priority_score', 'distance', 'rating', 'review_count', 'years_in_business', 'last_change', 'next_follow_up', 'last_contacted',
] as const;
export const CUSTOM_FIELD_OPS = ['eq', 'gte', 'lte', 'contains', 'exists'] as const;
export const CERTIFICATIONS = ['gaf:master_elite', 'gaf:certified_plus', 'gaf:certified', 'gaf:none'] as const;
// Roofing taxonomy keys (leadmaker/tagging/taxonomy.py). Materials and services both match `service:<key>`
// system tags (and `specialty:<key>` from the GAF listing); other keys are accepted for future industries.
export const MATERIALS = [
  'shingle_roofing', 'metal_roofing', 'slate_roofing', 'tile_roofing', 'flat_roofing', 'tpo_roofing', 'single_ply_roofing',
] as const;
export const SERVICES = [
  'roof_replacement', 'roof_repair', 'storm_damage', 'insurance_claims', 'emergency_service', 'new_construction',
  'commercial_roofing', 'inspections', 'gutters', 'siding', 'windows', 'skylights', 'chimney', 'masonry',
  'waterproofing', 'insulation', 'solar', 'general_contracting', ...MATERIALS,
] as const;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** System tag keys a LeadFilter may name (also the keys db function system_tag_facets indexes). */
export const TAG_KEY = /^[a-z0-9_:.-]+$/i;
const TAXONOMY_KEY = /^[a-z0-9_]+$/;

export const tagRefSchema = z
  .string()
  .max(200)
  .refine((ref) => {
    const t = parseTagRef(ref);
    return TAG_KEY.test(t.key) && (t.value === undefined || t.value.length > 0);
  }, 'expected "key" or "key=value", e.g. "service:metal_roofing" or "gaf_tier=master_elite"')
  .describe('System tag: "key" (tag present and not false) or "key=value" (exact value), e.g. '
    + '"service:metal_roofing", "work_type:storm_emergency", "gaf_tier=master_elite", "region=Brooklyn", "distance_band=0-5".');

const customFieldSchema = z
  .object({
    key: z.string().min(1).max(100),
    op: z.enum(CUSTOM_FIELD_OPS),
    value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.op === 'exists') return;
    if (f.value === undefined) ctx.addIssue({ code: 'custom', message: `op "${f.op}" needs a value`, path: ['value'] });
    else if ((f.op === 'gte' || f.op === 'lte') && typeof f.value === 'boolean')
      ctx.addIssue({ code: 'custom', message: `op "${f.op}" needs a number or a string`, path: ['value'] });
    else if (f.op === 'contains' && typeof f.value !== 'string')
      ctx.addIssue({ code: 'custom', message: 'op "contains" needs a string', path: ['value'] });
  });

const isoDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** The LeadFilter object without its cross-field refinement, so derived schemas (the AI tool schema) can reuse it. */
export const leadFilterObject = z
  .object({
    scope: z
      .union([z.enum(['mine', 'unallocated', 'all']), z.object({ repId: z.uuid() }).strict()])
      .optional()
      .describe('"mine" (allocated to me), "unallocated" (the shared pool), "all" or {repId} (managers only). '
        + 'Omitted: everything the user may view (a rep: mine + unallocated).'),
    tagsAll: z.array(tagRefSchema).max(50).optional().describe('Lead has every one of these system tags.'),
    tagsAny: z.array(tagRefSchema).max(50).optional().describe('Lead has at least one of these system tags.'),
    customTags: z.array(z.string().min(1).max(100)).max(50).optional()
      .describe('Rep-created custom tags, by id or name (case-insensitive); any of them.'),
    customFields: z.array(customFieldSchema).max(20).optional()
      .describe('Conditions on rep-entered custom data slots; all must hold. gte/lte compare numbers, or strings '
        + 'such as ISO dates; contains is a case-insensitive substring (or an array element).'),
    certifications: z.array(z.string().regex(/^[a-z0-9_]+:[a-z0-9_]+$/)).max(20).optional()
      .describe(`Source-namespaced certification levels, any of: ${CERTIFICATIONS.join(', ')}.`),
    size: z.array(z.enum(SIZES)).max(3).optional(),
    segment: z.array(z.enum(SEGMENTS)).max(4).optional(),
    accountStatus: z.array(z.enum(ACCOUNT_STATUSES)).max(4).optional(),
    stages: z.array(z.enum(SALES_STAGES)).max(6).optional()
      .describe('Sales stages, any of: new, contacted, interested, quoting, won, lost ("Not a fit").'),
    followUp: z.enum(FOLLOW_UPS).optional()
      .describe('Open follow-up tasks: "overdue" (due before today), "today", "week" (due today or in the next 6 days), '
        + '"none" (no open task). Days are in the sales team\'s time zone.'),
    notContactedSince: isoDate.optional()
      .describe('No call, email or visit logged at or after this ISO date/time (never contacted included).'),
    materials: z.array(z.string().regex(TAXONOMY_KEY)).max(20).optional()
      .describe(`Roof materials, any of: ${MATERIALS.join(', ')}.`),
    services: z.array(z.string().regex(TAXONOMY_KEY)).max(40).optional()
      .describe(`Services / work types, any of: ${SERVICES.join(', ')}.`),
    minRating: z.number().min(0).max(5).optional().describe('Minimum star rating (0-5).'),
    minPriority: z.number().min(0).max(100).optional().describe('Minimum priority score (0-100).'),
    minYearsInBusiness: z.number().int().min(0).max(200).optional(),
    near: z
      .object({ zip: z.string().regex(/^\d{5}$/), radiusMiles: z.number().positive().max(250) })
      .strict()
      .optional()
      .describe('Within radiusMiles of the ZIP code centroid.'),
    counties: z.array(z.string().regex(/^\d{5}$/)).max(100).optional()
      .describe('County FIPS codes (5 digits, e.g. "36061"); any of.'),
    unchecked: z.enum(['me', 'team']).optional()
      .describe('Not reviewed since its last material change, by me or by anyone on the team.'),
    unserviced: z.enum(['me', 'team']).optional()
      .describe('No call, email or visit logged, by me or by anyone on the team.'),
    updatedSince: isoDate.optional().describe('New or materially changed at or after this ISO date/time.'),
    updatedInLastPoll: z.boolean().optional()
      .describe('true: new or materially changed in the most recent complete pipeline run of its area; false: not.'),
    text: z.string().trim().min(1).max(200).optional().describe('Business name contains this text.'),
    sort: z
      .object({ by: z.enum(SORT_FIELDS), dir: z.enum(['asc', 'desc']) })
      .strict()
      .optional()
      .describe('Default priority_score desc. "distance" needs near. "next_follow_up": the earliest open task\'s due date '
        + '(leads without one last); "last_contacted": the latest call, email or visit (never contacted counts as oldest).'),
    cursor: z.string().max(2000).optional().describe('nextCursor from the previous page.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Page size, default ${DEFAULT_LIMIT}.`),
  })
  .strict();

export const leadFilterSchema = leadFilterObject
  .superRefine((f, ctx) => {
    if (f.sort?.by === 'distance' && !f.near)
      ctx.addIssue({ code: 'custom', message: 'sort by distance needs near', path: ['sort', 'by'] });
  })
  .describe('LeadFilter: the shared lead list filter.');

export type LeadFilter = z.infer<typeof leadFilterSchema>;
export type LeadScope = NonNullable<LeadFilter['scope']>;
export type SortField = (typeof SORT_FIELDS)[number];
export type CustomFieldCondition = NonNullable<LeadFilter['customFields']>[number];

export function parseTagRef(ref: string): { key: string; value?: string } {
  const i = ref.indexOf('=');
  return i < 0 ? { key: ref } : { key: ref.slice(0, i), value: ref.slice(i + 1) };
}

export function tagRef(key: string, value?: string | number | boolean): string {
  return value === undefined ? key : `${key}=${value}`;
}

/** JSON Schema (draft 2020-12) of LeadFilter, for the AI filter tool and the Python pipeline. */
export function leadFilterJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(leadFilterSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

/** LeadFilter as the AI filter tool takes it: no paging; scope without the {repId} object (repId is its own key,
 *  so providers that cannot express anyOf get a plain enum). The assistant maps repId -> scope {repId}. */
export const leadFilterToolSchema = leadFilterObject
  .omit({ cursor: true, limit: true, scope: true })
  .extend({
    scope: z.enum(['mine', 'unallocated', 'all']).optional()
      .describe('"mine" (allocated to me), "unallocated" (the pool), "all" (everything I may view).'),
    repId: z.uuid().optional().describe("Managers only: one rep's leads (an id from the vocabulary)."),
  })
  .strict()
  .describe('LeadFilter for the lead list (complete; it replaces the current filter).');
export type LeadFilterTool = z.infer<typeof leadFilterToolSchema>;
export function leadFilterToolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(leadFilterToolSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}
