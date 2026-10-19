// EXPLAIN (ANALYZE, BUFFERS) of the query service's hot statements at perf scale, with the exact SQL its
// compilers emit (services/query/src: buildSearchQuery, headQuery/bodyQuery, mineQuery, teamKpis).
// Usage: node scripts/perf/explain.mjs [--label postfix]   (PERF_DATABASE_URL; writes scripts/perf/results/[<label>-]explain/*.txt + summary.json)
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { Sql, zctaCentroid } from '@leadmaker/shared';
import { buildSearchQuery } from '../../services/query/src/filter-sql.ts';
import { bodyQuery, headQuery } from '../../services/query/src/profile.ts';
import { mineQuery, teamKpis } from '../../services/query/src/kpis.ts';
import { DEFAULT_DB_URL, FILTERS, prng, repId, uid } from './lib.mjs';

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : '';
const OUT = new URL(`./results/${label ? `${label}-` : ''}explain/`, import.meta.url);
mkdirSync(OUT, { recursive: true });
const client = new pg.Client({ connectionString: process.env.PERF_DATABASE_URL ?? DEFAULT_DB_URL });
await client.connect();

const rep = { id: repId(1), role: 'rep' };
const manager = { id: uid('u1'), role: 'manager' };

// teamKpis' statement is module-private: capture it from a stub client on the real code path.
let teamSql;
const stub = { $queryRaw: async (q) => { teamSql = new Sql(q.strings, q.values); return [{ totals: {}, pool: null, reps: [] }]; } };
await teamKpis({ primary: stub, replica: stub }, false);

const rnd = prng(7);
const search = (name, viewer, filter) => {
  const center = filter.near ? zctaCentroid(filter.near.zip) : undefined;
  return { name: `search:${name}:${viewer.role}`, filter, q: buildSearchQuery(filter, { viewer, center }).query };
};
// The rep's own lead with the most activity, so the head statement's sub-selects all run.
const { rows: [{ id: profileId }] } = await client.query(`SELECT c.id FROM companies c LEFT JOIN activity_logs a ON a.company_id = c.id
  WHERE c.assigned_rep_id = $1 GROUP BY c.id ORDER BY count(a.id) DESC, c.id LIMIT 1`, [rep.id]);
const cases = [
  search('default', rep, FILTERS.default()),
  search('mine', rep, FILTERS.mine()),
  search('unallocated_tags', rep, { ...FILTERS.unallocated_tags(rnd), tagsAll: ['service:metal_roofing'] }),
  search('cert_segment_rating', manager, FILTERS.cert_segment_rating()),
  search('near_distance', manager, { near: { zip: '10001', radiusMiles: 10 }, sort: { by: 'distance', dir: 'asc' } }),
  search('near_storm', rep, { near: { zip: '07030', radiusMiles: 25 }, tagsAny: ['work_type:storm_emergency', 'service:storm_damage'] }),
  search('text', rep, { text: 'summit' }),
  search('unchecked_team', manager, FILTERS.unchecked_team()),
  search('unchecked_me', rep, FILTERS.unchecked_me()),
  search('custom', manager, FILTERS.custom()),
  search('years_sort', manager, FILTERS.years_sort()),
  search('default', manager, FILTERS.default()),
  { name: 'profile:head:rep', q: headQuery(profileId, rep) },
  { name: 'profile:body', q: bodyQuery(profileId) },
  { name: 'kpi:mine:rep', q: mineQuery(rep.id) },
  { name: 'kpi:team', q: teamSql },
];

function walk(node, acc = []) {
  const t = node['Node Type'];
  const rel = node['Relation Name'] ?? node['CTE Name'] ?? '';
  const idx = node['Index Name'] ? ` using ${node['Index Name']}` : '';
  if (/Scan/.test(t)) acc.push(`${t}${rel ? ` on ${rel}` : ''}${idx} (rows=${node['Actual Rows']}, loops=${node['Actual Loops']})`);
  for (const c of node.Plans ?? []) walk(c, acc);
  return acc;
}

const summary = [];
for (const c of cases) {
  const { text, values } = c.q.compile();
  for (let i = 0; i < 2; i++) await client.query(text, values); // warm the buffer cache
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await client.query(text, values);
    times.push(performance.now() - t);
  }
  const [{ 'QUERY PLAN': [plan] }] = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values)).rows;
  const txt = (await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values)).rows.map((r) => r['QUERY PLAN']).join('\n');
  const scans = walk(plan.Plan);
  const row = {
    name: c.name,
    filter: c.filter,
    median_ms: Math.round(times.sort((a, b) => a - b)[2] * 10) / 10,
    execution_ms: Math.round(plan['Execution Time'] * 10) / 10,
    planning_ms: Math.round(plan['Planning Time'] * 10) / 10,
    shared_hit: plan.Plan['Shared Hit Blocks'],
    shared_read: plan.Plan['Shared Read Blocks'],
    jit: plan.JIT ? Math.round(plan.JIT.Timing.Total * 10) / 10 : 0,
    seq_scans: scans.filter((s) => s.startsWith('Seq Scan')),
    scans,
  };
  summary.push(row);
  const file = c.name.replace(/[^a-z0-9_-]+/gi, '_');
  writeFileSync(new URL(`${file}.txt`, OUT), `-- ${c.name}\n-- filter: ${JSON.stringify(c.filter ?? null)}\n-- params: ${JSON.stringify(values)}\n${text}\n\n${txt}\n`);
  console.log(`${c.name.padEnd(36)} median ${String(row.median_ms).padStart(7)} ms  exec ${String(row.execution_ms).padStart(7)} ms  jit ${row.jit}  ${row.seq_scans.length ? `SEQ: ${row.seq_scans.join('; ')}` : ''}`);
}
writeFileSync(new URL('summary.json', OUT), JSON.stringify(summary, null, 2));
await client.end();
