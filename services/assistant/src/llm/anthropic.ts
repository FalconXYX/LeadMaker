// Anthropic Messages API (streaming), the production provider. Built and unit-tested against recorded event
// fixtures; never called live in the demo (paid). The static system prompt is marked cache_control (prompt caching).
//   Events: message_start (input usage), content_block_start (text / tool_use id+name / thinking),
//   content_block_delta (text_delta, input_json_delta accumulated per block, thinking/signature deltas),
//   content_block_stop, message_delta (stop_reason, output usage), message_stop, error.
//   end.raw is the assistant turn's content blocks, replayed verbatim on the next tool round (keeps thinking).
import { parseJsonObject, postStream, retryAfterMs, type ErrorResponse, type FetchLike } from './http.ts';
import { toJsonSchemaForProvider } from './schema.ts';
import { parseSse } from './sse-lines.ts';
import {
  LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, type ChatDelta, type ChatMessage,
  type ChatRequest, type LlmError, type LlmProvider,
} from './types.ts';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

type Json = Record<string, unknown>;
type Block = Json & { type: string };

export interface AnthropicOptions { apiKey: string | undefined; model: string; url?: string; fetch?: FetchLike }

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  readonly fingerprint: string;
  readonly #apiKey: string | undefined;
  readonly #url: string;
  readonly #fetch: FetchLike;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.fingerprint = `anthropic:${opts.model}`;
    this.#apiKey = opts.apiKey;
    this.#url = opts.url ?? ANTHROPIC_URL;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  isConfigured(): { ok: true } | { ok: false; reason: string } {
    if (!this.#apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY not set' };
    if (!this.model) return { ok: false, reason: 'no Anthropic model configured' };
    return { ok: true };
  }

  body(req: ChatRequest): Json {
    const body: Json = { model: this.model, max_tokens: req.maxOutputTokens, messages: messages(req.messages), stream: true };
    if (req.system) body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchemaForProvider(t.parameters, 'anthropic') }));
      body.tool_choice = { type: req.toolChoice === 'required' ? 'any' : req.toolChoice };
    }
    return body;
  }

  classify(r: ErrorResponse): LlmError {
    const err = (r.body as { error?: Json } | undefined)?.error ?? {};
    const message = String(err.message ?? r.text.slice(0, 300));
    const text = `HTTP ${r.status} ${String(err.type ?? '')}: ${message}`;
    const opts = { provider: this.name, status: r.status };
    if (r.status === 429) return new LlmRateLimited(text, { ...opts, retryAfterMs: retryAfterMs(r.headers) });
    if (r.status === 401 || r.status === 403 || r.status === 404) return new LlmAuthError(text, opts);
    if (r.status === 400 && /credit balance is too low/i.test(message)) {
      return new LlmQuotaExceeded(text, { ...opts, resetsAt: null, scope: 'billing' });
    }
    return new LlmApiError(text, opts);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const ready = this.isConfigured();
    if (!ready.ok) throw new LlmAuthError(ready.reason, { provider: this.name });
    const body = await postStream(this.#fetch, this.name, this.#url,
      { 'x-api-key': this.#apiKey!, 'anthropic-version': API_VERSION }, this.body(req), signal, (r) => this.classify(r));
    const blocks: Block[] = [];
    const partialJson = new Map<number, string>();
    let stop = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopped = false;
    for await (const frame of parseSse(body, signal)) {
      const ev = parseJsonObject(frame.data);
      if (!ev) continue;
      const type = String(ev.type ?? frame.event);
      if (type === 'message_start') {
        const usage = (ev.message as Json | undefined)?.usage as Json | undefined;
        inputTokens = Number(usage?.input_tokens ?? 0) + Number(usage?.cache_read_input_tokens ?? 0) + Number(usage?.cache_creation_input_tokens ?? 0);
        outputTokens = Number(usage?.output_tokens ?? 0);
        // Input usage is known (and billed) now: report it at once, so a call cut off mid-answer is charged.
        if (inputTokens) yield { type: 'usage', inputTokens, outputTokens };
      } else if (type === 'content_block_start') {
        const i = Number(ev.index);
        const block = { ...(ev.content_block as Block) };
        if (block.type === 'tool_use') partialJson.set(i, '');
        blocks[i] = block;
      } else if (type === 'content_block_delta') {
        const i = Number(ev.index);
        const delta = (ev.delta ?? {}) as Json;
        const block = blocks[i];
        if (!block) continue;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = String(block.text ?? '') + delta.text;
          if (delta.text) yield { type: 'text', text: delta.text };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          partialJson.set(i, (partialJson.get(i) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = String(block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = delta.signature;
        }
      } else if (type === 'content_block_stop') {
        const i = Number(ev.index);
        const block = blocks[i];
        if (block?.type === 'tool_use') {
          const json = partialJson.get(i) ?? '';
          const input = json.trim() ? parseJsonObject(json) : {};
          if (!input) throw new LlmOutputError('tool_use input is not a JSON object', { provider: this.name });
          block.input = input;
          yield { type: 'tool_call', call: { id: String(block.id ?? `toolu_${i}`), name: String(block.name ?? ''), arguments: input } };
        }
      } else if (type === 'message_delta') {
        const delta = (ev.delta ?? {}) as Json;
        if (delta.stop_reason) stop = String(delta.stop_reason);
        const usage = ev.usage as Json | undefined;
        if (usage?.output_tokens !== undefined) outputTokens = Number(usage.output_tokens) || outputTokens;
      } else if (type === 'message_stop') {
        stopped = true;
      } else if (type === 'error') {
        const e = (ev.error ?? {}) as Json;
        const msg = `stream error ${String(e.type ?? '')}: ${String(e.message ?? '').slice(0, 300)}`;
        if (e.type === 'rate_limit_error') throw new LlmRateLimited(msg, { provider: this.name, retryAfterMs: null });
        throw new LlmApiError(msg, { provider: this.name });
      }
    }
    if (signal.aborted) throw signal.reason;
    if (stop === 'refusal') throw new LlmOutputError('model refused', { provider: this.name });
    if (stop === 'max_tokens') throw new LlmOutputError('model output truncated at max_tokens', { provider: this.name });
    if (!stopped && !stop) throw new LlmApiError('stream ended before message_stop', { provider: this.name });
    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'end', stopReason: stop || 'end_turn', raw: { provider: this.name, content: blocks.filter(Boolean) } };
  }
}

export function messages(msgs: ChatMessage[]): Json[] {
  const out: { role: string; content: unknown }[] = [];
  for (const m of msgs) {
    if (m.role === 'tool') {
      const block: Json = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content };
      if (m.isError) block.is_error = true;
      const prev = out.at(-1);
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b: Json) => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (m.role === 'assistant') {
      const raw = m.raw as { provider?: string; content?: unknown } | undefined;
      if (raw?.provider === 'anthropic' && Array.isArray(raw.content) && raw.content.length) {
        out.push({ role: 'assistant', content: raw.content });
        continue;
      }
      const blocks: Json[] = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      out.push({ role: 'assistant', content: blocks.length ? blocks : m.content });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}
