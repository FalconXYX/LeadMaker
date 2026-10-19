// normalizeToolFilter: every rule of §7.6, in order. The model's filter is untrusted; what comes out must pass the
// list's own leadFilterSchema and must never widen the viewer's scope.
import { leadFilterSchema } from '@leadmaker/shared';
import { describe, expect, it } from 'vitest';
import { filterArg, matchSentence, normalizeToolFilter, toolSpecs } from '../src/tools.ts';
import { MANAGER, MANAGER_VOCAB, REP1, REP2, VOCAB } from './helpers.ts';

const ok = (r: ReturnType<typeof normalizeToolFilter>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.errors.join('; ')}`);
  expect(leadFilterSchema.safeParse({ ...r.filter, ...(r.sort ? { sort: r.sort } : {}) }).success).toBe(true);
  return r;
};
const errors = (r: ReturnType<typeof normalizeToolFilter>) => {
  if (r.ok) throw new Error('expected errors');
  return r.errors;
};

describe('normalizeToolFilter', () => {
  it('defaults the scope like the list does: reps mine, managers all', () => {
    expect(ok(normalizeToolFilter({}, REP1, VOCAB)).filter).toEqual({ scope: 'mine' });
    expect(ok(normalizeToolFilter({}, MANAGER, MANAGER_VOCAB)).filter).toEqual({ scope: 'all' });
    expect(ok(normalizeToolFilter({ scope: 'unallocated' }, REP1, VOCAB)).filter).toEqual({ scope: 'unallocated' });
  });

  it('coerces numeric strings for gte/lte (and typed eq), drops updatedInLastPoll false, nulls and empties', () => {
    const vocab = { ...VOCAB, customFieldKeys: [...VOCAB.customFieldKeys, { key: 'bonded', valueType: 'boolean' as const }] };
    const r = ok(normalizeToolFilter({
      customFields: [
        { key: 'annual_volume_squares', op: 'gte', value: '1000' },
        { key: 'annual_volume_squares', op: 'eq', value: '2400' },
        { key: 'bonded', op: 'eq', value: 'true' },
        { key: 'notes', op: 'eq', value: '12' },
      ],
      updatedInLastPoll: false, minRating: null, materials: [], text: '',
    }, REP1, vocab));
    expect(r.filter).toEqual({
      scope: 'mine',
      customFields: [
        { key: 'annual_volume_squares', op: 'gte', value: 1000 },
        { key: 'annual_volume_squares', op: 'eq', value: 2400 },
        { key: 'bonded', op: 'eq', value: true },
        { key: 'notes', op: 'eq', value: '12' },
      ],
    });
  });

  it('parses strictly: unknown keys, paging, object scope and bad values are errors', () => {
    expect(errors(normalizeToolFilter({ cursor: 'x' }, REP1, VOCAB)).join()).toMatch(/cursor/);
    expect(errors(normalizeToolFilter({ limit: 5 }, REP1, VOCAB)).join()).toMatch(/limit/);
    expect(errors(normalizeToolFilter({ scope: { repId: REP1.id } }, REP1, VOCAB)).length).toBeGreaterThan(0);
    expect(errors(normalizeToolFilter({ minRating: 9 }, REP1, VOCAB)).join()).toMatch(/minRating/);
    expect(errors(normalizeToolFilter({ notAKey: 1 }, REP1, VOCAB)).join()).toMatch(/notAKey/);
    expect(errors(normalizeToolFilter('x', REP1, VOCAB))).toEqual(['filter must be an object']);
  });

  it('maps repId: a rep only to themself; a manager only to a known rep', () => {
    expect(ok(normalizeToolFilter({ repId: REP1.id }, REP1, VOCAB)).filter.scope).toBe('mine');
    expect(errors(normalizeToolFilter({ repId: REP2.id }, REP1, VOCAB))).toEqual(['reps can only filter their own leads or the pool']);
    expect(ok(normalizeToolFilter({ repId: REP2.id, followUp: 'overdue' }, MANAGER, MANAGER_VOCAB)).filter)
      .toEqual({ scope: { repId: REP2.id }, followUp: 'overdue' });
    expect(errors(normalizeToolFilter({ repId: '44444444-4444-4444-8444-444444444444' }, MANAGER, MANAGER_VOCAB))[0]).toMatch(/unknown rep id/);
  });

  it('accepts only counties the viewer has leads in, listing the valid ones', () => {
    expect(ok(normalizeToolFilter({ counties: ['34003'] }, REP1, VOCAB)).filter.counties).toEqual(['34003']);
    const e = errors(normalizeToolFilter({ counties: ['34003', '36119'] }, REP1, VOCAB))[0]!;
    expect(e).toMatch(/unknown county FIPS 36119/);
    expect(e).toMatch(/Bergen County, NJ = 34003/);
    // Without a vocabulary the query service is the check.
    expect(ok(normalizeToolFilter({ counties: ['36119'] }, REP1, null)).filter.counties).toEqual(['36119']);
  });

  it('maps custom tags case-insensitively (name or id) and rejects unknown ones', () => {
    expect(ok(normalizeToolFilter({ customTags: ['bulk BUYER'] }, REP1, VOCAB)).filter.customTags).toEqual(['Bulk buyer']);
    expect(ok(normalizeToolFilter({ customTags: [VOCAB.customTags[0]!.id] }, REP1, VOCAB)).filter.customTags).toEqual(['Bulk buyer']);
    expect(errors(normalizeToolFilter({ customTags: ['VIP'] }, REP1, VOCAB))[0]).toMatch(/unknown custom tag "VIP"; valid: Bulk buyer/);
  });

  it('drops a distance sort without near (with a note) and moves sort out', () => {
    const r = ok(normalizeToolFilter({ sort: { by: 'distance', dir: 'asc' } }, REP1, VOCAB));
    expect(r.sort).toBeUndefined();
    expect(r.notes[0]).toMatch(/distance needs a ZIP/);
    const s = ok(normalizeToolFilter({ near: { zip: '10013', radiusMiles: 10 }, sort: { by: 'distance', dir: 'asc' } }, REP1, VOCAB));
    expect(s.sort).toEqual({ by: 'distance', dir: 'asc' });
    expect(s.filter).not.toHaveProperty('sort');
  });

  it('reads flattened arguments as the filter', () => {
    expect(filterArg({ minRating: 4, explanation: 'x' }, ['explanation'])).toEqual({ minRating: 4 });
    expect(filterArg({ filter: { minRating: 4 }, repId: REP2.id }, ['explanation'])).toEqual({ repId: REP2.id, minRating: 4 });
    expect(filterArg({ filter: { scope: 'all' }, scope: 'mine' }, [])).toEqual({ scope: 'all' });
  });
});

describe('tool specs', () => {
  it('are built from the shared tool schema', () => {
    const [apply, find, calls, open] = toolSpecs();
    expect(calls!.name).toBe('todaysCalls');
    expect(calls!.parameters).toMatchObject({ properties: { limit: { minimum: 1, maximum: 5 } } });
    expect(apply!.name).toBe('applyListFilters');
    expect(apply!.parameters).toMatchObject({ required: ['filter', 'explanation'], properties: { explanation: { maxLength: 120 } } });
    const filter = (apply!.parameters.properties as Record<string, Record<string, unknown>>).filter!;
    expect(Object.keys(filter.properties as object)).toContain('repId');
    expect(filter).not.toHaveProperty('$schema');
    expect(find!.parameters).toMatchObject({ required: ['filter'], properties: { limit: { minimum: 1, maximum: 5 } } });
    expect(open!.parameters).toMatchObject({ properties: { leadId: { type: 'string' }, name: { maxLength: 200 } } });
  });

  it('server sentences', () => {
    expect(matchSentence(undefined, undefined)).toBe('Applied the filters.');
    expect(matchSentence(2, false)).toBe('2 leads match.');
    expect(matchSentence(1, false)).toBe('1 lead matches.');
    expect(matchSentence(1000, true)).toBe('Over 1,000 leads match.');
    expect(matchSentence(0, false)).toBe('No leads match. Try removing a filter.');
  });
});
