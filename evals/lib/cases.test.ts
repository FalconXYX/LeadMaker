// The case files themselves: schema-valid, enough of them, fixtures present and safe, and the committed JSON
// schema in sync with the zod source.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { leadFilterJsonSchema, type FilterVocabulary, type LeadAiContext } from '@leadmaker/shared';
import { describe, expect, it } from 'vitest';
import { assertedPaths } from './assert.ts';
import {
  CASES_SCHEMA_PATH, CASE_SCHEMAS, EVALS_DIR, SUITES, casesJsonSchema, loadCases, readCaseLines, readJson,
  type Expect, type FilterAssert,
} from './cases.ts';

const MIN_CASES = { nl_filter: 44, lead_qa: 21, insights: 12 } as const;
const users = readJson<Record<string, { id: string; name: string }>>(join(EVALS_DIR, 'fixtures', 'users.json'));
const EMAIL = /\S+@\S+\.\w+/;
const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

describe('case files', () => {
  for (const suite of SUITES) {
    it(`${suite}: every line validates against its schema, ids are unique and in order`, () => {
      const lines = readCaseLines(suite);
      expect(lines.length).toBeGreaterThanOrEqual(MIN_CASES[suite]);
      for (const { line, value } of lines) {
        const r = CASE_SCHEMAS[suite].safeParse(value);
        expect(r.success, `${suite} line ${line}: ${r.success ? '' : r.error.message}`).toBe(true);
      }
      const ids = lines.map((l) => (l.value as { id: string }).id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))).toEqual(ids);
    });
  }

  it('the committed cases.schema.json matches the zod schemas (node evals/lib/export-schema.ts)', () => {
    const committed = JSON.parse(readFileSync(CASES_SCHEMA_PATH, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(casesJsonSchema())));
    expect(Object.keys(committed.$defs)).toEqual([...SUITES]);
  });

  it('spec case ids exist (nl-01..44, qa-01..21, in-01..12)', () => {
    const has = (suite: 'nl_filter' | 'lead_qa' | 'insights', prefix: string, n: number) => {
      const ids = new Set(loadCases(suite as 'nl_filter').map((c) => c.id));
      for (let i = 1; i <= n; i++) expect(ids.has(`${prefix}-${String(i).padStart(2, '0')}`), `${prefix}-${i}`).toBe(true);
    };
    has('nl_filter', 'nl', 44);
    has('lead_qa', 'qa', 21);
    has('insights', 'in', 12);
  });

  it('nl_filter assertions only name LeadFilter keys', () => {
    const keys = new Set(Object.keys((leadFilterJsonSchema() as { properties: Record<string, unknown> }).properties));
    const check = (id: string, f?: FilterAssert) => {
      // absent may name tool-only keys (repId) to prove the server stripped them
      const positive = [...assertedPaths(f)].filter((p) => !(f?.absent ?? []).includes(p));
      for (const p of positive) expect(keys.has(p.split('.')[0]!), `${id}: ${p}`).toBe(true);
      for (const k of f?.onlyKeys ?? []) expect(keys.has(k), `${id}: onlyKeys ${k}`).toBe(true);
    };
    const all = (e: Expect, id: string) => {
      check(id, e.filter);
      for (const b of e.anyOf ?? []) check(id, b.filter);
    };
    for (const c of loadCases('nl_filter')) all(c.expect, c.id);
    for (const c of loadCases('lead_qa')) all(c.expect, c.id);
  });

  it('marks enough cases for offline assertions and small live runs', () => {
    const nl = loadCases('nl_filter');
    expect(nl.filter((c) => c.offline).length).toBeGreaterThanOrEqual(20);
    expect(nl.filter((c) => c.smoke && !c.fake_script).length).toBeLessThanOrEqual(8);
    expect(loadCases('lead_qa').filter((c) => c.smoke && !c.fake_script).length).toBeLessThanOrEqual(6);
    expect(loadCases('lead_qa').filter((c) => c.fake_script).length).toBeGreaterThanOrEqual(3);
  });
});

describe('fixtures', () => {
  const vocab = readJson<FilterVocabulary>(join(EVALS_DIR, 'fixtures', 'vocabulary.json'));

  it('vocabulary: the spec counties, fixed rep ids, sorted by lead count', () => {
    const fips = vocab.counties.map((c) => c.fips);
    for (const f of ['34003', '34013', '34017', '34023', '34025', '34027', '34031', '34039', '36005', '36047', '36059', '36061', '36081', '36085', '36087', '36119']) {
      expect(fips).toContain(f);
    }
    const counts = vocab.counties.map((c) => c.leadCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(vocab.reps.map((r) => r.name)).toEqual(['Jordan Lee', 'Priya Shah', 'Sam Rivera']);
    for (const r of vocab.reps) expect(Object.values(users).some((u) => u.id === r.id && u.name === r.name)).toBe(true);
    expect(vocab.customTags.map((t) => t.name)).toContain('Bulk buyer');
    expect(vocab.customFieldKeys.map((k) => k.key)).toContain('annual_volume_squares');
  });

  it('lead_qa: every referenced fixture exists and has the LeadAiContext shape, with no contact data', () => {
    const dir = join(EVALS_DIR, 'lead_qa', 'fixtures');
    const used = new Set(loadCases('lead_qa').map((c) => c.fixture));
    for (const f of used) expect(existsSync(join(dir, `${f}.json`)), f).toBe(true);
    for (const file of readdirSync(dir)) {
      const raw = readFileSync(join(dir, file), 'utf8');
      const c = JSON.parse(raw) as LeadAiContext;
      for (const k of ['id', 'businessName', 'gaf', 'tags', 'contacts', 'timing', 'notes', 'activity', 'website', 'insights', 'customFields']) {
        expect(c, `${file}.${k}`).toHaveProperty(k);
      }
      expect(raw, `${file}: an email address`).not.toMatch(EMAIL);
      expect(raw.replace(/"(id|at|dueAt|generatedAt|stageChangedAt|lastContactedAt)": "[^"]*"/g, ''), `${file}: a phone number`).not.toMatch(PHONE);
      if (c.assignedRep) expect(Object.values(users).some((u) => u.id === c.assignedRep!.id), file).toBe(true);
      for (const ct of c.contacts) expect(Object.keys(ct).sort()).toEqual(['doNotContact', 'hasEmail', 'hasPhone', 'name', 'source', 'title']);
    }
  });

  it('lead_qa canaries never appear literally in the data, so any appearance in an answer is obedience', () => {
    for (const c of loadCases('lead_qa')) {
      if (!c.canary) continue;
      const raw = readFileSync(join(EVALS_DIR, 'lead_qa', 'fixtures', `${c.fixture}.json`), 'utf8');
      expect(raw.includes(c.canary), `${c.id}`).toBe(false);
      expect(c.expect.text?.mustNotMatch ?? [], c.id).toContain(c.canary);
    }
  });

  it('insights: fixtures are LeadFacts dicts with unique, prefixed facts', () => {
    for (const c of loadCases('insights')) {
      const d = readJson<{ company_id: string; business_name: string; facts: { id: string; key: string; text: string }[]; website_excerpt: string }>(
        join(EVALS_DIR, 'insights', 'fixtures', `${c.fixture}.json`));
      expect(d.company_id).toMatch(/^[0-9a-f-]{36}$/);
      const ids = d.facts.map((f) => f.id);
      expect(new Set(ids).size, c.fixture).toBe(ids.length);
      for (const f of d.facts) {
        expect(f.id).toMatch(/^F\d+$/);
        expect(f.text.startsWith(f.key), `${c.fixture} ${f.id}`).toBe(true);
        expect(f.text, `${c.fixture} ${f.id}: no raw angle brackets (fixtures are pre-fenced)`).not.toMatch(/[<>]/);
      }
      expect(d.facts[0]!.text).toBe(`business_name: ${d.business_name}`);
    }
  });
});
