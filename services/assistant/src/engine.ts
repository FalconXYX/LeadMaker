// runAssistant: one chat request, start to terminal event (§7.3). Stateless; every read goes through the
// QueryClient with the caller's identity. Emits AssistantEvents in wire order and always ends with exactly one
// `done` or `error`. Imported by the HTTP route (app.ts) and by the evaluation runner (evals/assistant).
//
//   provider state -> vocabulary -> history + wrapped turn -> rounds (<= maxToolRounds):
//     `status` (what it is doing), stream text (citations extracted, answer capped), collect tool calls (<= 2/round)
//     applyListFilters ok -> `tool apply_filter` + the server's sentence, done (no second LLM call)
//     openLead ok         -> `tool open_lead` + "Opening {name}.", done
//     findLeads / todaysCalls / errors -> tool results go back to the model for the next round
// Token usage is charged per provider call as the provider reports it (the latest cumulative count), and estimated
// from the request size when a call is cut off before any report, so a client that disconnects still pays.
import {
  ASSISTANT_PROMPT_VERSION, type AssistantChatRequest, type AssistantErrorCode, type AssistantEvent, type FilterVocabulary,
  type LeadAiContext, type LeadFilter, type Viewer,
} from '@leadmaker/shared';
import { CitationExtractor } from './citations.ts';
import type { CircuitBreaker } from './circuit.ts';
import { errorPayload } from './errors.ts';
import { fenceLine } from './fence.ts';
import {
  LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, LlmTimeoutError,
  type ChatMessage, type ChatRequest, type LlmProvider, type ToolCall,
} from './llm/types.ts';
import { SYSTEM_PROMPT, buildHistory, buildTurn, initialMessages } from './prompt.ts';
import type { QueryClient } from './query-client.ts';
import { runTool, toolSpecs, type ToolContext } from './tools.ts';

export type { QueryClient } from './query-client.ts';
export { createProvider } from './llm/index.ts';
export { parseFilterRules } from './llm/fake.ts';

/** The user's own daily share of provider calls is used up (limits.ts UserLimits.callBudget). */
export class UserLimitReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserLimitReached';
  }
}

export interface ProviderBudget {
  /** Waits briefly for a provider slot; throws LlmRateLimited (no slot soon) or LlmQuotaExceeded (day spent). */
  acquire(signal?: AbortSignal): Promise<void>;
  reportQuotaExhausted(resetsAt: Date | null): Promise<void>;
}

export interface EngineLimits {
  maxToolRounds: number;
  maxOutputTokens: number;
  providerTimeoutMs: number;
  requestTimeoutMs: number;
  maxAnswerChars: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  maxToolRounds: 3, maxOutputTokens: 2048, providerTimeoutMs: 30_000, requestTimeoutMs: 60_000, maxAnswerChars: 2000,
};

export interface EngineLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface EngineDeps {
  provider: LlmProvider | null;
  query: QueryClient;
  /** Evals pin 2026-10-19T15:00:00-04:00. */
  now?: () => Date;
  /** Defaults: DEFAULT_ENGINE_LIMITS (3, 2048, 30000, 60000, 2000). */
  limits?: Partial<EngineLimits>;
  /** Omitted = no global budget (evals). */
  budget?: ProviderBudget;
  /** Omitted = no circuit breaker. */
  circuit?: CircuitBreaker;
  log?: EngineLog;
}

export interface EngineInput { request: AssistantChatRequest; viewer: Viewer; leadContext: LeadAiContext | null }

export interface EngineResult {
  outcome: 'done' | 'error';
  errorCode?: AssistantErrorCode;
  llmCalls: number;
  toolCalls: { name: string; ok: boolean; args: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  ms: number;
  /** The streamed answer, tags stripped. */
  text: string;
  appliedFilter?: LeadFilter;
  openedLeadId?: string;
  citations: { field: string }[];
}

const ROUND_LIMIT_TEXT = "I couldn't finish that. Try a simpler request.";
const MAX_CALLS_PER_ROUND = 2;
const RETRY_AFTER_MAX_MS = 2000;
const RETRY_5XX_DELAY_MS = 500;

class RequestTimeout extends Error {
  constructor() {
    super('request deadline exceeded');
    this.name = 'RequestTimeout';
  }
}

class AnswerCapped extends Error {}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RoundOutput { text: string; calls: ToolCall[]; raw: unknown; capped: boolean }

export async function runAssistant(
  input: EngineInput, deps: EngineDeps, emit: (e: AssistantEvent) => void, signal: AbortSignal,
): Promise<EngineResult> {
  const t0 = performance.now();
  const limits = { ...DEFAULT_ENGINE_LIMITS, ...deps.limits };
  const now = deps.now ? deps.now() : new Date();
  const { request, viewer, leadContext } = input;
  const result: EngineResult = {
    outcome: 'done', llmCalls: 0, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, ms: 0, text: '', citations: [],
  };
  let ended = false;
  const send = (e: AssistantEvent) => {
    if (ended) return;
    if (e.type === 'done' || e.type === 'error') ended = true;
    emit(e);
  };
  const finish = (): EngineResult => {
    result.ms = Math.round(performance.now() - t0);
    send({
      type: 'done',
      usage: { llmCalls: result.llmCalls, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, ms: result.ms },
      promptVersion: ASSISTANT_PROMPT_VERSION,
    });
    return result;
  };
  const fail = (code: AssistantErrorCode, resetsAt?: Date | null): EngineResult => {
    result.outcome = 'error';
    result.errorCode = code;
    result.ms = Math.round(performance.now() - t0);
    send({ type: 'error', ...errorPayload(code, { resetsAt, now }) });
    return result;
  };
  // Progress for the drawer while nothing streams; never repeated, never after text has started.
  let lastStatus = '';
  const status = (text: string) => {
    if (ended || result.text || text === lastStatus) return;
    lastStatus = text;
    send({ type: 'status', text });
  };

  // 2. Provider state: no provider call when it can't succeed.
  const provider = deps.provider;
  if (!provider || !provider.isConfigured().ok) return fail('ai_not_configured');
  if (deps.circuit?.isOpen()) return fail('ai_provider_down');

  // One deadline for the whole request; the caller's signal (client gone, shutdown) aborts it too.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new RequestTimeout()), limits.requestTimeoutMs);
  const onAbort = () => deadline.abort(signal.reason ?? new Error('aborted'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Answer text: [src:] tags out, citations de-duplicated, at most maxAnswerChars streamed.
  let answerChars = 0;
  let capped = false;
  const token = (text: string) => {
    if (!text) return;
    result.text += text;
    send({ type: 'token', text });
  };
  const extractor = new CitationExtractor(leadContext, {
    text: (t) => {
      if (capped) return;
      const room = limits.maxAnswerChars - answerChars;
      if (t.length >= room) {
        capped = true;
        const part = t.slice(0, Math.max(0, room - 1)).trimEnd();
        answerChars += part.length + 1;
        token(`${part}…`);
        return;
      }
      answerChars += t.length;
      token(t);
    },
    citation: (c) => {
      if (capped) return;
      result.citations.push({ field: c.field });
      send({ type: 'citation', leadId: c.leadId, field: c.field, ...(c.leadName ? { leadName: fenceLine(c.leadName, 200) } : {}) });
    },
  });

  try {
    // 3. Vocabulary (cached per user by the client); the assistant still works without it.
    let vocab: FilterVocabulary | null = null;
    try {
      vocab = await deps.query.vocabulary(viewer, deadline.signal);
    } catch (err) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      deps.log?.warn({ err: (err as Error)?.message }, 'filter vocabulary unavailable');
    }

    // 4. Messages.
    const messages: ChatMessage[] = initialMessages(
      buildHistory(request), buildTurn({ request, viewer, vocabulary: vocab, leadContext, now }));
    const knownLeads = new Map<string, string>();
    if (leadContext) knownLeads.set(leadContext.id, fenceLine(leadContext.businessName, 200));
    const ctx: ToolContext = { viewer, vocab, query: deps.query, signal: deadline.signal, leadContext, knownLeads, now };

    // 5. Rounds.
    for (let round = 1; round <= limits.maxToolRounds; round++) {
      const last = round === limits.maxToolRounds;
      status(round > 1 ? 'Writing the answer…' : leadContext ? `Reading ${fenceLine(leadContext.businessName, 60)}…` : 'Thinking…');
      const req: ChatRequest = {
        system: SYSTEM_PROMPT, messages, tools: toolSpecs(), toolChoice: last && round > 1 ? 'none' : 'auto',
        maxOutputTokens: limits.maxOutputTokens,
      };
      if (round > 1 && result.text && !/\s$/.test(result.text)) extractor.push('\n\n');
      const out = await callProvider(provider, req, deps, limits, deadline.signal, result, extractor, () => capped);
      extractor.flush();
      if (out.capped || !out.calls.length) return finish();

      const pending: { call: ToolCall; content: string; isError: boolean }[] = [];
      for (const [i, call] of out.calls.entries()) {
        if (i >= MAX_CALLS_PER_ROUND) {
          result.toolCalls.push({ name: call.name, ok: false, args: call.arguments });
          pending.push({ call, content: JSON.stringify({ ok: false, errors: [`at most ${MAX_CALLS_PER_ROUND} tool calls per turn; this one was not run`] }), isError: true });
          continue;
        }
        status(toolStatus(call.name));
        const outcome = await runTool(call, ctx);
        if (outcome.kind === 'apply') {
          result.toolCalls.push({ name: call.name, ok: true, args: call.arguments });
          result.appliedFilter = outcome.filter;
          send({ type: 'tool', ...outcome.event });
          if (!out.text.trim()) token(outcome.sentence);
          return finish();
        }
        if (outcome.kind === 'open') {
          result.toolCalls.push({ name: call.name, ok: true, args: call.arguments });
          result.openedLeadId = outcome.leadId;
          send({ type: 'tool', name: 'open_lead', leadId: outcome.leadId });
          token(`${result.text && !/\s$/.test(result.text) ? ' ' : ''}Opening ${outcome.name}.`);
          return finish();
        }
        result.toolCalls.push({ name: call.name, ok: !outcome.isError, args: call.arguments });
        pending.push({ call, content: outcome.content, isError: outcome.isError });
      }
      messages.push({ role: 'assistant', content: out.text, toolCalls: out.calls, raw: out.raw });
      for (const p of pending) {
        messages.push({ role: 'tool', content: p.content, toolCallId: p.call.id, name: p.call.name, isError: p.isError });
      }
    }
    // 5.7 Still calling tools after the last round.
    token(`${result.text && !/\s$/.test(result.text) ? '\n\n' : ''}${ROUND_LIMIT_TEXT}`);
    return finish();
  } catch (err) {
    extractor.flush();
    return handleError(err, deps, deadline.signal, signal, fail);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function toolStatus(name: string): string {
  switch (name) {
    case 'applyListFilters': return 'Counting matching leads…';
    case 'todaysCalls': return 'Checking today’s follow-ups…';
    case 'openLead': return 'Looking up the lead…';
    default: return 'Searching your leads…';
  }
}

async function handleError(
  err: unknown, deps: EngineDeps, deadline: AbortSignal, outer: AbortSignal,
  fail: (code: AssistantErrorCode, resetsAt?: Date | null) => EngineResult,
): Promise<EngineResult> {
  const reason = deadline.aborted ? deadline.reason : undefined;
  if (err instanceof RequestTimeout || reason instanceof RequestTimeout) return fail('ai_timeout');
  if (err instanceof UserLimitReached) return fail('user_daily_limit');
  if (outer.aborted && !(err instanceof LlmError)) return fail('internal_error');
  // What the provider said, for operators (the logger redacts keys; users only ever get the fixed copy).
  if (err instanceof LlmError && !(err instanceof LlmAuthError) && err.provider !== 'budget') {
    deps.log?.warn({ provider: err.provider, status: err.status, errorClass: err.name, err: err.message }, 'LLM call failed');
  }
  if (err instanceof LlmQuotaExceeded) {
    if (err.provider !== 'budget') await deps.budget?.reportQuotaExhausted(err.resetsAt).catch(() => {});
    return fail('ai_quota_exhausted', err.resetsAt);
  }
  if (err instanceof LlmRateLimited) return fail('ai_rate_limited');
  if (err instanceof LlmAuthError) {
    deps.log?.error({ err, provider: err.provider }, 'LLM provider rejected the credentials or model; treating as not configured');
    return fail('ai_not_configured');
  }
  if (err instanceof LlmTimeoutError) return fail('ai_timeout');
  if (err instanceof LlmOutputError) return fail('ai_output_blocked');
  if (err instanceof LlmApiError) return fail('ai_provider_error');
  deps.log?.error({ err }, 'assistant request failed');
  return fail('internal_error');
}

/**
 * One provider call with the interactive retry policy: a rate limit with retryAfterMs <= 2 s or a 5xx/network
 * error is retried once, and only while nothing of this call has been streamed. API errors and timeouts count
 * toward the circuit breaker.
 */
async function callProvider(
  provider: LlmProvider, req: ChatRequest, deps: EngineDeps, limits: EngineLimits, deadline: AbortSignal,
  result: EngineResult, extractor: CitationExtractor, isCapped: () => boolean,
): Promise<RoundOutput> {
  for (let attempt = 1; ; attempt++) {
    await deps.budget?.acquire(deadline);
    result.llmCalls++;
    let streamed = false;
    try {
      const out = await streamOnce(provider, req, limits, deadline, result, (text) => {
        streamed = true;
        extractor.push(text);
        if (isCapped()) throw new AnswerCapped();
      });
      deps.circuit?.recordSuccess();
      return out;
    } catch (err) {
      const e = toLlmError(err, deadline, provider.name);
      if (e instanceof LlmApiError || e instanceof LlmTimeoutError) deps.circuit?.recordFailure();
      const retryable = !streamed && attempt === 1 && !deadline.aborted && (
        (e instanceof LlmRateLimited && e.retryAfterMs !== null && e.retryAfterMs <= RETRY_AFTER_MAX_MS)
        || (e instanceof LlmApiError && (e.status === undefined || e.status >= 500)));
      if (!retryable) throw e;
      await wait(e instanceof LlmRateLimited ? Math.max(100, e.retryAfterMs ?? 0) : RETRY_5XX_DELAY_MS, deadline);
    }
  }
}

function toLlmError(err: unknown, deadline: AbortSignal, provider: string): unknown {
  if (err instanceof LlmError) return err;
  if (deadline.aborted) return deadline.reason instanceof RequestTimeout ? deadline.reason : err;
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new LlmTimeoutError('provider call timed out', { provider });
  }
  return err;
}

async function streamOnce(
  provider: LlmProvider, req: ChatRequest, limits: EngineLimits, deadline: AbortSignal, result: EngineResult,
  onText: (text: string) => void,
): Promise<RoundOutput> {
  const stop = new AbortController();
  const callSignal = AbortSignal.any([deadline, AbortSignal.timeout(limits.providerTimeoutMs), stop.signal]);
  const out: RoundOutput = { text: '', calls: [], raw: undefined, capped: false };
  // The latest usage the provider reported for this call (cumulative), charged however the call ends.
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let streamed = 0;
  try {
    for await (const d of provider.stream(req, callSignal)) {
      if (d.type === 'text') {
        out.text += d.text;
        streamed += d.text.length;
        onText(d.text);
      } else if (d.type === 'tool_call') {
        out.calls.push(d.call);
      } else if (d.type === 'usage') {
        usage = { inputTokens: d.inputTokens, outputTokens: d.outputTokens };
      } else if (d.type === 'end') {
        out.raw = d.raw;
      }
    }
  } catch (err) {
    if (err instanceof AnswerCapped) {
      stop.abort(err);
      out.capped = true;
      return out;
    }
    if (!deadline.aborted && callSignal.aborted && !(err instanceof LlmError)) {
      throw new LlmTimeoutError('provider call timed out', { provider: provider.name });
    }
    throw err;
  } finally {
    // Cut off (client gone, deadline, cap) before the provider reported usage: the request was still sent and
    // billed, so charge an estimate (4 characters a token) instead of nothing.
    if (!usage && callSignal.aborted) {
      usage = { inputTokens: Math.ceil(requestChars(req) / 4), outputTokens: Math.ceil(streamed / 4) };
    }
    if (usage) {
      result.usage.inputTokens += usage.inputTokens;
      result.usage.outputTokens += usage.outputTokens;
    }
  }
  return out;
}

function requestChars(req: ChatRequest): number {
  return req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(req.tools).length;
}
