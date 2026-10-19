// Live-run planning (budgets, --limit, smoke-first) and --dry-run, which must make no calls and load no provider.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadCases } from '../lib/cases.ts';
import { LIVE_DEFAULTS, describePlan, estimateCalls, planSuite } from './plan.ts';

describe('planSuite', () => {
  it('offline runs every case and estimates no real calls', () => {
    const p = planSuite('nl_filter', { mode: 'offline' });
    expect(p.run.length).toBe(loadCases('nl_filter').length);
    expect(p.skipped.size).toBe(0);
    expect(p.estCalls).toBe(0);
    expect(p.maxCalls).toBeNull();
  });

  it('live: no scripted cases, smoke first, --limit 8, within the per-suite call budget', () => {
    for (const suite of ['nl_filter', 'lead_qa'] as const) {
      const p = planSuite(suite, { mode: 'live' });
      expect(p.run.length).toBeLessThanOrEqual(LIVE_DEFAULTS.limit);
      expect(p.run.every((c) => !c.fake_script)).toBe(true);
      expect(p.maxCalls).toBe(LIVE_DEFAULTS.maxCalls[suite]);
      expect(p.estCalls).toBeLessThanOrEqual(p.maxCalls!);
      expect(p.worstCalls).toBeLessThanOrEqual(p.maxCalls!);
      const smoke = loadCases(suite as 'nl_filter').filter((c) => c.smoke && !c.fake_script).map((c) => c.id);
      for (const id of smoke) expect(p.run.map((c) => c.id)).toContain(id);
      for (const c of loadCases(suite as 'nl_filter').filter((x) => x.fake_script)) expect(p.skipped.get(c.id)).toMatch(/offline only/);
    }
    // the spec's live budget: nl <= 8, qa <= 6 calls
    expect(planSuite('nl_filter', { mode: 'live' }).maxCalls).toBe(9); // nl-53 (todaysCalls) answers in a second call
    expect(planSuite('lead_qa', { mode: 'live' }).maxCalls).toBe(6);
  });

  it('--ids and --max-calls narrow the run; over-budget cases are skipped with a reason', () => {
    const p = planSuite('nl_filter', { mode: 'live', ids: ['nl-01', 'nl-42', 'nl-02'], maxCalls: 2 });
    expect(p.run.map((c) => c.id)).toEqual(['nl-01', 'nl-02']);
    expect(p.skipped.get('nl-42')).toMatch(/over the call budget/);
    expect(p.skipped.get('nl-03')).toBe('not in --ids');
  });

  it('gateway mode skips lead_qa (its leads are fixtures)', () => {
    const p = planSuite('lead_qa', { mode: 'gateway' });
    expect(p.run).toEqual([]);
    expect([...p.skipped.values()].some((w) => /in-process only/.test(w))).toBe(true);
  });

  it('estimates: findLeads answers in two calls, scripted cases cost nothing real', () => {
    const nl = new Map(loadCases('nl_filter').map((c) => [c.id, c]));
    expect(estimateCalls(nl.get('nl-42')!)).toEqual({ typical: 2, worst: 3 });
    expect(estimateCalls(nl.get('nl-01')!)).toEqual({ typical: 1, worst: 3 });
    expect(estimateCalls(nl.get('nl-45')!)).toEqual({ typical: 0, worst: 0 });
    expect(describePlan(planSuite('lead_qa', { mode: 'live' }))).toMatch(/estimated LLM calls: \d+ \(worst case \d+, hard cap 6\)/);
  });
});

describe('run.ts --dry-run', () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(REPO_ROOT, 'evals/assistant/run.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30_000,
  });
  // No key in the environment and a provider that would fail if it were ever constructed and called.
  const env = { PATH: process.env.PATH, LEADMAKER_ASSISTANT_LLM_PROVIDER: 'gemini', LEADMAKER_LLM_BASE_URL: 'http://127.0.0.1:9' };

  it('prints the plan and the estimate and makes no calls', () => {
    const r = run(['--live', '--dry-run'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nl_filter: \d+ cases \(live, budget 9 calls\)/);
    expect(r.stdout).toMatch(/lead_qa: \d+ cases \(live, budget 6 calls\)/);
    expect(r.stdout).toMatch(/total: about \d+ LLM calls \(hard cap 15\)/);
    expect(r.stdout).toContain('dry run: no provider was created and no calls were made');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/AIza|api[_-]?key/i);
  });

  it('defers insights to the Python runner', () => {
    const r = run(['--suite', 'insights'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('python -m evals.insights.run');
  });
});
