// Google Gemini (REST v1beta streamGenerateContent?alt=sse): the demo's free-tier provider.
//   * Auth: the key goes in the x-goog-api-key header, never in the URL.
//   * Tools: tools[].functionDeclarations (parameters converted by toGeminiSchema) + toolConfig mode AUTO/NONE/ANY.
//   * A model turn's parts are kept verbatim in end.raw: Gemini 3 attaches thoughtSignatures to them that must be
//     sent back on the next turn (tool rounds), so replays use raw when it is there.
//   * Usage: every chunk's usageMetadata is cumulative; it is yielded as soon as it changes, so a call cut off
//     mid-answer is still charged (engine.ts keeps the latest).
//   * Errors are classified like leadmaker/llm/providers/gemini.py classify_error: a 429 naming a per-day quota is
//     LlmQuotaExceeded (resets at midnight Pacific, or earlier when the 429's RetryInfo says so), other 429s
//     LlmRateLimited (RetryInfo), 401/403/
//     FAILED_PRECONDITION/API_KEY_*/SERVICE_DISABLED and 404 (unknown model) LlmAuthError, the rest LlmApiError.
import { PACIFIC_TZ, nextMidnight } from '../time.ts';
import { parseJsonObject, postStream, retryAfterMs, type ErrorResponse, type FetchLike } from './http.ts';
import { toGeminiSchema } from './schema.ts';
import { parseSse } from './sse-lines.ts';
import {
  LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, type ChatDelta, type ChatMessage,
  type ChatRequest, type LlmError, type LlmProvider, type ToolCall,
} from './types.ts';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Ids invented when the API returns none; they are never echoed back to the API. */
export const SYNTH_ID_PREFIX = 'gemini-call-';
const BAD_FINISH = new Set([
  'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY', 'UNEXPECTED_TOOL_CALL', 'OTHER',
]);

type Json = Record<string, unknown>;
type Part = Json & { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown } };

export interface GeminiOptions {
  apiKey: string | undefined;
  model: string;
  baseUrl?: string;
  /** generationConfig.thinkingConfig.thinkingLevel; undefined sends none (the model's default). */
  thinkingLevel?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  readonly model: string;
  readonly fingerprint: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #thinkingLevel: string | undefined;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(opts: GeminiOptions) {
    this.model = opts.model;
    this.fingerprint = `gemini:${opts.model}`;
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl || GEMINI_BASE_URL).replace(/\/+$/, '');
    this.#thinkingLevel = opts.thinkingLevel;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#now = opts.now ?? (() => new Date());
  }

  isConfigured(): { ok: true } | { ok: false; reason: string } {
    if (!this.#apiKey) return { ok: false, reason: 'GEMINI_API_KEY (or GOOGLE_API_KEY) not set' };
    if (!this.model) return { ok: false, reason: 'no Gemini model configured' };
    return { ok: true };
  }

  get url(): string {
    return `${this.#baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
  }

  body(req: ChatRequest): Json {
    const generationConfig: Json = { maxOutputTokens: req.maxOutputTokens };
    if (this.#thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.#thinkingLevel };
    const body: Json = { contents: contents(req.messages), generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools.length) {
      body.tools = [{
        functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })),
      }];
      body.toolConfig = { functionCallingConfig: { mode: { auto: 'AUTO', none: 'NONE', required: 'ANY' }[req.toolChoice] } };
    }
    return body;
  }

  classify(r: ErrorResponse): LlmError {
    const err = (r.body as { error?: Json } | undefined)?.error ?? {};
    const code = String(err.status ?? '');
    const message = String(err.message ?? r.text.slice(0, 300));
    const reasons: string[] = [];
    const quotaIds: string[] = [];
    let retryDelayMs: number | null = null;
    for (const d of Array.isArray(err.details) ? err.details : []) {
      if (typeof d !== 'object' || d === null) continue;
      const detail = d as Json;
      if (detail.reason) reasons.push(String(detail.reason));
      for (const v of Array.isArray(detail.violations) ? detail.violations : []) {
        if (v && typeof v === 'object' && (v as Json).quotaId) quotaIds.push(String((v as Json).quotaId));
      }
      const m = /^\s*([\d.]+)s\s*$/.exec(String(detail.retryDelay ?? ''));
      if (m) retryDelayMs = Math.round(Number(m[1]) * 1000);
    }
    const tags = [...reasons, ...quotaIds];
    const text = `HTTP ${r.status} ${code}${tags.length ? ` [${tags.join(',')}]` : ''}: ${message}`;
    const opts = { provider: this.name, status: r.status };
    if (r.status === 429) {
      if (quotaIds.some((q) => q.toLowerCase().includes('perday'))) {
        // The quota day ends at midnight Pacific; a RetryInfo hint that ends sooner wins (seen 2026-10-19: "retry in
        // 14h51m" at 09:08Z, 7 h before midnight Pacific), so the assistant probes again no later than Google says.
        const now = this.#now();
        const midnight = nextMidnight(PACIFIC_TZ, now);
        const hinted = retryDelayMs !== null ? new Date(now.getTime() + retryDelayMs) : null;
        const resetsAt = hinted && hinted < midnight ? hinted : midnight;
        return new LlmQuotaExceeded(text, { ...opts, resetsAt, scope: 'daily' });
      }
      return new LlmRateLimited(text, { ...opts, retryAfterMs: retryDelayMs ?? retryAfterMs(r.headers) });
    }
    if (r.status === 401 || r.status === 403 || code === 'FAILED_PRECONDITION'
      || reasons.some((x) => x.startsWith('API_KEY') || x === 'SERVICE_DISABLED' || x === 'BILLING_DISABLED')) {
      return new LlmAuthError(text, opts);
    }
    if (r.status === 404) return new LlmAuthError(text, opts);
    return new LlmApiError(text, opts);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const ready = this.isConfigured();
    if (!ready.ok) throw new LlmAuthError(ready.reason, { provider: this.name });
    const body = await postStream(this.#fetch, this.name, this.url, { 'x-goog-api-key': this.#apiKey! }, this.body(req), signal,
      (r) => this.classify(r));
    const parts: Part[] = [];
    let finish = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let calls = 0;
    let sawCandidate = false;
    let blockReason: string | null = null;
    for await (const frame of parseSse(body, signal)) {
      const chunk = parseJsonObject(frame.data);
      if (!chunk) continue;
      if (chunk.error) throw new LlmApiError(`stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`, { provider: this.name });
      const feedback = chunk.promptFeedback as Json | undefined;
      if (feedback?.blockReason) blockReason = String(feedback.blockReason);
      const meta = chunk.usageMetadata as Json | undefined;
      if (meta) {
        const out = (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0);
        const next = { inputTokens: Number(meta.promptTokenCount) || 0, outputTokens: out };
        if (!usage || next.inputTokens !== usage.inputTokens || next.outputTokens !== usage.outputTokens) {
          usage = next;
          yield { type: 'usage', ...usage };
        }
      }
      const cand = (Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined) as Json | undefined;
      if (!cand) continue;
      sawCandidate = true;
      if (cand.finishReason) finish = String(cand.finishReason);
      const cparts = ((cand.content as Json | undefined)?.parts ?? []) as Part[];
      for (const p of Array.isArray(cparts) ? cparts : []) {
        if (!p || typeof p !== 'object') continue;
        parts.push(p);
        if (p.thought) continue;
        if (typeof p.text === 'string' && p.text) yield { type: 'text', text: p.text };
        if (p.functionCall && typeof p.functionCall === 'object') {
          const fc = p.functionCall;
          const args = fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? (fc.args as Json) : {};
          const call: ToolCall = { id: fc.id ? String(fc.id) : `${SYNTH_ID_PREFIX}${calls}`, name: String(fc.name ?? ''), arguments: args };
          calls++;
          yield { type: 'tool_call', call };
        }
      }
    }
    if (!sawCandidate && blockReason) throw new LlmOutputError(`prompt blocked (${blockReason})`, { provider: this.name });
    if (finish === 'MAX_TOKENS') throw new LlmOutputError('model output truncated at maxOutputTokens', { provider: this.name });
    if (BAD_FINISH.has(finish)) throw new LlmOutputError(`model stopped with finishReason=${finish}`, { provider: this.name });
    if (signal.aborted) throw signal.reason;
    if (!sawCandidate) throw new LlmApiError('stream ended without a candidate', { provider: this.name });
    yield { type: 'end', stopReason: finish || 'STOP', raw: { provider: this.name, content: mergeParts(parts) } };
  }
}

/** Streamed text arrives as many parts: adjacent plain text parts are joined (keeping any thoughtSignature). */
export function mergeParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    const plainText = typeof p.text === 'string' && !p.thought && !p.functionCall;
    const prevPlain = prev && typeof prev.text === 'string' && !prev.thought && !prev.functionCall;
    if (plainText && prevPlain && !(prev.thoughtSignature && p.thoughtSignature)) {
      out[out.length - 1] = { ...prev, text: prev.text! + p.text!, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) };
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

function asStruct(content: string): Json {
  const v = parseJsonObject(content);
  return v ?? { result: content };
}

export function contents(messages: ChatMessage[]): Json[] {
  const out: { role: string; parts: Json[] }[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const result = asStruct(m.content);
      const fr: Json = { name: m.name ?? '', response: m.isError ? { error: result } : result };
      if (m.toolCallId && !m.toolCallId.startsWith(SYNTH_ID_PREFIX)) fr.id = m.toolCallId;
      const part = { functionResponse: fr };
      const prev = out.at(-1);
      if (prev && prev.role === 'user' && prev.parts.every((p) => 'functionResponse' in p)) prev.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
    } else if (m.role === 'assistant') {
      const raw = m.raw as { provider?: string; content?: unknown } | undefined;
      if (raw?.provider === 'gemini' && Array.isArray(raw.content) && raw.content.length) {
        out.push({ role: 'model', parts: raw.content as Json[] });
        continue;
      }
      const parts: Json[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        const fc: Json = { name: c.name, args: c.arguments };
        if (!c.id.startsWith(SYNTH_ID_PREFIX)) fc.id = c.id;
        parts.push({ functionCall: fc });
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    } else {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    }
  }
  return out;
}
