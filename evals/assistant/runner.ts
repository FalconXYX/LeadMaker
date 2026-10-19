// Runs nl_filter and lead_qa cases through the real assistant engine (services/assistant/src/engine.ts) with a
// fixture QueryClient and a pinned clock, or end to end over HTTP through the gateway. Each case yields the
// events the drawer would receive, contract checks (wire format, permissions, citations, caps) and the DSL result.
import {
  ASSISTANT_ERROR_CODES, CITATION_FIELDS, assistantChatRequestSchema, leadFilterSchema, type AssistantChatRequest,
  type AssistantEvent, type LeadAiContext, type Viewer,
} from '@leadmaker/shared';
import {
  createProvider, runAssistant, type EngineResult, type ProviderBudget,
} from '../../services/assistant/src/engine.ts';
import { LlmQuotaExceeded, type LlmProvider } from '../../services/assistant/src/llm/types.ts';
import { evaluate, type CaseOutput, type Role } from '../lib/assert.ts';
import type { AssistantSuite, LeadQaCase, NlFilterCase } from '../lib/cases.ts';
import type { CaseRecord, RunMode } from '../lib/report.ts';
import { FixtureQueryClient, USERS, qaFixture, type QueryCall } from './fixture-query.ts';
import type { AnyCase } from './plan.ts';

/** The eval clock: Monday 2026-10-19, 3 PM ET. */
export const PINNED_NOW = new Date('2026-10-19T15:00:00-04:00');
export const MAX_ANSWER_CHARS = 2000;
/** Server-written sentences (match counts, the round-limit apology) may follow a capped answer. */
const TEXT_SLACK = 120;
const CITATION_VALUES = new Set<string>(Object.values(CITATION_FIELDS));
const SECRET = /AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}/;

export function viewerFor(role: Role): Viewer {
  return role === 'manager' ? { id: USERS.manager.id, role: 'manager' } : { id: USERS.rep1.id, role: 'rep' };
}

/** The fake provider in rules/script mode, from an explicit env (never process.env: a key there must not matter). */
export function offlineProvider(now: Date = PINNED_NOW): LlmProvider {
  const p = createProvider(
    { LEADMAKER_ASSISTANT_LLM_PROVIDER: 'fake', LEADMAKER_ALLOW_FAKE_LLM: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv,
    { now: () => now },
  );
  if (!p) throw new Error('the fake provider is unavailable');
  return p;
}

/** Spaces live cases to the provider's per-minute rate (the assistant service does this with its Redis bucket; in
 *  process the evals do it between cases, so the wait never counts toward a case's latency). Shared by all suites. */
export class Pacer {
  readonly intervalMs: number;
  #nextAt = 0;

  constructor(rpm = 0) {
    this.intervalMs = rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
  }

  /** Waits until the calls of the previous case have had their share of the minute. */
  async beforeCase(): Promise<void> {
    const wait = this.#nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  afterCase(llmCalls: number): void {
    this.#nextAt = Date.now() + Math.max(0, llmCalls) * this.intervalMs;
  }
}

/** A per-suite cap on real provider calls: every attempt counts, retries included. */
export class CountingBudget implements ProviderBudget {
  used = 0;
  exhausted = false;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.used >= this.max) {
      this.exhausted = true;
      throw new LlmQuotaExceeded(`eval call budget of ${this.max} used`, { provider: 'budget' });
    }
    this.used++;
  }

  async reportQuotaExhausted(): Promise<void> {
    this.exhausted = true;
  }
}

// ------------------------------------------------------------------ request building

function isNl(c: AnyCase): c is NlFilterCase {
  return 'utterance' in c;
}

export function caseInput(c: AnyCase): string {
  return isNl(c) ? c.utterance : c.question;
}

/** The chat request the drawer would send for this case. fake_script cases send "/fake {script}" (offline only). */
export function buildRequest(c: AnyCase, leadId?: string): AssistantChatRequest {
  const content = c.fake_script ? `/fake ${JSON.stringify(c.fake_script)}` : caseInput(c);
  const messages = [...(c.history ?? []), { role: 'user' as const, content }];
  const context: AssistantChatRequest['context'] = isNl(c)
    ? { page: c.page, ...(c.page === 'leads' && c.currentFilter ? { filter: c.currentFilter } : {}) }
    : { page: 'profile', leadId };
  const parsed = assistantChatRequestSchema.safeParse({ messages, context });
  if (!parsed.success) throw new Error(`${c.id}: the case builds an invalid chat request: ${parsed.error.message}`);
  return parsed.data;
}

// ------------------------------------------------------------------ outputs and contracts

export interface CaseRun {
  events: AssistantEvent[];
  result: EngineResult | null;
  queryCalls: QueryCall[];
  leadContext: LeadAiContext | null;
  /** The route's pre-stream answer when it never opened the stream (404 lead_not_found, ...). */
  preStream?: { status: number; body: unknown };
  ms: number;
  firstTokenMs: number | null;
}

function scopeFilter(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = { ...(raw as Record<string, unknown>) };
  if (typeof f.repId === 'string') {
    f.scope = { repId: f.repId };
    delete f.repId;
  }
  return f;
}

export function outputOf(run: CaseRun): CaseOutput {
  const apply = run.events.find((e) => e.type === 'tool' && e.name === 'apply_filter');
  const open = run.events.find((e) => e.type === 'tool' && e.name === 'open_lead');
  const found = run.result?.toolCalls.find((t) => t.name === 'findLeads' && t.ok);
  const calls = run.result?.toolCalls.find((t) => t.name === 'todaysCalls' && t.ok);
  const terminal = run.events.find((e) => e.type === 'done' || e.type === 'error');
  let filter: Record<string, unknown> | null = null;
  if (apply && apply.type === 'tool' && apply.name === 'apply_filter') {
    filter = { ...(apply.filter as Record<string, unknown>), ...(apply.sort ? { sort: apply.sort } : {}) };
  } else if (found) {
    filter = scopeFilter((found.args as { filter?: unknown } | null)?.filter ?? found.args);
  }
  return {
    tool: apply ? 'applyListFilters' : open ? 'openLead' : found ? 'findLeads' : calls ? 'todaysCalls' : 'none',
    filter,
    matchCount: apply && apply.type === 'tool' && apply.name === 'apply_filter' ? apply.matchCount ?? null : null,
    text: run.events.filter((e) => e.type === 'token').map((e) => (e.type === 'token' ? e.text : '')).join(''),
    explanation: apply && apply.type === 'tool' && apply.name === 'apply_filter' ? apply.explanation : null,
    citations: run.events.filter((e) => e.type === 'citation').map((e) => (e.type === 'citation' ? e.field : '')),
    outcome: terminal?.type === 'done' ? 'done' : terminal?.type === 'error' ? 'error' : 'none',
    errorCode: terminal?.type === 'error' ? String(terminal.code ?? '') : null,
  };
}

/** Invariants every run must satisfy, whatever the model said ([] = all hold). */
export function checkContracts(run: CaseRun, viewer: Viewer, opts: { inProcess: boolean }): string[] {
  const out: string[] = [];
  const ev = run.events;
  if (run.preStream) return out; // the route answered before streaming (checked by the case's expectation)
  const terminals = ev.filter((e) => e.type === 'done' || e.type === 'error');
  if (terminals.length !== 1) out.push(`expected exactly one terminal event, got ${terminals.length}`);
  else if (ev.at(-1) !== terminals[0]) out.push('events were emitted after the terminal event');
  for (const e of ev) {
    if (!['token', 'status', 'tool', 'citation', 'done', 'error'].includes(e.type)) out.push(`unknown event type ${e.type}`);
    if (SECRET.test(JSON.stringify(e))) out.push(`a key-shaped string in a ${e.type} event`);
  }
  const tools = ev.filter((e) => e.type === 'tool');
  if (tools.length > 1) out.push(`more than one tool event (${tools.length})`);
  for (const e of tools) {
    if (e.type !== 'tool') continue;
    if (e.name === 'apply_filter') {
      const f = e.filter as Record<string, unknown>;
      const parsed = leadFilterSchema.safeParse(f);
      if (!parsed.success) out.push(`apply_filter.filter fails leadFilterSchema: ${parsed.error.issues[0]?.message}`);
      if (e.sort && !leadFilterSchema.safeParse({ ...f, sort: e.sort }).success) out.push('apply_filter.sort is invalid for the filter');
      if ('cursor' in f || 'limit' in f) out.push('apply_filter carries cursor/limit');
      if (typeof e.explanation !== 'string' || !e.explanation.trim()) out.push('apply_filter has no explanation');
      else if (e.explanation.length > 120) out.push(`apply_filter.explanation is ${e.explanation.length} chars (max 120)`);
      if (opts.inProcess && typeof e.matchCount !== 'number') out.push('apply_filter.matchCount is not a number');
      if (e.matchCount !== undefined && typeof e.matchCountCapped !== 'boolean') out.push('matchCountCapped missing');
      const scope = f.scope as unknown;
      if (viewer.role === 'rep' && scope && typeof scope === 'object' && (scope as { repId?: string }).repId !== viewer.id) {
        out.push("a rep's apply_filter names another rep's scope");
      }
    } else if (e.name === 'open_lead') {
      if (typeof e.leadId !== 'string' || !e.leadId) out.push('open_lead without a leadId');
      if (opts.inProcess) {
        const returned = new Set(run.queryCalls.flatMap((q) => (q.op === 'search' ? q.returned ?? [] : [])));
        if (run.leadContext) returned.add(run.leadContext.id);
        if (!returned.has(e.leadId)) out.push('open_lead names a lead no visibility-checked read returned');
      }
    } else {
      out.push(`unknown tool event ${(e as { name: string }).name}`);
    }
  }
  const cites = ev.filter((e) => e.type === 'citation');
  const seen = new Set<string>();
  for (const e of cites) {
    if (e.type !== 'citation') continue;
    if (!run.leadContext) out.push('a citation without an active lead');
    else if (e.leadId !== run.leadContext.id) out.push(`a citation for another lead (${e.leadId})`);
    if (!CITATION_VALUES.has(e.field)) out.push(`citation field ${e.field} is not allowlisted`);
    if (seen.has(e.field)) out.push(`duplicate citation ${e.field}`);
    seen.add(e.field);
  }
  const text = ev.filter((e) => e.type === 'token').map((e) => (e.type === 'token' ? e.text : '')).join('');
  if (/\[src:/i.test(text)) out.push('a [src:] tag reached the client');
  if (text.length > MAX_ANSWER_CHARS + TEXT_SLACK) out.push(`answer is ${text.length} chars (cap ${MAX_ANSWER_CHARS})`);
  for (const e of ev) {
    if (e.type !== 'error') continue;
    if (typeof e.message !== 'string' || !e.message) out.push('error event without a message');
    if (e.code && !(ASSISTANT_ERROR_CODES as readonly string[]).includes(String(e.code))) out.push(`unknown error code ${e.code}`);
  }
  if (opts.inProcess) {
    for (const q of run.queryCalls) {
      if (q.viewer.id !== viewer.id || q.viewer.role !== viewer.role) out.push(`a query ${q.op} call carried another identity`);
      if (q.op === 'search' && q.error === 'invalid filter') out.push('query search was called with an invalid filter');
      if (q.op === 'search' && viewer.role === 'rep') {
        const s = q.filter.scope as unknown;
        if (s && typeof s === 'object' && (s as { repId?: string }).repId !== viewer.id) out.push("query search was asked for another rep's leads");
      }
      if (q.op === 'aiContext' && q.leadId !== run.leadContext?.id) out.push(`lead context fetched for another lead (${q.leadId})`);
    }
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ running one case

export interface RunEnv {
  mode: RunMode;
  provider: LlmProvider | null;
  now: Date;
  budget?: ProviderBudget;
  gatewayUrl?: string;
  /** Cached gateway tokens per role. */
  tokens?: Map<Role, string>;
}

function leadIdFor(c: AnyCase): string | undefined {
  return isNl(c) ? undefined : qaFixture((c as LeadQaCase).fixture).id;
}

export async function runInProcess(c: AnyCase, env: RunEnv): Promise<CaseRun> {
  const viewer = viewerFor(c.role);
  const query = new FixtureQueryClient();
  const leadId = leadIdFor(c);
  const request = buildRequest(c, leadId);
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
  // The route prefetches the active lead (visibility-checked) before opening the stream.
  const leadContext = leadId ? await query.aiContext(viewer, leadId) : null;
  if (leadId && !leadContext) {
    return { events: [], result: null, queryCalls: query.calls, leadContext: null, preStream: { status: 404, body: { error: 'lead_not_found' } }, ms: 0, firstTokenMs: null };
  }
  const events: AssistantEvent[] = [];
  const result = await runAssistant(
    { request, viewer, leadContext },
    { provider: env.provider, query, now: () => env.now, budget: env.budget },
    (e) => {
      if (firstTokenMs === null && e.type === 'token') firstTokenMs = performance.now() - t0;
      events.push(structuredClone(e));
    },
    AbortSignal.timeout(90_000),
  );
  return { events, result, queryCalls: query.calls, leadContext, ms: performance.now() - t0, firstTokenMs };
}

/** Parse an SSE body into AssistantEvents (comments and unknown fields ignored, like the drawer). */
export function parseSse(body: string): AssistantEvent[] {
  const out: AssistantEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let type = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!type) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = data.length ? JSON.parse(data.join('\n')) : {};
    } catch {
      payload = { unparsable: data.join('\n') };
    }
    out.push({ type, ...payload } as AssistantEvent);
  }
  return out;
}

async function gatewayToken(env: RunEnv, role: Role): Promise<string> {
  const cached = env.tokens?.get(role);
  if (cached) return cached;
  const email = role === 'manager' ? USERS.manager.email : USERS.rep1.email;
  const r = await fetch(`${env.gatewayUrl}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(`dev-login ${email}: HTTP ${r.status} (is DEMO_MODE on?)`);
  const token = ((await r.json()) as { token: string }).token;
  env.tokens?.set(role, token);
  return token;
}

export async function runViaGateway(c: AnyCase, env: RunEnv): Promise<CaseRun> {
  const token = await gatewayToken(env, c.role);
  const request = buildRequest(c, leadIdFor(c));
  const t0 = performance.now();
  const r = await fetch(`${env.gatewayUrl}/api/assistant/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120_000),
  });
  if (!(r.headers.get('content-type') ?? '').includes('text/event-stream')) {
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { events: [], result: null, queryCalls: [], leadContext: null, preStream: { status: r.status, body }, ms: performance.now() - t0, firstTokenMs: null };
  }
  let text = '';
  let firstTokenMs: number | null = null;
  const decoder = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (firstTokenMs === null && text.includes('event: token')) firstTokenMs = performance.now() - t0;
  }
  return { events: parseSse(text), result: null, queryCalls: [], leadContext: null, ms: performance.now() - t0, firstTokenMs };
}

// ------------------------------------------------------------------ records

function asserted(c: AnyCase, mode: RunMode): boolean {
  return mode !== 'offline' || !!c.offline || !!c.fake_script;
}

export function toRecord(suite: AssistantSuite, c: AnyCase, run: CaseRun, env: RunEnv): CaseRecord {
  const viewer = viewerFor(c.role);
  const contract = checkContracts(run, viewer, { inProcess: env.mode !== 'gateway' });
  const out = outputOf(run);
  if (run.preStream) {
    contract.push(`the route answered ${run.preStream.status} before streaming: ${JSON.stringify(run.preStream.body)}`);
  }
  const failures = evaluate(c.expect, out, { role: c.role, now: env.mode === 'gateway' ? new Date() : env.now });
  // Canaries are checked on every case that names one, on top of the expectation.
  const canary = (c as LeadQaCase).canary;
  if (canary && out.text.toLowerCase().includes(canary.toLowerCase())) failures.push(`text contains the canary ${canary}`);
  const isAsserted = asserted(c, env.mode);
  const done = run.events.find((e) => e.type === 'done');
  const usage = done && done.type === 'done' ? done.usage : undefined;
  return {
    id: c.id,
    suite,
    tags: c.tags,
    input: caseInput(c),
    asserted: isAsserted,
    pass: contract.length === 0 && (!isAsserted || failures.length === 0),
    dslPass: failures.length === 0,
    contractFailures: contract,
    failures,
    actual: {
      tool: out.tool,
      ...(out.filter ? { filter: out.filter } : {}),
      ...(out.explanation ? { explanation: out.explanation } : {}),
      text: out.text,
      citations: out.citations,
      outcome: out.outcome,
      ...(out.errorCode ? { errorCode: out.errorCode } : {}),
      toolCalls: run.result?.toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'error'}`) ?? [],
      ...(run.preStream ? { preStream: run.preStream } : {}),
    },
    latencyMs: Math.round(run.ms),
    firstTokenMs: run.firstTokenMs === null ? null : Math.round(run.firstTokenMs),
    llmCalls: run.result?.llmCalls ?? usage?.llmCalls ?? 0,
    inputTokens: run.result?.usage.inputTokens ?? usage?.inputTokens ?? 0,
    outputTokens: run.result?.usage.outputTokens ?? usage?.outputTokens ?? 0,
  };
}

export function skippedRecord(suite: AssistantSuite, c: AnyCase | { id: string; tags?: string[] }, why: string): CaseRecord {
  return {
    id: c.id, suite, tags: c.tags ?? [], input: 'utterance' in c ? c.utterance : 'question' in c ? c.question : '',
    asserted: false, pass: false, dslPass: null, contractFailures: [], failures: [], skipped: why, actual: {},
    latencyMs: null, llmCalls: 0, inputTokens: 0, outputTokens: 0,
  };
}

export async function runCase(suite: AssistantSuite, c: AnyCase, env: RunEnv): Promise<CaseRecord> {
  const run = env.mode === 'gateway' ? await runViaGateway(c, env) : await runInProcess(c, env);
  return toRecord(suite, c, run, env);
}

