// Integration suites run only with TEST_DATABASE_URL and TEST_REDIS_URL (npm run test:db sets both).
// They refuse a database whose name does not end in _test and Redis db 0, because they wipe both.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig, type Config } from '../src/config.ts';

export const dbUrl = process.env.TEST_DATABASE_URL;
export const redisUrl = process.env.TEST_REDIS_URL;
export const hasInfra = Boolean(dbUrl && redisUrl);

export const silent = pino({ level: 'silent' });

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: 'test' }),
    jwtSecret: 'test-secret-0123456789abcdef0123456789',
    internalToken: 'test-internal-token',
    demoMode: true,
    ...over,
  };
}

export async function openDb(): Promise<PrismaClient> {
  const db = createPrismaClient(dbUrl);
  const [{ name }] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!name.endsWith('_test')) throw new Error(`refusing to truncate ${name}: TEST_DATABASE_URL must name a *_test database`);
  return db;
}

export function openRedis(): Redis {
  const r = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  if (!r.options.db) throw new Error('refusing to flush Redis db 0: TEST_REDIS_URL must select another db');
  return r;
}

export async function resetDb(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`DO $$ BEGIN
    EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' RESTART IDENTITY CASCADE'
             FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys'));
  END $$`);
}

export async function seed(db: PrismaClient) {
  const user = (name: string, role: string) =>
    db.users.create({ data: { name, email: `${name.toLowerCase()}@test.local`, role } });
  const [manager, rep1, rep2, rep3] = await Promise.all([
    user('Manager', 'manager'), user('Rep1', 'rep'), user('Rep2', 'rep'), user('Rep3', 'rep'),
  ]);
  const company = (business_name: string, assigned_rep_id: string | null) =>
    db.companies.create({ data: { business_name, latitude: 40.72, longitude: -74, content_hash: 'h', assigned_rep_id } });
  const [own, other, pool] = await Promise.all([company('Own', rep1.id), company('Other', rep2.id), company('Pool', null)]);
  for (const [c, rep] of [[own, rep1], [other, rep2]] as const) {
    await db.lead_allocations.create({ data: { company_id: c.id, rep_id: rep.id, allocated_by: manager.id } });
  }
  return { manager, rep1, rep2, rep3, own, other, pool };
}

/** A stand-in internal service that records every request and answers with JSON. */
export type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

export async function fakeUpstream(name: string) {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Upstream': name, 'X-Request-Id': 'upstream-own-id' });
      res.end(JSON.stringify({ upstream: name, url: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export type SseMessage = { id?: string; event: string; data: unknown };

/** Minimal EventSource for tests: collects messages and resolves waiters. */
export function openSse(base: string, path: string, headers: Record<string, string> = {}) {
  const messages: SseMessage[] = [];
  let status = 0;
  let notify = () => {};
  let req!: http.ClientRequest;
  const opened = new Promise<number>((resolve, reject) => {
    req = http.get(`${base}${path}`, { headers }, (res) => {
      status = res.statusCode!;
      resolve(status);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m: Partial<SseMessage> & { raw?: string } = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) m.id = line.slice(4);
            else if (line.startsWith('event: ')) m.event = line.slice(7);
            else if (line.startsWith('data: ')) m.raw = line.slice(6);
          }
          if (m.event) messages.push({ id: m.id, event: m.event, data: JSON.parse(m.raw ?? 'null') });
          notify();
        }
      });
    });
    req.on('error', reject);
  });
  const waitFor = (pred: (m: SseMessage) => boolean, ms = 5000) =>
    new Promise<SseMessage>((resolve, reject) => {
      const check = () => {
        const hit = messages.find(pred);
        if (hit) {
          clearTimeout(t);
          resolve(hit);
          return true;
        }
        return false;
      };
      const t = setTimeout(() => reject(new Error(`no SSE message matched within ${ms} ms; got ${JSON.stringify(messages)}`)), ms);
      if (check()) return;
      const prev = notify;
      notify = () => {
        prev();
        check();
      };
    });
  return { messages, opened, waitFor, close: () => req.destroy(), get status() { return status; } };
}
