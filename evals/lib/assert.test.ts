import { describe, expect, it } from 'vitest';
import { countLeadLinks, etDate, evaluate, getPath, isoToEtDate, normalizeFilter, type CaseOutput } from './assert.ts';
import type { Expect } from './cases.ts';

const NOW = new Date('2026-10-19T15:00:00-04:00');
const rep = { role: 'rep' as const, now: NOW };
const mgr = { role: 'manager' as const, now: NOW };

function out(filter: Record<string, unknown> | null, extra: Partial<CaseOutput> = {}): CaseOutput {
  return {
    tool: filter ? 'applyListFilters' : 'none', filter, text: '', explanation: null, citations: [], outcome: 'done',
    errorCode: null, ...extra,
  };
}
const run = (e: Expect, o: CaseOutput, ctx = rep) => evaluate(e, o, ctx);

describe('helpers', () => {
  it('reads dotted paths and ignores arrays and scalars on the way', () => {
    expect(getPath({ near: { zip: '10013' } }, 'near.zip')).toBe('10013');
    expect(getPath({ scope: 'mine' }, 'scope.repId')).toBeUndefined();
    expect(getPath({ a: [1] }, 'a.0')).toBeUndefined();
  });

  it('sorts arrays and drops the default scope per role', () => {
    expect(normalizeFilter({ scope: 'mine', stages: ['quoting', 'interested'] }, 'rep')).toEqual({ stages: ['interested', 'quoting'] });
    expect(normalizeFilter({ scope: 'all' }, 'rep')).toEqual({ scope: 'all' });
    expect(normalizeFilter({ scope: 'all' }, 'manager')).toEqual({});
    expect(normalizeFilter({ scope: 'mine' }, 'rep', true)).toEqual({ scope: 'mine' });
  });

  it('resolves dates in America/New_York', () => {
    expect(etDate(new Date('2026-10-20T02:00:00Z'))).toBe('2026-10-19');
    expect(isoToEtDate('2026-10-05')).toBe('2026-10-05');
    expect(isoToEtDate('2026-10-05T03:00:00Z')).toBe('2026-10-04');
    expect(isoToEtDate(42)).toBeNull();
  });

  it('counts distinct lead links', () => {
    expect(countLeadLinks('[A](/leads/a1) and [B](/leads/b2), again [A](/leads/a1)')).toBe(2);
  });
});

describe('filter operators', () => {
  it('includes: arrays are subsets, scalars and objects are equal, dotted paths work', () => {
    const f = { certifications: ['gaf:master_elite'], materials: ['metal_roofing', 'tpo_roofing'], unchecked: 'me', near: { zip: '10013', radiusMiles: 10 } };
    expect(run({ filter: { includes: { materials: ['tpo_roofing'], unchecked: 'me', 'near.zip': '10013' } } }, out(f))).toEqual([]);
    expect(run({ filter: { includes: { near: { zip: '10013', radiusMiles: 10 } } } }, out(f))).toEqual([]);
    expect(run({ filter: { includes: { materials: ['slate_roofing'] } } }, out(f))).toHaveLength(1);
    expect(run({ filter: { includes: { unchecked: 'team' } } }, out(f))).toHaveLength(1);
    expect(run({ filter: { includes: { near: { zip: '10013', radiusMiles: 15 } } } }, out(f))).toHaveLength(1);
  });

  it('includes compares objects inside arrays deeply (custom fields)', () => {
    const f = { customFields: [{ key: 'annual_volume_squares', op: 'gte', value: 1000 }] };
    expect(run({ filter: { includes: { customFields: [{ value: 1000, op: 'gte', key: 'annual_volume_squares' }] } } }, out(f))).toEqual([]);
    expect(run({ filter: { includes: { customFields: [{ key: 'annual_volume_squares', op: 'gte', value: '1000' }] } } }, out(f))).toHaveLength(1);
  });

  it('setEquals: same set, any order; extra or missing values fail', () => {
    const f = { stages: ['quoting', 'interested'] };
    expect(run({ filter: { setEquals: { stages: ['interested', 'quoting'] } } }, out(f))).toEqual([]);
    expect(run({ filter: { setEquals: { stages: ['interested'] } } }, out(f))).toHaveLength(1);
    expect(run({ filter: { setEquals: { stages: ['interested', 'quoting', 'won'] } } }, out(f))).toHaveLength(1);
    expect(run({ filter: { setEquals: { counties: ['34003'] } } }, out(f))).toHaveLength(1);
  });

  it('range is inclusive and needs a number', () => {
    expect(run({ filter: { range: { minRating: [4, 4.1] } } }, out({ minRating: 4 }))).toEqual([]);
    expect(run({ filter: { range: { minRating: [4, 4.1] } } }, out({ minRating: 4.5 }))).toHaveLength(1);
    expect(run({ filter: { range: { minRating: [4, 4.1] } } }, out({}))).toHaveLength(1);
  });

  it('absent treats an empty array as absent', () => {
    expect(run({ filter: { absent: ['materials', 'scope.repId'] } }, out({ materials: [], scope: 'all' }))).toEqual([]);
    expect(run({ filter: { absent: ['materials'] } }, out({ materials: ['metal_roofing'] }))).toHaveLength(1);
    expect(run({ filter: { absent: ['scope.repId'] } }, out({ scope: { repId: 'x' } }))).toHaveLength(1);
  });

  it('excludes forbids values inside an array', () => {
    const e: Expect = { filter: { excludes: { services: ['storm_damage'] } } };
    expect(run(e, out({ services: ['gutters'] }))).toEqual([]);
    expect(run(e, out({}))).toEqual([]);
    expect(run(e, out({ services: ['gutters', 'storm_damage'] }))).toHaveLength(1);
  });

  it('onlyKeys runs after the default scope is dropped', () => {
    const e: Expect = { filter: { includes: { scope: 'all' }, onlyKeys: ['scope', 'sort'] } };
    expect(run(e, out({ scope: 'all' }))).toEqual([]);
    expect(run(e, out({ scope: 'all', minRating: 4 }))).toHaveLength(1);
  });

  it('matches tests String(value) case-insensitively', () => {
    expect(run({ filter: { matches: { updatedSince: '^2026-10-01' } } }, out({ updatedSince: '2026-10-01T00:00:00-04:00' }))).toEqual([]);
    expect(run({ filter: { matches: { updatedSince: '^2026-10-01' } } }, out({ updatedSince: '2026-09-30' }))).toHaveLength(1);
  });

  it('dateDaysAgo resolves against the pinned clock with one day of slack', () => {
    const e: Expect = { filter: { dateDaysAgo: { notContactedSince: 14 } } };
    expect(run(e, out({ notContactedSince: '2026-10-05' }))).toEqual([]);
    expect(run(e, out({ notContactedSince: '2026-10-04' }))).toEqual([]);
    expect(run(e, out({ notContactedSince: '2026-10-05T04:00:00Z' }))).toEqual([]);
    expect(run(e, out({ notContactedSince: '2026-10-02' }))).toHaveLength(1);
    expect(run(e, out({}))).toHaveLength(1);
    expect(evaluate(e, out({ notContactedSince: '2026-10-12' }), { role: 'rep', now: new Date('2026-10-26T12:00:00Z') })).toEqual([]);
  });

  it('anyOf passes when one branch passes and reports every branch otherwise', () => {
    const e: Expect = { filter: { includes: { unserviced: 'me' }, anyOf: [{ includes: { services: ['storm_damage'] } }, { includes: { tagsAll: ['work_type:storm_emergency'] } }] } };
    expect(run(e, out({ unserviced: 'me', tagsAll: ['work_type:storm_emergency'] }))).toEqual([]);
    const fails = run(e, out({ unserviced: 'me', services: ['gutters'] }));
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatch(/anyOf: no branch passed/);
  });

  it('keeps the default scope when an assertion names it', () => {
    const e: Expect = { filter: { includes: { stages: ['won'] }, anyOf: [{ absent: ['scope'] }, { includes: { scope: 'mine' } }] } };
    expect(run(e, out({ stages: ['won'], scope: 'mine' }))).toEqual([]);
    expect(run(e, out({ stages: ['won'] }))).toEqual([]);
    expect(run(e, out({ stages: ['won'], scope: 'unallocated' }))).toHaveLength(1);
    // a manager's default is "all"
    expect(evaluate({ filter: { onlyKeys: ['followUp'] } }, out({ scope: 'all', followUp: 'overdue' }), mgr)).toEqual([]);
  });

  it('fails filter checks when no filter was produced, except pure absence checks', () => {
    expect(run({ filter: { includes: { followUp: 'today' } } }, out(null))).toEqual(['filter: no filter was produced']);
    expect(run({ filter: { absent: ['scope.repId'] } }, out(null))).toEqual([]);
  });
});

describe('tool, text, citations, outcome', () => {
  it('tool accepts one value or a list', () => {
    expect(run({ tool: 'none' }, out(null))).toEqual([]);
    expect(run({ tool: ['none', 'findLeads'] }, out(null, { tool: 'findLeads' }))).toEqual([]);
    expect(run({ tool: 'applyListFilters' }, out(null))).toEqual(['tool: expected applyListFilters, got none']);
  });

  it('text: every mustMatch, no mustNotMatch, word/char/link limits', () => {
    const o = out(null, { text: 'Top picks: [Carework](/leads/a1) and [Kearny](/leads/b2).' });
    expect(run({ text: { mustMatch: ['top picks', 'kearny'], mustNotMatch: ['forecast'], maxWords: 10, minLinks: 1, maxLinks: 2 } }, o)).toEqual([]);
    expect(run({ text: { mustMatch: ['top picks', 'acme'] } }, o)).toHaveLength(1);
    expect(run({ text: { mustNotMatch: ['CAREWORK'] } }, o)).toHaveLength(1);
    expect(run({ text: { maxWords: 3 } }, o)).toHaveLength(1);
    expect(run({ text: { maxChars: 10 } }, o)).toHaveLength(1);
    expect(run({ text: { maxLinks: 1 } }, o)).toHaveLength(1);
    expect(run({ text: { minLinks: 3 } }, o)).toHaveLength(1);
  });

  it('explanation has its own text checks', () => {
    expect(run({ explanation: { mustMatch: ['review'] } }, out({}, { explanation: "Reviews can't be filtered" }))).toEqual([]);
    expect(run({ explanation: { mustMatch: ['review'] } }, out({}, { explanation: null }))).toHaveLength(1);
  });

  it('citations: includes, includesAny, excludes, none', () => {
    const o = out(null, { citations: ['details', 'timing'] });
    expect(run({ citations: { includes: ['details'], includesAny: ['notes', 'timing'], excludes: ['bogus'], none: false } }, o)).toEqual([]);
    expect(run({ citations: { includes: ['notes'] } }, o)).toHaveLength(1);
    expect(run({ citations: { includesAny: ['notes', 'activity'] } }, o)).toHaveLength(1);
    expect(run({ citations: { excludes: ['timing'] } }, o)).toHaveLength(1);
    expect(run({ citations: { none: true } }, o)).toHaveLength(1);
    expect(run({ citations: { none: false } }, out(null))).toHaveLength(1);
  });

  it('outcome and errorCode', () => {
    const o = out(null, { outcome: 'error', errorCode: 'ai_quota_exhausted' });
    expect(run({ outcome: 'error', errorCode: 'ai_quota_exhausted' }, o)).toEqual([]);
    expect(run({ outcome: 'done' }, o)).toHaveLength(1);
    expect(run({ errorCode: 'ai_rate_limited' }, o)).toHaveLength(1);
  });

  it('top-level anyOf combines tool, filter and text branches', () => {
    const e: Expect = {
      anyOf: [
        { tool: 'none', text: { mustMatch: ['only|cannot'] } },
        { tool: 'applyListFilters', filter: { absent: ['scope.repId'] }, explanation: { mustMatch: ['own'] } },
      ],
    };
    expect(run(e, out(null, { text: 'I can only show your own leads or the pool.' }))).toEqual([]);
    expect(run(e, out({ scope: 'mine' }, { explanation: 'Your own leads only' }))).toEqual([]);
    expect(run(e, out({ scope: { repId: 'x' } }, { explanation: 'Priya' }))).toHaveLength(1);
  });
});

describe('review additions (2026-10-19)', () => {
  it('matchCountMin fails an empty or missing count', () => {
    expect(run({ matchCountMin: 1 }, out({ counties: ['36047'] }, { matchCount: 14 }))).toEqual([]);
    expect(run({ matchCountMin: 1 }, out({ counties: ['36047'] }, { matchCount: 0 }))).toEqual(['matchCount: expected at least 1, got 0']);
    expect(run({ matchCountMin: 1 }, out({ counties: ['36047'] }))).toEqual(['matchCount: expected at least 1, got null']);
  });

  it('todaysCalls is an outcome of its own', () => {
    expect(run({ tool: 'todaysCalls' }, out(null, { tool: 'todaysCalls' }))).toEqual([]);
    expect(run({ tool: 'todaysCalls' }, out(null, { tool: 'findLeads' }))).toEqual(['tool: expected todaysCalls, got findLeads']);
  });
});
