// The profile's Refresh button: POST /api/leads/:id/insights/refresh queues a forced, immediate `insights` job for one
// lead (any viewer of the lead may ask), merges a second press into the open job, and caps presses per user per day
// with a neutral 429.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InsightsRefreshResult } from '@leadmaker/shared';
import { loadConfig } from '../src/config.ts';
import { MANUAL_INSIGHTS_PRIORITY } from '../src/routes/insights.ts';
import { Harness, url, type Fixture } from './harness.ts';

const h = new Harness();

type JobRow = {
  id: number; kind: string; params: Record<string, unknown>; dedupe_key: string; status: string; priority: number;
  max_attempts: number; requested_by: string | null; due: boolean;
};
const jobs = () => h.all<JobRow>(
  `SELECT id, kind, params, dedupe_key, status, priority, max_attempts, requested_by, run_after <= now() AS due
   FROM jobs ORDER BY id`);
const refresh = (path: string) => `/api/leads/${path}/insights/refresh`;

describe('manual insights refresh config', () => {
  it('defaults to 30 presses per user per day; <= 0 disables the cap', () => {
    expect(loadConfig({}).manualInsightsPerUserPerDay).toBe(30);
    expect(loadConfig({ LEADMAKER_MANUAL_INSIGHTS_PER_USER_PER_DAY: '0' }).manualInsightsPerUserPerDay).toBe(0);
  });
});

describe.skipIf(!url)('POST /api/leads/:id/insights/refresh', () => {
  let f: Fixture;

  beforeAll(async () => {
    await h.start();
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    h.config = { ...h.config, manualInsightsPerUserPerDay: 10 };
    f = await h.reset();
  });

  it('queues one forced, immediate, high-priority insights job for the lead and returns 202 {jobId, requestedAt}', async () => {
    const before = Date.now();
    const res = await h.as(f.rep1).post(refresh(f.leads.own));
    expect(res.status).toBe(202);
    const body = res.body as InsightsRefreshResult;
    expect(body.merged).toBe(false);
    expect(Number.isInteger(body.jobId)).toBe(true);
    expect(Date.parse(body.requestedAt)).toBeGreaterThanOrEqual(before - 5000);
    expect(await jobs()).toEqual([{
      id: body.jobId, kind: 'insights', params: { company_ids: [f.leads.own], force: true, requested_by: f.rep1.id },
      dedupe_key: `insights:company:${f.leads.own}:manual`, status: 'queued', priority: MANUAL_INSIGHTS_PRIORITY,
      max_attempts: 1, requested_by: null, due: true,
    }]);
    // audited, and nothing about the lead itself changes (no version bump, no event)
    expect((await h.all<{ action: string }>(`SELECT action FROM audit_events WHERE entity_type = 'job'`))).toEqual([{ action: 'created' }]);
    expect(await h.version(f.leads.own)).toBe(1);
    expect(await h.outbox()).toEqual([]);
  });

  it('a second press merges into the open job; once it finishes, a new one is queued', async () => {
    const a = await h.as(f.rep1).post(refresh(f.leads.own));
    const b = await h.as(f.manager).post(refresh(f.leads.own));
    expect(b.status).toBe(202);
    expect(b.body).toEqual({ jobId: a.body.jobId, requestedAt: a.body.requestedAt, merged: true });
    expect(await jobs()).toHaveLength(1);
    // the edit hook's delayed job for the same lead is a different key and never blocks it
    await h.db.$executeRawUnsafe(
      `INSERT INTO jobs (kind, params, dedupe_key, priority, run_after)
       VALUES ('insights', '{}'::jsonb, $1, 150, now() + interval '60 seconds')`, `insights:company:${f.leads.pool}`);
    expect((await h.as(f.rep1).post(refresh(f.leads.pool))).body.merged).toBe(false);
    await h.db.$executeRawUnsafe(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, a.body.jobId);
    const c = await h.as(f.rep1).post(refresh(f.leads.own));
    expect(c.status).toBe(202);
    expect(c.body.merged).toBe(false);
    expect(c.body.jobId).not.toBe(a.body.jobId);
  });

  it('follows the profile visibility rule: own and pool leads yes, another rep\'s lead 404; managers see all', async () => {
    expect((await h.as(f.rep1).post(refresh(f.leads.pool))).status).toBe(202);
    expect((await h.as(f.rep1).post(refresh(f.leads.other))).status).toBe(404);
    expect((await h.as(f.manager).post(refresh(f.leads.other))).status).toBe(202);
    expect((await h.as(f.rep1).post(refresh('not-a-uuid'))).status).toBe(404);
    expect((await h.as(f.rep1).post(refresh('00000000-0000-4000-8000-000000000000'))).status).toBe(404);
    expect((await h.as(f.rep1, { token: 'wrong' }).post(refresh(f.leads.own))).status).toBe(401);
    expect((await jobs()).map((j) => (j.params.company_ids as string[])[0]).sort()).toEqual([f.leads.pool, f.leads.other].sort());
  });

  it('a do-not-contact lead is 409 insights_unavailable and queues nothing', async () => {
    await h.db.$executeRawUnsafe(`UPDATE companies SET account_status = 'do_not_contact' WHERE id = $1::uuid`, f.leads.own);
    const res = await h.as(f.rep1).post(refresh(f.leads.own));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'insights_unavailable' });
    expect(await jobs()).toEqual([]);
  });

  it('caps new jobs per user per day with a neutral 429; merges stay free; other users and area refreshes are unaffected', async () => {
    h.config = { ...h.config, manualInsightsPerUserPerDay: 2 };
    const rep = h.as(f.rep1);
    expect((await rep.post(refresh(f.leads.own))).status).toBe(202);
    expect((await rep.post(refresh(f.leads.own))).body.merged).toBe(true); // free
    expect((await rep.post(refresh(f.leads.pool))).status).toBe(202);
    const over = await rep.post(refresh(f.leads.pool));
    expect(over.status).toBe(202); // still open: merged, free
    await h.db.$executeRawUnsafe(`UPDATE jobs SET status = 'succeeded'`);
    const capped = await rep.post(refresh(f.leads.own));
    expect(capped.status).toBe(429);
    expect(capped.body).toEqual({ error: 'try_again_later' });
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.stringify(capped.body)).not.toMatch(/quota|limit/i);
    expect((await jobs()).filter((j) => j.status === 'queued')).toEqual([]);
    // another user has their own allowance
    expect((await h.as(f.manager).post(refresh(f.leads.own))).status).toBe(202);
    // manual refreshes are not area refreshes: jobs.requested_by stays null, so the hourly refresh limit is untouched
    expect((await rep.post('/api/refresh', { postal_code: '10013', radius_miles: 25 })).status).toBe(202);
    // a day later the presses age out
    await h.db.$executeRawUnsafe(`UPDATE jobs SET status = 'succeeded'`);
    expect((await rep.post(refresh(f.leads.own))).status).toBe(429);
    await h.db.$executeRawUnsafe(`UPDATE jobs SET created_at = now() - interval '25 hours' WHERE kind = 'insights'`);
    const later = await rep.post(refresh(f.leads.own));
    expect(later.status).toBe(202);
    expect(later.body.merged).toBe(false);
  });
});
