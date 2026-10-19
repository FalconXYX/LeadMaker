// The assistant's pure pieces for Section 4: filter coercion and chips, event decoding, the status endpoint and
// line, history sizing and the match count label.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { sessionStore } from '@/auth/session';
import { getAssistantStatus, toAssistantEvent, toAssistantStatus } from '@/features/assistant/api';
import { requestError } from '@/features/assistant/context';
import { coerceFilter, describeFilter } from '@/features/assistant/filters';
import { isMatchSentence } from '@/features/assistant/Messages';
import { pausedMessage, resetLabel, statusLine } from '@/features/assistant/Panel';
import { pitchSuggestion } from '@/features/assistant/pageContext';
import type { TimingBadge } from '@/api/types';
import { HISTORY_LIMITS, buildHistory, emptyReply, reducer, type AssistantMessage, type ChatMessage } from '@/features/assistant/state';
import { matchCountLabel } from '@/features/assistant/ToolCards';
import { NetworkError, NotFoundError, RateLimitedError, ApiError } from '@/api/errors';
import { leadsHref } from '@/lib/filterUrl';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

describe('coerceFilter', () => {
  it('keeps stages, counties, follow-up, not-contacted-since and minimum priority through the list URL', () => {
    const f = coerceFilter({
      stages: ['interested', 'quoting'], counties: ['34003', '36047'], followUp: 'week',
      notContactedSince: '2026-10-05', minPriority: 70,
    });
    expect(f).toEqual({
      stages: ['interested', 'quoting'], counties: ['34003', '36047'], followUp: 'week', notContactedSince: '2026-10-05', minPriority: 70,
    });
    expect(leadsHref(f!)).toBe('/leads?stage=interested&stage=quoting&county=34003&county=36047&followUp=week&notContactedSince=2026-10-05&minPriority=70');
  });

  it('drops values the list can’t carry', () => {
    expect(coerceFilter({
      stages: ['interested', 'bogus', 3], counties: ['Bergen', '34003'], followUp: 'someday', notContactedSince: 'last week', minPriority: 400,
    })).toEqual({ stages: ['interested'], counties: ['34003'] });
    expect(coerceFilter({ minPriority: '70', followUp: 1 })).toEqual({});
  });

  it('keeps updatedInLastPoll true only', () => {
    expect(coerceFilter({ updatedInLastPoll: true })).toEqual({ updatedInLastPoll: true });
    expect(coerceFilter({ updatedInLastPoll: false })).toEqual({});
  });
});

describe('describeFilter', () => {
  it('has chips for stages, counties, follow-up, not contacted since, priority and new', () => {
    const chips = describeFilter({
      stages: ['quoting', 'lost'], counties: ['34003', '36061', '99999'], followUp: 'today', notContactedSince: '2026-09-30',
      minPriority: 70, updatedInLastPoll: true,
    });
    expect(chips.map((c) => [c.facet, c.label])).toEqual([
      ['Stage', 'Quoting'], ['Stage', 'Not a fit'],
      ['County', 'Bergen'], ['County', 'Manhattan'], ['County', '99999'],
      ['Follow-up', 'today'], ['Not contacted', 'since Sep 30'], ['Priority', '70+'],
      ['Updated', 'in last poll'],
    ]);
  });

  // The list's own chip labels (features/leads FilterChips), so the card and the list read the same.
  it.each([['overdue', 'overdue'], ['today', 'today'], ['week', 'this week'], ['none', 'none']] as const)(
    'follow-up %s reads “%s”',
    (followUp, label) => {
      expect(describeFilter({ followUp })).toEqual([{ id: 'followUp', facet: 'Follow-up', label }]);
    },
  );
});

describe('toAssistantEvent', () => {
  const msg = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });

  it('reads retryable and resetsAt on errors', () => {
    expect(toAssistantEvent(msg('error', {
      message: 'The AI’s daily limit is used up.', code: 'ai_quota_exhausted', retryable: false, resetsAt: '2026-10-20T07:00:00Z',
    }))).toEqual({
      type: 'error', message: 'The AI’s daily limit is used up.', code: 'ai_quota_exhausted', retryable: false, resetsAt: '2026-10-20T07:00:00Z',
    });
    // Junk types are dropped, not trusted.
    expect(toAssistantEvent(msg('error', { message: 'x', retryable: 'no', resetsAt: 'soon' }))).toEqual({ type: 'error', message: 'x' });
  });

  it('reads the match count on apply_filter', () => {
    expect(toAssistantEvent(msg('tool', {
      name: 'apply_filter', filter: { scope: 'mine' }, explanation: 'Mine', matchCount: 37, matchCountCapped: false,
    }))).toEqual({ type: 'tool', name: 'apply_filter', filter: { scope: 'mine' }, explanation: 'Mine', matchCount: 37, matchCountCapped: false });
    const bad = toAssistantEvent(msg('tool', { name: 'apply_filter', filter: {}, explanation: '', matchCount: -1, matchCountCapped: true }));
    expect(bad).toEqual({ type: 'tool', name: 'apply_filter', filter: {}, explanation: '' });
  });

  it('reads done.usage (which the client ignores) and accepts an empty done', () => {
    expect(toAssistantEvent(msg('done', { usage: { llmCalls: 1, inputTokens: 2310, outputTokens: 58, ms: 1840 }, promptVersion: 'assistant/v1' })))
      .toEqual({ type: 'done', usage: { llmCalls: 1, inputTokens: 2310, outputTokens: 58, ms: 1840 } });
    expect(toAssistantEvent({ event: 'done', data: '' })).toEqual({ type: 'done' });
  });
});

describe('assistant status', () => {
  it('maps the body; anything unrecognisable is offline', () => {
    expect(toAssistantStatus({ available: false, reason: 'quota_exhausted', resetsAt: '2026-10-20T07:00:00Z', provider: 'gemini', model: 'm' }))
      .toEqual({ available: false, reason: 'quota_exhausted', resetsAt: '2026-10-20T07:00:00Z', provider: 'gemini', model: 'm' });
    expect(toAssistantStatus({ available: true, reason: 'weird' }).reason).toBe('ok');
    expect(toAssistantStatus('<html>').reason).toBe('offline');
  });

  it.each([
    ['404', () => json({ error: 'not_found' }, 404)],
    ['501', () => json({ error: 'not_implemented' }, 501)],
    ['502', () => new Response('Bad Gateway', { status: 502 })],
  ])('GET /api/assistant/status %s is offline', async (_s, res) => {
    vi.stubGlobal('fetch', vi.fn(async () => res()));
    await expect(getAssistantStatus()).resolves.toMatchObject({ available: false, reason: 'offline' });
  });

  it('no network is offline; a 500 is an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(getAssistantStatus()).resolves.toMatchObject({ reason: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'internal' }, 500)));
    await expect(getAssistantStatus()).rejects.toBeInstanceOf(ApiError);
  });

  it('is a plain GET of /api/assistant/status', async () => {
    const fetchMock = vi.fn(async () => json({ available: true, reason: 'ok', provider: 'fake', model: 'fake-1', resetsAt: null }));
    vi.stubGlobal('fetch', fetchMock);
    await getAssistantStatus();
    expect(fetchMock).toHaveBeenCalledWith('/api/assistant/status', expect.objectContaining({ method: 'GET' }));
  });

  it('the status line, per state', () => {
    const s = (reason: string, resetsAt: string | null = null) =>
      ({ available: reason === 'ok', reason, resetsAt, provider: null, model: null }) as Parameters<typeof statusLine>[2];
    expect(statusLine(true, 'connected', s('quota_exhausted'))).toBe('Answering…');
    expect(statusLine(false, 'unknown', s('ok'))).toBe('Lead Q&A and list filtering');
    expect(statusLine(false, 'unknown', null)).toBe('Lead Q&A and list filtering');
    expect(statusLine(false, 'unknown', s('not_configured'))).toBe('AI isn’t set up on this server');
    expect(statusLine(false, 'unknown', s('quota_exhausted', '2026-10-20T07:00:00Z'))).toMatch(/^Daily AI limit reached · back \w+ 3:00\s?AM ET$/);
    expect(statusLine(false, 'unknown', s('quota_exhausted'))).toBe('Daily AI limit reached');
    expect(statusLine(false, 'unknown', s('provider_down'))).toBe('AI temporarily unavailable');
    expect(statusLine(false, 'unknown', s('offline'))).toBe('Offline');
    expect(statusLine(false, 'unavailable', s('ok'))).toBe('Offline');
    // An answer that just came through beats an older "offline" status read.
    expect(statusLine(false, 'connected', s('offline'))).toBe('Lead Q&A and list filtering');
  });
});

describe('requestError', () => {
  it('says whether a retry can help', () => {
    expect(requestError(new RateLimitedError(3000))).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(requestError(new NetworkError())).toMatchObject({ retryable: true });
    expect(requestError(new NotFoundError('lead_not_found'))).toMatchObject({ code: 'lead_not_found', retryable: false, message: 'Not found, or you no longer have access.' });
    expect(requestError(new ApiError(400, 'invalid_request'))).toMatchObject({ retryable: false });
    expect(requestError(new ApiError(500, 'internal')).retryable).toBeUndefined();
  });
});

describe('buildHistory', () => {
  const exchange = (i: number, answer: string, question = `question ${i}`): ChatMessage[] => [
    { id: `u${i}`, role: 'user', content: question, context: { page: 'dashboard' }, contextLabel: null },
    { id: `a${i}`, role: 'assistant', parts: [{ kind: 'text', id: `t${i}`, text: answer }], citations: [], status: 'done' },
  ];

  it('cuts long earlier answers to what the server keeps', () => {
    const h = buildHistory(exchange(1, 'x'.repeat(5000)), 'next');
    expect(h[1]!.content).toHaveLength(HISTORY_LIMITS.keptAssistantChars);
  });

  it('drops the oldest exchanges until the conversation fits 24,000 characters', () => {
    // Nine exchanges of 2,000 + 2,000 characters, then a 2,000-character question: 38,000 in all.
    const msgs = Array.from({ length: 9 }, (_, i) => exchange(i, 'y'.repeat(4000), `${i}:${'x'.repeat(1998)}`)).flat();
    const h = buildHistory(msgs, 'q'.repeat(2000));
    const total = h.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(HISTORY_LIMITS.maxTotalChars);
    expect(h).toHaveLength(11); // the newest 5 exchanges, then the question
    expect(h[0]!.content.startsWith('4:')).toBe(true);
    expect(h.at(-1)).toEqual({ role: 'user', content: 'q'.repeat(2000) });
    expect(h.map((m) => m.role)).toEqual([...Array.from({ length: 5 }, () => ['user', 'assistant']).flat(), 'user']);
  });
});

describe('matchCountLabel', () => {
  it('counts leads, with a plus when capped', () => {
    expect(matchCountLabel(0)).toBe('0 leads');
    expect(matchCountLabel(1)).toBe('1 lead');
    expect(matchCountLabel(37)).toBe('37 leads');
    expect(matchCountLabel(1000, true)).toBe('1,000+ leads');
  });
});

describe('quota and pause copy (product review M2, M7)', () => {
  it('names the reset day and zone like the server does', () => {
    const now = new Date('2026-10-19T09:00:00Z'); // 5 AM ET Monday
    expect(resetLabel('2026-10-20T07:00:00Z', now)).toMatch(/^tomorrow 3:00\s?AM ET$/);
    expect(resetLabel('2026-10-19T20:00:00Z', now)).toMatch(/^today 4:00\s?PM ET$/);
    expect(resetLabel('2026-10-22T07:00:00Z', now)).toMatch(/^Thursday 3:00\s?AM ET$/);
    expect(resetLabel(null, now)).toBeNull();
    expect(resetLabel('soon', now)).toBeNull();
  });

  it('pauses the composer only when a question can only fail', () => {
    const s = (reason: string, resetsAt: string | null = null) =>
      ({ available: reason === 'ok', reason, resetsAt, provider: null, model: null }) as Parameters<typeof pausedMessage>[0];
    expect(pausedMessage(s('quota_exhausted', '2026-10-20T07:00:00Z'), 'unknown', false))
      .toMatch(/^AI answers are paused until \w+ 3:00\s?AM ET\. Filters and profiles work as usual\.$/);
    expect(pausedMessage(s('not_configured'), 'unknown', false)).toBe('AI isn’t set up on this server. Filters and profiles work as usual.');
    for (const r of ['ok', 'provider_down', 'offline']) expect(pausedMessage(s(r), 'unknown', false)).toBeNull();
    expect(pausedMessage(s('quota_exhausted'), 'unknown', true)).toBeNull(); // an answer in flight
  });
});

describe('pitch suggestion (product review M4)', () => {
  const badge = (key: string, reason: string) => ({ key, label: key, reason, source: 'nws', severity: 'high' }) as TimingBadge;
  it('is worded from the lead\'s timing data, and offers no storm when there is none', () => {
    expect(pitchSuggestion([])).toEqual({ prompt: 'What should I pitch to them?', icon: 'priority' });
    expect(pitchSuggestion(undefined).prompt).toBe('What should I pitch to them?');
    expect(pitchSuggestion([badge('storm_response', 'Severe Thunderstorm Warning in Bergen County until 8 PM')]))
      .toEqual({ prompt: 'What should I pitch while the Severe Thunderstorm Warning is on?', icon: 'storm' });
    expect(pitchSuggestion([badge('season', 'Install season'), badge('recent_storm',
      '3 roof-relevant storm reports in this county in the last 30 days; latest 2026-09-26 TSTM WND DMG at 3 W Ramsey')]).prompt)
      .toBe('What should I pitch after the Sep 26 storm reports?');
  });
});

describe('match sentence (product review L4)', () => {
  it('recognises only the server\'s count sentence', () => {
    for (const t of ['37 leads match.', '1 lead matches.', 'Over 1,000 leads match.', ' 12 leads match. ']) expect(isMatchSentence(t)).toBe(true);
    for (const t of ['No leads match. Try removing a filter.', '37 leads match, mostly in Bergen.', 'Opening Acme.']) expect(isMatchSentence(t)).toBe(false);
  });
});

describe('progress (product review M1)', () => {
  it('a status event shows while streaming and is dropped when the reply ends', () => {
    const reply = emptyReply();
    let state: ChatMessage[] = reducer([], { type: 'send', user: { id: 'u', role: 'user', content: 'q', context: { page: 'dashboard' }, contextLabel: null }, reply });
    state = reducer(state, { type: 'progress', id: reply.id, text: 'Checking today’s follow-ups…' });
    expect((state[1] as AssistantMessage).progress).toBe('Checking today’s follow-ups…');
    state = reducer(state, { type: 'finish', id: reply.id, status: 'done' });
    expect((state[1] as AssistantMessage).progress).toBeUndefined();
    expect(toAssistantEvent({ event: 'status', data: JSON.stringify({ text: '  Searching your leads…  ' }) })).toEqual({ type: 'status', text: 'Searching your leads…' });
    expect(toAssistantEvent({ event: 'status', data: JSON.stringify({ text: 42 }) })).toBeNull();
  });
});
