// Fixtures for the DB-backed tests. They run only with TEST_DATABASE_URL (npm run test:db migrates
// leadmaker_query_test) and refuse any database whose name does not end in _test, because they truncate it.
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createPrismaClient, type PrismaClient } from '@leadmaker/db';
import { createApp, type AppDeps } from '../src/app.ts';
import { Cache } from '../src/cache.ts';
import type { Db } from '../src/db.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/14';
export const TOKEN = 'test-internal-token';

export interface Users {
  manager: string;
  rep1: string;
  rep2: string;
  rep3: string;
}

export interface Fixture {
  users: Users;
  ids: Record<string, string>;
}

export interface Harness {
  prisma: PrismaClient;
  redis: Redis;
  app: ReturnType<typeof createApp>;
  exec: (text: string, ...values: unknown[]) => Promise<number>;
  query: <T = Record<string, unknown>>(text: string, ...values: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export async function harness(over: Partial<AppDeps> = {}): Promise<Harness> {
  const prisma = createPrismaClient(TEST_DATABASE_URL);
  const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name');
  if (!name.endsWith('_test')) throw new Error(`refusing to truncate ${name}: TEST_DATABASE_URL must name a *_test database`);
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.ping();
  const db: Db = { primary: prisma, replica: prisma };
  const log = pino({ level: 'silent' });
  const app = createApp({ db, cache: new Cache(redis, log), log, internalToken: TOKEN, leadListTtlSeconds: 60, ...over });
  return {
    prisma,
    redis,
    app,
    exec: (text, ...values) => prisma.$executeRawUnsafe(text, ...values),
    query: (text, ...values) => prisma.$queryRawUnsafe(text, ...values),
    close: async () => {
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

export function as(userId: string, role: 'rep' | 'manager') {
  return { 'x-internal-token': TOKEN, 'x-user-id': userId, 'x-user-role': role };
}

const tag = (key: string, value: unknown, category = 'misc', extra: Record<string, unknown> = {}) =>
  ({ key, value, label: `${key}: ${value}`, category, reason: `${key} reason`, source: 'test', ...extra });

interface CompanySpec {
  name: string;
  rep?: keyof Users;
  priority?: number | null;
  rating?: number | null;
  reviews?: number;
  lat: number;
  lng: number;
  postal: string;
  state: string;
  city: string;
  county: string;
  tags?: Record<string, unknown>[];
  segment?: string;
  account?: string;
  since?: number;
  scraped?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  changed?: string;
  dba?: string;
}

// Miles from the 10013 ZCTA point (40.72005, -74.00481): acme 0.1, soho 0.2, jersey 2.0, williamsburg 2.6,
// brooklyn 3.8, queens 6.8, hackensack 11.6, staten 12.3, longisland 43; fillers are near Albany.
export const COMPANIES: Record<string, CompanySpec> = {
  acme: {
    name: 'Acme Roofing', rep: 'rep1', priority: 90, rating: 4.9, reviews: 200, lat: 40.7210, lng: -74.0040,
    postal: '10013', state: 'NY', city: 'New York', county: '36061', segment: 'strategic', since: 2001,
    tags: [tag('gaf_tier', 'master_elite', 'certification', { source: 'gaf' }), tag('size', 'large', 'size'),
      tag('service:metal_roofing', true, 'services'), tag('service:storm_damage', true, 'services'),
      tag('region', 'Manhattan', 'geography'), tag('maturity', 'veteran', 'maturity', { reason: 'in business since 1990 (per website)' }),
      tag('priority_drivers', ['GAF tier', 'Review volume'], 'priority'),
      tag('target_contact', 'owner', 'contactability', { label: 'Ask for: Jane Owner', contact: { name: 'Jane Owner' } })],
    custom: { po_number: 'PO-1001', budget: 5000, next_visit: '2026-11-01', brands: ['GAF', 'Owens'] },
    changed: '2026-10-10T12:00:00Z',
  },
  brooklyn: {
    name: 'Brooklyn Shingle Co', rep: 'rep1', priority: 70, rating: 4.2, reviews: 40, lat: 40.6930, lng: -73.9420,
    postal: '11201', state: 'NY', city: 'Brooklyn', county: '36047', segment: 'growth',
    tags: [tag('gaf_tier', 'certified', 'certification'), tag('size', 'small', 'size'),
      tag('service:shingle_roofing', true, 'services'), tag('region', 'Brooklyn', 'geography'),
      tag('offers_financing', true, 'digital')],
    custom: { budget: 1200 }, changed: '2026-10-01T12:00:00Z',
  },
  jersey: {
    name: 'Jersey Flat Roofs', priority: 80, rating: null, reviews: 0, lat: 40.7178, lng: -74.0431,
    postal: '07302', state: 'NJ', city: 'Jersey City', county: '34017', segment: 'growth', dba: 'JFR 100% Flat',
    tags: [tag('gaf_tier', 'certified_plus', 'certification'), tag('size', 'medium', 'size'),
      tag('service:flat_roofing', true, 'services'), tag('service:tpo_roofing', true, 'services'),
      tag('distance_band', '0-5', 'geography'), tag('presidents_club', 2, 'certification')],
    scraped: { founded_year: '1975' },
  },
  hackensack: {
    name: 'Hackensack Metal Works', rep: 'rep2', priority: 85, rating: 4.7, reviews: 120, lat: 40.8859, lng: -74.0435,
    postal: '07601', state: 'NJ', city: 'Hackensack', county: '34003', segment: 'strategic',
    tags: [tag('gaf_tier', 'master_elite', 'certification'), tag('specialty:metal_roofing', true, 'specialty')],
  },
  longisland: {
    name: 'Long Island Pros', priority: null, rating: 4.0, reviews: 5, lat: 40.85, lng: -73.2,
    postal: '11743', state: 'NY', city: 'Huntington', county: '36103', account: 'existing_customer', since: 2020,
    tags: [tag('social', ['facebook', 'instagram'], 'digital')],
  },
  staten: {
    name: 'Staten Island Roofing', rep: 'rep2', priority: 70, rating: 3.5, reviews: 12, lat: 40.5795, lng: -74.1502,
    postal: '10314', state: 'NY', city: 'Staten Island', county: '36085', segment: 'long_tail',
    tags: [tag('gaf_tier', 'certified', 'certification'), tag('size', 'small', 'size')],
  },
  queens: {
    name: 'Queens Gutter & Roof', priority: 60, rating: 4.4, reviews: 30, lat: 40.7420, lng: -73.8780,
    postal: '11368', state: 'NY', city: 'Corona', county: '36081', segment: 'emerging',
    tags: [tag('gaf_tier', 'certified', 'certification'), tag('offers_financing', false, 'digital'),
      tag('region', 'Queens', 'geography')],
  },
  soho: {
    name: 'SoHo Slate', priority: 50, rating: 4.1, reviews: 8, lat: 40.7230, lng: -74.0020,
    postal: '10013', state: 'NY', city: 'New York', county: '36061', segment: 'emerging',
    tags: [tag('gaf_tier', 'certified', 'certification'), tag('service:slate_roofing', true, 'services')],
  },
  williamsburg: {
    name: 'Williamsburg Roof Care', priority: 45, rating: 3.9, reviews: 3, lat: 40.7081, lng: -73.9571,
    postal: '11211', state: 'NY', city: 'Brooklyn', county: '36047', segment: 'long_tail',
    tags: [tag('gaf_tier', 'certified', 'certification')],
  },
  miami: {
    name: 'Miami Outlier Roofing', priority: 20, rating: 5.0, reviews: 1, lat: 25.7743, lng: -80.1937,
    postal: '33101', state: 'FL', city: 'Miami', county: '12086', tags: [],
  },
};

export const FILLERS = 14;

export async function seed(h: Harness): Promise<Fixture> {
  await h.exec(`DO $$ BEGIN
    EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' RESTART IDENTITY CASCADE'
             FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys'));
  END $$`);
  const user = async (name: string, email: string, role: string) =>
    (await h.query<{ id: string }>(`INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id`, name, email, role))[0].id;
  const users: Users = {
    manager: await user('Morgan Manager', 'manager@test', 'manager'),
    rep1: await user('Riley Rep', 'rep1@test', 'rep'),
    rep2: await user('Sam Rep', 'rep2@test', 'rep'),
    rep3: await user('Taylor Rep', 'rep3@test', 'rep'),
  };
  const ids: Record<string, string> = {};
  const insert = async (key: string, c: CompanySpec) => {
    const [{ id }] = await h.query<{ id: string }>(
      `INSERT INTO companies (business_name, dba, latitude, longitude, postal_code, state, city, county_fips, rating,
         review_count, priority_score, segment, account_status, in_business_since, system_tags, scraped_attributes,
         custom_fields, last_material_change_at, first_seen_at, content_hash, phone, website_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb,
               $18::timestamptz, '2026-09-01T00:00:00Z', 'h', '(212) 555-0100', 'https://example.com')
       RETURNING id`,
      c.name, c.dba ?? null, c.lat, c.lng, c.postal, c.state, c.city, c.county, c.rating ?? null, c.reviews ?? 0,
      c.priority ?? null, c.segment ?? null, c.account ?? 'prospect', c.since ?? null, JSON.stringify(c.tags ?? []),
      JSON.stringify(c.scraped ?? {}), JSON.stringify(c.custom ?? {}), c.changed ?? null);
    ids[key] = id;
    if (c.rep) {
      await h.exec(`INSERT INTO lead_allocations (company_id, rep_id, allocated_by) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        id, users[c.rep], users.manager);
      await h.exec(`UPDATE companies SET assigned_rep_id = $2::uuid WHERE id = $1::uuid`, id, users[c.rep]);
    }
  };
  for (const [key, c] of Object.entries(COMPANIES)) await insert(key, c);
  // Unallocated fillers with tied priorities (pairs) for pagination.
  for (let i = 0; i < FILLERS; i++) {
    await insert(`filler${i}`, {
      name: `Filler Roofing ${String(i).padStart(2, '0')}`, priority: 30 - Math.floor(i / 2), rating: i % 3 ? 3 + (i % 3) / 2 : null,
      reviews: i, lat: 42.6 + i * 0.01, lng: -73.8 + i * 0.01, postal: '12207', state: 'NY', city: 'Albany', county: '36001',
    });
  }
  return { users, ids };
}

export async function clearCache(redis: Redis): Promise<void> {
  if (!/\/([1-9]\d*)$/.test(TEST_REDIS_URL)) throw new Error('TEST_REDIS_URL must select a non-default Redis DB (e.g. /14)');
  await redis.flushdb();
}
