// Fixes from the Section 4 reviews (2026-10-19), each with its repro: the call-first order (product H1), model
// fallback and per-user call shares (product H2, security M2), usage charged on abort (security M3), history caps
// after NFKC (security L2), rep scope widening (AI M5), citation punctuation (AI L4), the quota reset hint and its
// day word (product M7), progress events (product M1), and the config defaults behind them.
import type { AssistantEvent, LeadFilter, LeadSearchResult, LeadSummary, Viewer } from '@leadmaker/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { StreamRegistry, createApp, type AppDeps } from '../src/app.ts';
import { CitationExtractor } from '../src/citations.ts';
import { CircuitBreaker } from '../src/circuit.ts';
import { configWarnings, loadConfig, parseFallbackModels } from '../src/config.ts';
import { runAssistant } from '../src/engine.ts';
import { errorPayload } from '../src/errors.ts';
import { MemoryStore, ProviderBudgetLimiter, UserLimits } from '../src/limits.ts';
import { FakeProvider } from '../src/llm/fake.ts';
import { GeminiProvider } from '../src/llm/gemini.ts';
import { LlmQuotaExceeded, type ChatDelta, type LlmProvider } from '../src/llm/types.ts';
import { createLogger } from '../src/log.ts';
import { buildHistory } from '../src/prompt.ts';
import { Redactor } from '../src/redact.ts';
import { WIDENED_NOTE } from '../src/tools.ts';
import { FakeQuery, NOW, REP1, chat, collector, parseSseBody, script, summary } from './helpers.ts';

const TOKEN = 'test-internal-token';

/** A QueryClient whose search answers per filter shape (todaysCalls' four groups, scope widening). */
class ShapedQuery extends FakeQuery {
  readonly answer: (f: LeadFilter) => { items: LeadSummary[]; total?: number };

  constructor(answer: (f: LeadFilter) => { items: LeadSummary[]; total?: number }) {
    super();
    this.answer = answer;
  }

  override async search(viewer: Viewer, filter: LeadFilter): Promise<LeadSearchResult> {
    this.calls.push({ op: 'search', viewer, arg: filter });
    const { items, total } = this.answer(filter);
    return { items: items.slice(0, filter.limit ?? 50), nextCursor: null, total: total ?? items.length, totalCapped: false };
  }
}

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const task = (dueAt: string, title: string) => ({ id: id(99), title, type: 'call' as const, dueAt, status: 'open' }) as unknown as LeadSummary['nextTask'];

describe('todaysCalls (product H1): follow-ups before priority', () => {
  const hot = summary(id(1), 'Jersey Roofing', { priorityScore: 83, salesStage: 'new' });
  const overdue = summary(id(2), 'Carework Construction', { priorityScore: 40, salesStage: 'interested', nextTask: task('2026-10-15T14:00:00Z', 'Send the quote') });
  const today = summary(id(3), 'Complete Roof Systems', { priorityScore: 74, salesStage: 'quoting', nextTask: task('2026-10-19T16:00:00Z', 'Call back') });
  const quiet = summary(id(4), 'Kelly Exteriors', { priorityScore: 78, salesStage: 'interested', lastContactedAt: '2026-10-05T15:00:00Z' });
  const query = new ShapedQuery((f) => {
    if (f.followUp === 'overdue') return { items: [overdue], total: 4 };
    if (f.followUp === 'today') return { items: [today, overdue], total: 9 };
    if (f.stages?.includes('interested')) return { items: [quiet, overdue] };
    return { items: [hot, today] };
  });

  it('returns the dashboard order with reasons and counts, scoped to the rep', async () => {
    const c = collector();
    const provider = new FakeProvider({ now: () => NOW });
    const result = await runAssistant({ request: chat('Which of my leads should I call first today, and why?', { page: 'dashboard' }), viewer: REP1, leadContext: null },
      { provider, query, now: () => NOW }, c.emit, new AbortController().signal);
    expect(result.toolCalls.map((t) => t.name)).toEqual(['todaysCalls']);
    const payload = JSON.parse(provider.calls[1]!.messages.at(-1)!.content);
    expect(payload).toMatchObject({ ok: true, overdue: 4, dueToday: 9 });
    expect(payload.leads.map((l: { name: string }) => l.name)).toEqual(['Carework Construction', 'Complete Roof Systems', 'Kelly Exteriors', 'Jersey Roofing']);
    expect(payload.leads[0].reason).toBe('follow-up overdue since 2026-10-15: Send the quote');
    expect(payload.leads[1].reason).toBe('follow-up due today: Call back');
    expect(payload.leads[2].reason).toBe('interested, last contacted 2026-10-05');
    expect(payload.leads[3].reason).toBe('new lead, priority 83');
    const searches = query.calls.filter((x) => x.op === 'search').map((x) => x.arg as LeadFilter);
    expect(searches.every((f) => f.scope === 'mine')).toBe(true);
    expect(searches.find((f) => f.stages?.includes('interested'))).toMatchObject({ notContactedSince: '2026-10-12' });
    const text = c.events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(text).toMatch(/^4 follow-ups are overdue and 9 due today\. Call first: \[Carework Construction\]/);
    expect(c.events.filter((e) => e.type === 'status').map((e) => (e as { text: string }).text))
      .toEqual(['Thinking…', 'Checking today’s follow-ups…', 'Writing the answer…']);
  });
});

describe('rep scope widening (AI M5): "roofers in Brooklyn"', () => {
  const pool = summary(id(5), 'Brooklyn Roof Co');
  const query = new ShapedQuery((f) => (f.scope === 'mine' ? { items: [] } : { items: [pool], total: 14 }));

  it('applyListFilters widens a defaulted "mine" with 0 matches to the rep\'s pool view and says so', async () => {
    const c = collector();
    await runAssistant({ request: chat(script({ tool: 'applyListFilters', args: { filter: { counties: ['36047'] }, explanation: 'Brooklyn roofers' } })), viewer: REP1, leadContext: null },
      { provider: new FakeProvider(), query, now: () => NOW }, c.emit, new AbortController().signal);
    const tool = c.events.find((e) => e.type === 'tool') as Extract<AssistantEvent, { type: 'tool' }> & { filter: LeadFilter; matchCount: number; explanation: string };
    expect(tool.filter).toEqual({ scope: 'all', counties: ['36047'] });
    expect(tool.matchCount).toBe(14);
    expect(tool.explanation).toContain(WIDENED_NOTE.slice(0, 20));
    // the rep's "all" is sent to the search API as no scope (their default visibility)
    expect((query.calls.at(-1)!.arg as LeadFilter).scope).toBeUndefined();
  });

  it('an explicit "my leads" is never widened', async () => {
    const c = collector();
    await runAssistant({ request: chat(script({ tool: 'applyListFilters', args: { filter: { scope: 'mine', counties: ['36047'] }, explanation: 'mine' } })), viewer: REP1, leadContext: null },
      { provider: new FakeProvider(), query, now: () => NOW }, c.emit, new AbortController().signal);
    const tool = c.events.find((e) => e.type === 'tool') as unknown as { filter: LeadFilter; matchCount: number };
    expect(tool.filter.scope).toBe('mine');
    expect(tool.matchCount).toBe(0);
  });
});

describe('usage on abort (security M3)', () => {
  it('charges the latest reported usage when the client disconnects mid-answer', async () => {
    const abort = new AbortController();
    const provider: LlmProvider = {
      name: 'gemini', model: 'm', fingerprint: 'gemini:m', isConfigured: () => ({ ok: true }),
      async *stream(_req, signal): AsyncIterable<ChatDelta> {
        yield { type: 'usage', inputTokens: 9900, outputTokens: 40 };
        yield { type: 'text', text: 'Half an' };
        abort.abort(new Error('client closed the stream'));
        if (signal.aborted) throw signal.reason;
      },
    };
    const result = await runAssistant({ request: chat('x'), viewer: REP1, leadContext: null },
      { provider, query: new FakeQuery(), now: () => NOW }, () => {}, abort.signal);
    expect(result.usage).toEqual({ inputTokens: 9900, outputTokens: 40 });
  });

  it('estimates from the request size when a call is cut off before any usage report', async () => {
    const abort = new AbortController();
    const provider: LlmProvider = {
      name: 'gemini', model: 'm', fingerprint: 'gemini:m', isConfigured: () => ({ ok: true }),
      async *stream(_req, signal): AsyncIterable<ChatDelta> {
        abort.abort(new Error('client closed the stream'));
        if (signal.aborted) throw signal.reason;
        yield { type: 'text', text: 'never' };
      },
    };
    const result = await runAssistant({ request: chat('x'), viewer: REP1, leadContext: null },
      { provider, query: new FakeQuery(), now: () => NOW }, () => {}, abort.signal);
    expect(result.usage.inputTokens).toBeGreaterThan(3000); // system prompt + tool schemas, 4 chars a token
  });

  it('the Gemini parser reports usage as it arrives, not only at the end', async () => {
    const body = ['data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":9940,"candidatesTokenCount":1}}\n\n'];
    const fetch = async () => new Response(new ReadableStream({
      start(c) {
        for (const b of body) c.enqueue(new TextEncoder().encode(b));
        c.close(); // ends without a final chunk: the client went away after the first text
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const g = new GeminiProvider({ apiKey: 'k', model: 'gemini-x', fetch });
    const seen: ChatDelta[] = [];
    const ctrl = new AbortController();
    try {
      for await (const d of g.stream({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], toolChoice: 'auto', maxOutputTokens: 64 }, ctrl.signal)) {
        seen.push(d);
        if (d.type === 'text') ctrl.abort(new Error('gone'));
      }
    } catch { /* aborted */ }
    expect(seen.find((d) => d.type === 'usage')).toEqual({ type: 'usage', inputTokens: 9940, outputTokens: 1 });
  });
});

describe('history caps after fencing (security L2)', () => {
  it('a 16 KB request of U+FDFA no longer becomes ~96,000 characters of history', () => {
    const ligature = 'ﷺ'.repeat(1330); // 1,330 chars that NFKC expands to ~24,000
    const messages = [
      ...Array.from({ length: 4 }, () => ({ role: 'user' as const, content: ligature })),
      { role: 'user' as const, content: 'question' },
    ];
    const history = buildHistory({ messages, context: { page: 'leads' } });
    const total = history.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(24_000);
    expect(history.every((m) => m.content.length <= 8000)).toBe(true);
    expect(history[0]!.role).toBe('user');
  });
});

describe('citation punctuation (AI L4)', () => {
  it.each([
    ['for a strip-mall job, [src:activity].', 'for a strip-mall job.'],
    ['They rate 4.8 stars [src:details], and quote TPO [src:activity].', 'They rate 4.8 stars, and quote TPO.'],
    ['Note: [src:notes] they want TPO.', 'Note: they want TPO.'],
    ['Buys 1,000 squares [src:notes], mostly shingles.', 'Buys 1,000 squares, mostly shingles.'],
    ['job, [src:x], next', 'job, next'],
  ])('%s', (input, expected) => {
    let out = '';
    const ex = new CitationExtractor({ id: 'x', businessName: 'X' } as never, { text: (t) => { out += t; }, citation: () => {} });
    for (const ch of input) ex.push(ch); // one character at a time: chunk boundaries everywhere
    ex.flush();
    expect(out).toBe(expected);
  });
});

describe('quota reset (product M7)', () => {
  it('a daily 429 resets at the RetryInfo hint when it is earlier than midnight Pacific', () => {
    const now = new Date('2026-10-19T09:08:41Z');
    const g = new GeminiProvider({ apiKey: 'k', model: 'gemini-x', now: () => now });
    const e = g.classify({
      status: 429, headers: new Headers(), text: '',
      body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
        { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '53478.9s' },
      ] } },
    }) as LlmQuotaExceeded;
    expect(e).toBeInstanceOf(LlmQuotaExceeded);
    expect(e.resetsAt!.toISOString()).toBe('2026-10-19T23:59:59.900Z'); // 09:08:41Z + 14h51m18.9s
    const noHint = g.classify({ status: 429, headers: new Headers(), text: '', body: { error: { details: [{ violations: [{ quotaId: 'PerDay' }] }] } } }) as LlmQuotaExceeded;
    expect(noHint.resetsAt!.toISOString()).toBe('2026-10-20T07:00:00.000Z');
  });

  it('the copy names the day and keeps the way forward', () => {
    const at = new Date('2026-10-20T07:00:00Z');
    expect(errorPayload('ai_quota_exhausted', { resetsAt: at, now: new Date('2026-10-19T09:00:00Z') }).message)
      .toBe("The AI's daily limit is used up. It resets tomorrow at 3:00 AM ET. Lists, filters and profiles work as usual.");
    expect(errorPayload('ai_quota_exhausted', { resetsAt: at, now: new Date('2026-10-20T05:00:00Z') }).message).toMatch(/resets today at 3:00 AM ET/);
  });
});

// ---- the HTTP app: fallback models and per-user call shares ---------------------------------------------------

/** A FakeProvider whose every call fails with the provider's daily-quota error (a real 429, not a script). */
class SpentProvider extends FakeProvider {
  override async *stream(req: Parameters<FakeProvider['stream']>[0]): AsyncIterable<ChatDelta> {
    this.calls.push(req);
    throw new LlmQuotaExceeded('HTTP 429 RESOURCE_EXHAUSTED [PerDay]', { provider: 'fake', status: 429, resetsAt: new Date('2026-10-20T07:00:00Z') });
  }
}

function app(opts: { fallback?: boolean; callsPerDay?: number; primaryRpd?: number; spent?: boolean } = {}) {
  const store = new MemoryStore();
  const lines: string[] = [];
  const log = createLogger('info', new Redactor([TOKEN]), { write: (l: string) => void lines.push(l) } as never);
  const base = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'fake' });
  const config = { ...base, pingMs: 0, user: { ...base.user, callsPerDay: opts.callsPerDay ?? 100 } };
  const primary = opts.spent ? new SpentProvider({ model: 'primary', now: () => NOW }) : new FakeProvider({ model: 'primary', now: () => NOW });
  const backup = new FakeProvider({ model: 'backup', now: () => NOW });
  const budget = (p: LlmProvider, rpd = 0) => new ProviderBudgetLimiter(store, p.fingerprint, { rpm: 0, rpd, dayTz: 'America/Los_Angeles' }, () => NOW);
  const deps: AppDeps = {
    config, log, provider: primary, queryFor: () => new FakeQuery(),
    userLimits: new UserLimits(store, config.user),
    budget: budget(primary, opts.primaryRpd ?? 0),
    fallbacks: opts.fallback ? [{ provider: backup, budget: budget(backup) }] : [],
    circuit: new CircuitBreaker(),
    now: () => NOW,
  };
  const a = createApp(deps, new StreamRegistry());
  const hdr = (r: request.Test) => r.set('x-internal-token', TOKEN).set('x-user-id', REP1.id).set('x-user-role', 'rep');
  return {
    primary, backup, lines,
    post: (body: unknown) => hdr(request(a).post('/api/assistant/chat')).send(body as object),
    status: () => hdr(request(a).get('/api/assistant/status')),
  };
}

describe('fallback models (product H2)', () => {
  it('moves to the next model when the primary\'s day is spent, and status names the model in use', async () => {
    const s = app({ fallback: true, spent: true });
    const first = parseSseBody((await s.post(chat('Show me Master Elite roofers'))).text);
    // the primary's quota error was not shown: the backup answered the same request
    expect(first.some((e) => e.event === 'error')).toBe(false);
    expect(first.at(-1)!.event).toBe('done');
    expect(s.primary.calls).toHaveLength(1);
    expect(s.backup.calls).toHaveLength(1);
    expect((await s.status()).body).toMatchObject({ available: true, reason: 'ok', model: 'backup' });
    // the next request goes straight to the backup
    await s.post(chat('Show me Master Elite roofers'));
    expect(s.primary.calls).toHaveLength(1);
    expect(s.backup.calls).toHaveLength(2);
    expect(s.lines.join('\n')).toContain('trying the next model');
  });

  it('without a fallback the quota error is shown as before', async () => {
    const s = app({ spent: true });
    const evs = parseSseBody((await s.post(chat('Show me Master Elite roofers'))).text);
    expect(evs.at(-1)).toMatchObject({ event: 'error', data: { code: 'ai_quota_exhausted' } });
    expect((await s.status()).body).toMatchObject({ available: false, reason: 'quota_exhausted', model: 'primary' });
  });
});

describe('per-user call share (security M2)', () => {
  it('one user cannot spend more than their share; the global budget is untouched once it is reached', async () => {
    const s = app({ callsPerDay: 2, primaryRpd: 50 });
    // "which should I call first" makes 2 provider calls: the share is used up
    await s.post(chat('Which of my leads should I call first today?', { page: 'dashboard' }));
    expect(s.primary.calls).toHaveLength(2);
    const evs = parseSseBody((await s.post(chat('Show me Master Elite roofers'))).text);
    expect(evs.at(-1)).toMatchObject({ event: 'error', data: { code: 'user_daily_limit', retryable: false } });
    expect(s.primary.calls).toHaveLength(2);
  });

  it('defaults to a quarter of the day budget, and warns when one user could drain it', () => {
    const gemini = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k',
      LEADMAKER_ASSISTANT_RPD: '100', LEADMAKER_ASSISTANT_FALLBACK_MODELS: 'gemini-3.8-flash:20, gemini-3.6-flash' });
    expect(gemini.fallbackModels).toEqual([{ model: 'gemini-3.8-flash', rpd: 20 }, { model: 'gemini-3.6-flash', rpd: 0 }]);
    expect(gemini.user.callsPerDay).toBe(55); // (100 + 20 + 100) / 4
    expect(configWarnings(gemini, {})).toEqual([]);
    const greedy = { ...gemini, user: { ...gemini.user, callsPerDay: 500 } };
    expect(configWarnings(greedy, {})[0]).toMatch(/one user can spend the whole team's AI day/);
    const defaults = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    // flash-lite primary (100 a day for the assistant) with gemini-3.8-flash (20) behind it: 30 calls per user
    expect([defaults.providerRpd, defaults.fallbackModels, defaults.user.callsPerDay]).toEqual([100, [{ model: 'gemini-3.8-flash', rpd: 20 }], 30]);
    const off = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', LEADMAKER_ASSISTANT_FALLBACK_MODELS: 'none' });
    expect([off.fallbackModels, off.user.callsPerDay]).toEqual([[], 25]);
    const claude = loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: TOKEN, LEADMAKER_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' });
    expect([claude.providerRpm, claude.providerRpd]).toEqual([120, 5000]); // a cost ceiling for paid providers
    expect(configWarnings({ ...defaults, internalToken: 'dev-internal-token-change-me' }, { NODE_ENV: 'production' }))
      .toContain('INTERNAL_TOKEN is the public development default: set a secret INTERNAL_TOKEN for every service');
  });

  it('parses fallback lists strictly', () => {
    expect(parseFallbackModels(' a-1:5 ,b ,a-1 ')).toEqual([{ model: 'a-1', rpd: 5 }, { model: 'b', rpd: 0 }]);
    expect(() => parseFallbackModels('bad model')).toThrow(/model\[:requests per day\]/);
  });
});

describe('fake parity (AI L5): a model that writes text and then calls applyListFilters', () => {
  it('keeps the model\'s own words and does not add the server sentence; the filter still applies', async () => {
    const c = collector();
    const r = await runAssistant({ request: chat(script({ text: 'Here are the Master Elite roofers.', tool: 'applyListFilters', args: { filter: { certifications: ['gaf:master_elite'] }, explanation: 'Master Elite' } })), viewer: REP1, leadContext: null },
      { provider: new FakeProvider(), query: new FakeQuery(), now: () => NOW }, c.emit, new AbortController().signal);
    const text = c.events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Here are the Master Elite roofers.');
    expect(r.appliedFilter).toMatchObject({ scope: 'mine', certifications: ['gaf:master_elite'] });
    const types = c.events.map((e) => e.type).filter((t) => t !== 'status').filter((t, i, a) => t !== a[i - 1]);
    expect(types).toEqual(['token', 'tool', 'done']); // text (in chunks), then the tool, no sentence after it
  });
});
