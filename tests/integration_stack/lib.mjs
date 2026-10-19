// Helpers for the cross-service suite: a gateway client that times every call, an SSE reader, the Python
// pipeline (pipeline.py in the worker image), and psql on the stack's database (checks and cleanup only).
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
export const DB_NAME = process.env.E2E_DB || 'leadmaker';
export const RUN_ID = Date.now().toString(36);
export const COMPOSE_PROJECT = process.env.E2E_COMPOSE_PROJECT || 'leadmaker';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const PIPELINE_MODE = process.env.E2E_PIPELINE === 'host' ? 'host venv' : 'docker compose run worker';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timings = new Map();

export function record(step, ms) {
  if (!timings.has(step)) timings.set(step, []);
  timings.get(step).push(ms);
}

export function latencyReport() {
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
  const rows = [...timings].map(([step, xs]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { step, n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.at(-1) };
  });
  const w = Math.max(4, ...rows.map((r) => r.step.length));
  const fmt = (v) => String(typeof v === 'number' ? v.toFixed(1) : v).padStart(8);
  const lines = [`${'step'.padEnd(w)} ${'n'.padStart(4)}${fmt('p50 ms')}${fmt('p95 ms')}${fmt('max ms')}`];
  for (const r of rows) lines.push(`${r.step.padEnd(w)} ${String(r.n).padStart(4)}${fmt(r.p50)}${fmt(r.p95)}${fmt(r.max)}`);
  return lines.join('\n');
}

/**
 * One gateway call: {status, body, headers, ms}. A gateway rate-limit 429 (body has retryAfterMs) is
 * waited out and retried; a service 429 (e.g. the refresh hourly limit) is returned as is.
 */
export async function call(method, path, { token, body, headers = {}, step } = {}) {
  const label = step ?? `${method} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
  for (let attempt = 0; ; attempt++) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const t0 = performance.now();
    const res = await fetch(GATEWAY_URL + path, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    if (res.status === 429 && parsed?.retryAfterMs !== undefined && attempt < 5) {
      record('gateway rate limit 429 (waited, retried)', ms);
      await sleep(Math.max(250, Number(res.headers.get('retry-after') ?? 1) * 1000));
      continue;
    }
    record(label, ms);
    return { status: res.status, body: parsed, headers: res.headers, ms };
  }
}

export async function login(email) {
  const r = await call('POST', '/auth/dev-login', { body: { email }, step: 'POST /auth/dev-login' });
  if (r.status !== 200) throw new Error(`dev-login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}

/** A user's view of GET /api/events: every message kept in order, with waitFor/none helpers. */
export class EventStream {
  constructor(token) {
    this.token = token;
    this.events = [];
    this.ready = null;
    this.waiters = new Set();
    this.ctrl = new AbortController();
  }

  async open(timeoutMs = 5000) {
    const t0 = performance.now();
    const res = await fetch(`${GATEWAY_URL}/api/events`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal: this.ctrl.signal,
    });
    if (res.status !== 200) throw new Error(`GET /api/events: ${res.status} ${await res.text()}`);
    this.pump(res.body).catch(() => {});
    await this.waitFor((e) => e.event === 'ready', timeoutMs, { includeReady: true });
    record('GET /api/events (ready)', performance.now() - t0);
    return this;
  }

  async pump(body) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const msg = { event: 'message', data: '', id: null, at: performance.now(), wall: Date.now() };
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const j = line.indexOf(':');
          const field = j < 0 ? line : line.slice(0, j);
          const value = j < 0 ? '' : line.slice(j + 1).replace(/^ /, '');
          if (field === 'event') msg.event = value;
          else if (field === 'data') msg.data += (msg.data ? '\n' : '') + value;
          else if (field === 'id') msg.id = value;
        }
        if (!msg.data) continue;
        try {
          msg.data = JSON.parse(msg.data);
        } catch {}
        if (msg.event === 'ready') this.ready = msg;
        else {
          this.events.push(msg);
          // created_at is the outbox row's insert time (Postgres clock): write -> relay -> Redis -> gateway -> client.
          const created = Date.parse(msg.data?.created_at);
          if (Number.isFinite(created)) record('outbox insert -> SSE delivery (all events)', Math.max(0, msg.wall - created));
        }
        for (const w of this.waiters) w(msg);
      }
    }
  }

  /** Resolves with the first message (already received or future) matching pred, else rejects after timeoutMs. */
  waitFor(pred, timeoutMs, { includeReady = false } = {}) {
    const seen = includeReady && this.ready && pred(this.ready) ? this.ready : this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`no matching SSE event within ${timeoutMs} ms`));
      }, timeoutMs);
      const w = (msg) => {
        if (!pred(msg)) return;
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(msg);
      };
      this.waiters.add(w);
    });
  }

  close() {
    this.ctrl.abort();
  }
}

/** Every company id an SSE message names. */
export function eventCompanyIds(msg) {
  const d = msg.data ?? {};
  const p = d.payload ?? {};
  return [d.company_id, p.company_id, ...(Array.isArray(p.company_ids) ? p.company_ids : [])]
    .filter((id) => typeof id === 'string').map((id) => id.toLowerCase());
}

/** Container ids of a compose service's long-running containers (not `docker compose run` one-offs). */
export function composeContainers(service) {
  const out = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.oneoff=False'],
  { encoding: 'utf8' }).trim();
  return out ? out.split('\n') : [];
}

function postgresContainer() {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const [id] = composeContainers('postgres');
  if (!id) throw new Error(`no running postgres container for compose project ${COMPOSE_PROJECT}`);
  return id;
}

/**
 * Runs tests/integration_stack/pipeline.py against E2E_DB and returns its JSON output. E2E_PIPELINE=compose
 * (default) runs it in the worker image (a one-off `docker compose run`); host uses the repo's .venv.
 * Asynchronous, so SSE messages are timestamped as they arrive while the pipeline runs.
 */
export async function pipeline(args, step) {
  const t0 = performance.now();
  const opts = { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 };
  let res;
  try {
    if (process.env.E2E_PIPELINE === 'host') {
      const url = `postgresql+psycopg://leadmaker:leadmaker@localhost:${process.env.POSTGRES_HOST_PORT || 55432}/${DB_NAME}`;
      res = await promisify(execFile)(join(REPO, '.venv/bin/python'), [join(REPO, 'tests/integration_stack/pipeline.py'), ...args],
        { ...opts, env: { ...process.env, LEADMAKER_DATABASE_URL: url } });
    } else {
      res = await promisify(execFile)('docker', ['compose', '-p', COMPOSE_PROJECT, '--profile', 'app', 'run', '--rm', '--no-deps', '-T',
        '-e', `DATABASE_URL=postgresql+psycopg://leadmaker:leadmaker@postgres:5432/${DB_NAME}`,
        '-v', `${join(REPO, 'tests/integration_stack')}:/e2e:ro`, 'worker', 'python', '/e2e/pipeline.py', ...args], opts);
    }
  } catch (err) {
    throw new Error(`pipeline ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
  record(step, performance.now() - t0);
  return JSON.parse(res.stdout.trim().split('\n').at(-1));
}

/** Runs SQL in one transaction on the stack's database (E2E_DB) and returns psql's unaligned output. */
export function psql(sqlText, step = 'psql (simulated pipeline write)') {
  const t0 = performance.now();
  const out = execFileSync('docker', ['exec', '-i', postgresContainer(), 'psql', '-U', process.env.E2E_PG_USER || 'leadmaker',
    '-d', DB_NAME, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'],
  { input: sqlText, encoding: 'utf8' });
  record(step, performance.now() - t0);
  return out.trim();
}
