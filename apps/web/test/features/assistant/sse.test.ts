import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, RateLimitedError } from '@/api/errors';
import { sessionStore } from '@/auth/session';
import {
  AssistantUnavailableError, streamAssistantChat, toAssistantEvent, type AssistantChatRequest, type AssistantEvent,
} from '@/features/assistant/api';
import { createSseParser, readSse } from '@/features/assistant/sse';

const enc = new TextEncoder();

/** A ReadableStream that emits the given chunks (strings are UTF-8 encoded; byte arrays pass through). */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

const sse = (chunks: (string | Uint8Array)[], status = 200) =>
  new Response(streamOf(chunks), { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const REQ: AssistantChatRequest = { messages: [{ role: 'user', content: 'hi' }], context: { page: 'dashboard' } };

describe('createSseParser', () => {
  it('handles events split at every possible chunk boundary', () => {
    const wire = 'event: token\ndata: {"text":"Hel"}\n\nevent: token\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n';
    for (let cut = 1; cut < wire.length; cut++) {
      const p = createSseParser();
      const got = [...p.push(wire.slice(0, cut)), ...p.push(wire.slice(cut))];
      expect(got.map((m) => `${m.event}:${m.data}`), `cut at ${cut}`).toEqual([
        'token:{"text":"Hel"}', 'token:{"text":"lo"}', 'done:{}',
      ]);
    }
  });

  it('returns several events from one chunk, in order', () => {
    const p = createSseParser();
    const got = p.push('event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"text":"b"}\n\nevent: citation\ndata: {"leadId":"x","field":"notes"}\n\n');
    expect(got.map((m) => m.event)).toEqual(['token', 'token', 'citation']);
  });

  it('keeps an incomplete event until its blank line arrives', () => {
    const p = createSseParser();
    expect(p.push('event: token\ndata: {"text":"a"}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
  });

  it('supports CRLF and CR line endings, including a CRLF split across chunks', () => {
    const p = createSseParser();
    expect(p.push('event: token\r\ndata: {"text":"a"}\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
    expect(p.push('data: x\r\r')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('joins multi-line data, ignores comments and unknown fields, strips one leading space only', () => {
    const p = createSseParser();
    const got = p.push(': keep-alive\nretry: 3000\nfoo: bar\nevent:token\ndata:  two spaces\ndata: line 2\nid: 7\n\n');
    expect(got).toEqual([{ event: 'token', data: ' two spaces\nline 2', id: '7' }]);
  });

  it('delivers a named event without data (event: done)', () => {
    expect(createSseParser().push('event: done\n\n')).toEqual([{ event: 'done', data: '' }]);
  });
});

describe('readSse', () => {
  it('decodes UTF-8 characters split across byte chunks', async () => {
    const bytes = enc.encode('event: token\ndata: {"text":"4.8★ é"}\n\n');
    const star = bytes.indexOf(0xe2); // first byte of "★"
    const got = await collect(readSse(streamOf([bytes.slice(0, star + 1), bytes.slice(star + 1, star + 2), bytes.slice(star + 2)])));
    expect(got).toEqual([{ event: 'token', data: '{"text":"4.8★ é"}' }]);
  });

  it('drops a trailing event that never got its blank line', async () => {
    const got = await collect(readSse(streamOf(['event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"text":"cut'])));
    expect(got).toHaveLength(1);
  });
});

describe('toAssistantEvent', () => {
  it('maps the error event, with a fallback message', () => {
    expect(toAssistantEvent({ event: 'error', data: '{"message":"Model quota exceeded","code":"quota"}' }))
      .toEqual({ type: 'error', message: 'Model quota exceeded', code: 'quota' });
    expect(toAssistantEvent({ event: 'error', data: '{}' })).toMatchObject({ type: 'error', message: expect.any(String) });
  });

  it('decodes both tools and rejects malformed ones', () => {
    expect(toAssistantEvent({ event: 'tool', data: '{"name":"apply_filter","filter":{"minRating":4.5},"sort":{"by":"rating","dir":"desc"},"explanation":"x"}' }))
      .toEqual({ type: 'tool', name: 'apply_filter', filter: { minRating: 4.5 }, sort: { by: 'rating', dir: 'desc' }, explanation: 'x' });
    expect(toAssistantEvent({ event: 'tool', data: '{"name":"open_lead","leadId":"abc"}' })).toEqual({ type: 'tool', name: 'open_lead', leadId: 'abc' });
    expect(toAssistantEvent({ event: 'tool', data: '{"name":"apply_filter","filter":"nope"}' })).toBeNull();
    expect(toAssistantEvent({ event: 'tool', data: '{"name":"delete_everything"}' })).toBeNull();
  });

  it('skips unknown events and invalid JSON', () => {
    expect(toAssistantEvent({ event: 'usage', data: '{"tokens":5}' })).toBeNull();
    expect(toAssistantEvent({ event: 'token', data: '{not json' })).toBeNull();
    expect(toAssistantEvent({ event: 'token', data: '{"text":5}' })).toBeNull();
  });
});

describe('streamAssistantChat', () => {
  afterEach(() => sessionStore.set(null));

  it('POSTs the request with the bearer token and yields typed events across chunk boundaries', async () => {
    const fetchMock = vi.fn(async () => sse([
      'event: token\ndata: {"te', 'xt":"Hi "}\n\nevent: tok', 'en\ndata: {"text":"there"}\n\n',
      'event: citation\ndata: {"leadId":"L1","field":"notes"}\n\nevent: done\ndata: {}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const events = await collect(streamAssistantChat(REQ, { token: 'tok' }));
    expect(events).toEqual<AssistantEvent[]>([
      { type: 'token', text: 'Hi ' },
      { type: 'token', text: 'there' },
      { type: 'citation', leadId: 'L1', field: 'notes' },
      { type: 'done' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/assistant/chat');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect(JSON.parse(String(init.body))).toEqual(REQ);
  });

  it('surfaces an error event mid-stream after the tokens before it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(['event: token\ndata: {"text":"Partial"}\n\nevent: error\ndata: {"message":"The model timed out."}\n\n'])));
    const events = await collect(streamAssistantChat(REQ, { token: null }));
    expect(events).toEqual([{ type: 'token', text: 'Partial' }, { type: 'error', message: 'The model timed out.' }]);
  });

  it.each([
    ['route 404', () => json({ error: 'not_found' }, 404)],
    ['502 bad gateway', () => new Response('Bad Gateway', { status: 502 })],
    ['501', () => json({ error: 'not_implemented' }, 501)],
    ['200 that is not a stream (SPA fallback)', () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
  ])('treats %s as "not connected"', async (_name, res) => {
    vi.stubGlobal('fetch', vi.fn(async () => res()));
    await expect(collect(streamAssistantChat(REQ, { token: null }))).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it('keeps real errors as API errors (invisible lead, rate limit)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'lead_not_found' }, 404)));
    await expect(collect(streamAssistantChat(REQ, { token: null }))).rejects.toBeInstanceOf(NotFoundError);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'rate_limited' }, 429, { 'Retry-After': '4' })));
    await expect(collect(streamAssistantChat(REQ, { token: null }))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('signs the user out on 401, like every other API call', async () => {
    sessionStore.set({ token: 't', user: { id: 'u', name: 'Sam', email: 's@x', role: 'rep' } as never });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthenticated' }, 401)));
    await expect(collect(streamAssistantChat(REQ))).rejects.toThrow();
    expect(sessionStore.get()).toBeNull();
  });

  it('stops reading when aborted', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: token\ndata: {"text":"a"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const ctrl = new AbortController();
    const got: AssistantEvent[] = [];
    for await (const ev of streamAssistantChat(REQ, { token: null, signal: ctrl.signal })) {
      got.push(ev);
      ctrl.abort();
    }
    expect(got).toEqual([{ type: 'token', text: 'a' }]);
    expect(cancelled).toBe(true);
  });
});
