// One table over every scripts/perf/results/runs/*.json run: throughput and p95 per endpoint vs the §3 targets.
// Usage: node scripts/perf/report.mjs [label ...]
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./results/runs/', import.meta.url);
const want = process.argv.slice(2);
const runs = readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
  .filter((r) => r.endpoints && (!want.length || want.includes(r.label)))
  .sort((a, b) => a.at.localeCompare(b.at));

const cell = (e) => (e ? `${e.p50}/${e.p95}/${e.p99}${e.pass === false ? ' FAIL' : ''}` : '-');
const hit = (e) => {
  if (!e?.cache) return '-';
  const n = Object.values(e.cache).reduce((a, b) => a + b, 0);
  return `${Math.round(((e.cache.hit ?? 0) / n) * 100)}%`;
};
console.log('| run | VUs | req/s | non-2xx | search p50/p95/p99 (<=300) | profile (<=200) | KPIs (<=500) | list hit | profile hit | CPU avg % pg / query / gateway |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  const e = r.endpoints;
  const cpu = r.cpu_pct ?? {};
  const c = (k) => cpu[k]?.avg ?? '-';
  console.log(`| ${r.label} | ${r.vus} | ${r.throughput_rps} | ${r.non_2xx} | ${cell(e.search)} | ${cell(e.profile)} | ${cell(e.kpi)} | ${hit(e.search)} | ${hit(e.profile)} | ${c('leadmaker-postgres-1')} / ${c('query')} / ${c('gateway')} |`);
}
