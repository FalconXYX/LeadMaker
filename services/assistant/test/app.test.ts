// The HTTP surface end to end with the fake provider and an in-memory QueryClient + counters: pre-stream errors in
// order, the SSE flows, /status, per-user limits, logging without content and key redaction.
import { leadFilterSchema } from '@leadmaker/shared';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { StreamRegistry, createApp, type AppDeps } from '../src/app.ts';
import { CircuitBreaker } from '../src/circuit.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { MemoryStore, ProviderBudgetLimiter, UserLimits, type CounterStore } from '../src/limits.ts';
import { FakeProvider } from '../src/llm/fake.ts';
import { LlmAuthError, type ChatDelta, type LlmProvider } from '../src/llm/types.ts';
import { createLogger } from '../src/log.ts';
import { Redactor } from '../src/redact.ts';
import { FakeQuery, LEAD_OWN, LEAD_POOL, LEAD_THEIRS, NOW, REP1, chat, parseSseBody, script } from './helpers.ts';

const TOKEN = 'test-internal-token';
const KEY = 'AIzaSyFAKE-not-a-real-key-0123456789abc';

interface Setup {
  provider?: LlmProvider | null;
  query?: FakeQuery;
  config?: Partial<Config>;
  user?: Partial<Config['user']>;
  store?: CounterStore;
}

function setup(s: Setup = {}) {
  const lines: string[] = [];
  const redactor = new Redactor([KEY, TOKEN]);
  const log = createLogger('info', redactor, { write: (l: string) => void lines.push(l) } as never);
  const base = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'fake' });
  const config: Config = { ...base, pingMs: 0, ...s.config, user: { ...base.user, ...s.user } };
  const provider = s.provider === undefined ? new FakeProvider() : s.provider;
  const query = s.query ?? new FakeQuery();
  const store = s.store ?? new MemoryStore();
  const streams = new StreamRegistry();
  const deps: AppDeps = {
    config, log, provider, queryFor: () => query,
    userLimits: new UserLimits(store, config.user),
    budget: provider ? new ProviderBudgetLimiter(store, provider.fingerprint, { rpm: 0, rpd: 0, dayTz: 'America/Los_Angeles' }, () => NOW) : null,
    circuit: new CircuitBreaker(),
    now: () => NOW,
  };
  const app = createApp(deps, streams);
  const post = (body: unknown, viewer = REP1) => request(app).post('/api/assistant/chat')
    .set('x-internal-token', TOKEN).set('x-user-id', viewer.id).set('x-user-role', viewer.role)
    .set('accept', 'text/event-stream').send(body as object);
  const status = (viewer = REP1) => request(app).get('/api/assistant/status')
    .set('x-internal-token', TOKEN).set('x-user-id', viewer.id).set('x-user-role', viewer.role);
  return { app, post, status, lines, query, deps, streams, store };
}

const events = (res: request.Response) => parseSseBody(res.text);

describe('POST /api/assistant/chat: before the stream', () => {
  it('401 without the internal hop headers', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/assistant/chat').send(chat('x'));
    expect(res.status).toBe(401);
    const spoofed = await request(app).post('/api/assistant/chat').set('x-internal-token', 'nope').set('x-user-id', REP1.id).set('x-user-role', 'rep').send(chat('x'));
    expect(spoofed.status).toBe(401);
  });

  it('413 over 64 KB', async () => {
    const { post } = setup();
    const res = await post({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }], context: { page: 'leads' } });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'payload_too_large' });
  });

  it.each([
    [{ messages: [], context: { page: 'leads' } }],
    [{ messages: [{ role: 'assistant', content: 'hi' }], context: { page: 'leads' } }],
    [{ messages: [{ role: 'user', content: 'x'.repeat(4001) }], context: { page: 'leads' } }],
    [{ messages: [{ role: 'user', content: 'hi' }], context: { page: 'settings' } }],
    [{ messages: [{ role: 'system', content: 'hi' }], context: { page: 'leads' } }],
    [{ messages: Array.from({ length: 21 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })), context: { page: 'leads' } }],
  ])('400 invalid_request (%#)', async (body) => {
    const { post, query } = setup();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request', message: expect.any(String) });
    expect(query.calls).toEqual([]);
  });

  it('404 lead_not_found for a bad id or a lead the user cannot view', async () => {
    const { post } = setup();
    expect((await post(chat('hi', { page: 'profile', leadId: 'not-a-uuid' }))).body).toEqual({ error: 'lead_not_found' });
    const theirs = await post(chat('hi', { page: 'profile', leadId: LEAD_THEIRS }));
    expect([theirs.status, theirs.body]).toEqual([404, { error: 'lead_not_found' }]);
  });

  it('503 busy when the lead context cannot be read', async () => {
    const query = new FakeQuery();
    query.aiContext = async () => {
      throw new Error('query down');
    };
    const { post } = setup({ query });
    const res = await post(chat('hi', { page: 'profile', leadId: LEAD_OWN }));
    expect([res.status, res.headers['retry-after'], res.body]).toEqual([503, '2', { error: 'busy', retryAfterMs: 2000 }]);
  });

  it('the 7th request in a minute gets 429 with Retry-After', async () => {
    const { post } = setup();
    for (let i = 0; i < 6; i++) expect((await post(chat('Show me Master Elite roofers'))).status).toBe(200);
    const res = await post(chat('Show me Master Elite roofers'));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('429 beyond the open streams per user, 503 beyond the instance cap', async () => {
    const slow = script({ delayMs: 400 }, { text: 'done' });
    const user = setup({ user: { maxStreams: 1 } });
    const [a, b] = await Promise.all([user.post(chat(slow)), new Promise((r) => setTimeout(r, 100)).then(() => user.post(chat(slow)))]);
    expect(a.status).toBe(200);
    expect([b.status, b.headers['retry-after'], b.body.error]).toEqual([429, '2', 'rate_limited']);
    // The slot is released after the stream.
    expect((await user.post(chat('Show me Master Elite roofers'))).status).toBe(200);

    const inst = setup({ config: { maxStreams: 1 } });
    const [c, d] = await Promise.all([inst.post(chat(slow)), new Promise((r) => setTimeout(r, 100)).then(() => inst.post(chat(slow)))]);
    expect(c.status).toBe(200);
    expect([d.status, d.body]).toEqual([503, { error: 'busy', retryAfterMs: 2000 }]);
  });
});

describe('POST /api/assistant/chat: the stream', () => {
  it('NL filter: `: ok`, tool apply_filter (scope mine, matchCount), token, done', async () => {
    const { post } = setup();
    const res = await post(chat("Master Elite contractors doing metal roofs near 10013 that I haven't checked yet"));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.text.startsWith(': ok\n\n')).toBe(true);
    const evs = events(res).filter((e) => e.event !== 'status');
    expect(events(res).map((e) => e.event)).toEqual(['status', 'status', 'tool', 'token', 'done']);
    expect(evs[0]!.data).toMatchObject({ name: 'apply_filter', filter: { scope: 'mine' }, matchCount: expect.any(Number) });
    expect(leadFilterSchema.safeParse(evs[0]!.data.filter).success).toBe(true);
    expect(evs[2]!.data).toMatchObject({ promptVersion: 'assistant/v2', usage: { llmCalls: 1 } });
  });

  it('Q&A on a pool lead: citations carry that lead', async () => {
    const { post, query } = setup();
    const evs = events(await post(chat('Summarize this contractor', { page: 'profile', leadId: LEAD_POOL })));
    const cites = evs.filter((e) => e.event === 'citation');
    expect(cites.length).toBeGreaterThan(0);
    for (const c of cites) expect(c.data).toMatchObject({ leadId: LEAD_POOL, leadName: 'Pool Roofing Co' });
    expect(query.calls.find((c) => c.op === 'aiContext')).toMatchObject({ viewer: REP1, arg: LEAD_POOL });
    expect(evs.at(-1)!.event).toBe('done');
  });

  it('drops an invalid context.filter instead of rejecting, and uses a valid one', async () => {
    const provider = new FakeProvider();
    const { post } = setup({ provider });
    expect((await post({ ...chat('Only the ones in Bergen'), context: { page: 'leads', filter: { minRating: 'high' } }, extra: 1 })).status).toBe(200);
    expect(provider.calls[0]!.messages.at(-1)!.content).not.toContain('<current_filter>');
    await post({ ...chat('Only the ones in Bergen'), context: { page: 'leads', filter: { certifications: ['gaf:master_elite'], limit: 50 } } });
    expect(provider.calls[1]!.messages.at(-1)!.content).toContain('<current_filter>{"certifications":["gaf:master_elite"]}</current_filter>');
  });

  it('a daily cap of 1 gives user_daily_limit on the 2nd request', async () => {
    const { post, status } = setup({ user: { perDay: 1 } });
    expect(events(await post(chat('Show me Master Elite roofers'))).at(-1)!.event).toBe('done');
    const evs = events(await post(chat('Show me Master Elite roofers')));
    expect(evs).toEqual([{ event: 'error', data: { code: 'user_daily_limit', retryable: false, message: "You've reached today's limit of 1 assistant questions. It resets at midnight ET." } }]);
    expect((await status()).body.limits).toEqual({ perMinute: 6, perDay: 1, usedToday: 2 });
  });

  it('logs one line per request with counts, never the question or the context', async () => {
    const { post, lines } = setup();
    await post(chat('Summarize this contractor SECRET-QUESTION-TEXT', { page: 'profile', leadId: LEAD_OWN }));
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'assistant request');
    expect(line).toMatchObject({
      userId: REP1.id, role: 'rep', page: 'profile', hasLead: true, promptVersion: 'assistant/v2', provider: 'fake', model: 'fake-1',
      llmCalls: 1, tools: [], outcome: 'done', status: 200,
    });
    expect(lines.join('')).not.toMatch(/SECRET-QUESTION-TEXT|Carework|late deliveries/);
  });
});

describe('GET /api/assistant/status', () => {
  it('available with the fake provider', async () => {
    const { status } = setup();
    const res = await status();
    expect(res.body).toEqual({ available: true, reason: 'ok', provider: 'fake', model: 'fake-1', resetsAt: null, limits: { perMinute: 6, perDay: 150, usedToday: 0 } });
  });

  it('A4: not configured -> status not_configured and chat errors without a provider call', async () => {
    const none = setup({ provider: null });
    expect((await none.status()).body).toMatchObject({ available: false, reason: 'not_configured', provider: null });
    expect(events(await none.post(chat('Show me Master Elite roofers')))).toEqual([
      { event: 'error', data: expect.objectContaining({ code: 'ai_not_configured', retryable: false }) },
    ]);
    const stream = vi.fn();
    const unconfigured: LlmProvider = { name: 'gemini', model: 'gemini-3.8-flash', fingerprint: 'gemini:gemini-3.8-flash', isConfigured: () => ({ ok: false, reason: 'no key' }), stream };
    const off = setup({ provider: unconfigured });
    expect((await off.status()).body).toMatchObject({ reason: 'not_configured', provider: 'gemini' });
    expect(events(await off.post(chat('x'))).at(-1)!.data).toMatchObject({ code: 'ai_not_configured' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('quota_exhausted after a quota error, until reset', async () => {
    const { post, status } = setup();
    const evs = events(await post(chat(script({ error: 'quota' }))));
    expect(evs.at(-1)!.data).toMatchObject({ code: 'ai_quota_exhausted', retryable: false, resetsAt: '2026-10-20T07:00:00.000Z' });
    expect((await status()).body).toMatchObject({ available: false, reason: 'quota_exhausted', resetsAt: '2026-10-20T07:00:00.000Z' });
    // The next chat fails fast from the budget, without calling the provider.
    expect(events(await post(chat('Show me Master Elite roofers'))).at(-1)!.data).toMatchObject({ code: 'ai_quota_exhausted' });
  });

  it('provider_down while the circuit is open', async () => {
    const s = setup();
    s.deps.circuit.recordFailure();
    s.deps.circuit.recordFailure();
    s.deps.circuit.recordFailure();
    expect((await s.status()).body).toMatchObject({ available: false, reason: 'provider_down' });
  });
});

describe('secrets', () => {
  it('a key inside a provider error never reaches the logs or the stream', async () => {
    const leaky: LlmProvider = {
      name: 'gemini', model: 'gemini-3.8-flash', fingerprint: 'gemini:gemini-3.8-flash', isConfigured: () => ({ ok: true }),
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ChatDelta> {
        throw new LlmAuthError(`HTTP 400 INVALID_ARGUMENT: API key not valid (${KEY}); url=https://x/?key=${KEY}; x-goog-api-key: ${KEY}`, { provider: 'gemini', status: 400 });
      },
    };
    const { post, lines } = setup({ provider: leaky });
    const res = await post(chat('Show me Master Elite roofers'));
    expect(events(res).at(-1)!.data).toMatchObject({ code: 'ai_not_configured' });
    const all = lines.join('\n');
    expect(all).toContain('[redacted]');
    expect(all).toContain('LLM provider rejected the credentials');
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/AIza|sk-ant-/);
    expect(res.text).not.toContain(KEY);
  });
});
