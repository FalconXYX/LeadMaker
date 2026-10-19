// Section 4 read API helpers that need no database: redaction, clipping, website packing, brief scopes, insight rows.
import { describe, expect, it } from 'vitest';
import { AI_CONTEXT_LIMITS, isInsightsOnlyUpdate } from '@leadmaker/shared';
import { clip, redactContactData, shortName, tagText, websitePages } from '../src/ai-context.ts';
import { briefFromRow, briefScope } from '../src/brief.ts';
import { insightOut } from '../src/profile.ts';

const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const OTHER = 'e1817cb3-f647-416d-9c20-084a9ab62324';
const MANAGER = { id: '8b974b0a-101c-47cf-bdfe-1aed4786febc', role: 'manager' as const };

describe('redactContactData', () => {
  it.each([
    ['Call (212) 555-0100 today', 'Call [phone] today'],
    ['cell 212.555.0100, office 212-555-0101', 'cell [phone], office [phone]'],
    ['+1 973 555 0123 or 9735550123', '[phone] or [phone]'],
    ['call our office at ( 201)436-1011 , and', 'call our office at [phone] , and'],
    ['dial 201 - 436 - 1011.', 'dial [phone].'],
    ['mail jose.s+roof@acme-roofing.co.uk now', 'mail [email] now'],
    ['in business since 2009; 132 reviews; ZIP 07071-1234; 2026-10-07', 'in business since 2009; 132 reviews; ZIP 07071-1234; 2026-10-07'],
  ])('%s', (input, out) => {
    expect(redactContactData(input)).toBe(out);
  });
});

describe('tagText', () => {
  it('drops the tagger\'s match confidences', () => {
    expect(tagText('Luis Simbaina (Owner, website @ 0.55); also R. Mag (CEO, ny_dos @ 0.891; also fmcsa)'))
      .toBe('Luis Simbaina (Owner, website); also R. Mag (CEO, ny_dos; also fmcsa)');
  });
});

describe('clip', () => {
  it('keeps short text and cuts long text at a word boundary with an ellipsis', () => {
    expect(clip('  short  ', 10)).toBe('short');
    const long = 'alpha beta gamma delta epsilon';
    const out = clip(long, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toBe('alpha beta gamma…');
    expect(clip('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('websitePages', () => {
  it('keeps stored order, caps each page and the total, and skips empty pages', () => {
    const page = (title: string, n: number) => ({ url: `https://a.test/${title}`, title, text: 'word '.repeat(n) });
    const out = websitePages([page('a', 1000), { url: 'x', title: 'empty', text: '' }, page('b', 1000), page('c', 1000), page('d', 1000)]);
    expect(out.map((p) => p.title)).toEqual(['a', 'b', 'c']);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.websitePageChars);
    expect(out.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.websiteChars);
    expect(websitePages(null)).toEqual([]);
    expect(websitePages({ pages: [] })).toEqual([]);
  });
});

describe('shortName', () => {
  it('abbreviates users and names pipeline rows by actor', () => {
    expect(shortName({ user: { id: 'u', name: 'Jordan  Lee' }, actorLabel: 'Jordan Lee' })).toBe('Jordan L.');
    expect(shortName({ user: { id: 'u', name: 'Cher' }, actorLabel: 'Cher' })).toBe('Cher');
    expect(shortName({ user: null, actorLabel: 'pipeline' })).toBe('pipeline');
  });
});

describe('briefScope', () => {
  it.each([
    [REP, undefined, `rep:${REP.id}`],
    [REP, 'mine', `rep:${REP.id}`],
    [REP, `rep:${REP.id.toUpperCase()}`, `rep:${REP.id}`],
    [MANAGER, undefined, 'team'],
    [MANAGER, 'mine', 'team'],
    [MANAGER, 'team', 'team'],
    [MANAGER, `rep:${OTHER}`, `rep:${OTHER}`],
  ])('%o %s -> %s', (viewer, raw, scope) => {
    expect(briefScope(viewer, raw)).toBe(scope);
  });

  it('refuses a rep any scope but their own (403), and non-scopes (400)', () => {
    expect(() => briefScope(REP, 'team')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => briefScope(REP, `rep:${OTHER}`)).toThrow(expect.objectContaining({ status: 403 }));
    for (const raw of ['all', 'rep:x', '', 'rep:']) {
      expect(() => briefScope(MANAGER, raw)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('briefFromRow', () => {
  const row = {
    scope: 'team', digest_text: 'Digest.', quiet: false, computed_at: '2026-10-19T12:00:00Z', ai_text: null, generated_at: null,
    model: null, prompt_version: null,
    digest: { poll: { finished_at: 'not a date' }, leads: [{ id: OTHER.toUpperCase(), name: 'A' }, { id: 'bad' }, { id: OTHER }] },
  };
  it('falls back to the digest text and keeps only well-formed, distinct leads', () => {
    expect(briefFromRow('team', row)).toMatchObject({
      text: 'Digest.', source: 'digest', pollFinishedAt: null, leads: [{ id: OTHER, name: 'A' }],
    });
    expect(briefFromRow('team', { ...row, ai_text: 'AI.', generated_at: '2026-10-19T12:01:00Z', digest: null }))
      .toMatchObject({ text: 'AI.', source: 'ai', leads: [], generatedAt: '2026-10-19T12:01:00.000Z' });
  });
});

describe('insightOut', () => {
  const base = {
    business_summary: 'S', sales_recommendation: 'P', model: 'fake:fake-1', prompt_version: 'insights/v1',
    generated_at: '2026-10-19T12:00:00Z',
  };
  it('reads the JSON columns defensively', () => {
    expect(insightOut(null)).toBeNull();
    expect(insightOut({
      ...base, talking_points: ['a', 3, 'b'], target_contact: { name: '', title: 'Owner' }, product_focus: 'tarps',
      cited_facts: [{ id: 'F1', text: 'x' }, { id: 2 }, null],
    })).toEqual({
      businessSummary: 'S', salesRecommendation: 'P', talkingPoints: ['a', 'b'], targetContact: null, productFocus: [],
      citedFacts: [{ id: 'F1', text: 'x' }], model: 'fake:fake-1', promptVersion: 'insights/v1', generatedAt: '2026-10-19T12:00:00.000Z',
    });
    expect(insightOut({ ...base, talking_points: [], target_contact: { name: 'Jose', title: 'Owner' }, product_focus: [], cited_facts: [] })!
      .targetContact).toEqual({ name: 'Jose', title: 'Owner', why: '' });
  });
});

describe('isInsightsOnlyUpdate', () => {
  it('matches only a lead.updated whose fields are exactly [insights]', () => {
    expect(isInsightsOnlyUpdate({ type: 'lead.updated', payload: { fields: ['insights'] } })).toBe(true);
    expect(isInsightsOnlyUpdate({ type: 'lead.updated', payload: { fields: ['insights', 'tier'] } })).toBe(false);
    expect(isInsightsOnlyUpdate({ type: 'lead.updated', payload: {} })).toBe(false);
    expect(isInsightsOnlyUpdate({ type: 'tags.changed', payload: { fields: ['insights'] } })).toBe(false);
  });
});
