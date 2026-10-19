import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cell, percentile, renderMarkdown, scrub, stamp, summarize, writeReport, type CaseRecord, type SuiteReport } from './report.ts';

const dir = mkdtempSync(join(tmpdir(), 'lm-evals-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function rec(id: string, over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id, suite: 'nl_filter', tags: ['scope'], input: `utterance ${id}`, asserted: true, pass: true, dslPass: true,
    contractFailures: [], failures: [], actual: { tool: 'applyListFilters', filter: { scope: 'all' } },
    latencyMs: 100, llmCalls: 1, inputTokens: 1000, outputTokens: 50, ...over,
  };
}

const report: SuiteReport = {
  suite: 'nl_filter', mode: 'live', provider: 'fake', model: 'fake-1', promptVersion: 'assistant/v1',
  startedAt: '2026-10-19T19:00:00.000Z', finishedAt: '2026-10-19T19:02:30.000Z', now: '2026-10-19T19:00:00.000Z',
  options: { limit: 4 }, notes: ['A note with a key-shaped string AIza' + 'x'.repeat(35)],
  cases: [
    rec('nl-01', { latencyMs: 1200, tags: ['scope', 'near'] }),
    rec('nl-02', { pass: false, dslPass: false, failures: ['filter.certifications: missing ["gaf:none"]'], latencyMs: 3000, tags: ['certifications'] }),
    rec('nl-03', { pass: false, contractFailures: ['a [src:] tag reached the client'], latencyMs: 800, llmCalls: 2 }),
    rec('nl-04', { asserted: false, dslPass: null, pass: false, skipped: '--limit 3', latencyMs: null, llmCalls: 0, inputTokens: 0, outputTokens: 0 }),
  ],
};

describe('summary', () => {
  it('counts run cases only, per tag, with latency percentiles and totals', () => {
    const s = summarize(report);
    expect(s).toMatchObject({ cases: 4, run: 3, skipped: 1, llmCalls: 4, inputTokens: 3000, outputTokens: 150 });
    expect(s.passRate).toEqual({ pass: 1, total: 3 });
    expect(s.dsl).toEqual({ pass: 2, total: 3 });
    expect(s.contract).toEqual({ pass: 2, total: 3 });
    expect(s.byTag.scope!.pass).toEqual({ pass: 1, total: 2 });
    expect(s.byTag.certifications!.dsl).toEqual({ pass: 0, total: 1 });
    expect(s.latencyMs).toEqual({ p50: 1200, p95: 3000 });
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });
});

describe('writer', () => {
  it('writes <suite>-<UTC yyyymmddThhmm>.json and .md', () => {
    const paths = writeReport(report, dir);
    expect(paths.json).toBe(join(dir, 'nl_filter-20261019T1902.json'));
    expect(paths.md).toBe(join(dir, 'nl_filter-20261019T1902.md'));
    const json = JSON.parse(readFileSync(paths.json, 'utf8'));
    expect(json.cases).toHaveLength(4);
    expect(json.summary.passRate).toEqual({ pass: 1, total: 3 });
    const md = readFileSync(paths.md, 'utf8');
    expect(md).toContain('# Eval report: nl_filter');
    expect(md).toContain('| Pass rate (contract + expectations) | 1/3 (33%) |');
    expect(md).toContain('| Latency p50 / p95 | 1200 ms / 3000 ms |');
    expect(md).toMatch(/\| nl-02 \| yes \|/);
    expect(md).toMatch(/\| nl-03 \| yes \| .*contract: a \[src:\] tag reached the client/);
    expect(md).toContain('| --limit 3 | nl-04 |');
    expect(md).toContain('## By tag');
  });

  it('never writes key-shaped strings', () => {
    const paths = writeReport(report, dir);
    for (const p of [paths.json, paths.md]) expect(readFileSync(p, 'utf8')).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(scrub('k=sk-ant-abcdefghijklmnop and sk-' + 'a'.repeat(24))).toBe('k=[redacted] and [redacted]');
  });

  it('labels the offline nl DSL score as the rules-parser baseline', () => {
    expect(renderMarkdown({ ...report, mode: 'offline' })).toContain('rules-parser baseline (not asserted)');
  });

  it('escapes table cells and stamps in UTC', () => {
    expect(cell('a|b\nc', 10)).toBe('a\\|b c');
    expect(cell('x'.repeat(20), 10)).toHaveLength(10);
    expect(stamp(new Date('2026-10-19T23:59:59-04:00'))).toBe('20261020T0359');
  });
});
