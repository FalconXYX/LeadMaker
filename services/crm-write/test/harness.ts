// Test harness for the database suites: a migrated *_test database (TEST_DATABASE_URL, reset by
// `npm run test:db`) and optionally a private Redis db (TEST_REDIS_URL). Truncates every table, so
// it refuses any database whose name does not end in _test.
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { createPrismaClient, Prisma, type PrismaClient } from '@leadmaker/db';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';

export const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
export const TOKEN = 'test-internal-token';

export type User = { id: string; role: 'rep' | 'manager'; name: string };
export type Fixture = {
  manager: User;
  rep1: User;
  rep2: User;
  /** Allocated to rep1, unallocated, allocated to rep2. */
  leads: { own: string; pool: string; other: string };
  contacts: { own: string; pool: string; other: string };
  tag: string;
};

export class Harness {
  db!: PrismaClient;
  redis: Redis | null = null;
  config: Config = { ...loadConfig({}), internalToken: TOKEN, userJobsPerHour: 3, maxBulkAllocation: 50 };
  f!: Fixture;

  async start() {
    this.db = createPrismaClient(url);
    const [{ name }] = await this.db.$queryRaw<{ name: string }[]>(Prisma.sql`SELECT current_database() AS name`);
    if (!name.endsWith('_test')) throw new Error(`refusing to truncate ${name}: TEST_DATABASE_URL must name a *_test database`);
    if (redisUrl) this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  }

  async stop() {
    await this.db?.$disconnect();
    await this.redis?.quit();
  }

  app() {
    return createApp({ db: this.db, redis: this.redis, config: this.config, log: pino({ level: process.env.HARNESS_LOG ?? 'silent' }) });
  }

  one = async <T>(sql: string, ...params: unknown[]): Promise<T> =>
    ((await this.db.$queryRawUnsafe(sql, ...params)) as T[])[0];

  all = async <T>(sql: string, ...params: unknown[]): Promise<T[]> =>
    (await this.db.$queryRawUnsafe(sql, ...params)) as T[];

  async reset(): Promise<Fixture> {
    await this.db.$executeRawUnsafe(`DO $$ BEGIN
      EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' RESTART IDENTITY CASCADE'
               FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys'));
    END $$`);
    await this.redis?.flushdb();
    const user = async (name: string, role: User['role']): Promise<User> =>
      this.one<User>(`INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id, role, name`,
        name, `${name.toLowerCase().replace(/\s+/g, '.')}@test`, role);
    const manager = await user('Alex Manager', 'manager');
    const rep1 = await user('Jordan Rep', 'rep');
    const rep2 = await user('Priya Rep', 'rep');
    const company = async (name: string, rep: User | null) => {
      const { id } = await this.one<{ id: string }>(
        `INSERT INTO companies (business_name, phone, latitude, longitude, county_fips, content_hash, assigned_rep_id)
         VALUES ($1, '(212) 555-0000', 40.72, -74.0, '36061', 'h', $2::uuid) RETURNING id`, name, rep?.id ?? null);
      if (rep) {
        await this.db.$executeRawUnsafe(
          `INSERT INTO lead_allocations (company_id, rep_id, allocated_by, allocated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '1 day')`, id, rep.id, manager.id);
      }
      const contact = await this.one<{ id: string }>(
        `INSERT INTO contacts (company_id, name, title, email, source)
         VALUES ($1::uuid, 'Pat Owner', 'Owner', 'pat@example.com', 'bbb') RETURNING id`, id);
      return { id, contact: contact.id };
    };
    const own = await company('Own Roofing', rep1);
    const pool = await company('Pool Roofing', null);
    const other = await company('Other Roofing', rep2);
    const tag = await this.one<{ id: string }>(
      `INSERT INTO custom_tags (name, created_by) VALUES ('Storm chaser', $1::uuid) RETURNING id`, manager.id);
    this.f = {
      manager, rep1, rep2,
      leads: { own: own.id, pool: pool.id, other: other.id },
      contacts: { own: own.contact, pool: pool.contact, other: other.contact },
      tag: tag.id,
    };
    return this.f;
  }

  /** A supertest request as the given user, through the internal hop headers the gateway sets. */
  as(user: User, opts: { token?: string; role?: string } = {}) {
    const app = this.app();
    const headers = {
      'x-internal-token': opts.token ?? TOKEN, 'x-user-id': user.id, 'x-user-role': opts.role ?? user.role,
    };
    return {
      get: (path: string) => request(app).get(path).set(headers),
      post: (path: string, body?: object) => request(app).post(path).set(headers).send(body),
      put: (path: string, body?: object) => request(app).put(path).set(headers).send(body),
      patch: (path: string, body?: object) => request(app).patch(path).set(headers).send(body),
      delete: (path: string, body?: object) => request(app).delete(path).set(headers).send(body),
    };
  }

  version = async (companyId: string) =>
    (await this.one<{ version: number }>('SELECT version FROM companies WHERE id = $1::uuid', companyId)).version;

  outbox = () =>
    this.all<{ event_type: string; company_id: string | null; payload: Record<string, unknown> }>(
      'SELECT event_type, company_id, payload FROM outbox_events ORDER BY id');

  counts = () =>
    this.one<{ outbox: number; activity: number; audit: number }>(
      `SELECT (SELECT count(*)::int FROM outbox_events) AS outbox, (SELECT count(*)::int FROM activity_logs) AS activity,
              (SELECT count(*)::int FROM audit_events) AS audit`);
}
