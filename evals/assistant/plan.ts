// Case selection and LLM-call estimates for the assistant suites. Pure (no engine or provider imports), so
// `run.ts --dry-run` prints the plan without loading the engine, a provider or any credential.
import type { AssistantSuite, Expect, LeadQaCase, NlFilterCase } from '../lib/cases.ts';
import { loadCases } from '../lib/cases.ts';
import type { RunMode } from '../lib/report.ts';

export type AnyCase = NlFilterCase | LeadQaCase;

/** Live defaults (spec E4: nl <= 8 calls, qa <= 6 calls). */
export const LIVE_DEFAULTS = { limit: 8, maxCalls: { nl_filter: 9, lead_qa: 6 } as Record<AssistantSuite, number> };
export const MAX_TOOL_ROUNDS = 3;

export interface SuitePlan {
  suite: AssistantSuite;
  mode: RunMode;
  run: AnyCase[];
  /** case id -> why it is not run */
  skipped: Map<string, string>;
  maxCalls: number | null;
  estCalls: number;
  worstCalls: number;
}

export interface PlanOptions {
  mode: RunMode;
  ids?: string[];
  limit?: number;
  maxCalls?: number;
}

function expectsTool(e: Expect, tool: string): boolean {
  const has = (t: Expect['tool']) => (Array.isArray(t) ? t.includes(tool as never) : t === tool);
  return has(e.tool) || (e.anyOf ?? []).some((b) => has(b.tool));
}

/** Typical real LLM calls for one case: findLeads and todaysCalls answer in a second call; everything else in one. */
export function estimateCalls(c: AnyCase): { typical: number; worst: number } {
  if (c.fake_script) return { typical: 0, worst: 0 };
  return { typical: expectsTool(c.expect, 'findLeads') || expectsTool(c.expect, 'todaysCalls') ? 2 : 1, worst: MAX_TOOL_ROUNDS };
}

export function planSuite(suite: AssistantSuite, opts: PlanOptions, all?: AnyCase[]): SuitePlan {
  const cases: AnyCase[] = all ?? (suite === 'nl_filter' ? loadCases('nl_filter') : loadCases('lead_qa'));
  const skipped = new Map<string, string>();
  const real = opts.mode !== 'offline';
  let pool = cases;
  if (opts.ids?.length) {
    const want = new Set(opts.ids);
    for (const c of cases) if (!want.has(c.id)) skipped.set(c.id, 'not in --ids');
    pool = cases.filter((c) => want.has(c.id));
  }
  if (real) {
    for (const c of pool) if (c.fake_script) skipped.set(c.id, 'offline only (fake_script)');
    pool = pool.filter((c) => !c.fake_script);
    if (opts.mode === 'gateway' && suite === 'lead_qa') {
      for (const c of pool) skipped.set(c.id, 'lead_qa needs the fixture leads: in-process only');
      pool = [];
    }
    // Smoke cases first when --limit trims the run.
    pool = [...pool].sort((a, b) => Number(!!b.smoke) - Number(!!a.smoke));
  }
  const limit = opts.limit ?? (real ? LIVE_DEFAULTS.limit : undefined);
  if (limit !== undefined && pool.length > limit) {
    for (const c of pool.slice(limit)) skipped.set(c.id, `--limit ${limit}`);
    pool = pool.slice(0, limit);
  }
  const maxCalls = real ? (opts.maxCalls ?? LIVE_DEFAULTS.maxCalls[suite]) : null;
  const run: AnyCase[] = [];
  let est = 0;
  let worst = 0;
  for (const c of pool) {
    const e = estimateCalls(c);
    if (maxCalls !== null && est + e.typical > maxCalls) {
      skipped.set(c.id, `over the call budget (${maxCalls})`);
      continue;
    }
    run.push(c);
    est += real ? e.typical : 0;
    worst += real ? e.worst : 0;
  }
  const order = new Map(cases.map((c, i) => [c.id, i]));
  run.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { suite, mode: opts.mode, run, skipped, maxCalls, estCalls: est, worstCalls: maxCalls === null ? worst : Math.min(worst, maxCalls) };
}

export function describePlan(p: SuitePlan, provider?: string): string {
  const lines = [
    `${p.suite}: ${p.run.length} cases (${p.mode}${provider ? `, provider ${provider}` : ''}${p.maxCalls !== null ? `, budget ${p.maxCalls} calls` : ''})`,
    `  run: ${p.run.map((c) => c.id).join(', ') || 'none'}`,
  ];
  for (const [id, why] of p.skipped) lines.push(`  skip ${id}: ${why}`);
  lines.push(p.mode === 'offline'
    ? '  estimated LLM calls: 0 real calls (fake provider)'
    : `  estimated LLM calls: ${p.estCalls} (worst case ${p.worstCalls}${p.maxCalls !== null ? `, hard cap ${p.maxCalls}` : ''})`);
  return lines.join('\n');
}
