// The tag_facets conditions (db function system_tag_facets) must select exactly the leads the original
// jsonb containment conditions on system_tags did. Read-only; runs only with TEST_DATABASE_URL (a migrated database).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  and, certificationCondition, filterConditions, or, parseTagRef, raw, sql, tagCondition, type LeadFilter, type Sql,
} from '../src/index.ts';

const url = process.env.TEST_DATABASE_URL;
const MANAGER = { id: '8b974b0a-101c-47cf-bdfe-1aed4786febc', role: 'manager' as const };
const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const OTHER_REP = 'e1817cb3-f647-416d-9c20-084a9ab62324';

// The pre-tag_facets compiler, as the reference.
const contains = (tags: Record<string, unknown>[]) => sql`c.system_tags @> ${JSON.stringify(tags)}::jsonb`;

function referenceTag(ref: string): Sql {
  const { key, value } = parseTagRef(ref);
  if (value === undefined) return sql`(${contains([{ key }])} AND NOT ${contains([{ key, value: false }])})`;
  const candidates: unknown[] = [value, [value]];
  if (value === 'true' || value === 'false') candidates.push(value === 'true');
  if (value.trim() !== '' && Number.isFinite(Number(value))) candidates.push(Number(value));
  return or(candidates.map((v) => contains([{ key, value: v }])));
}

function referenceCertification(cert: string): Sql {
  const [source, level] = cert.split(':');
  const key = `${source}_tier`;
  const exact = contains([{ key, value: level }]);
  return level === 'none' ? sql`(${exact} OR NOT ${contains([{ key }])})` : exact;
}

const referenceServices = (keys: string[]) =>
  or(keys.flatMap((k) => [contains([{ key: `service:${k}`, value: true }]), contains([{ key: `specialty:${k}`, value: true }])]));

const t = (key: unknown, value?: unknown, extra: Record<string, unknown> = {}) =>
  (value === undefined ? { key, ...extra } : { key, value, ...extra });

const ELEMENTS: unknown[] = [
  t('gaf_tier', 'none'), t('gaf_tier', false), t('gaf_tier', null), t('gaf_tier'), t('gaf_tier', ['master_elite']),
  t('gaf_tier', 'MASTER_ELITE'), t('gaf_tier', 'master_elite'), t('gaf_tier', 'certified'), t('gaf_tier', true), t('gaf_tier', 'false'),
  t('size', ['small']), t('size', 'small '), t('size', 1), t('size', 'small'), t('size', 'large'), t('size', false),
  t('service:metal_roofing', 'true'), t('service:metal_roofing', 1), t('service:metal_roofing', [true]), t('service:metal_roofing', true),
  t('service:metal_roofing', false), t('specialty:metal_roofing', true), t('specialty:roof_repair', 'yes'), t('service:roof_repair', true),
  t('x', 5), t('x', 5.1), t('x', '5'), t('x', [5]), t('x', ['5']), t('x', 1e21), t('x', 0.1), t('x', -12.5), t('x', true),
  t('x', 'true'), t('x', [true]), t('x', ['true']), t('x', [['a']]), t('x', { a: 1 }), t('x', null), t('x', 'a,b'), t('x', '{a}'),
  t('x', '"q"'), t('x', 'NULL'), t('x', 'back\\slash'), t('x', 'Brooklyn 🏠'), t('x', ' 5'), t('x', ['a', 7, false, null]), t('x', []),
  t('A', 'b'), t('a=b', 'c'), t('x#', 1), t('k k', 'v'), t('ü', 'v'), t('', 'v'), t('x[]', 'v'), t('x?', true), t(5, 'x'), { value: 'nokey' },
  t('region', ['Queens', 'Brooklyn']), t('work_type:storm_emergency', true), t('work_type:storm_emergency', false),
  'str', 7, null, [], [{ key: 'nested' }],
];

// Deterministic subsets, plus duplicates and every element on its own.
const ROWS: unknown[][] = [[], ...ELEMENTS.map((e) => [e])];
for (let i = 0; i < 80; i++) ROWS.push(ELEMENTS.filter((_, j) => ((i * 31 + j * 17) ^ (i >> 2)) % 5 === 0));
ROWS.push([t('x', 5), t('x', false)], [t('gaf_tier', 'none'), t('gaf_tier', false)], [t('x', 5), t('x', 5.0), t('x', '5')]);

const REFS = [
  'gaf_tier', 'gaf_tier=none', 'gaf_tier=false', 'gaf_tier=true', 'gaf_tier=master_elite', 'size', 'size=small', 'size=small ', 'size=1',
  'service:metal_roofing', 'service:metal_roofing=true', 'service:metal_roofing=1', 'x', 'x=5', 'x=5.0', 'x= 5', 'x=+5', 'x=0x5',
  'x=1e21', 'x=0.1', 'x=-12.5', 'x=true', 'x=false', 'x=a', 'x=7', 'x=a,b', 'x={a}', 'x="q"', 'x=NULL', 'x=null', 'x=back\\slash',
  'x=Brooklyn 🏠', 'x=[]', 'A', 'A=b', 'a', 'region=Brooklyn', 'work_type:storm_emergency', 'nested',
  'ü', 'ü=v', 'x#', 'x#=1', 'x[]=v', 'x?=true', 'k k=v', '=v', 'x=',
];

const CERTS = ['gaf:master_elite', 'gaf:certified', 'gaf:none', 'gaf:bogus', 'nope:none'];

describe.skipIf(!url)('tag_facets conditions equal the system_tags conditions', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function matches(cond: Sql): Promise<number[]> {
    const q = sql`SELECT COALESCE(array_agg(c.ord::int ORDER BY c.ord), '{}') AS ords FROM (
      SELECT r.ord, r.tags AS system_tags, system_tag_facets(r.tags) AS tag_facets, NULL::uuid AS assigned_rep_id
      FROM jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb) WITH ORDINALITY r(tags, ord)) c WHERE ${cond}`.compile();
    return (await client.query<{ ords: number[] }>(q.text, q.values)).rows[0].ords;
  }

  it.each(REFS)('tag %j', async (ref) => {
    expect(await matches(tagCondition(ref))).toEqual(await matches(referenceTag(ref)));
  });

  it.each(CERTS)('certification %j', async (cert) => {
    expect(await matches(certificationCondition(cert))).toEqual(await matches(referenceCertification(cert)));
  });

  it('size, services and materials', async () => {
    const cases: [LeadFilter, Sql][] = [
      [{ size: ['small', 'large'] }, or(['small', 'large'].map((s) => contains([{ key: 'size', value: s }])))],
      [{ services: ['metal_roofing', 'roof_repair'] }, referenceServices(['metal_roofing', 'roof_repair'])],
      [{ materials: ['metal_roofing'] }, referenceServices(['metal_roofing'])],
    ];
    for (const [filter, reference] of cases)
      expect(await matches(and(filterConditions(filter, { viewer: MANAGER })))).toEqual(await matches(reference));
  });

  it('the rows exercise the conditions', async () => {
    let nonEmpty = 0;
    for (const ref of REFS) if ((await matches(referenceTag(ref))).length) nonEmpty++;
    expect(nonEmpty).toBeGreaterThan(REFS.length * 0.6);
  });
});

// counties and minPriority against hand-written SQL, over rows typed like companies (county_fips CHAR(5),
// priority_score NUMERIC(4,1)) with NULLs, a short (blank-padded) county, boundary scores and every owner.
const COUNTY_ROWS: { county: string | null; priority: number | null; rep: string | null }[] = [];
for (const county of ['36061', '34003', '36047', '3606', null])
  for (const priority of [null, 0, 69.9, 70, 70.1, 100])
    for (const rep of [null, REP.id, OTHER_REP]) COUNTY_ROWS.push({ county, priority, rep });

describe.skipIf(!url)('counties and minPriority equal hand-written SQL', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function matches(cond: Sql): Promise<number[]> {
    const q = sql`SELECT COALESCE(array_agg(c.ord::int ORDER BY c.ord), '{}') AS ords FROM (
      SELECT r.ord, (r.e->>'county')::char(5) AS county_fips, (r.e->>'priority')::numeric(4,1) AS priority_score,
             (r.e->>'rep')::uuid AS assigned_rep_id
      FROM jsonb_array_elements(${JSON.stringify(COUNTY_ROWS)}::jsonb) WITH ORDINALITY r(e, ord)) c WHERE ${cond}`.compile();
    return (await client.query<{ ords: number[] }>(q.text, q.values)).rows[0].ords;
  }

  const cases: [string, LeadFilter, typeof MANAGER | typeof REP, string][] = [
    ['two counties', { counties: ['36061', '34003'] }, MANAGER, "county_fips IN ('36061', '34003')"],
    ['an unknown county', { counties: ['99999'] }, MANAGER, "county_fips = '99999'"],
    ['minPriority 70', { minPriority: 70 }, MANAGER, 'priority_score >= 70'],
    ['minPriority 0 (no NULLs)', { minPriority: 0 }, MANAGER, 'priority_score IS NOT NULL'],
    ['a fractional minPriority', { minPriority: 69.95 }, MANAGER, 'priority_score >= 69.95'],
    ['both, for a rep', { counties: ['36047', '36061'], minPriority: 70 }, REP,
      `(assigned_rep_id = '${REP.id}' OR assigned_rep_id IS NULL) AND county_fips IN ('36047', '36061') AND priority_score >= 70`],
    ['both with scope mine', { scope: 'mine', counties: ['34003'], minPriority: 100 }, REP,
      `assigned_rep_id = '${REP.id}' AND county_fips = '34003' AND priority_score >= 100`],
  ];

  it.each(cases)('%s', async (_name, filter, viewer, reference) => {
    const got = await matches(and(filterConditions(filter, { viewer })));
    expect(got).toEqual(await matches(raw(reference)));
    if (filter.counties?.[0] !== '99999') expect(got.length).toBeGreaterThan(0);
  });
});
