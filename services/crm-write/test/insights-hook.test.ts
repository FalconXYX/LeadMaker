// Section 4 review (AI M3): a rep's edit that changes a lead's AI-insight inputs queues an `insights` job in the same
// transaction (LEADMAKER_INSIGHTS_ON_EDIT=1), delayed and deduplicated per lead, so the profile's summary and pitch
// follow the notes instead of waiting for an operator. The worker then regenerates only if the input_hash changed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { configureInsightsHook } from '../src/tx.ts';
import { Harness, url, type Fixture } from './harness.ts';

const h = new Harness();

type JobRow = { kind: string; params: { company_ids: string[] }; dedupe_key: string; status: string; priority: number; delay: number; requested_by: string | null };
const jobs = () => h.all<JobRow>(
  `SELECT kind, params, dedupe_key, status, priority, requested_by,
          round(extract(epoch FROM run_after - created_at))::int AS delay
   FROM jobs ORDER BY id`);

describe('insights hook config', () => {
  it('is off unless LEADMAKER_INSIGHTS_ON_EDIT=1, with a 60 s default delay', () => {
    expect(loadConfig({}).insightsOnEdit).toEqual({ enabled: false, delaySeconds: 60 });
    expect(loadConfig({ LEADMAKER_INSIGHTS_ON_EDIT: '1', LEADMAKER_INSIGHTS_EDIT_DELAY_SECONDS: '5' }).insightsOnEdit)
      .toEqual({ enabled: true, delaySeconds: 5 });
  });
});

describe.skipIf(!url)('insights jobs on edit', () => {
  let f: Fixture;

  beforeAll(async () => {
    h.config = { ...h.config, insightsOnEdit: { enabled: true, delaySeconds: 60 } };
    await h.start();
  });
  afterAll(async () => {
    configureInsightsHook({ enabled: false, delaySeconds: 60 });
    await h.stop();
  });
  beforeEach(async () => {
    f = await h.reset();
  });

  it('a note queues one delayed insights job for that lead; a burst of edits merges into it', async () => {
    const rep = h.as(f.rep1);
    expect((await rep.post(`/api/leads/${f.leads.own}/notes`, { text: 'Not interested in shingles, wants TPO' })).status).toBe(201);
    expect((await rep.post(`/api/leads/${f.leads.own}/activities`, { type: 'call', outcome: 'connected', note: 'Quote TPO' })).status).toBe(201);
    expect(await jobs()).toEqual([{
      kind: 'insights', params: { company_ids: [f.leads.own] }, dedupe_key: `insights:company:${f.leads.own}`,
      status: 'queued', priority: 150, delay: 60, requested_by: null,
    }]);
    // another lead gets its own job
    expect((await h.as(f.manager).post(`/api/leads/${f.leads.pool}/notes`, { text: 'Owner asked about metal' })).status).toBe(201);
    expect((await jobs()).map((j) => j.params.company_ids[0])).toEqual([f.leads.own, f.leads.pool]);
  });

  it('a stage change queues one; a checked toggle does not (it is not an insight input)', async () => {
    expect((await h.as(f.rep1).post(`/api/leads/${f.leads.own}/state`, { checked: true })).status).toBe(200);
    expect(await jobs()).toEqual([]);
    expect((await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, { stage: 'interested', version: 1 })).status).toBe(200);
    expect((await jobs()).map((j) => j.kind)).toEqual(['insights']);
  });

  it('a rejected write queues nothing (same transaction)', async () => {
    expect((await h.as(f.rep1).post(`/api/leads/${f.leads.other}/notes`, { text: 'not mine' })).status).toBe(404);
    expect(await jobs()).toEqual([]);
  });
});
