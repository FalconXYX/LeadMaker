import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Territory } from '@leadmaker/shared';
import { Harness, url, type Fixture } from './harness.ts';

const h = new Harness();

describe.skipIf(!url)('admin territories (crm-write)', () => {
  let f: Fixture;

  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(async () => {
    f = await h.reset();
  });

  const create = (body: object) => h.as(f.manager).post('/api/admin/territories', body);
  const schedule = (id: string) => h.one<{
    name: string; kind: string; params: Record<string, unknown>; every_hours: number | null; enabled: boolean;
    next_run_at: Date | null;
  }>('SELECT name, kind, params, every_hours, enabled, next_run_at FROM schedules WHERE id = $1::int', Number(id));

  it('answers 403 to a rep on every write and changes nothing', async () => {
    const t = (await create({ zip: '10013', radiusMiles: 25 })).body as Territory;
    const rep = h.as(f.rep1);
    for (const res of [
      await rep.post('/api/admin/territories', { zip: '07030', radiusMiles: 10 }),
      await rep.patch(`/api/admin/territories/${t.id}`, { enabled: false }),
      await rep.delete(`/api/admin/territories/${t.id}`),
      await rep.post(`/api/admin/territories/${t.id}/run`),
      // The role comes from users, not the header.
      await h.as(f.rep1, { role: 'manager' }).post(`/api/admin/territories/${t.id}/run`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }
    expect((await h.one<{ n: number }>('SELECT count(*)::int AS n FROM schedules')).n).toBe(1);
    expect((await h.one<{ n: number }>('SELECT count(*)::int AS n FROM jobs')).n).toBe(0);
  });

  it('creates a territory as a pipeline schedule and returns it', async () => {
    const res = await create({ name: 'Hoboken', zip: '07030', radiusMiles: 12.5, alsoZips: ['07302', '07030', '07302'], everyHours: 24, enabled: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String), name: 'Hoboken', zip: '07030', radiusMiles: 12.5, alsoZips: ['07302'], everyHours: 24,
      enabled: true, lastRun: null, nextRunAt: expect.any(String),
    } satisfies Record<keyof Territory, unknown>);
    // The first scheduled run is due now (as with `leadmaker schedule add`).
    expect(Math.abs(Date.parse(res.body.nextRunAt) - Date.now())).toBeLessThan(60_000);
    const row = await schedule(res.body.id);
    expect(row).toMatchObject({ kind: 'pipeline', every_hours: 24, enabled: true,
      params: { postal_code: '07030', radius_miles: 12.5, also_zips: ['07302'] } });
    const [audit] = await h.all<{ entity_type: string; action: string; actor_id: string }>(
      "SELECT entity_type, action, actor_id FROM audit_events WHERE entity_type = 'territory'");
    expect(audit).toEqual({ entity_type: 'territory', action: 'created', actor_id: f.manager.id });
  });

  it('defaults: a name from the area, manual only, enabled; manual only has no next run', async () => {
    const res = await create({ zip: '10013', radiusMiles: 25 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: '10013 (25 mi)', alsoZips: [], everyHours: null, enabled: true, nextRunAt: null });
    expect((await schedule(res.body.id)).next_run_at).toBeNull();
    expect((await create({ zip: '10013', radiusMiles: 25 })).body).toEqual({
      error: 'territory_exists', details: 'a territory with this name already exists' });
  });

  it('validates the ZIP, the radius, extra ZIPs and the interval', async () => {
    const bad = [
      { zip: '1001', radiusMiles: 5 }, { zip: '10013-1234', radiusMiles: 5 }, { zip: 'abcde', radiusMiles: 5 },
      { zip: '10013', radiusMiles: 0.5 }, { zip: '10013', radiusMiles: 51 }, { zip: '10013', radiusMiles: '25' },
      { zip: '10013' }, { radiusMiles: 25 }, { zip: '10013', radiusMiles: 25, alsoZips: ['123'] },
      { zip: '10013', radiusMiles: 25, everyHours: 0 }, { zip: '10013', radiusMiles: 25, everyHours: -1 },
      { zip: '10013', radiusMiles: 25, enabled: 'yes' }, { zip: '10013', radiusMiles: 25, name: '  ' },
      { zip: '10013', radiusMiles: 25, extra: 1 },
    ];
    for (const body of bad) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    expect((await create({ zip: '10013', radiusMiles: 1 })).status).toBe(201);
    expect((await create({ zip: '10014', radiusMiles: 50 })).status).toBe(201);
    const t = (await create({ zip: '10015', radiusMiles: 5 })).body as Territory;
    expect((await h.as(f.manager).patch(`/api/admin/territories/${t.id}`, { radiusMiles: 60 })).status).toBe(400);
    expect((await h.as(f.manager).patch(`/api/admin/territories/${t.id}`, { zip: '1' })).status).toBe(400);
  });

  it('patches any subset and retimes the schedule only when the interval changes', async () => {
    const t = (await create({ name: 'North', zip: '10013', radiusMiles: 25 })).body as Territory;
    const patch = (body: object) => h.as(f.manager).patch(`/api/admin/territories/${t.id}`, body);

    let res = await patch({ everyHours: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'North', zip: '10013', radiusMiles: 25, everyHours: 6, nextRunAt: expect.any(String) });
    const slot = res.body.nextRunAt;

    res = await patch({ name: 'North Jersey', zip: '07030', alsoZips: ['07302'] });
    expect(res.body).toMatchObject({ name: 'North Jersey', zip: '07030', radiusMiles: 25, alsoZips: ['07302'], everyHours: 6 });
    expect(res.body.nextRunAt).toBe(slot);

    res = await patch({ enabled: false });
    expect(res.body).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await schedule(t.id)).next_run_at).not.toBeNull(); // kept for when it is turned back on

    res = await patch({ everyHours: null, enabled: true });
    expect(res.body).toMatchObject({ everyHours: null, enabled: true, nextRunAt: null });
    expect((await schedule(t.id)).next_run_at).toBeNull();

    expect((await patch({})).status).toBe(200);
    expect((await h.as(f.manager).patch('/api/admin/territories/999', { enabled: false })).status).toBe(404);
    expect((await h.as(f.manager).patch('/api/admin/territories/abc', { enabled: false })).status).toBe(404);
    await create({ name: 'Taken', zip: '10014', radiusMiles: 5 });
    expect((await patch({ name: 'Taken' })).status).toBe(409);

    const actions = await h.all<{ action: string; changes: Record<string, unknown> }>(
      "SELECT action, changes FROM audit_events WHERE entity_type = 'territory' AND entity_id = $1 ORDER BY id", t.id);
    expect(actions.map((a) => a.action)).toEqual(['created', 'updated', 'updated', 'updated', 'updated']);
    expect(actions[1].changes).toEqual({ every_hours: [null, 6] });
  });

  it('deletes a territory and keeps its runs in the history', async () => {
    const t = (await create({ zip: '10013', radiusMiles: 25 })).body as Territory;
    const run = await h.as(f.manager).post(`/api/admin/territories/${t.id}/run`);
    expect((await h.as(f.manager).delete(`/api/admin/territories/${t.id}`)).status).toBe(204);
    expect((await h.as(f.manager).delete(`/api/admin/territories/${t.id}`)).status).toBe(404);
    expect(await h.one('SELECT count(*)::int AS n FROM schedules')).toEqual({ n: 0 });
    expect(await h.one('SELECT schedule_id FROM jobs WHERE id = $1::int', Number(run.body.jobId))).toEqual({ schedule_id: null });
  });

  it('"Run now" queues the full refresh for the area once, merging repeats into the open run', async () => {
    const t = (await create({ zip: '07030', radiusMiles: 12.5, alsoZips: ['07302'] })).body as Territory;
    const run = () => h.as(f.manager).post(`/api/admin/territories/${t.id}/run`);
    const first = await run();
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ jobId: expect.stringMatching(/^\d+$/), merged: false });
    const job = await h.one<Record<string, unknown>>(
      'SELECT kind, params, dedupe_key, schedule_id, requested_by, status FROM jobs WHERE id = $1::int', Number(first.body.jobId));
    expect(job).toEqual({
      kind: 'pipeline', params: { postal_code: '07030', radius_miles: 12.5, also_zips: ['07302'] },
      // leadmaker/jobs.py area_dedupe_key, so the territory's own schedule merges into the same job.
      dedupe_key: 'pipeline:07030:12.5:*', schedule_id: Number(t.id), requested_by: f.manager.id, status: 'queued',
    });

    const again = await run();
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ jobId: first.body.jobId, merged: true });
    expect(await h.one('SELECT count(*)::int AS n FROM jobs')).toEqual({ n: 1 });

    // The territory now shows that run; once it finishes, the next "Run now" queues a new one.
    const listed = (await h.as(f.manager).patch(`/api/admin/territories/${t.id}`, {})).body as Territory;
    expect(listed.lastRun).toEqual({ jobId: first.body.jobId, status: 'queued', finishedAt: null });
    await h.db.$executeRawUnsafe("UPDATE jobs SET status = 'succeeded', finished_at = now()");
    const next = await run();
    expect(next.body.merged).toBe(false);
    expect(next.body.jobId).not.toBe(first.body.jobId);

    expect((await h.as(f.manager).post('/api/admin/territories/999/run')).status).toBe(404);
  });

  it('works on a CLI-made schedule: keeps its other params and merges into the run its schedule queued', async () => {
    const [{ id }] = await h.all<{ id: number }>(
      `INSERT INTO schedules (name, kind, params, every_hours, next_run_at)
       VALUES ('nightly', 'pipeline', '{"postal_code": "10013", "radius_miles": 25, "sources": ["osm", "bbb"]}', 24, now())
       RETURNING id`);
    // The worker's own enqueue of that schedule (leadmaker/jobs.py area_dedupe_key: sources sorted).
    const [{ id: fired }] = await h.all<{ id: number }>(
      `INSERT INTO jobs (kind, params, dedupe_key, schedule_id) VALUES ('pipeline', '{}', 'pipeline:10013:25:bbb,osm', $1::int)
       RETURNING id`, id);
    const run = await h.as(f.manager).post(`/api/admin/territories/${id}/run`);
    expect(run.body).toEqual({ jobId: String(fired), merged: true });

    const res = await h.as(f.manager).patch(`/api/admin/territories/${id}`, { radiusMiles: 10, alsoZips: ['10014'] });
    expect(res.body).toMatchObject({ name: 'nightly', zip: '10013', radiusMiles: 10, alsoZips: ['10014'], everyHours: 24 });
    expect((await schedule(String(id))).params).toEqual({ postal_code: '10013', radius_miles: 10, sources: ['osm', 'bbb'], also_zips: ['10014'] });
    await h.as(f.manager).patch(`/api/admin/territories/${id}`, { alsoZips: [] });
    expect((await schedule(String(id))).params).toEqual({ postal_code: '10013', radius_miles: 10, sources: ['osm', 'bbb'] });
  });
});
