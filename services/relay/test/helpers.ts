// Integration suites run only with TEST_DATABASE_URL and TEST_REDIS_URL (npm run test:db sets both).
// They refuse a database whose name does not end in _test and Redis db 0, because they wipe both.
import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';

export const dbUrl = process.env.TEST_DATABASE_URL;
export const redisUrl = process.env.TEST_REDIS_URL;
export const hasInfra = Boolean(dbUrl && redisUrl);

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
  await db.$executeRawUnsafe('REFRESH MATERIALIZED VIEW team_dashboard_kpis');
}

export async function users(db: PrismaClient) {
  const make = (name: string, role: string) =>
    db.users.create({ data: { name, email: `${name.toLowerCase()}@test.local`, role } });
  const [manager, rep1, rep2] = await Promise.all([make('Manager', 'manager'), make('Rep1', 'rep'), make('Rep2', 'rep')]);
  return { manager, rep1, rep2 };
}

export const company = (db: PrismaClient, assigned_rep_id: string | null = null) =>
  db.companies.create({ data: { business_name: 'Acme', latitude: 40.72, longitude: -74, content_hash: 'h', assigned_rep_id } });

export async function outbox(db: PrismaClient, type: string, companyId: string | null, payload: Record<string, unknown> = {}) {
  const [row] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO outbox_events (event_type, company_id, payload)
    VALUES (${type}, ${companyId}::uuid, ${JSON.stringify({ actor_type: 'user', ...payload })}::jsonb)
    RETURNING id::text`;
  return row.id;
}

export const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};
