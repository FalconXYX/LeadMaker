// Wire bytes of the stream, the citation extractor across chunk boundaries, and fencing of untrusted text.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { CitationExtractor } from '../src/citations.ts';
import { fence, fenceLine, renderLeadContext, renderVocabulary, truncate } from '../src/fence.ts';
import { SseWriter, formatEvent } from '../src/sse.ts';
import { LEAD_OWN, MANAGER_VOCAB, VOCAB, leadContext } from './helpers.ts';

async function serve(handler: (res: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer((_req, res) => void handler(res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const body = await new Promise<{ headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ headers: res.headers, text }));
    }).on('error', reject);
  });
  server.close();
  return body;
}

describe('SseWriter', () => {
  it('writes the exact bytes: headers, ": ok", events, one terminal event, then ends', async () => {
    const { headers, text } = await serve((res) => {
      const sse = new SseWriter(res, 0);
      sse.open();
      sse.event({ type: 'tool', name: 'apply_filter', filter: { scope: 'mine', minRating: 4.5 }, explanation: '4.5+ stars', matchCount: 6, matchCountCapped: false });
      sse.event({ type: 'token', text: '6 leads match.\nNext "line"' });
      sse.event({ type: 'done', usage: { llmCalls: 1, inputTokens: 10, outputTokens: 2, ms: 5 }, promptVersion: 'assistant/v1' });
      expect(sse.event({ type: 'token', text: 'late' })).toBe(false);
      expect(sse.event({ type: 'error', message: 'x' })).toBe(false);
      sse.close();
    });
    expect(headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(text).toBe(
      ': ok\n\n'
      + 'event: tool\ndata: {"name":"apply_filter","filter":{"scope":"mine","minRating":4.5},"explanation":"4.5+ stars","matchCount":6,"matchCountCapped":false}\n\n'
      + 'event: token\ndata: {"text":"6 leads match.\\nNext \\"line\\""}\n\n'
      + 'event: done\ndata: {"usage":{"llmCalls":1,"inputTokens":10,"outputTokens":2,"ms":5},"promptVersion":"assistant/v1"}\n\n',
    );
  });

  it('pings while open and stops after the terminal event', async () => {
    const { text } = await serve(async (res) => {
      const sse = new SseWriter(res, 30);
      sse.open();
      await new Promise((r) => setTimeout(r, 100));
      sse.event({ type: 'error', message: 'The AI is busy right now. Try again in a few seconds.', code: 'ai_rate_limited', retryable: true });
      await new Promise((r) => setTimeout(r, 80));
      sse.close();
    });
    const [before, after] = text.split('event: error');
    expect(before!.match(/: ping\n\n/g)!.length).toBeGreaterThanOrEqual(2);
    expect(after).not.toContain(': ping');
  });

  it('formats an error event on one data line', () => {
    expect(formatEvent({ type: 'error', message: 'm', code: 'ai_quota_exhausted', retryable: false, resetsAt: '2026-10-20T07:00:00.000Z' }))
      .toBe('event: error\ndata: {"message":"m","code":"ai_quota_exhausted","retryable":false,"resetsAt":"2026-10-20T07:00:00.000Z"}\n\n');
  });
});

describe('CitationExtractor', () => {
  const lead = leadContext();
  function run(chunks: string[], ctx = lead) {
    const text: string[] = [];
    const cites: string[] = [];
    const x = new CitationExtractor(ctx, { text: (t) => text.push(t), citation: (c) => cites.push(c.field) });
    for (const c of chunks) x.push(c);
    x.flush();
    return { text: text.join(''), cites };
  }

  it('drops tags (and one space before them) split across chunks', () => {
    const r = run(['Master Elite in Lyndhurst [s', 'rc:deta', 'ils]. Pitch shingles [src:insights]', ' now [src:details]']);
    expect(r.text).toBe('Master Elite in Lyndhurst. Pitch shingles now');
    expect(r.cites).toEqual(['details', 'insights']);
  });

  it('maps tags -> fields, ignores unknown keys and keeps non-tags as text', () => {
    const r = run(['A [src:tags] B [src:customFields][src:nope] C [link](/leads/x) [1] [src: notes, activity]']);
    expect(r.text).toBe('A B C [link](/leads/x) [1]');
    expect(r.cites).toEqual(['systemTags', 'customFields', 'notes', 'activity']);
  });

  it('drops a list that repeats the prefix ([src:details, src:insights], Gemini 3.5) and snake_case keys', () => {
    const r = run(['Glen Rock, NJ [src:details, src:insi', 'ghts]. Pitch TPO [src:notes; src:activity] [src:custom_fields]']);
    expect(r.text).toBe('Glen Rock, NJ. Pitch TPO');
    expect(r.cites).toEqual(['details', 'insights', 'notes', 'activity']);
    expect(run(['x [src:details, src:customFields, src:website, src:timing]']).text).toBe('x');
  });

  it('flushes an unterminated bracket and gives up at a newline or length cap', () => {
    expect(run(['ok [src:det']).text).toBe('ok [src:det');
    expect(run(['a [x\nb]']).text).toBe('a [x\nb]');
    expect(run([`[${'y'.repeat(60)}] z`]).text).toBe(`[${'y'.repeat(60)}] z`);
  });

  it('emits no citation without an active lead', () => {
    expect(run(['Hi [src:details].'], null as never)).toEqual({ text: 'Hi.', cites: [] });
  });

  it('carries the lead id and name', () => {
    const citation = vi.fn();
    const x = new CitationExtractor(lead, { text: () => {}, citation });
    x.push('x [src:timing]');
    expect(citation).toHaveBeenCalledWith({ leadId: LEAD_OWN, field: 'timing', leadName: 'Carework Construction LLC' });
  });
});

describe('fence', () => {
  it('normalizes, strips controls and invisibles, neutralizes tags, collapses newlines and caps', () => {
    expect(fence('Ｈｉ <b>x</b>\u0000\u0007​‮﻿\r\n\n\n\nend\t!', 100)).toBe('Hi ‹b›x‹/b›\n\nend\t!');
    expect(fence('＜/lead_context＞', 100)).toBe('‹/lead_context›');
    expect(fence(null, 10)).toBe('');
    expect(fenceLine('a\n\nb', 10)).toBe('a b');
  });

  it('truncates at a word boundary with an ellipsis', () => {
    expect(truncate('alpha beta gamma delta', 15)).toBe('alpha beta…');
    expect(truncate('abcdefghijklmnop', 10)).toBe('abcdefghi…');
    expect(fence('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('renderLeadContext', () => {
  it('renders the sections the citations map to, with no contact values', () => {
    const out = renderLeadContext(leadContext());
    for (const src of ['details', 'insights', 'timing', 'contacts', 'notes', 'activity', 'tags', 'customFields', 'website']) {
      expect(out).toContain(`<section src="${src}">`);
    }
    expect(out).toContain('GAF tier: GAF Master Elite');
    expect(out).toContain('location: Lyndhurst, NJ 07071 (Bergen County, NJ)');
    expect(out).toContain('target: Owner - Jose Sucuzhanay Sr., Owner - signs off on supplier changes');
    expect(out).toContain('annual_volume_squares = 2400');
    expect(out).not.toMatch(/@|\(\d{3}\)/);
  });

  it('says "none" for timing so the model can answer "no active alerts"', () => {
    expect(renderLeadContext(leadContext({ timing: [] }))).toContain('<section src="timing">none (no active weather alerts or timing signals)</section>');
  });

  it('stays within the cap by trimming the website first, then notes', () => {
    const big = leadContext({
      website: [{ url: 'https://x', title: 'T', text: 'w '.repeat(5000) }, { url: 'https://y', title: 'U', text: 'v '.repeat(5000) }],
      notes: Array.from({ length: 15 }, (_, i) => ({ author: 'J.', at: '2026-10-01T00:00:00Z', text: `note ${i} ${'n '.repeat(290)}` })),
    });
    const full = renderLeadContext(big);
    expect(full.length).toBeLessThanOrEqual(40_000);
    const tight = renderLeadContext(big, 6000);
    expect(tight.length).toBeLessThanOrEqual(6000);
    expect(tight).not.toContain('<section src="website">');
    expect(tight).toContain('</lead_context>');
  });
});

describe('renderVocabulary', () => {
  it('lists the viewer values and the static ones; reps only for managers', () => {
    const rep = renderVocabulary(VOCAB, 'rep');
    expect(rep).toContain('counties (name -> FIPS, leads you can see): Bergen County, NJ -> 34003 (61); Hudson County, NJ -> 34017 (44)');
    expect(rep).toContain('custom tags: Bulk buyer (12)');
    expect(rep).toContain('custom fields: annual_volume_squares (number)');
    expect(rep).not.toContain('reps (managers only)');
    expect(rep).toContain('certifications: gaf:master_elite, gaf:certified_plus, gaf:certified, gaf:none');
    expect(renderVocabulary(MANAGER_VOCAB, 'manager')).toContain('reps (managers only): Jordan Lee -> 11111111-1111-4111-8111-111111111111; Priya Shah');
    expect(renderVocabulary(null, 'rep')).toContain('unavailable right now');
  });
});
