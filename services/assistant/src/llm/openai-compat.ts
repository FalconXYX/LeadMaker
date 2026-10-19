// OpenAI-compatible Chat Completions (streaming), e.g. a local Ollama at http://localhost:11434/v1.
// POST {LEADMAKER_LLM_BASE_URL}/chat/completions with Authorization: Bearer $LEADMAKER_LLM_API_KEY when set.
// Tool calls arrive as tool_calls[i].function.arguments fragments; they are accumulated per index and parsed when
// the choice finishes. Usage arrives in a final chunk (stream_options.include_usage). Never called live in the demo.
import { parseJsonObject, postStream, retryAfterMs, type ErrorResponse, type FetchLike } from './http.ts';
import { toJsonSchemaForProvider } from './schema.ts';
import { parseSse } from './sse-lines.ts';
import {
  LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, type ChatDelta, type ChatMessage,
  type ChatRequest, type LlmError, type LlmProvider,
} from './types.ts';

export const OPENAI_COMPAT_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

type Json = Record<string, unknown>;

export interface OpenAICompatOptions { baseUrl?: string; apiKey?: string; model: string; fetch?: FetchLike }

export class OpenAICompatProvider implements LlmProvider {
  readonly name = 'openai_compat' as const;
  readonly model: string;
  readonly fingerprint: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: OpenAICompatOptions) {
    this.model = opts.model;
    this.fingerprint = `openai_compat:${opts.model}`;
    this.#baseUrl = (opts.baseUrl || OPENAI_COMPAT_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = opts.apiKey || undefined;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  isConfigured(): { ok: true } | { ok: false; reason: string } {
    if (!this.model) return { ok: false, reason: 'LEADMAKER_LLM_MODEL must name the model for openai_compat' };
    return { ok: true };
  }

  get url(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  body(req: ChatRequest): Json {
    const body: Json = {
      model: this.model,
      messages: messages(req.system, req.messages),
      max_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function', function: { name: t.name, description: t.description, parameters: toJsonSchemaForProvider(t.parameters, 'openai_compat') },
      }));
      body.tool_choice = req.toolChoice;
    }
    return body;
  }

  classify(r: ErrorResponse): LlmError {
    const err = (r.body as { error?: Json } | undefined)?.error ?? {};
    const message = String(err.message ?? r.text.slice(0, 300));
    const code = String(err.code ?? err.type ?? '');
    const text = `HTTP ${r.status} ${code}: ${message}`;
    const opts = { provider: this.name, status: r.status };
    if (r.status === 429) {
      if (code === 'insufficient_quota') return new LlmQuotaExceeded(text, { ...opts, resetsAt: null, scope: 'billing' });
      return new LlmRateLimited(text, { ...opts, retryAfterMs: retryAfterMs(r.headers) });
    }
    if (r.status === 401 || r.status === 403 || r.status === 404) return new LlmAuthError(text, opts);
    return new LlmApiError(text, opts);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const ready = this.isConfigured();
    if (!ready.ok) throw new LlmAuthError(ready.reason, { provider: this.name });
    const headers: Record<string, string> = this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
    const body = await postStream(this.#fetch, this.name, this.url, headers, this.body(req), signal, (r) => this.classify(r));
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish = '';
    let text = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let done = false;
    const flushCalls = function* (provider: string): Generator<ChatDelta> {
      for (const [i, c] of [...pending].sort((a, b) => a[0] - b[0])) {
        const args = c.args.trim() ? parseJsonObject(c.args) : {};
        if (!args) throw new LlmOutputError(`tool call arguments are not a JSON object (${c.name})`, { provider });
        yield { type: 'tool_call', call: { id: c.id || `call_${i}`, name: c.name, arguments: args } };
      }
      pending.clear();
    };
    for await (const frame of parseSse(body, signal)) {
      if (frame.data.trim() === '[DONE]') {
        done = true;
        break;
      }
      const chunk = parseJsonObject(frame.data);
      if (!chunk) continue;
      if (chunk.error) throw new LlmApiError(`stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`, { provider: this.name });
      const u = chunk.usage as Json | undefined;
      if (u) usage = { inputTokens: Number(u.prompt_tokens) || 0, outputTokens: Number(u.completion_tokens) || 0 };
      const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Json | undefined;
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Json;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      for (const tc of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []) {
        const i = Number(tc.index ?? 0);
        const fn = (tc.function ?? {}) as Json;
        const cur = pending.get(i) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = String(tc.id);
        if (fn.name) cur.name += String(fn.name);
        if (typeof fn.arguments === 'string') cur.args += fn.arguments;
        pending.set(i, cur);
      }
      if (choice.finish_reason) {
        finish = String(choice.finish_reason);
        yield* flushCalls(this.name);
      }
    }
    if (signal.aborted) throw signal.reason;
    yield* flushCalls(this.name);
    if (finish === 'length') throw new LlmOutputError('model output truncated at max_tokens', { provider: this.name });
    if (finish === 'content_filter') throw new LlmOutputError('model output blocked by the content filter', { provider: this.name });
    if (!finish && !done) throw new LlmApiError('stream ended without a finish_reason', { provider: this.name });
    if (usage) yield { type: 'usage', ...usage };
    yield { type: 'end', stopReason: finish || 'stop', raw: { provider: this.name, text } };
  }
}

export function messages(system: string, msgs: ChatMessage[]): Json[] {
  const out: Json[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of msgs) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    else if (m.role === 'assistant') {
      const msg: Json = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      }
      out.push(msg);
    } else out.push({ role: 'user', content: m.content });
  }
  return out;
}
