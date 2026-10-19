// Assistant eval runner (nl_filter + lead_qa): node evals/assistant/run.ts [flags]
//
//   (default)            offline: the fake provider (rules + scripted adversarial outputs); exits 1 on an asserted failure
//   --live               the provider configured in the environment (node --env-file-if-exists=.env), in process,
//                        with the fixture QueryClient and the pinned clock; reports only, exits 0 unless it crashes
//   --via-gateway URL    end to end over HTTP (dev-login as rep1 / manager); nl_filter only
//   --suite nl_filter|lead_qa|insights|all   (insights is the Python runner's: python -m evals.insights.run)
//   --limit N            cases per suite (live default 8; smoke cases first)
//   --ids a,b            only these cases
//   --max-calls N        real LLM calls per suite (live defaults: nl_filter 8, lead_qa 6); a hard cap
//   --dry-run            print the plan and the call estimate; loads no engine, provider or credential
//   --out DIR            report directory (default data/evals)
//   --allow-provider X   live providers other than gemini/fake are refused without it (paid APIs)
//   --rpm N              spacing between live cases (default LEADMAKER_ASSISTANT_RPM, else 8 for gemini, 6 via the
//                        gateway (the per-user minute limit), off otherwise)
//
// Prints provider and model names, never keys.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ASSISTANT_SUITES, REPO_ROOT, type AssistantSuite } from '../lib/cases.ts';
import { scrub, summarize, writeReport, type CaseRecord, type RunMode, type SuiteReport } from '../lib/report.ts';
import { describePlan, planSuite, type SuitePlan } from './plan.ts';

const FREE_PROVIDERS = ['gemini', 'fake'];

const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'all' },
    live: { type: 'boolean', default: false },
    'via-gateway': { type: 'string' },
    limit: { type: 'string' },
    ids: { type: 'string' },
    'max-calls': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string' },
    'allow-provider': { type: 'string', multiple: true, default: [] },
    rpm: { type: 'string' },
  },
  allowPositionals: false,
});

const int = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
};

async function main(): Promise<number> {
  const suiteArg = values.suite!;
  if (![...ASSISTANT_SUITES, 'insights', 'all'].includes(suiteArg)) throw new Error(`unknown --suite ${suiteArg}`);
  if (suiteArg === 'insights') {
    console.log('nothing to do for --suite insights here: run .venv/bin/python -m evals.insights.run');
    return 0;
  }
  const suites: AssistantSuite[] = suiteArg === 'all' ? [...ASSISTANT_SUITES] : [suiteArg as AssistantSuite];
  const gatewayUrl = values['via-gateway']?.replace(/\/+$/, '');
  const mode: RunMode = gatewayUrl ? 'gateway' : values.live ? 'live' : 'offline';
  const ids = values.ids ? values.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const plans: SuitePlan[] = suites.map((s) => planSuite(s, {
    mode, ids, limit: int(values.limit, '--limit'), maxCalls: int(values['max-calls'], '--max-calls'),
  }));

  if (values['dry-run']) {
    for (const p of plans) console.log(describePlan(p));
    const est = plans.reduce((n, p) => n + p.estCalls, 0);
    const cap = plans.reduce((n, p) => n + (p.maxCalls ?? 0), 0);
    console.log(mode === 'offline'
      ? 'total: 0 real LLM calls (offline uses the fake provider)'
      : `total: about ${est} LLM calls${cap ? ` (hard cap ${cap})` : ''}`);
    console.log('dry run: no provider was created and no calls were made');
    return 0;
  }

  // Loaded only for a real run, so --dry-run never touches the engine or a provider.
  const runner = await import('./runner.ts');
  let provider = null;
  let providerLabel = 'gateway';
  if (mode === 'offline') {
    provider = runner.offlineProvider();
    providerLabel = provider.fingerprint;
  } else if (mode === 'live') {
    const { createProvider } = await import('../../services/assistant/src/llm/index.ts');
    provider = createProvider(process.env);
    if (!provider) {
      console.error('no LLM provider is configured: set GEMINI_API_KEY in .env (run with node --env-file-if-exists=.env)');
      return 2;
    }
    if (!FREE_PROVIDERS.includes(provider.name) && !values['allow-provider']!.includes(provider.name)) {
      console.error(`refusing live provider ${provider.name}: only the Gemini free tier is approved for live evals (--allow-provider ${provider.name} overrides)`);
      return 2;
    }
    const ok = provider.isConfigured();
    if (!ok.ok) {
      console.error(`provider ${provider.name} is not configured: ${ok.reason}`);
      return 2;
    }
    providerLabel = provider.fingerprint;
  }

  const outDir = values.out ?? join(REPO_ROOT, 'data', 'evals');
  let failed = false;
  const tokens = new Map();
  const rpm = int(values.rpm, '--rpm') ?? int(process.env.LEADMAKER_ASSISTANT_RPM || undefined, 'LEADMAKER_ASSISTANT_RPM')
    ?? (mode === 'gateway' ? 6 : provider?.name === 'gemini' ? 8 : 0); // gateway: the per-user limit is 6/min
  const pacer = new runner.Pacer(mode === 'offline' ? 0 : rpm);
  for (const plan of plans) {
    console.log(describePlan(plan, providerLabel));
    const budget = plan.maxCalls !== null && mode === 'live' ? new runner.CountingBudget(plan.maxCalls) : undefined;
    const env = { mode, provider, now: runner.PINNED_NOW, budget, gatewayUrl, tokens };
    const startedAt = new Date().toISOString();
    const records: CaseRecord[] = [];
    const notes: string[] = [];
    let gatewayCalls = 0;
    for (const c of plan.run) {
      if (budget?.exhausted || (mode === 'gateway' && plan.maxCalls !== null && gatewayCalls >= plan.maxCalls)) {
        records.push(runner.skippedRecord(plan.suite, c, 'call budget or provider quota reached'));
        continue;
      }
      let rec: CaseRecord;
      await pacer.beforeCase();
      try {
        rec = await runner.runCase(plan.suite, c, env);
      } catch (err) {
        rec = { ...runner.skippedRecord(plan.suite, c, ''), skipped: undefined, asserted: true, dslPass: false,
          contractFailures: [`runner error: ${scrub(String((err as Error)?.message ?? err))}`], actual: {} };
      }
      gatewayCalls += rec.llmCalls;
      pacer.afterCase(mode === 'gateway' ? Math.max(1, rec.llmCalls) : rec.llmCalls);
      records.push(rec);
      const mark = rec.pass ? (rec.dslPass === false ? 'ok*' : 'ok') : 'FAIL';
      console.log(`  ${mark.padEnd(4)} ${c.id} ${rec.latencyMs ?? '-'} ms${rec.llmCalls ? ` · ${rec.llmCalls} call(s)` : ''}`);
    }
    for (const [id, why] of plan.skipped) {
      const c = { id, tags: [] as string[] };
      records.push(runner.skippedRecord(plan.suite, c, why));
    }
    if (budget?.exhausted) notes.push(`The call budget (${budget.max}) or the provider quota stopped the run early.`);
    if (mode === 'offline' && plan.suite === 'nl_filter') {
      notes.push('Offline the fake provider answers with parseFilterRules, so the DSL score is the rules-parser baseline; only cases marked offline (and scripted cases) are asserted.');
    }
    const order = new Map(plan.run.map((c, i) => [c.id, i]));
    records.sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6) || a.id.localeCompare(b.id));
    const report: SuiteReport = {
      suite: plan.suite, mode, provider: provider?.name ?? (mode === 'gateway' ? 'gateway' : null),
      model: provider?.model ?? null, promptVersion: 'assistant/v1', startedAt, finishedAt: new Date().toISOString(),
      now: (mode === 'gateway' ? new Date() : runner.PINNED_NOW).toISOString(),
      options: { limit: values.limit ?? null, ids: ids ?? null, maxCalls: plan.maxCalls, gateway: gatewayUrl ?? null },
      cases: records, notes,
    };
    const s = summarize(report);
    const paths = writeReport(report, outDir);
    const pct = (r: { pass: number; total: number }) => `${r.pass}/${r.total}`;
    console.log(`${plan.suite} (${mode}): pass ${pct(s.passRate)}, asserted ${pct(s.asserted)}, DSL ${pct(s.dsl)}, contract ${pct(s.contract)}, ${s.llmCalls} ${mode === 'offline' ? 'fake provider' : 'LLM'} calls`);
    console.log(`report: ${paths.md}\n        ${paths.json}`);
    if (mode === 'offline' && s.asserted.pass < s.asserted.total) {
      failed = true;
      for (const r of records) {
        if (r.asserted && !r.pass && !r.skipped) console.error(`  FAIL ${r.id}: ${scrub([...r.contractFailures, ...r.failures].join('; ')).slice(0, 400)}`);
      }
    }
  }
  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}, (err) => {
  console.error(`eval runner crashed: ${scrub(String((err as Error)?.message ?? err))}`);
  process.exitCode = 2;
});
