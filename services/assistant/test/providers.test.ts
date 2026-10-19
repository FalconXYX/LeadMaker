// Provider adapters against recorded-shape fixtures (no network): request bodies, streaming parse, tool calls,
// replay of raw turns, error classification, schema conversion and selection by configuration.
import { leadFilterToolJsonSchema } from '@leadmaker/shared';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.ts';
import { GeminiProvider, contents as geminiContents } from '../src/llm/gemini.ts';
import { createProvider, DEFAULT_MODELS, resolveProviderName } from '../src/llm/index.ts';
import { OpenAICompatProvider } from '../src/llm/openai-compat.ts';
import { toGeminiSchema } from '../src/llm/schema.ts';
import { parseSse } from '../src/llm/sse-lines.ts';
import {
  LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, type ChatDelta, type ChatRequest,
} from '../src/llm/types.ts';
import { toolSpecs } from '../src/tools.ts';

const KEY = 'AIzaFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEY';

type Captured = { url: string; init: RequestInit };

/** A fetch that answers with an SSE body split into the given chunks (or a JSON error). */
function fakeFetch(chunks: string[] | { status: number; body: unknown; headers?: Record<string, string> }) {
  const seen: Captured[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    if (!Array.isArray(chunks)) {
      return new Response(JSON.stringify(chunks.body), { status: chunks.status, headers: { 'content-type': 'application/json', ...chunks.headers } });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fn, seen };
}

const REQ: ChatRequest = {
  system: 'SYSTEM', messages: [{ role: 'user', content: 'hello' }], tools: toolSpecs(), toolChoice: 'auto', maxOutputTokens: 2048,
};

async function collect(it: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of it) out.push(d);
  return out;
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;

describe('parseSse', () => {
  it('handles CRLF, multi-line data, comments and splits anywhere', async () => {
    const raw = ': c\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: é\n\nevent: b\rdata: x\r\r';
    const enc = new TextEncoder().encode(raw);
    const chunks = [...enc].map((b) => new Uint8Array([b]));
    async function* gen() { for (const c of chunks) yield c; }
    const frames = [];
    for await (const f of parseSse(gen())) frames.push(f);
    expect(frames).toEqual([{ event: 'a', data: '1\n2' }, { event: 'message', data: 'é' }, { event: 'b', data: 'x' }]);
  });
});

describe('Gemini', () => {
  const thoughtSig = 'c2lnbmF0dXJl';
  const chunks = [
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Carework is ' }] } }] }),
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'a roofer.', thoughtSignature: thoughtSig }] } }] }),
    sse({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'findLeads', args: { filter: { minRating: 4.5 } } }, thoughtSignature: 'fc-sig' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2310, candidatesTokenCount: 40, thoughtsTokenCount: 18 } }),
  ];

  it('streams text and tool calls, keeps the raw parts for replay, and never puts the key in the URL', async () => {
    const f = fakeFetch(chunks);
    const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-3.8-flash', thinkingLevel: 'low', fetch: f.fn });
    const out = await collect(p.stream(REQ, new AbortController().signal));
    expect(out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('Carework is a roofer.');
    expect(out.find((d) => d.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'gemini-call-0', name: 'findLeads', arguments: { filter: { minRating: 4.5 } } } });
    expect(out.find((d) => d.type === 'usage')).toEqual({ type: 'usage', inputTokens: 2310, outputTokens: 58 });
    const end = out.at(-1) as Extract<ChatDelta, { type: 'end' }>;
    expect(end.raw).toEqual({ provider: 'gemini', content: [
      { text: 'Carework is a roofer.', thoughtSignature: thoughtSig },
      { functionCall: { name: 'findLeads', args: { filter: { minRating: 4.5 } } }, thoughtSignature: 'fc-sig' },
    ] });
    const { url, init } = f.seen[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYSTEM' }] });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
    expect(body.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(['applyListFilters', 'findLeads', 'todaysCalls', 'openLead']);
    expect(JSON.stringify(body.tools)).not.toMatch(/additionalProperties|\$schema|exclusiveMinimum/);
  });

  it('replays the raw model turn (thought signatures) and groups parallel tool results', () => {
    const raw = { provider: 'gemini', content: [{ functionCall: { name: 'findLeads', args: {} }, thoughtSignature: 'sig' }] };
    const out = geminiContents([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-call-0', name: 'findLeads', arguments: {} }], raw },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'gemini-call-0', name: 'findLeads' },
      { role: 'tool', content: '{"ok":false,"errors":["x"]}', toolCallId: 'abc', name: 'openLead', isError: true },
    ]);
    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: raw.content },
      { role: 'user', parts: [
        { functionResponse: { name: 'findLeads', response: { ok: true } } },
        { functionResponse: { name: 'openLead', id: 'abc', response: { error: { ok: false, errors: ['x'] } } } },
      ] },
    ]);
  });

  it.each([
    [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } }, LlmQuotaExceeded],
    [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'slow down', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.5s' }] } } }, LlmRateLimited],
    [{ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } } }, LlmAuthError],
    [{ status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'denied' } } }, LlmAuthError],
    [{ status: 400, body: { error: { status: 'FAILED_PRECONDITION', message: 'User location is not supported' } } }, LlmAuthError],
    [{ status: 404, body: { error: { status: 'NOT_FOUND', message: 'models/x is not found' } } }, LlmAuthError],
    [{ status: 503, body: { error: { status: 'UNAVAILABLE', message: 'overloaded' } } }, LlmApiError],
  ])('classifies HTTP errors (%#)', async (resp, cls) => {
    const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-3.8-flash', fetch: fakeFetch(resp).fn, now: () => new Date('2026-10-19T19:00:00Z') });
    const err = await collect(p.stream(REQ, new AbortController().signal)).catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    if (err instanceof LlmQuotaExceeded) expect(err.resetsAt?.toISOString()).toBe('2026-10-20T07:00:00.000Z');
    if (err instanceof LlmRateLimited) expect(err.retryAfterMs).toBe(1500);
    expect(String(err.message)).not.toContain(KEY);
  });

  it.each([
    ['MAX_TOKENS'], ['SAFETY'], ['MALFORMED_FUNCTION_CALL'],
  ])('a %s finish is an output error', async (finish) => {
    const f = fakeFetch([sse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: finish }] })]);
    const p = new GeminiProvider({ apiKey: KEY, model: 'm', fetch: f.fn });
    await expect(collect(p.stream(REQ, new AbortController().signal))).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('a blocked prompt is an output error; skipping thought parts', async () => {
    const blocked = new GeminiProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch([sse({ promptFeedback: { blockReason: 'SAFETY' } })]).fn });
    await expect(collect(blocked.stream(REQ, new AbortController().signal))).rejects.toBeInstanceOf(LlmOutputError);
    const thinking = new GeminiProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch([
      sse({ candidates: [{ content: { parts: [{ text: 'secret plan', thought: true }, { text: 'Answer.' }] }, finishReason: 'STOP' }] }),
    ]).fn });
    const out = await collect(thinking.stream(REQ, new AbortController().signal));
    expect(out.filter((d) => d.type === 'text')).toEqual([{ type: 'text', text: 'Answer.' }]);
  });

  it('is not configured without a key and never sends a request', async () => {
    const f = fakeFetch([]);
    const p = new GeminiProvider({ apiKey: undefined, model: 'm', fetch: f.fn });
    expect(p.isConfigured()).toEqual({ ok: false, reason: expect.stringContaining('GEMINI_API_KEY') });
    await expect(collect(p.stream(REQ, new AbortController().signal))).rejects.toBeInstanceOf(LlmAuthError);
    expect(f.seen).toHaveLength(0);
  });
});

describe('Anthropic (never called live)', () => {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const chunks = [
    ev('message_start', { message: { usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Looking ' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'that up.' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'findLeads', input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"filter": {"min' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'Rating": 4.5}}' } }),
    ev('content_block_stop', { index: 1 }),
    ev('ping', {}),
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 61 } }),
    ev('message_stop', {}),
  ];

  it('streams text, accumulates tool_use JSON and builds a cached system block', async () => {
    const f = fakeFetch(chunks);
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test-0123456789', model: 'claude-haiku-5-5', fetch: f.fn });
    const out = await collect(p.stream(REQ, new AbortController().signal));
    expect(out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('Looking that up.');
    expect(out.find((d) => d.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'toolu_1', name: 'findLeads', arguments: { filter: { minRating: 4.5 } } } });
    expect(out.filter((d) => d.type === 'usage').at(-1)).toEqual({ type: 'usage', inputTokens: 2000, outputTokens: 61 });
    expect(out.find((d) => d.type === 'usage')).toEqual({ type: 'usage', inputTokens: 2000, outputTokens: 1 }); // at message_start
    const end = out.at(-1) as Extract<ChatDelta, { type: 'end' }>;
    expect(end.stopReason).toBe('tool_use');
    expect((end.raw as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'Looking that up.' },
      { type: 'tool_use', id: 'toolu_1', name: 'findLeads', input: { filter: { minRating: 4.5 } } },
    ]);
    const { url, init } = f.seen[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test-0123456789');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 2048, stream: true, tool_choice: { type: 'auto' } });
    expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0].input_schema.properties.filter).not.toHaveProperty('$schema');
  });

  it.each([
    [{ status: 429, body: { error: { type: 'rate_limit_error', message: 'slow' } }, headers: { 'retry-after': '2' } }, LlmRateLimited],
    [{ status: 529, body: { error: { type: 'overloaded_error', message: 'overloaded' } } }, LlmApiError],
    [{ status: 401, body: { error: { type: 'authentication_error', message: 'bad key' } } }, LlmAuthError],
    [{ status: 400, body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } } }, LlmQuotaExceeded],
  ])('classifies HTTP errors (%#)', async (resp, cls) => {
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test-0123456789', model: 'm', fetch: fakeFetch(resp).fn });
    const err = await collect(p.stream(REQ, new AbortController().signal)).catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    if (err instanceof LlmRateLimited) expect(err.retryAfterMs).toBe(2000);
    if (err instanceof LlmQuotaExceeded) expect(err.scope).toBe('billing');
  });

  it('a refusal or a mid-stream error fails the call', async () => {
    const refusal = new AnthropicProvider({ apiKey: 'k-0123456789', model: 'm', fetch: fakeFetch([
      ev('message_start', { message: { usage: {} } }), ev('message_delta', { delta: { stop_reason: 'refusal' } }), ev('message_stop', {}),
    ]).fn });
    await expect(collect(refusal.stream(REQ, new AbortController().signal))).rejects.toBeInstanceOf(LlmOutputError);
    const overloaded = new AnthropicProvider({ apiKey: 'k-0123456789', model: 'm', fetch: fakeFetch([
      ev('message_start', { message: { usage: {} } }), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ]).fn });
    await expect(collect(overloaded.stream(REQ, new AbortController().signal))).rejects.toBeInstanceOf(LlmApiError);
  });
});

describe('OpenAI-compatible (never called live)', () => {
  const d = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  it('accumulates tool call argument deltas and reads the usage chunk', async () => {
    const f = fakeFetch([
      d({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure' } }] }),
      d({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'applyListFilters', arguments: '{"filter":' } }] } }] }),
      d({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"size":["large"]},"explanation":"Large"}' } }] } }] }),
      d({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      d({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 30 } }),
      'data: [DONE]\n\n',
    ]);
    const p = new OpenAICompatProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: 'local-key-123456', model: 'llama3.3', fetch: f.fn });
    const out = await collect(p.stream(REQ, new AbortController().signal));
    expect(out).toContainEqual({ type: 'text', text: 'Sure' });
    expect(out).toContainEqual({ type: 'tool_call', call: { id: 'call_1', name: 'applyListFilters', arguments: { filter: { size: ['large'] }, explanation: 'Large' } } });
    expect(out).toContainEqual({ type: 'usage', inputTokens: 900, outputTokens: 30 });
    expect(f.seen[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect((f.seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer local-key-123456');
    const body = JSON.parse(String(f.seen[0]!.init.body));
    expect(body).toMatchObject({ model: 'llama3.3', stream: true, stream_options: { include_usage: true }, tool_choice: 'auto' });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'applyListFilters' } });
  });

  it('needs a model', () => {
    expect(new OpenAICompatProvider({ model: '' }).isConfigured().ok).toBe(false);
  });
});

describe('toGeminiSchema', () => {
  it('converts the LeadFilter tool schema to the OpenAPI subset Gemini accepts', () => {
    const g = toGeminiSchema(leadFilterToolJsonSchema());
    const json = JSON.stringify(g);
    expect(json).not.toMatch(/"additionalProperties"|"\$schema"|"exclusiveMinimum"|"default"|"const"/);
    expect(json).not.toMatch(/"anyOf"/);
    expect(json).not.toMatch(/"format":"date"[,}]/);
    const props = g.properties as Record<string, Record<string, unknown>>;
    expect(g.type).toBe('OBJECT');
    expect(props.scope).toMatchObject({ type: 'STRING', enum: ['mine', 'unallocated', 'all'] });
    expect(props.repId).toMatchObject({ type: 'STRING' });
    expect(props.notContactedSince).toEqual({ type: 'STRING', description: expect.stringMatching(/ISO date.*Format: date-time or date\./) });
    const cf = (props.customFields!.items as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(cf.value).toEqual({ type: 'STRING', description: 'string, number or boolean.' });
    expect(props.near).toMatchObject({ type: 'OBJECT', required: ['zip', 'radiusMiles'], propertyOrdering: ['zip', 'radiusMiles'] });
    expect((props.near!.properties as Record<string, unknown>).radiusMiles).toEqual({ type: 'NUMBER', maximum: 250 });
    expect(props).not.toHaveProperty('cursor');
    expect(props).not.toHaveProperty('limit');
  });

  it('turns [X, null] into nullable X and keeps keys it supports', () => {
    expect(toGeminiSchema({ anyOf: [{ type: 'string', maxLength: 5 }, { type: 'null' }], description: 'd' }))
      .toEqual({ type: 'STRING', maxLength: 5, description: 'd', nullable: true });
    expect(toGeminiSchema({ type: ['integer', 'null'], minimum: 1 })).toEqual({ type: 'INTEGER', minimum: 1, nullable: true });
  });
});

describe('createProvider', () => {
  const env = (over: Record<string, string>) => ({ NODE_ENV: 'production', ...over }) as NodeJS.ProcessEnv;

  it('auto picks Gemini, then Anthropic, then openai_compat, else none', () => {
    expect(resolveProviderName(env({}))).toBeNull();
    expect(createProvider(env({}))).toBeNull();
    expect(resolveProviderName(env({ GEMINI_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-x' }))).toBe('gemini');
    expect(resolveProviderName(env({ GOOGLE_API_KEY: KEY }))).toBe('gemini');
    expect(resolveProviderName(env({ ANTHROPIC_API_KEY: 'sk-ant-x' }))).toBe('anthropic');
    expect(resolveProviderName(env({ LEADMAKER_LLM_BASE_URL: 'http://ollama:11434/v1' }))).toBe('openai_compat');
  });

  it('honours the assistant override, then the shared setting, and the model precedence', () => {
    const p = createProvider(env({ LEADMAKER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: KEY, LEADMAKER_LLM_MODEL: 'gemini-x' }))!;
    expect([p.name, p.model, p.fingerprint]).toEqual(['gemini', 'gemini-x', 'gemini:gemini-x']);
    const a = createProvider(env({ LEADMAKER_ASSISTANT_LLM_PROVIDER: 'anthropic', LEADMAKER_LLM_PROVIDER: 'gemini', LEADMAKER_LLM_MODEL: 'gemini-x', ANTHROPIC_API_KEY: 'sk-ant-y' }))!;
    expect([a.name, a.model]).toEqual(['anthropic', DEFAULT_MODELS.anthropic]);
    const b = createProvider(env({ LEADMAKER_ASSISTANT_LLM_PROVIDER: 'anthropic', LEADMAKER_ASSISTANT_LLM_MODEL: 'claude-z', ANTHROPIC_API_KEY: 'sk-ant-y' }))!;
    expect(b.model).toBe('claude-z');
    expect(createProvider(env({ GEMINI_API_KEY: KEY }))!.model).toBe('gemini-3.5-flash-lite');
    expect(() => createProvider(env({ LEADMAKER_LLM_PROVIDER: 'nope' }))).toThrow(/must be auto or one of/);
  });

  it('redirects Gemini to LEADMAKER_LLM_BASE_URL only when gemini is explicit', async () => {
    const seen: string[] = [];
    const fetch = async (url: string) => {
      seen.push(url);
      return new Response('{}', { status: 500 });
    };
    const auto = createProvider(env({ GEMINI_API_KEY: KEY, LEADMAKER_LLM_BASE_URL: 'http://evil.example/v1' }), { fetch })!;
    const explicit = createProvider(env({ LEADMAKER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: KEY, LEADMAKER_LLM_BASE_URL: 'http://proxy.example/v1beta' }), { fetch })!;
    await collect(auto.stream(REQ, new AbortController().signal)).catch(() => {});
    await collect(explicit.stream(REQ, new AbortController().signal)).catch(() => {});
    expect(seen[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(seen[1]).toMatch(/^http:\/\/proxy\.example\/v1beta\/models\//);
  });

  it('gates the fake in production', () => {
    expect(createProvider(env({ LEADMAKER_LLM_PROVIDER: 'fake' }))!.isConfigured().ok).toBe(false);
    expect(createProvider(env({ LEADMAKER_LLM_PROVIDER: 'fake', LEADMAKER_ALLOW_FAKE_LLM: '1' }))!.isConfigured().ok).toBe(true);
    expect(createProvider({ LEADMAKER_ASSISTANT_LLM_PROVIDER: 'fake', NODE_ENV: 'test' } as NodeJS.ProcessEnv)!.fingerprint).toBe('fake:fake-1');
  });

  it('defaults Gemini 3 to a low thinking level, overridable', () => {
    const body = (e: Record<string, string>) => (createProvider(env({ GEMINI_API_KEY: KEY, ...e })) as GeminiProvider).body(REQ);
    expect(body({}).generationConfig).toEqual({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
    expect(body({ ASSISTANT_GEMINI_THINKING_LEVEL: 'off' }).generationConfig).toEqual({ maxOutputTokens: 2048 });
    expect(body({ LEADMAKER_LLM_MODEL: 'gemini-2.5-flash' }).generationConfig).toEqual({ maxOutputTokens: 2048 });
  });
});
