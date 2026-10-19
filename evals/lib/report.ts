// Eval reports: data/evals/<suite>-<UTC yyyymmddThhmm>.json (every case) and .md (pass rates per suite and tag,
// latency percentiles, call and token totals, a failures table). evals/insights/run.py writes the same shape.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RunMode = 'offline' | 'live' | 'gateway';

export interface CaseRecord {
  id: string;
  suite: string;
  tags: string[];
  /** The utterance or question (truncated), for the failures table. */
  input: string;
  /** Counted in the asserted pass rate (offline: `offline: true` and fake_script cases; live: every case run). */
  asserted: boolean;
  /** Contract checks and (when asserted) the DSL passed. */
  pass: boolean;
  /** The DSL result whether or not it is asserted; null when no DSL ran (skipped). */
  dslPass: boolean | null;
  contractFailures: string[];
  failures: string[];
  /** Set when the case was not run (budget, --limit, offline-only in live mode, ...). */
  skipped?: string;
  actual: Record<string, unknown>;
  latencyMs: number | null;
  firstTokenMs?: number | null;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SuiteReport {
  suite: string;
  mode: RunMode;
  provider: string | null;
  model: string | null;
  promptVersion?: string | null;
  startedAt: string;
  finishedAt: string;
  /** The clock the cases ran against (pinned in-process). */
  now: string;
  options: Record<string, unknown>;
  cases: CaseRecord[];
  notes: string[];
}

export interface Rate { pass: number; total: number }
export interface SuiteSummary {
  cases: number;
  run: number;
  skipped: number;
  passRate: Rate;
  asserted: Rate;
  dsl: Rate;
  contract: Rate;
  byTag: Record<string, { pass: Rate; dsl: Rate }>;
  latencyMs: { p50: number | null; p95: number | null };
  firstTokenMs: { p50: number | null; p95: number | null };
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

const rate = (xs: boolean[]): Rate => ({ pass: xs.filter(Boolean).length, total: xs.length });

export function summarize(r: SuiteReport): SuiteSummary {
  const run = r.cases.filter((c) => !c.skipped);
  const byTag: SuiteSummary['byTag'] = {};
  for (const tag of [...new Set(run.flatMap((c) => c.tags))].sort()) {
    const cs = run.filter((c) => c.tags.includes(tag));
    byTag[tag] = { pass: rate(cs.map((c) => c.pass)), dsl: rate(cs.filter((c) => c.dslPass !== null).map((c) => c.dslPass === true)) };
  }
  const lat = run.map((c) => c.latencyMs).filter((x): x is number => typeof x === 'number');
  const first = run.map((c) => c.firstTokenMs).filter((x): x is number => typeof x === 'number');
  return {
    cases: r.cases.length,
    run: run.length,
    skipped: r.cases.length - run.length,
    passRate: rate(run.map((c) => c.pass)),
    asserted: rate(run.filter((c) => c.asserted).map((c) => c.pass)),
    dsl: rate(run.filter((c) => c.dslPass !== null).map((c) => c.dslPass === true)),
    contract: rate(run.map((c) => c.contractFailures.length === 0)),
    byTag,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    firstTokenMs: { p50: percentile(first, 50), p95: percentile(first, 95) },
    llmCalls: run.reduce((n, c) => n + c.llmCalls, 0),
    inputTokens: run.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: run.reduce((n, c) => n + c.outputTokens, 0),
  };
}

// Defense in depth: reports hold model output, never keys; scrub anything key-shaped anyway.
const SECRET = /AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}/g;
export function scrub(s: string): string {
  return s.replace(SECRET, '[redacted]');
}

const pct = (r: Rate) => (r.total ? `${r.pass}/${r.total} (${Math.round((100 * r.pass) / r.total)}%)` : 'n/a');
const ms = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)} ms`);
export function cell(v: unknown, max = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  const t = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function renderMarkdown(r: SuiteReport): string {
  const s = summarize(r);
  const dslLabel = r.mode === 'offline'
    ? (r.suite === 'nl_filter' ? 'DSL score, rules-parser baseline (not asserted)' : 'DSL score, all cases (asserted where marked)')
    : 'DSL score';
  const lines = [
    `# Eval report: ${r.suite}`,
    '',
    `Mode **${r.mode}** · provider ${r.provider ?? 'none'} · model ${r.model ?? 'n/a'}${r.promptVersion ? ` · prompt ${r.promptVersion}` : ''}`,
    `Started ${r.startedAt} · finished ${r.finishedAt} · eval clock ${r.now}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Cases run / skipped | ${s.run} / ${s.skipped} |`,
    `| Pass rate (contract + expectations) | ${pct(s.passRate)} |`,
    `| Asserted cases | ${pct(s.asserted)} |`,
    `| ${dslLabel} | ${pct(s.dsl)} |`,
    `| Contract checks | ${pct(s.contract)} |`,
    `| Latency p50 / p95 | ${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)} |`,
    ...(s.firstTokenMs.p50 !== null ? [`| First token p50 / p95 | ${ms(s.firstTokenMs.p50)} / ${ms(s.firstTokenMs.p95)} |`] : []),
    `| ${r.mode === 'offline' ? 'Fake provider calls' : 'LLM calls'} · input tokens · output tokens | ${s.llmCalls} · ${s.inputTokens} · ${s.outputTokens} |`,
    '',
  ];
  if (r.notes.length) lines.push(...r.notes.map((n) => `- ${scrub(n)}`), '');
  if (Object.keys(s.byTag).length) {
    lines.push('## By tag', '', '| Tag | Pass | DSL |', '|---|---|---|');
    for (const [tag, t] of Object.entries(s.byTag)) lines.push(`| ${tag} | ${pct(t.pass)} | ${pct(t.dsl)} |`);
    lines.push('');
  }
  const failed = r.cases.filter((c) => !c.skipped && (!c.pass || c.dslPass === false));
  lines.push('## Failures', '');
  if (!failed.length) lines.push('None.', '');
  else {
    lines.push('| Case | Asserted | Input | Failed checks | Actual |', '|---|---|---|---|---|');
    for (const c of failed) {
      const why = [...c.contractFailures.map((f) => `contract: ${f}`), ...c.failures].join('; ');
      const actual = c.actual.filter ?? c.actual.text ?? c.actual.summary ?? c.actual;
      lines.push(`| ${c.id} | ${c.asserted ? 'yes' : 'no'} | ${cell(scrub(c.input), 80)} | ${cell(scrub(why), 300)} | ${cell(scrub(typeof actual === 'string' ? actual : JSON.stringify(actual)), 200)} |`);
    }
    lines.push('');
  }
  const skipped = new Map<string, string[]>();
  for (const c of r.cases) if (c.skipped) skipped.set(c.skipped, [...(skipped.get(c.skipped) ?? []), c.id]);
  if (skipped.size) {
    lines.push('## Skipped', '', '| Why | Cases |', '|---|---|');
    for (const [why, ids] of skipped) lines.push(`| ${cell(scrub(why))} | ${ids.join(', ')} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** UTC yyyymmddThhmm. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').slice(0, 13);
}

export function writeReport(r: SuiteReport, outDir: string, at = new Date(r.finishedAt)): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${r.suite}-${stamp(at)}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, `${scrub(JSON.stringify({ ...r, summary: summarize(r) }, null, 2))}\n`);
  writeFileSync(md, renderMarkdown(r));
  return { json, md };
}
