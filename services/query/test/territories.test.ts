import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run, Territory } from '@leadmaker/shared';
import { as, seed, harness, TEST_DATABASE_URL, type Fixture, type Harness } from './helpers.ts';

const migration = readFileSync(new URL('../../../db/migrations/20261019120000_territories.sql', import.meta.url), 'utf8');
/** The migration's backfill of the default area, run again against the truncated test tables. */
const backfill = migration.slice(migration.indexOf('INSERT INTO schedules'), migration.indexOf('ON CONFLICT (name) DO NOTHING;') + 'ON CONFLICT (name) DO NOTHING;'.length);

describe.skipIf(!TEST_DATABASE_URL)('admin reads: territories and run history', () => {
  let h: Harness;
  let f: Fixture;
  const get = (path: string, user: string, role: 'rep' | 'manager') => request(h.app).get(path).set(as(user, role));

  beforeAll(async () => {
    h = await harness();
    f = await seed(h);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.exec('DELETE FROM jobs');
    await h.exec('DELETE FROM schedules');
  });

  const schedule = async (name: string, kind: string, params: object, everyHours: number | null, enabled = true) =>
    (await h.query<{ id: number }>(
      `INSERT INTO schedules (name, kind, params, every_hours, enabled, next_run_at)
       VALUES ($1, $2, $3::jsonb, $4::float8, $5, CASE WHEN $4::float8 IS NULL THEN NULL ELSE '2026-10-20T06:00:00Z'::timestamptz END)
       RETURNING id`, name, kind, JSON.stringify(params), everyHours, enabled))[0].id;
  const job = async (o: {
    kind?: string; params?: object; status: string; scheduleId?: number | null; requestedBy?: string | null;
    created?: string; locked?: string | null; finished?: string | null; result?: object | null; error?: string | null;
    attempts?: number;
  }) => (await h.query<{ id: number }>(
    `INSERT INTO jobs (kind, params, status, schedule_id, requested_by, created_at, locked_at, finished_at, result, error, attempts)
     VALUES ($1, $2::jsonb, $3, $4::int, $5::uuid, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::jsonb, $10, $11)
     RETURNING id`,
    o.kind ?? 'pipeline', JSON.stringify(o.params ?? { postal_code: '10013', radius_miles: 25 }), o.status,
    o.scheduleId ?? null, o.requestedBy ?? null, o.created ?? '2026-10-19T10:00:00Z', o.locked ?? null, o.finished ?? null,
    o.result === undefined || o.result === null ? null : JSON.stringify(o.result), o.error ?? null, o.attempts ?? 0))[0].id;

  it('answers 403 to reps', async () => {
    for (const path of ['/api/admin/territories', '/api/admin/runs', '/admin/runs?limit=5']) {
      const res = await get(path, f.users.rep1, 'rep');
      expect(res.status, path).toBe(403);
    }
  });

  it('lists pipeline schedules as territories with their newest run and next run', async () => {
    const north = await schedule('North Jersey', 'pipeline', { postal_code: '07030', radius_miles: 12.5, also_zips: ['07302'] }, 24);
    const home = await schedule('Default area', 'pipeline', { postal_code: '10013', radius_miles: 25 }, null);
    const paused = await schedule('Paused', 'pipeline', { postal_code: '11201', radius_miles: 5 }, 6, false);
    await schedule('insights-stale', 'insights', { stale: true }, 0.25); // not a territory
    await job({ status: 'succeeded', scheduleId: north, finished: '2026-10-19T10:05:00Z' });
    const newest = await job({ status: 'dead', scheduleId: north, finished: '2026-10-19T11:00:00Z', error: 'boom' });

    const res = await get('/api/admin/territories', f.users.manager, 'manager');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: String(home), name: 'Default area', zip: '10013', radiusMiles: 25, alsoZips: [], everyHours: null, enabled: true,
        lastRun: null, nextRunAt: null },
      { id: String(north), name: 'North Jersey', zip: '07030', radiusMiles: 12.5, alsoZips: ['07302'], everyHours: 24,
        enabled: true, lastRun: { jobId: String(newest), status: 'failed', finishedAt: '2026-10-19T11:00:00.000Z' },
        nextRunAt: '2026-10-20T06:00:00.000Z' },
      { id: String(paused), name: 'Paused', zip: '11201', radiusMiles: 5, alsoZips: [], everyHours: 6, enabled: false,
        lastRun: null, nextRunAt: null },
    ] satisfies Territory[]);
  });

  it('shows the default area (10013, 25 mi) as a territory via the migration backfill, once', async () => {
    expect(backfill).toMatch(/^INSERT INTO schedules[\s\S]*DO NOTHING;$/);
    await h.exec(backfill);
    await h.exec(backfill); // idempotent
    const list = (await get('/api/admin/territories', f.users.manager, 'manager')).body as Territory[];
    expect(list).toEqual([expect.objectContaining({
      name: 'Default area', zip: '10013', radiusMiles: 25, alsoZips: [], everyHours: null, enabled: true, nextRunAt: null })]);
    // Skipped when a schedule already covers that ZIP.
    await h.exec('DELETE FROM schedules');
    await schedule('Manhattan', 'pipeline', { postal_code: '10013', radius_miles: 10 }, 24);
    await h.exec(backfill);
    expect(((await get('/api/admin/territories', f.users.manager, 'manager')).body as Territory[]).map((t) => t.name))
      .toEqual(['Manhattan']);
  });

  it('lists refresh runs newest first with requester, timing and stats (null before stats were recorded)', async () => {
    const t = await schedule('North Jersey', 'pipeline', { postal_code: '07030', radius_miles: 12.5 }, 24);
    const old = await job({ kind: 'scrape', status: 'succeeded', requestedBy: f.users.rep1, created: '2026-10-18T09:00:00Z',
      locked: '2026-10-18T09:00:01Z', finished: '2026-10-18T09:02:01Z', result: { scrape: { upsert: { new: 1 } } } });
    const done = await job({ status: 'succeeded', scheduleId: t, params: { postal_code: '07030', radius_miles: 12.5 },
      locked: '2026-10-19T10:00:05Z', finished: '2026-10-19T10:01:05.5Z',
      result: { stats: { found: 42, new: 3, updated: 5 }, scrape: {} } });
    const dead = await job({ status: 'dead', requestedBy: f.users.manager, locked: '2026-10-19T11:00:00Z',
      finished: '2026-10-19T11:00:30Z', error: 'HttpError: 503', attempts: 3 });
    const retrying = await job({ status: 'queued', locked: '2026-10-19T12:00:00Z', error: 'HttpError: 429', attempts: 1,
      params: { postal_code: '11201', radius_miles: 5 } });
    const running = await job({ status: 'running', locked: '2026-10-19T13:00:00Z', params: { postal_code: '11201', radius_miles: 6 } });
    await job({ kind: 'insights', status: 'succeeded', params: { stale: true } }); // not a refresh

    const res = await get('/api/admin/runs?limit=20', f.users.manager, 'manager');
    expect(res.status).toBe(200);
    const runs = res.body as Run[];
    expect(runs.map((r) => r.jobId)).toEqual([running, retrying, dead, done, old].map(String));
    const by = Object.fromEntries(runs.map((r) => [r.jobId, r]));
    expect(by[done]).toEqual({
      jobId: String(done), kind: 'pipeline', territory: { zip: '07030', radiusMiles: 12.5 }, status: 'succeeded',
      requestedBy: null, createdAt: '2026-10-19T10:00:00.000Z', startedAt: '2026-10-19T10:00:05.000Z',
      finishedAt: '2026-10-19T10:01:05.500Z', durationMs: 60_500, stats: { found: 42, new: 3, updated: 5 }, error: null,
    } satisfies Run);
    expect(by[old]).toMatchObject({ kind: 'scrape', requestedBy: { name: 'Riley Rep' }, durationMs: 120_000, stats: null });
    expect(by[dead]).toMatchObject({ status: 'failed', requestedBy: { name: 'Morgan Manager' }, error: 'HttpError: 503',
      durationMs: 30_000, stats: null });
    // Waiting for a retry: not started, no duration, the last attempt's error shown.
    expect(by[retrying]).toMatchObject({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null,
      error: 'HttpError: 429' });
    expect(by[running]).toMatchObject({ status: 'running', startedAt: '2026-10-19T13:00:00.000Z', finishedAt: null,
      durationMs: null, territory: { zip: '11201', radiusMiles: 6 } });

    expect(((await get('/api/admin/runs?limit=2', f.users.manager, 'manager')).body as Run[]).map((r) => r.jobId))
      .toEqual([running, retrying].map(String));
    expect(((await get('/api/admin/runs', f.users.manager, 'manager')).body as Run[])).toHaveLength(5);
    for (const bad of ['0', '101', 'x']) {
      expect((await get(`/api/admin/runs?limit=${bad}`, f.users.manager, 'manager')).status).toBe(400);
    }
  });
});
