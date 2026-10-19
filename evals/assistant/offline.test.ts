// The offline suites (spec §9.1): every nl_filter and lead_qa case through the real engine with the fake provider.
// Contracts hold for every case; DSL assertions hold for cases marked offline and for scripted adversarial cases;
// the rest is reported as the rules-parser baseline.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantEvent } from '@leadmaker/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCases, type AssistantSuite } from '../lib/cases.ts';
import { summarize, writeReport, type CaseRecord } from '../lib/report.ts';
import { FixtureQueryClient, USERS, qaFixture } from './fixture-query.ts';
import { planSuite } from './plan.ts';
import {
  CountingBudget, PINNED_NOW, checkContracts, offlineProvider, parseSse, runCase, runInProcess, viewerFor, type CaseRun,
  type RunEnv,
} from './runner.ts';

const dir = mkdtempSync(join(tmpdir(), 'lm-evals-offline-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env: RunEnv = { mode: 'offline', provider: offlineProvider(), now: PINNED_NOW };

async function runSuite(suite: AssistantSuite): Promise<CaseRecord[]> {
  const plan = planSuite(suite, { mode: 'offline' });
  const out: CaseRecord[] = [];
  for (const c of plan.run) out.push(await runCase(suite, c, env));
  return out;
}

describe.each(['nl_filter', 'lead_qa'] as const)('%s offline', (suite) => {
  let records: CaseRecord[] = [];

  it('runs every case through the engine with the fake provider', async () => {
    records = await runSuite(suite);
    expect(records.length).toBe(loadCases(suite as 'nl_filter').length);
  });

  it('every case satisfies the contracts (one terminal event, valid filters, permissions, citations, caps)', () => {
    const broken = records.filter((r) => r.contractFailures.length).map((r) => `${r.id}: ${r.contractFailures.join('; ')}`);
    expect(broken).toEqual([]);
  });

  it('asserted cases (offline: true, fake_script) pass their expectations', () => {
    const asserted = records.filter((r) => r.asserted);
    expect(asserted.length).toBeGreaterThanOrEqual(suite === 'nl_filter' ? 20 : 10);
    const failed = asserted.filter((r) => !r.pass).map((r) => `${r.id}: ${r.failures.join('; ')} ${JSON.stringify(r.actual).slice(0, 300)}`);
    expect(failed).toEqual([]);
  });

  it('reports the full DSL score (the rules-parser baseline) without asserting it', () => {
    const report = {
      suite, mode: 'offline' as const, provider: 'fake', model: 'fake-1', startedAt: PINNED_NOW.toISOString(),
      finishedAt: PINNED_NOW.toISOString(), now: PINNED_NOW.toISOString(), options: {}, cases: records, notes: [],
    };
    const s = summarize(report);
    expect(s.dsl.total).toBe(records.length);
    expect(s.dsl.pass).toBeGreaterThan(0);
    const paths = writeReport(report, dir);
    expect(readFileSync(paths.md, 'utf8')).toContain(`# Eval report: ${suite}`);
  });
});

describe('server defenses, case by case', () => {
  const nl = new Map(loadCases('nl_filter').map((c) => [c.id, c]));
  const qa = new Map(loadCases('lead_qa').map((c) => [c.id, c]));

  it("a rep's repId for another rep never reaches query and emits no apply_filter (qa-20)", async () => {
    const run = await runInProcess(qa.get('qa-20')!, env);
    expect(run.events.some((e) => e.type === 'tool')).toBe(false);
    expect(run.result?.toolCalls).toEqual([expect.objectContaining({ name: 'applyListFilters', ok: false })]);
    const searches = run.queryCalls.filter((q) => q.op === 'search');
    expect(searches.every((q) => q.op === 'search' && typeof q.filter.scope !== 'object')).toBe(true);
  });

  it('every query call carries the requesting identity (manager and rep)', async () => {
    for (const c of [nl.get('nl-29')!, nl.get('nl-42')!, qa.get('qa-27')!]) {
      const run = await runInProcess(c, env);
      const viewer = viewerFor(c.role);
      expect(run.queryCalls.length).toBeGreaterThan(0);
      for (const q of run.queryCalls) expect(q.viewer).toEqual(viewer);
    }
  });

  it('citations carry the active lead, including a pool lead (qa-28)', async () => {
    const run = await runInProcess(qa.get('qa-28')!, env);
    const cites = run.events.filter((e) => e.type === 'citation');
    expect(cites.length).toBeGreaterThan(0);
    for (const e of cites) expect(e).toMatchObject({ leadId: qaFixture('certified_only').id });
  });

  it("the route's prefetch refuses another rep's lead (404 before any model call)", async () => {
    const query = new FixtureQueryClient();
    expect(await query.aiContext(viewerFor('rep'), qaFixture('me_replacement').id)).not.toBeNull();
    const priya = { id: USERS.rep2.id, role: 'rep' as const };
    expect(await query.aiContext(priya, qaFixture('me_replacement').id)).toBeNull();
    expect(await query.aiContext(priya, qaFixture('certified_only').id)).not.toBeNull(); // pool lead
  });

  it('the live call budget is a hard cap (budget errors end the stream as ai_quota_exhausted)', async () => {
    const budget = new CountingBudget(1);
    const live: RunEnv = { mode: 'live', provider: offlineProvider(), now: PINNED_NOW, budget };
    const r1 = await runCase('nl_filter', nl.get('nl-02')!, live);
    expect(r1.llmCalls).toBe(1);
    const r2 = await runCase('nl_filter', nl.get('nl-42')!, live);
    expect(r2.actual).toMatchObject({ outcome: 'error', errorCode: 'ai_quota_exhausted' });
    expect(budget.used).toBe(1);
    expect(budget.exhausted).toBe(true);
    expect(r2.contractFailures).toEqual([]);
  });
});

describe('contract checker', () => {
  const viewer = viewerFor('rep');
  const lead = qaFixture('me_replacement');
  const base = (events: AssistantEvent[], over: Partial<CaseRun> = {}): CaseRun => ({
    events, result: null, queryCalls: [], leadContext: null, ms: 1, firstTokenMs: null, ...over,
  });
  const done: AssistantEvent = { type: 'done', usage: { llmCalls: 1, inputTokens: 1, outputTokens: 1, ms: 1 } };

  it('accepts a well-formed stream', () => {
    const ev: AssistantEvent[] = [
      { type: 'tool', name: 'apply_filter', filter: { scope: 'mine', materials: ['metal_roofing'] }, explanation: 'Metal', matchCount: 3, matchCountCapped: false },
      { type: 'token', text: '3 leads match.' }, done,
    ];
    expect(checkContracts(base(ev), viewer, { inProcess: true })).toEqual([]);
  });

  it('catches each broken invariant', () => {
    const c = (ev: AssistantEvent[], over: Partial<CaseRun> = {}) => checkContracts(base(ev, over), viewer, { inProcess: true });
    expect(c([{ type: 'token', text: 'hi' }])).toContain('expected exactly one terminal event, got 0');
    expect(c([done, { type: 'token', text: 'late' }])).toContain('events were emitted after the terminal event');
    expect(c([done, done])).toContain('expected exactly one terminal event, got 2');
    expect(c([{ type: 'citation', leadId: lead.id, field: 'details' }, done])).toContain('a citation without an active lead');
    expect(c([{ type: 'citation', leadId: 'other', field: 'details' }, done], { leadContext: lead })).toContain('a citation for another lead (other)');
    expect(c([{ type: 'citation', leadId: lead.id, field: 'bogus' }, done], { leadContext: lead })).toContain('citation field bogus is not allowlisted');
    expect(c([{ type: 'token', text: 'x [src:notes]' }, done])).toContain('a [src:] tag reached the client');
    expect(c([{ type: 'token', text: 'x'.repeat(2500) }, done])).toContain('answer is 2500 chars (cap 2000)');
    expect(c([{ type: 'tool', name: 'apply_filter', filter: { scope: { repId: USERS.rep2.id } }, explanation: 'x', matchCount: 1, matchCountCapped: false }, done]))
      .toContain("a rep's apply_filter names another rep's scope");
    expect(c([{ type: 'tool', name: 'apply_filter', filter: { minRating: 9 }, explanation: 'x', matchCount: 1, matchCountCapped: false }, done])[0])
      .toMatch(/fails leadFilterSchema/);
    expect(c([{ type: 'tool', name: 'apply_filter', filter: {}, explanation: 'x' }, done])).toContain('apply_filter.matchCount is not a number');
    expect(c([{ type: 'tool', name: 'open_lead', leadId: USERS.rep2.id }, done])).toContain('open_lead names a lead no visibility-checked read returned');
    expect(c([{ type: 'error', message: 'x', code: 'made_up' }])).toContain('unknown error code made_up');
    expect(c([{ type: 'token', text: `AIza${'k'.repeat(35)}` }, done])).toContain('a key-shaped string in a token event');
    expect(c([done], { queryCalls: [{ op: 'search', viewer: { id: USERS.rep2.id, role: 'rep' }, filter: {} }] }))
      .toContain('a query search call carried another identity');
    expect(c([done], { queryCalls: [{ op: 'search', viewer, filter: { scope: { repId: USERS.rep2.id } } }] }))
      .toContain("query search was asked for another rep's leads");
  });
});

describe('SSE parsing (gateway mode)', () => {
  it('parses the wire format of spec §7.2, skipping comments', () => {
    const body = [
      ': ok', '',
      'event: tool', 'data: {"name":"apply_filter","filter":{"scope":"mine"},"explanation":"Mine","matchCount":6,"matchCountCapped":false}', '',
      ': ping', '',
      'event: token', 'data: {"text":"6 leads match."}', '',
      'event: done', 'data: {"usage":{"llmCalls":1,"inputTokens":2310,"outputTokens":58,"ms":1840},"promptVersion":"assistant/v1"}', '', '',
    ].join('\n');
    const ev = parseSse(body);
    expect(ev.map((e) => e.type)).toEqual(['tool', 'token', 'done']);
    expect(ev[2]).toMatchObject({ usage: { llmCalls: 1 } });
    expect(checkContracts(base2(ev), viewerFor('rep'), { inProcess: false })).toEqual([]);
  });
});

function base2(events: AssistantEvent[]): CaseRun {
  return { events, result: null, queryCalls: [], leadContext: null, ms: 1, firstTokenMs: null };
}
