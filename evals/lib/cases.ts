// Case-file schemas for the AI evaluation set (SystemDesign §7, BuildChecklist "AI evaluation set").
// The zod schemas here are the source of evals/schema/cases.schema.json (`node evals/lib/export-schema.ts`);
// a test fails when the committed JSON drifts from them, and every case line is validated against them.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(EVALS_DIR, '..');

export const SUITES = ['nl_filter', 'lead_qa', 'insights'] as const;
export type Suite = (typeof SUITES)[number];
export const ASSISTANT_SUITES = ['nl_filter', 'lead_qa'] as const;
export type AssistantSuite = (typeof ASSISTANT_SUITES)[number];

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-\\d{2,3}$`));
const regexString = z.string().min(1).refine((s) => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

/** Text checks (regexes are case-insensitive). mustMatch: every pattern matches; mustNotMatch: none does. */
export const textAssertSchema = z.object({
  mustMatch: z.array(regexString).optional(),
  mustNotMatch: z.array(regexString).optional(),
  maxWords: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  /** Count of distinct /leads/<id> links in the answer. */
  minLinks: z.number().int().min(0).optional(),
  maxLinks: z.number().int().min(0).optional(),
}).strict();
export type TextAssert = z.infer<typeof textAssertSchema>;

const pathMap = <T extends z.ZodType>(v: T) => z.record(z.string().min(1), v);

/** Filter checks on the normalized filter (arrays sorted, the role's default scope removed unless asserted).
 *  Keys are dotted paths ("near.zip", "scope.repId", "sort.by"). */
const filterAssertBase = z.object({
  includes: pathMap(z.unknown()).optional()
    .describe('arrays: expected values are a subset of the actual ones; scalars and objects: equal'),
  setEquals: pathMap(z.array(z.unknown())).optional().describe('arrays equal as sets'),
  range: pathMap(z.tuple([z.number(), z.number()])).optional().describe('numeric bounds, inclusive'),
  excludes: pathMap(z.array(z.unknown())).optional().describe('arrays: none of these values may be present'),
  absent: z.array(z.string().min(1)).optional().describe('paths that must be missing'),
  onlyKeys: z.array(z.string().min(1)).optional().describe('top-level keys allowed (others fail)'),
  matches: pathMap(regexString).optional().describe('String(value) matches the regex'),
  dateDaysAgo: pathMap(z.number().int().min(0)).optional()
    .describe('ISO date equals now minus N days (America/New_York), +-1 day'),
}).strict();
export const filterAssertSchema = filterAssertBase.extend({
  anyOf: z.array(filterAssertBase).min(1).optional().describe('at least one sub-assertion passes'),
}).strict();
export type FilterAssert = z.infer<typeof filterAssertSchema>;
export type FilterAssertBase = z.infer<typeof filterAssertBase>;

export const TOOL_OUTCOMES = ['applyListFilters', 'findLeads', 'todaysCalls', 'openLead', 'none'] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

const expectBase = z.object({
  /** The effective action: applyListFilters (an apply_filter event), openLead (an open_lead event), findLeads or
   *  todaysCalls (a successful call), else none. An array lists acceptable outcomes. */
  tool: z.union([z.enum(TOOL_OUTCOMES), z.array(z.enum(TOOL_OUTCOMES)).min(1)]).optional(),
  filter: filterAssertSchema.optional(),
  /** apply_filter's matchCount is at least this (a filter that shows the user an empty list fails). */
  matchCountMin: z.number().int().min(0).optional(),
  text: textAssertSchema.optional(),
  /** On the apply_filter explanation. */
  explanation: textAssertSchema.optional(),
  citations: z.object({
    includes: z.array(z.string()).optional(),
    includesAny: z.array(z.string()).min(1).optional(),
    excludes: z.array(z.string()).optional(),
    /** true: no citations at all; false: at least one. */
    none: z.boolean().optional(),
  }).strict().optional(),
  outcome: z.enum(['done', 'error']).optional(),
  errorCode: z.string().optional(),
}).strict();
export const expectSchema = expectBase.extend({
  anyOf: z.array(expectBase).min(1).optional(),
}).strict();
export type Expect = z.infer<typeof expectSchema>;
export type ExpectBase = z.infer<typeof expectBase>;

const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }).strict();

/** Fake provider script (services/assistant/src/llm/fake.ts script mode): one step per provider call. */
export const fakeStepSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ tool: z.enum(['applyListFilters', 'findLeads', 'todaysCalls', 'openLead']), args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ tools: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).strict()).min(1) }).strict(),
  z.object({ error: z.enum(['quota', 'rate_limited', 'auth', 'api', 'timeout', 'blocked']) }).strict(),
  z.object({ delayMs: z.number().int().min(0) }).strict(),
]);
export const fakeScriptSchema = z.object({ steps: z.array(fakeStepSchema).min(1) }).strict();

const common = {
  tags: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).describe('for per-tag pass rates'),
  /** Asserted in offline mode (fake provider, rules mode). Without it the case only reports a baseline offline. */
  offline: z.boolean().optional(),
  /** Picked first when --limit trims a live run. */
  smoke: z.boolean().optional(),
  note: z.string().optional(),
};

export const nlFilterCaseSchema = z.object({
  id: id('nl'),
  utterance: z.string().min(1).max(4000),
  role: z.enum(['rep', 'manager']).default('rep'),
  page: z.enum(['dashboard', 'leads', 'profile', 'allocation']).default('leads'),
  /** The list's current filter (context.filter on the leads page). */
  currentFilter: z.record(z.string(), z.unknown()).optional(),
  history: z.array(message).optional(),
  fake_script: fakeScriptSchema.optional(),
  expect: expectSchema,
  ...common,
}).strict();
export type NlFilterCase = z.infer<typeof nlFilterCaseSchema>;

export const leadQaCaseSchema = z.object({
  id: id('qa'),
  /** evals/lead_qa/fixtures/<fixture>.json (a LeadAiContext). */
  fixture: z.string().regex(/^[a-z0-9_]+$/),
  /** The user's question; "-" for fake_script cases (the script is the model's output). */
  question: z.string().min(1).max(4000),
  role: z.enum(['rep', 'manager']).default('rep'),
  /** Earlier turns (completed exchanges), oldest first. */
  history: z.array(message).optional(),
  fake_script: fakeScriptSchema.optional(),
  /** A string the planted injection asks for; it must never appear in the answer. */
  canary: z.string().optional(),
  expect: expectSchema,
  ...common,
}).strict();
export type LeadQaCase = z.infer<typeof leadQaCaseSchema>;

const insightsTextTargets = {
  summary: textAssertSchema.optional(),
  pitch: textAssertSchema.optional(),
  talkingPoints: textAssertSchema.optional(),
  pitchOrPoints: textAssertSchema.optional().describe('passes when the pitch or any talking point passes'),
  all: textAssertSchema.optional().describe('summary + pitch + talking points + target contact'),
};
export const insightsExpectSchema = z.object({
  ...insightsTextTargets,
  targetContactName: z.string().optional(),
  targetContactNull: z.boolean().optional(),
  /** A talking point cites a fact with this key (e.g. custom_field). */
  talkingPointCitesKey: z.string().optional(),
  /** Every talking point cites at least one fact. */
  allTalkingPointsCited: z.boolean().optional(),
  /** The lead is skipped before the model (LeadFacts.skip_reason). */
  skipped: z.enum(['do_not_contact', 'delisted']).optional(),
  /** The generation must end as an error result. violations: regexes that must each match some violation. */
  error: z.object({ attempts: z.number().int().min(1).max(2), violations: z.array(regexString).min(1) }).strict().optional(),
  /** An ok result after exactly this many attempts (2 = the retry with feedback fixed it). */
  attempts: z.number().int().min(1).max(2).optional(),
}).strict();
export type InsightsExpect = z.infer<typeof insightsExpectSchema>;

export const insightsCaseSchema = z.object({
  id: id('in'),
  /** evals/insights/fixtures/<fixture>.json (a LeadFacts dict for leadmaker.insights.facts_from_dict). */
  fixture: z.string().regex(/^[a-z0-9_]+$/),
  /** Python fake provider script (dicts returned as the model's JSON), consumed one per call. Offline only. */
  fake_script: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  canary: z.string().optional(),
  expect: insightsExpectSchema,
  ...common,
}).strict();
export type InsightsCase = z.infer<typeof insightsCaseSchema>;

export const CASE_SCHEMAS = {
  nl_filter: nlFilterCaseSchema,
  lead_qa: leadQaCaseSchema,
  insights: insightsCaseSchema,
} as const;

export function casesPath(suite: Suite): string {
  return join(EVALS_DIR, suite, 'cases.jsonl');
}

/** Raw JSON objects of a suite's cases.jsonl (blank lines and lines starting with // are skipped). */
export function readCaseLines(suite: Suite): { line: number; value: unknown }[] {
  const out: { line: number; value: unknown }[] = [];
  readFileSync(casesPath(suite), 'utf8').split('\n').forEach((text, i) => {
    const t = text.trim();
    if (!t || t.startsWith('//')) return;
    out.push({ line: i + 1, value: JSON.parse(t) });
  });
  return out;
}

export function loadCases(suite: 'nl_filter'): NlFilterCase[];
export function loadCases(suite: 'lead_qa'): LeadQaCase[];
export function loadCases(suite: 'insights'): InsightsCase[];
export function loadCases(suite: Suite): (NlFilterCase | LeadQaCase | InsightsCase)[] {
  const schema = CASE_SCHEMAS[suite];
  return readCaseLines(suite).map(({ line, value }) => {
    const r = schema.safeParse(value);
    if (!r.success) throw new Error(`${suite}/cases.jsonl line ${line}: ${z.prettifyError(r.error)}`);
    return r.data;
  });
}

/** The JSON schema of every case file (evals/schema/cases.schema.json). */
export function casesJsonSchema(): Record<string, unknown> {
  const one = (s: z.ZodType) => {
    const { $schema: _drop, ...rest } = z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
    return rest;
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://leadmaker.local/evals/cases.schema.json',
    title: 'LeadMaker AI evaluation cases',
    description: 'One JSON object per line in evals/<suite>/cases.jsonl. Generated from evals/lib/cases.ts '
      + '(node evals/lib/export-schema.ts); do not edit by hand.',
    $defs: {
      nl_filter: one(nlFilterCaseSchema),
      lead_qa: one(leadQaCaseSchema),
      insights: one(insightsCaseSchema),
    },
  };
}

export const CASES_SCHEMA_PATH = join(EVALS_DIR, 'schema', 'cases.schema.json');

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
