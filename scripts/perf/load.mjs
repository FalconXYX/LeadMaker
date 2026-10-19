// Closed-loop load generator for the gateway (built-in fetch). Each virtual user dev-logs-in as its own seeded
// user (rep or manager), then loops: pick an operation from the mix, send it, wait a think time, repeat.
// Usage: node scripts/perf/load.mjs --vus 200 --duration 60 [--think 2500] [--mix search=70,profile=20,kpi=10]
//   [--writes 5] [--base http://localhost:19080] [--label name] [--flush-redis redis://localhost:56379/6] [--seed 1]
//   (--flush-redis deletes the lead:/leads:/kpi: cache keys only)
//   [--exclude-filters years_sort,text] (drop search shapes from the mix, e.g. to measure the rest after a fix)
//   [--sample gateway=PID,query=PID,...] [--sample-container leadmaker-postgres-1]   (CPU % sampled every 2 s)
// --think is the mean think time in ms (exponential; 0 = back-to-back). 500 VUs x 2.5 s ~= the §3 200 req/s.
// --writes N takes N% of operations for writes (note / checked) on leads the user may write.
// A 429/503 with Retry-After makes that user wait at least that long (max 5 s) before its next operation.
// Writes scripts/perf/results/runs/<label>.json and prints a table against the SystemDesign §3 p95 targets.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { FILTERS, SEARCH_MIX, managerEmail, percentile, prng, repEmail, weighted } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const BASE = opt('base', 'http://localhost:19080').replace(/\/$/, '');
const VUS = Math.min(Number(opt('vus', 50)), 500);
const DURATION_S = Number(opt('duration', 60));
const THINK_MS = Number(opt('think', 0));
const WRITES = Number(opt('writes', 0));
const SEED = Number(opt('seed', 1));
const LABEL = opt('label', `vus${VUS}-${Date.now()}`);
const MANAGERS = Number(opt('managers', 200));
const REPS = Number(opt('reps', 2000));
const MIX = Object.fromEntries(opt('mix', 'search=70,profile=20,kpi=10').split(',').map((p) => p.split('=')).map(([k, v]) => [k, Number(v)]));
const FLUSH = opt('flush-redis', '');
const EXCLUDE = new Set(opt('exclude-filters', '').split(',').filter(Boolean));
for (const role of Object.keys(SEARCH_MIX)) SEARCH_MIX[role] = SEARCH_MIX[role].filter(([name]) => !EXCLUDE.has(name));
const SAMPLE = Object.fromEntries(opt('sample', '').split(',').filter(Boolean).map((p) => p.split('=')));
const CONTAINER = opt('sample-container', '');
const run = promisify(execFile);

const TARGETS = { search: 300, profile: 200, kpi: 500 };
const ENDPOINT = { search: 'POST /api/leads/search', profile: 'GET /api/leads/:id', kpi: 'GET /api/kpis', write: 'POST /api/leads/:id/(notes|state)' };

if (FLUSH) {
  const { Redis } = await import('ioredis');
  const r = new Redis(FLUSH, { lazyConnect: true });
  if (!r.options.db) throw new Error('refusing to flush Redis DB index 0');
  await r.connect();
  // Only the caches: FLUSHDB would also drop the 'events' stream and the relay's consumer group (NOGROUP until restart).
  let n = 0;
  for (const pattern of ['lead:*', 'leads:*', 'kpi:*']) {
    for await (const keys of r.scanStream({ match: pattern, count: 1000 })) if (keys.length) n += await r.unlink(...keys);
  }
  r.disconnect();
  console.log(`flushed ${n} cache keys from ${FLUSH}`);
}

// ~9% managers, matching 200 managers : 2,000 reps; VU i gets its own user.
function userFor(i) {
  return i % 11 === 0 ? { email: managerEmail(1 + ((i / 11) % MANAGERS)), role: 'manager' } : { email: repEmail(1 + (i % REPS)), role: 'rep' };
}

async function login(email) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${BASE}/auth/dev-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`dev-login ${email}: ${res.status} ${await res.text()}`);
    return (await res.json()).token;
  }
  throw new Error(`dev-login ${email}: rate limited`);
}

const t0 = performance.now();
const vus = [];
for (let i = 0; i < VUS; i += 25) {
  const batch = Array.from({ length: Math.min(25, VUS - i) }, (_, j) => i + j);
  vus.push(...await Promise.all(batch.map(async (k) => ({ ...userFor(k), token: await login(userFor(k).email), k }))));
}
console.log(`logged in ${VUS} users in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const samples = { search: [], profile: [], kpi: [], write: [] };
const samplesOk = { search: [], profile: [], kpi: [], write: [] }; // 2xx only, so fast 503s don't flatter the percentiles
const byFilter = {};
const statuses = {};
const cacheStates = {};
const errors = [];
const backoffUntil = new Map(); // token -> performance.now() deadline from Retry-After
let inflight = 0;
let maxInflight = 0;

async function call(op, method, path, body, token, tag) {
  const start = performance.now();
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
  let status = 0;
  let json;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if ((status === 429 || status === 503) && retryAfter > 0) backoffUntil.set(token, performance.now() + Math.min(retryAfter, 5) * 1000);
    const text = await res.text();
    if (res.ok && text) json = JSON.parse(text);
    else if (!res.ok && measuring && errors.length < 20) errors.push(`${op} ${status} ${text.slice(0, 200)}`);
    const c = res.headers.get('x-cache');
    if (c && measuring) (cacheStates[op] ??= {})[c] = ((cacheStates[op] ??= {})[c] ?? 0) + 1;
  } catch (err) {
    if (measuring && errors.length < 20) errors.push(`${op} ${err.name}: ${err.message}`);
  } finally {
    inflight--;
  }
  const ms = performance.now() - start;
  if (measuring) {
    samples[op].push(ms);
    if (status >= 200 && status < 300) samplesOk[op].push(ms);
    if (tag) (byFilter[tag] ??= []).push(ms);
    statuses[`${op} ${status}`] = (statuses[`${op} ${status}`] ?? 0) + 1;
  }
  return { status, json };
}

let measuring = true;
let stop = false;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const mixPairs = Object.entries(MIX).map(([k, w]) => [k, w * (100 - WRITES) / 100]);
if (WRITES > 0) mixPairs.push(['write', WRITES]);

async function vuLoop(vu) {
  const rnd = prng(SEED * 100_003 + vu.k);
  const seen = []; // lead ids from this user's recent lists
  const writable = [];
  let last;
  // Start staggered so 500 users don't fire in lockstep.
  await sleep(rnd() * Math.max(THINK_MS, 1000));
  while (!stop) {
    const op = weighted(rnd, mixPairs);
    if (op === 'search') {
      const name = weighted(rnd, SEARCH_MIX[vu.role]);
      let filter = FILTERS[name](rnd);
      if (last?.name === name && last.cursor && rnd() < 0.15) filter = { ...last.filter, cursor: last.cursor };
      const { json } = await call('search', 'POST', '/api/leads/search', { filter }, vu.token, name);
      if (json?.items) {
        last = { name, filter, cursor: json.nextCursor };
        for (const it of json.items.slice(0, 10)) {
          seen.push(it.id);
          if (it.canWrite) writable.push(it.id);
        }
        seen.splice(0, Math.max(0, seen.length - 200));
        writable.splice(0, Math.max(0, writable.length - 200));
      }
    } else if (op === 'profile') {
      if (!seen.length) await call('search', 'POST', '/api/leads/search', { filter: {} }, vu.token, 'default')
        .then(({ json }) => json?.items?.forEach((it) => { seen.push(it.id); if (it.canWrite) writable.push(it.id); }));
      const id = seen[Math.floor(rnd() * seen.length)];
      if (id) await call('profile', 'GET', `/api/leads/${id}`, null, vu.token);
    } else if (op === 'kpi') {
      await call('kpi', 'GET', '/api/kpis', null, vu.token);
    } else if (op === 'write') {
      const id = writable[Math.floor(rnd() * writable.length)];
      if (id) {
        if (rnd() < 0.5) await call('write', 'POST', `/api/leads/${id}/notes`, { text: `perf note ${Date.now()}` }, vu.token);
        else await call('write', 'POST', `/api/leads/${id}/state`, { checked: true }, vu.token);
      }
    }
    const wait = Math.max(THINK_MS > 0 ? -Math.log(1 - rnd()) * THINK_MS : 0, (backoffUntil.get(vu.token) ?? 0) - performance.now());
    if (wait > 0) await sleep(wait);
  }
}

const cpu = {};
async function sampleCpu() {
  while (!stop) {
    const pids = Object.values(SAMPLE);
    const jobs = [
      pids.length ? run('ps', ['-o', 'pid=,%cpu=', '-p', pids.join(',')]).then(({ stdout }) => {
        for (const line of stdout.trim().split('\n')) {
          const [pid, pct] = line.trim().split(/\s+/);
          const name = Object.keys(SAMPLE).find((k) => SAMPLE[k] === pid);
          if (name) (cpu[name] ??= []).push(Number(pct));
        }
      }).catch(() => {}) : null,
      CONTAINER ? run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', CONTAINER]).then(({ stdout }) => {
        (cpu[CONTAINER] ??= []).push(Number.parseFloat(stdout));
      }).catch(() => {}) : null,
    ];
    await Promise.all([...jobs, sleep(2000)]);
  }
}

const started = performance.now();
const runs = vus.map((vu) => vuLoop(vu));
const sampler = sampleCpu();
await sleep(DURATION_S * 1000);
measuring = false;
stop = true;
await sampler;
const elapsed = (performance.now() - started) / 1000;
await Promise.allSettled(runs);
loop.disable();

const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
function stats(list) {
  const s = [...list].sort((a, b) => a - b);
  return { count: s.length, rps: r1(s.length / elapsed), p50: r1(percentile(s, 50)), p95: r1(percentile(s, 95)), p99: r1(percentile(s, 99)), max: r1(s.at(-1) ?? null) };
}
const endpoints = Object.fromEntries(Object.entries(samples).filter(([, v]) => v.length).map(([op, v]) => {
  const st = stats(v);
  const target = TARGETS[op];
  return [op, { endpoint: ENDPOINT[op], ...st, target_p95: target ?? null, pass: target ? st.p95 <= target : null, cache: cacheStates[op] ?? null, ok: stats(samplesOk[op]) }];
}));
const total = Object.values(samples).reduce((n, v) => n + v.length, 0);
const non2xx = Object.entries(statuses).filter(([k]) => !/ 2\d\d$/.test(k)).reduce((n, [, v]) => n + v, 0);
const result = {
  label: LABEL, at: new Date().toISOString(), base: BASE, vus: VUS, duration_s: r1(elapsed), think_ms: THINK_MS, mix: MIX, writes_pct: WRITES,
  excluded_filters: [...EXCLUDE],
  total_requests: total, throughput_rps: r1(total / elapsed), non_2xx: non2xx, statuses, max_inflight: maxInflight,
  client_event_loop_p99_ms: r1(loop.percentile(99) / 1e6),
  cpu_pct: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, { avg: r1(v.reduce((a, b) => a + b, 0) / v.length), max: r1(Math.max(...v)) }])),
  endpoints,
  search_by_filter: Object.fromEntries(Object.entries(byFilter).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].p95 - a[1].p95)),
  errors,
};

const pad = (v, n) => String(v ?? '-').padStart(n);
console.log(`\n${LABEL}: ${VUS} VUs, ${r1(elapsed)} s, think ${THINK_MS} ms, writes ${WRITES}% -> ${result.throughput_rps} req/s, ${non2xx} non-2xx, client loop p99 ${result.client_event_loop_p99_ms} ms`);
console.log(`${'endpoint'.padEnd(36)}${pad('count', 8)}${pad('req/s', 8)}${pad('p50', 8)}${pad('p95', 8)}${pad('p99', 8)}${pad('max', 8)}${pad('target', 8)}  result  cache`);
for (const e of Object.values(endpoints)) {
  const cache = e.cache ? Object.entries(e.cache).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  console.log(`${e.endpoint.padEnd(36)}${pad(e.count, 8)}${pad(e.rps, 8)}${pad(e.p50, 8)}${pad(e.p95, 8)}${pad(e.p99, 8)}${pad(e.max, 8)}${pad(e.target_p95, 8)}  ${e.pass === null ? '  -   ' : e.pass ? ' PASS ' : ' FAIL '}  ${cache}`);
}
console.log('cpu % (avg/max):', Object.entries(result.cpu_pct).map(([k, v]) => `${k}=${v.avg}/${v.max}`).join(' '));
console.log('search p95 by filter:', Object.entries(result.search_by_filter).map(([k, v]) => `${k}=${v.p95}`).join(' '));
if (errors.length) console.log('errors:', errors.slice(0, 5));
const dir = new URL('./results/runs/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`${LABEL}.json`, dir), JSON.stringify(result, null, 2));
