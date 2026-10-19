import { describe, expect, it } from 'vitest';
import {
  certificationCondition, customFieldCondition, filterConditions, leadFilterSchema, likePattern, needsMyState,
  scopeCondition, tagCondition, zctaCentroid,
} from '../src/index.ts';

const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const MANAGER = { id: '8b974b0a-101c-47cf-bdfe-1aed4786febc', role: 'manager' as const };
const OTHER = 'e1817cb3-f647-416d-9c20-084a9ab62324';

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

describe('tag conditions', () => {
  it('matches a bare key when present and not false', () => {
    expect(tagCondition('service:metal_roofing').compile()).toEqual({
      text: 'c.tag_facets @> $1::text[]',
      values: [['service:metal_roofing']],
    });
  });

  it('matches key=value as a string, array element, boolean or number', () => {
    expect(tagCondition('region=Staten Island').compile()).toEqual({
      text: 'c.tag_facets && $1::text[]',
      values: [['region=Staten Island', 'region[]=Staten Island']],
    });
    expect(tagCondition('offers_financing=false').compile().values[0]).toContain('offers_financing?=false');
    expect(tagCondition('presidents_club=2').compile()).toEqual({
      text: 'c.tag_facets && array_append($1::text[], $2 || trim_scale($3::jsonb::numeric)::text)',
      values: [['presidents_club=2', 'presidents_club[]=2'], 'presidents_club#=', '2'],
    });
  });

  it('falls back to system_tags for keys outside the facet pattern', () => {
    expect(tagCondition('odd key=1').compile().text).toContain('c.system_tags @>');
  });

  it('falls back to system_tags for keys and values too long for tag_facets', () => {
    expect(tagCondition(`${'k'.repeat(200)}=v`).compile().text).toContain('c.tag_facets');
    expect(tagCondition('k'.repeat(201)).compile().text).toContain('c.system_tags @>');
    expect(tagCondition(`k=${'é'.repeat(500)}`).compile().text).toContain('c.tag_facets');
    expect(tagCondition(`k=${'é'.repeat(501)}`).compile().text).toContain('c.system_tags @>');
    expect(certificationCondition(`gaf:${'x'.repeat(501)}`).compile().text).toContain('c.system_tags @>');
    expect(certificationCondition(`${'x'.repeat(196)}:none`).compile().text).toContain('c.system_tags @>');
  });

  it('maps certifications to the source tier tag', () => {
    expect(certificationCondition('gaf:master_elite').compile()).toEqual({ text: 'c.tag_facets @> $1::text[]', values: [['gaf_tier=master_elite']] });
    expect(certificationCondition('gaf:none').compile()).toEqual({
      text: '(c.tag_facets @> $1::text[] OR NOT c.tag_facets && $2::text[])',
      values: [['gaf_tier=none'], ['gaf_tier', 'gaf_tier?=false']],
    });
  });

  it('compiles size and services to facets', () => {
    const [, size, services] = filterConditions({ size: ['small', 'large'], services: ['gutters'] }, { viewer: MANAGER });
    expect(size.compile().values).toEqual([['size=small', 'size=large']]);
    expect(services.compile().values).toEqual([['service:gutters?=true', 'specialty:gutters?=true']]);
  });
});

describe('custom field conditions', () => {
  it('binds the key and value of every operator', () => {
    for (const op of ['eq', 'gte', 'lte', 'contains', 'exists'] as const) {
      const value = op === 'exists' ? undefined : op === 'contains' ? "50%_off'" : 5;
      const q = customFieldCondition({ key: "k'; DROP", op, value }).compile();
      expect(q.text).not.toContain('DROP');
      expect(q.text).not.toContain('50%');
      expect(q.values).toContain("k'; DROP");
    }
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('scope', () => {
  it('limits "all" and other reps to managers', () => {
    expect(status(() => scopeCondition(REP, 'all'))).toBe(403);
    expect(status(() => scopeCondition(REP, { repId: OTHER }))).toBe(403);
    expect(status(() => scopeCondition(REP, { repId: REP.id }))).toBe(200);
    expect(status(() => scopeCondition(MANAGER, { repId: OTHER }))).toBe(200);
    expect(scopeCondition(REP, 'unallocated').compile().text).toBe('c.assigned_rep_id IS NULL');
  });
});

describe('filter conditions', () => {
  it('puts visibility first and binds every value', () => {
    const filter = leadFilterSchema.parse({ text: "O'Brien", tagsAll: ['size=small'], minRating: 4, unchecked: 'me' });
    const [first, ...rest] = filterConditions(filter, { viewer: REP });
    expect(first.compile().text).toBe('(c.assigned_rep_id = $1::uuid OR c.assigned_rep_id IS NULL)');
    const all = rest.map((c) => c.compile());
    expect(all.map((c) => c.text).join(' ')).not.toContain("O'Brien");
    expect(all.flatMap((c) => c.values)).toContain("%O'Brien%");
    expect(needsMyState(filter)).toBe(true);
    expect(filterConditions({}, { viewer: MANAGER }).map((c) => c.compile().text)).toEqual(['TRUE']);
  });

  it('compiles updatedInLastPoll to the pipeline flag, either way', () => {
    for (const flag of [true, false]) {
      const [, cond] = filterConditions({ updatedInLastPoll: flag }, { viewer: MANAGER }).map((c) => c.compile());
      expect(cond).toEqual({ text: 'c.updated_in_last_poll = $1::boolean', values: [flag] });
    }
  });

  it('compiles counties to a bound bpchar[] match and minPriority to a bound numeric bound', () => {
    const [, priority, counties] = filterConditions(
      leadFilterSchema.parse({ minPriority: 72.5, counties: ['36061', '34003'] }), { viewer: MANAGER }).map((c) => c.compile());
    expect(priority).toEqual({ text: 'c.priority_score >= $1::numeric', values: [72.5] });
    expect(counties).toEqual({ text: 'c.county_fips = ANY($1::bpchar[])', values: [['36061', '34003']] });
    expect(filterConditions({ counties: [] }, { viewer: MANAGER })).toHaveLength(1);
    expect(filterConditions({ minPriority: 0 }, { viewer: MANAGER })[1].compile().values).toEqual([0]);
  });

  it.each([
    [{ counties: ['3606'] }], [{ counties: ['36061 '] }], [{ counties: ["36061' OR '1'='1"] }], [{ counties: 'x' }],
    [{ counties: Array.from({ length: 101 }, (_, i) => String(10000 + i)) }],
    [{ minPriority: -1 }], [{ minPriority: 100.5 }], [{ minPriority: '70' }],
  ])('rejects %o', (f) => {
    expect(leadFilterSchema.safeParse(f).success).toBe(false);
  });

  it('needs a resolved centre for near', () => {
    const filter = leadFilterSchema.parse({ near: { zip: '10013', radiusMiles: 5 } });
    expect(status(() => filterConditions(filter, { viewer: REP }))).toBe(400);
    expect(filterConditions(filter, { viewer: REP, center: { lat: 40.7, lng: -74 } })).toHaveLength(2);
  });

  it('ships ZIP centroids for the Northeast', () => {
    expect(zctaCentroid('10013')).toEqual({ lat: 40.72005, lng: -74.00481 });
    expect(zctaCentroid('07302')).toBeDefined();
    expect(zctaCentroid('33101')).toBeUndefined();
  });
});
