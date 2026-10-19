// Integration suites run only with TEST_DATABASE_URL and TEST_REDIS_URL (npm run test:db sets both).
// They refuse a database whose name does not end in _test and Redis db 0, because they wipe both.
import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { NotifierEvent } from '../src/stream.ts';

export const dbUrl = process.env.TEST_DATABASE_URL;
export const redisUrl = process.env.TEST_REDIS_URL;
export const hasInfra = Boolean(dbUrl && redisUrl);
export const TOKEN = 'test-internal-token';

export const silent = pino({ level: 'silent' });

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
  const [manager, manager2, rep1, rep2] = await Promise.all([
    user('Manager', 'manager'), user('Boss', 'manager'), user('Rep1', 'rep'), user('Rep2', 'rep'),
  ]);
  return { manager, manager2, rep1, rep2 };
}

export const company = (
  db: PrismaClient, name: string, assigned_rep_id: string | null = null, extra: Record<string, unknown> = {},
) => db.companies.create({
  data: { business_name: name, latitude: 40.72, longitude: -74, content_hash: 'h', assigned_rep_id, ...extra },
});

/** Inserts an outbox row (so it has a real id) and returns the event as the relay would stream it. */
export async function event(
  db: PrismaClient, type: string, companyId: string | null, payload: Record<string, unknown> = {},
): Promise<NotifierEvent> {
  const full = { actor_type: 'user', actor_id: null, ...(companyId ? { company_id: companyId } : {}), ...payload };
  const [row] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO outbox_events (event_type, company_id, payload)
    VALUES (${type}, ${companyId}::uuid, ${JSON.stringify(full)}::jsonb)
    RETURNING id::text`;
  return { streamId: `${row.id}-0`, outboxId: row.id, type, companyId, payload: full };
}

/** Stream fields for an event, as the relay XADDs them. */
export const fields = (e: NotifierEvent) => [
  'id', e.outboxId, 'type', e.type, 'company_id', e.companyId ?? '', 'payload', JSON.stringify(e.payload),
  'created_at', new Date().toISOString(),
];

export type NotificationRow = {
  id: string; user_id: string; type: string; title: string; body: string; company_id: string | null;
  county_fips: string | null; data: Record<string, unknown>; dedupe_key: string; count: number; read_at: Date | null;
};

export const notifications = (db: PrismaClient, userId?: string) =>
  db.$queryRaw<NotificationRow[]>`
    SELECT id::text, user_id::text, type, title, body, company_id::text, county_fips::text, data, dedupe_key, count, read_at
    FROM notifications WHERE ${userId ?? null}::uuid IS NULL OR user_id = ${userId ?? null}::uuid
    ORDER BY created_at, id`;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
