// The assistant's tools (§7.6). Every read goes through the query service with the caller's identity, so the
// visibility rule applies; arguments are untrusted model output and are validated here before anything runs.
//   applyListFilters  emits the shared LeadFilter to the list (the drawer's `tool apply_filter` event)
//   findLeads         the same filter, read-only, top 5 rows: answers "how many..." questions
//   todaysCalls       the dashboard's call order, read-only: answers "which should I call first?" (follow-ups first)
//   openLead          opens one visible lead (an id seen in this request, or a unique name match)
// A rep's filter without a scope defaults to their own leads; when that matches nothing but leads they can see in the
// pool do, the filter widens to "Mine + unallocated" and says so (a rep asking for "roofers in Brooklyn" means the
// ones they can work, and the vocabulary's counts include the pool).
// There is no tool that reads another lead's details and no write tool.
import {
  isUuid, leadFilterSchema, leadFilterToolJsonSchema, leadFilterToolSchema, type ApplyFilterTool, type FilterVocabulary,
  type LeadAiContext, type LeadFilter, type LeadSort, type LeadSummary, type Viewer,
} from '@leadmaker/shared';
import { fenceLine, tierLabel } from './fence.ts';
import { toJsonSchemaForProvider } from './llm/schema.ts';
import type { ToolCall, ToolSpec } from './llm/types.ts';
import type { QueryClient } from './query-client.ts';
import { SALES_TZ, dateIn } from './time.ts';

export const TOOL = { apply: 'applyListFilters', find: 'findLeads', calls: 'todaysCalls', open: 'openLead' } as const;
export const FIND_LIMIT = 5;
export const EXPLANATION_MAX = 120;

let specs: ToolSpec[] | null = null;

/** Tool specs built from leadFilterToolJsonSchema() (never hand-copied); providers convert the schemas. */
export function toolSpecs(): ToolSpec[] {
  if (specs) return specs;
  const filter = toJsonSchemaForProvider(leadFilterToolJsonSchema(), 'fake');
  specs = [
    {
      name: TOOL.apply,
      description: 'Show the user a lead list: send the COMPLETE filter (it replaces the list\'s current filter) and a '
        + 'one-line explanation of at most 100 characters naming anything that could not be applied.',
      parameters: {
        type: 'object', required: ['filter', 'explanation'],
        properties: {
          filter,
          explanation: { type: 'string', maxLength: EXPLANATION_MAX, description: 'One plain line for the user, at most 100 characters.' },
        },
      },
    },
    {
      name: TOOL.find,
      description: "Look up the user's leads without changing the screen (same filter, at most 5 rows in the filter's "
        + 'sort order), to answer questions such as "how many..." or "which should I call first...".',
      parameters: {
        type: 'object', required: ['filter'],
        properties: { filter, limit: { type: 'integer', minimum: 1, maximum: FIND_LIMIT } },
      },
    },
    {
      name: TOOL.calls,
      description: "The user's call list for today, read-only, in the dashboard's order: overdue follow-ups, follow-ups "
        + 'due today, interested or quoting leads not contacted in 7 days, then the highest-priority new leads. Use it '
        + 'for "who should I call first / today / next".',
      parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: FIND_LIMIT } } },
    },
    {
      name: TOOL.open,
      description: "Open one lead's profile, by an id from a tool result (or the active lead) or by its business name.",
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'A lead id from a tool result or the active lead.' },
          name: { type: 'string', maxLength: 200, description: 'The business name, when no id is known.' },
        },
      },
    },
  ];
  return specs;
}

// ---- filter normalization ----------------------------------------------------------------------------------

export type NormalizedFilter =
  /** scopeDefaulted: the model named no scope (nor repId), so the role's default was used. */
  | { ok: true; filter: LeadFilter; sort?: LeadSort; notes: string[]; scopeDefaulted?: boolean }
  | { ok: false; errors: string[] };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.slice(0, 8).map((i) => `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}`);
}

/**
 * Model filter -> a LeadFilter this viewer may use (§7.6), in order: coerce, parse strictly with
 * leadFilterToolSchema, map repId, default the scope, check counties and custom tags against the viewer's
 * vocabulary, drop a distance sort without near, then re-check with leadFilterSchema and move sort out.
 */
export function normalizeToolFilter(args: unknown, viewer: Viewer, vocab: FilterVocabulary | null): NormalizedFilter {
  if (!isObj(args)) return { ok: false, errors: ['filter must be an object'] };
  const notes: string[] = [];
  // 1. Coerce what models commonly get almost right: nulls/empties for unused keys, numeric strings for gte/lte,
  //    updatedInLastPoll: false (the list has no form for it).
  const raw: Json = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    raw[k] = v;
  }
  if (raw.updatedInLastPoll === false) delete raw.updatedInLastPoll;
  if (Array.isArray(raw.customFields)) {
    // Gemini declares the value as a string (its schema subset has no scalar unions): restore numbers for
    // gte/lte, and for eq on keys the vocabulary knows are numbers or booleans.
    const types = new Map((vocab?.customFieldKeys ?? []).map((k) => [k.key, k.valueType]));
    raw.customFields = raw.customFields.map((c) => {
      if (!isObj(c) || typeof c.value !== 'string') return c;
      const type = types.get(String(c.key));
      if ((c.op === 'gte' || c.op === 'lte' || (c.op === 'eq' && type === 'number')) && NUMERIC.test(c.value)) {
        return { ...c, value: Number(c.value) };
      }
      if (c.op === 'eq' && type === 'boolean' && /^(true|false)$/i.test(c.value.trim())) {
        return { ...c, value: c.value.trim().toLowerCase() === 'true' };
      }
      return c;
    });
  }
  // 2. Strict parse.
  const parsed = leadFilterToolSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  const { repId, scope: toolScope, ...rest } = parsed.data;
  const f: LeadFilter = { ...rest };
  // 3. repId: a rep may only name themself; a manager one of the reps in the vocabulary.
  if (repId !== undefined) {
    if (viewer.role !== 'manager') {
      if (repId.toLowerCase() !== viewer.id.toLowerCase()) {
        return { ok: false, errors: ['reps can only filter their own leads or the pool'] };
      }
      f.scope = 'mine';
    } else {
      if (vocab && !vocab.reps.some((r) => r.id.toLowerCase() === repId.toLowerCase())) {
        return { ok: false, errors: [`unknown rep id ${repId}; use an id from the vocabulary's reps`] };
      }
      f.scope = { repId: repId.toLowerCase() };
    }
  } else if (toolScope) {
    f.scope = toolScope;
  }
  // 4. Default scope: what the list then shows (reps: My leads, managers: All).
  const scopeDefaulted = !f.scope;
  if (!f.scope) f.scope = viewer.role === 'manager' ? 'all' : 'mine';
  // 5. Counties must be ones the viewer has leads in.
  if (f.counties && vocab) {
    const known = new Set(vocab.counties.map((c) => c.fips));
    const unknown = f.counties.filter((c) => !known.has(c));
    if (unknown.length) {
      const valid = vocab.counties.slice(0, 12).map((c) => `${c.name ?? c.fips} = ${c.fips}`).join(', ');
      return { ok: false, errors: [`unknown county FIPS ${unknown.join(', ')}; valid: ${valid || 'none'}`] };
    }
  }
  // 6. Custom tags: case-insensitive, by name or id, mapped to the vocabulary's names.
  if (f.customTags && vocab) {
    const mapped: string[] = [];
    const unknown: string[] = [];
    for (const t of f.customTags) {
      const hit = vocab.customTags.find((v) => v.name.toLowerCase() === t.trim().toLowerCase() || v.id === t);
      if (hit) mapped.push(hit.name);
      else unknown.push(t);
    }
    if (unknown.length) {
      const valid = vocab.customTags.slice(0, 15).map((v) => v.name).join(', ');
      return { ok: false, errors: [`unknown custom tag ${unknown.map((u) => JSON.stringify(u)).join(', ')}; valid: ${valid || 'none'}`] };
    }
    f.customTags = [...new Set(mapped)];
  }
  // 7. Distance sort needs near.
  if (f.sort?.by === 'distance' && !f.near) {
    delete f.sort;
    notes.push('sorting by distance needs a ZIP, so the default order is used');
  }
  // 8. Final check with the list's own schema; sort travels separately.
  const final = leadFilterSchema.safeParse(f);
  if (!final.success) return { ok: false, errors: issues(final.error) };
  const { sort, ...filter } = final.data;
  const extra = scopeDefaulted ? { scopeDefaulted } : {};
  return sort ? { ok: true, filter, sort, notes, ...extra } : { ok: true, filter, notes, ...extra };
}

export const WIDENED_NOTE = 'none of your own leads match, so unallocated ones are included';

/** A rep's defaulted "mine" that matches nothing while their pool view does: that view instead (else null). */
async function widened(n: Extract<NormalizedFilter, { ok: true }>, ctx: ToolContext): Promise<LeadFilter | null> {
  if (!n.scopeDefaulted || ctx.viewer.role === 'manager' || n.filter.scope !== 'mine') return null;
  const all: LeadFilter = { ...n.filter, scope: 'all' };
  const r = await ctx.query.search(ctx.viewer, { ...searchFilter(all, ctx.viewer), limit: 1 }, ctx.signal);
  return r.total > 0 ? all : null;
}

/** The tool's `filter` argument, tolerating models that flatten LeadFilter keys into the top level. */
export function filterArg(args: Json, own: readonly string[]): unknown {
  const stray = Object.fromEntries(Object.entries(args).filter(([k]) => !own.includes(k) && k !== 'filter'));
  if (args.filter === undefined) return Object.keys(stray).length ? stray : {};
  if (!isObj(args.filter)) return args.filter;
  return { ...stray, ...args.filter };
}

// ---- handlers -----------------------------------------------------------------------------------------------

export interface ToolContext {
  viewer: Viewer;
  vocab: FilterVocabulary | null;
  query: QueryClient;
  signal: AbortSignal;
  leadContext: LeadAiContext | null;
  /** Lead ids seen in this request (tool results, the active lead) -> names: openLead accepts only these ids. */
  knownLeads: Map<string, string>;
  /** The request's clock (todaysCalls' "today"); defaults to the wall clock. */
  now?: Date;
}

export type ToolOutcome =
  /** Valid applyListFilters: emit the event (+ sentence) and finish without another LLM call. */
  | { kind: 'apply'; event: ApplyFilterTool; sentence: string; filter: LeadFilter }
  /** Valid openLead: emit open_lead and finish. */
  | { kind: 'open'; leadId: string; name: string }
  /** Goes back to the model as a tool result (findLeads rows, or an error to correct). */
  | { kind: 'result'; content: string; isError: boolean };

const errorResult = (errors: string[]): ToolOutcome => ({ kind: 'result', content: JSON.stringify({ ok: false, errors }), isError: true });

/**
 * The filter as the search API takes it from this viewer. A rep's "all" (the list's "Mine + unallocated" view) is
 * their default visibility, which the API expresses as no scope: query refuses scope "all" from reps. Same mapping
 * as the web list's apiScope. The emitted apply_filter keeps "all", since that is the list URL's form.
 */
export function searchFilter(filter: LeadFilter, viewer: Viewer): LeadFilter {
  if (viewer.role === 'manager' || filter.scope !== 'all') return filter;
  const { scope: _scope, ...rest } = filter;
  return rest;
}

export function matchSentence(total: number | undefined, capped: boolean | undefined): string {
  if (total === undefined) return 'Applied the filters.';
  if (capped) return `Over ${total.toLocaleString('en-US')} leads match.`;
  if (total === 0) return 'No leads match. Try removing a filter.';
  if (total === 1) return '1 lead matches.';
  return `${total.toLocaleString('en-US')} leads match.`;
}

function explanationOf(value: unknown, notes: string[]): string {
  const base = typeof value === 'string' ? fenceLine(value, EXPLANATION_MAX) : '';
  const parts = [base || 'Filters from your request', ...notes];
  return fenceLine(parts.join('; '), EXPLANATION_MAX);
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const args = isObj(call.arguments) ? call.arguments : {};
  switch (call.name) {
    case TOOL.apply:
      return applyListFilters(args, ctx);
    case TOOL.find:
      return findLeads(args, ctx);
    case TOOL.calls:
      return todaysCalls(args, ctx);
    case TOOL.open:
      return openLead(args, ctx);
    default:
      return errorResult([`unknown tool ${JSON.stringify(call.name).slice(0, 60)}; use applyListFilters, findLeads, todaysCalls or openLead`]);
  }
}

async function applyListFilters(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const n = normalizeToolFilter(filterArg(args, ['explanation']), ctx.viewer, ctx.vocab);
  if (!n.ok) return errorResult(n.errors);
  let total: number | undefined;
  let capped: boolean | undefined;
  try {
    const r = await ctx.query.search(ctx.viewer, { ...searchFilter(n.filter, ctx.viewer), ...(n.sort ? { sort: n.sort } : {}), limit: 1 }, ctx.signal);
    total = r.total;
    capped = r.totalCapped;
    if (total === 0) {
      const wider = await widened(n, ctx);
      if (wider) {
        const w = await ctx.query.search(ctx.viewer, { ...searchFilter(wider, ctx.viewer), ...(n.sort ? { sort: n.sort } : {}), limit: 1 }, ctx.signal);
        n.filter = wider;
        n.notes.push(WIDENED_NOTE);
        total = w.total;
        capped = w.totalCapped;
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // The preview count is optional: the filter is still applied (the list runs its own search).
  }
  const event: ApplyFilterTool = {
    name: 'apply_filter',
    filter: n.filter,
    ...(n.sort ? { sort: n.sort } : {}),
    explanation: explanationOf(args.explanation, n.notes),
    ...(total !== undefined ? { matchCount: total, matchCountCapped: !!capped } : {}),
  };
  return { kind: 'apply', event, sentence: matchSentence(total, capped), filter: n.filter };
}

function place(l: LeadSummary): string | null {
  return [l.city, l.state].filter(Boolean).join(', ') || null;
}

function why(l: LeadSummary): string[] {
  const out: string[] = [];
  const tier = tierLabel(l.tier);
  if (tier) out.push(tier.replace(/^GAF /, ''));
  if (l.rating !== null && l.rating !== undefined) out.push(`${l.rating}★ (${l.reviewCount})`);
  for (const d of l.priorityDrivers ?? []) if (out.length < 4) out.push(d);
  return out.map((s) => fenceLine(s, 80));
}

async function findLeads(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const n = normalizeToolFilter(filterArg(args, ['limit']), ctx.viewer, ctx.vocab);
  if (!n.ok) return errorResult(n.errors);
  const limit = Math.max(1, Math.min(FIND_LIMIT, Number.isInteger(args.limit) ? (args.limit as number) : FIND_LIMIT));
  let result;
  let note: string | undefined;
  try {
    result = await ctx.query.search(ctx.viewer, { ...searchFilter(n.filter, ctx.viewer), ...(n.sort ? { sort: n.sort } : {}), limit }, ctx.signal);
    if (result.total === 0) {
      const wider = await widened(n, ctx);
      if (wider) {
        result = await ctx.query.search(ctx.viewer, { ...searchFilter(wider, ctx.viewer), ...(n.sort ? { sort: n.sort } : {}), limit }, ctx.signal);
        note = WIDENED_NOTE;
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return errorResult(['the lead search is unavailable right now; tell the user to try again shortly']);
  }
  const leads = result.items.slice(0, limit).map((l) => {
    const name = fenceLine(l.businessName, 200);
    ctx.knownLeads.set(l.id, name);
    const badge = l.timing?.[0];
    return {
      id: l.id,
      name,
      city: place(l) ? fenceLine(place(l), 100) : null,
      stage: l.salesStage,
      priority: l.priorityScore === null ? null : Math.round(l.priorityScore),
      why: why(l),
      nextFollowUp: l.nextTask ? l.nextTask.dueAt.slice(0, 10) : null,
      timing: badge ? fenceLine(`${badge.label} (${badge.severity})`, 100) : null,
    };
  });
  return {
    kind: 'result',
    content: JSON.stringify({ ok: true, total: result.total, capped: result.totalCapped, ...(note ? { note } : {}), leads }),
    isError: false,
  };
}

/** YYYY-MM-DD in the sales team's zone, `days` before `now`. */
function salesDay(now: Date, days = 0): string {
  return dateIn(SALES_TZ, new Date(now.getTime() - days * 24 * 3600_000));
}

/**
 * The call list for today in the dashboard's order (apps/web features/dashboard/callList.ts): overdue follow-ups,
 * follow-ups due today, interested or quoting leads not contacted in 7 days, then the highest-priority new leads.
 * Reps: their own leads; managers: everyone's. Each lead once, in its most urgent group.
 */
async function todaysCalls(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = Math.max(1, Math.min(FIND_LIMIT, Number.isInteger(args.limit) ? (args.limit as number) : FIND_LIMIT));
  const now = ctx.now ?? new Date();
  const scope: LeadFilter['scope'] = ctx.viewer.role === 'manager' ? 'all' : 'mine';
  const byDue: LeadSort = { by: 'next_follow_up', dir: 'asc' };
  const groups: { kind: 'overdue' | 'today' | 'quiet' | 'new'; filter: LeadFilter }[] = [
    { kind: 'overdue', filter: { scope, followUp: 'overdue', sort: byDue } },
    { kind: 'today', filter: { scope, followUp: 'today', sort: byDue } },
    { kind: 'quiet', filter: { scope, stages: ['interested', 'quoting'], notContactedSince: salesDay(now, 7) } },
    { kind: 'new', filter: { scope, stages: ['new'] } },
  ];
  let results;
  try {
    results = await Promise.all(groups.map((g) => ctx.query.search(ctx.viewer, { ...searchFilter(g.filter, ctx.viewer), limit: FIND_LIMIT }, ctx.signal)));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return errorResult(['the lead search is unavailable right now; tell the user to try again shortly']);
  }
  const seen = new Set<string>();
  const leads: Json[] = [];
  groups.forEach((g, i) => {
    for (const l of results[i]!.items) {
      if (seen.has(l.id) || leads.length >= limit) continue;
      seen.add(l.id);
      const name = fenceLine(l.businessName, 200);
      ctx.knownLeads.set(l.id, name);
      const due = l.nextTask?.dueAt.slice(0, 10) ?? null;
      const task = l.nextTask?.title ? `: ${fenceLine(l.nextTask.title, 80)}` : '';
      const reason = g.kind === 'overdue' ? `follow-up overdue since ${due}${task}`
        : g.kind === 'today' ? `follow-up due today${task}`
          : g.kind === 'quiet' ? `${l.salesStage}, ${l.lastContactedAt ? `last contacted ${l.lastContactedAt.slice(0, 10)}` : 'never contacted'}`
            : `new lead, priority ${l.priorityScore === null ? 'unscored' : Math.round(l.priorityScore)}`;
      leads.push({
        id: l.id, name, city: place(l) ? fenceLine(place(l), 100) : null, stage: l.salesStage, reason,
        why: why(l), timing: l.timing?.[0] ? fenceLine(`${l.timing[0].label} (${l.timing[0].severity})`, 100) : null,
      });
    }
  });
  return {
    kind: 'result',
    content: JSON.stringify({ ok: true, overdue: results[0]!.total, dueToday: results[1]!.total, leads }),
    isError: false,
  };
}

async function openLead(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
  const known = leadId ? [...ctx.knownLeads].find(([id]) => id.toLowerCase() === leadId.toLowerCase()) : undefined;
  if (known) return { kind: 'open', leadId: known[0], name: known[1] };
  const name = (typeof args.name === 'string' && args.name.trim()) || (leadId && !isUuid(leadId) ? leadId : '');
  if (!name) {
    return errorResult(leadId
      ? ['that lead id did not appear in a tool result; pass the business name instead']
      : ['pass leadId (from a tool result) or name']);
  }
  let items: LeadSummary[];
  try {
    items = (await ctx.query.search(ctx.viewer, { text: name.slice(0, 200), limit: 5 }, ctx.signal)).items;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return errorResult(['the lead search is unavailable right now; tell the user to try again shortly']);
  }
  if (!items.length) return { kind: 'result', content: JSON.stringify({ ok: false, error: 'not_found' }), isError: true };
  const exact = items.filter((l) => l.businessName.trim().toLowerCase() === name.trim().toLowerCase());
  const pick = items.length === 1 ? items[0] : exact.length === 1 ? exact[0] : undefined;
  if (pick) return { kind: 'open', leadId: pick.id, name: fenceLine(pick.businessName, 200) };
  const candidates = items.map((l) => {
    const n = fenceLine(l.businessName, 200);
    ctx.knownLeads.set(l.id, n);
    return { id: l.id, name: n, city: place(l) ? fenceLine(place(l), 100) : null };
  });
  return { kind: 'result', content: JSON.stringify({ ok: false, candidates }), isError: true };
}
