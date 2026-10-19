// The assistant (Section 4) end to end, through the gateway only: identity, visibility, the SSE contract, the
// per-user limits and the provider-error path. It needs the stack's assistant on the fake provider
// (LEADMAKER_ASSISTANT_LLM_PROVIDER=fake, LEADMAKER_ALLOW_FAKE_LLM=1; compose.sh sets both for private projects), so
// it never spends a real model's quota: with any other provider the suite is skipped. Without an assistant
// (the gateway answers 502) it is skipped too, unless E2E_REQUIRE_ASSISTANT=1 (compose.sh) makes that a failure.
// The batch-insights and territory-brief scenarios drive the Python side through pipeline.py, always on the
// Python fake provider (they write AI rows, so they run only where the assistant is on the fake too: a private stack).
//   E2E_REDIS_DB  Redis DB index the stack's assistant uses (default 0); the quota scenario clears its key there
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, describe, test } from 'node:test';
import { leadFilterSchema } from '@leadmaker/shared';
import { call, composeContainers, eventCompanyIds, EventStream, GATEWAY_URL, isUuid, login, pipeline, psql, record, sleep } from './lib.mjs';

const S = {};
let skip = false;

const auth = (who, extra = {}) => ({ authorization: `Bearer ${who.token}`, ...extra });

/** Raw SSE body -> [{event, data}] (comments such as `: ok` and `: ping` skipped). */
function parseSse(text) {
  return text.split('\n\n').filter((b) => b.trim()).flatMap((block) => {
    const lines = block.split('\n').filter((l) => !l.startsWith(':'));
    if (!lines.length) return [];
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
    const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return [{ event, data: data ? JSON.parse(data) : {} }];
  });
}

/**
 * POST /api/assistant/chat. Unlike lib.mjs `call`, a 429 is returned as is (the per-user limit is under test).
 * {status, headers, events (SSE), body (JSON before the stream), text, ms}.
 */
async function chat(who, content, context = { page: 'leads' }, { headers = {}, history = [] } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${GATEWAY_URL}/api/assistant/chat`, {
    method: 'POST',
    headers: { ...auth(who, headers), 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ messages: [...history, { role: 'user', content }], context }),
  });
  const raw = await res.text();
  const ms = performance.now() - t0;
  record('POST /api/assistant/chat', ms);
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  let body = null;
  if (!sse) {
    try {
      body = JSON.parse(raw);
    } catch {}
  }
  const events = sse ? parseSse(raw) : [];
  const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  return { status: res.status, headers: res.headers, events, body, raw, text, ms };
}

async function status(who) {
  const res = await fetch(`${GATEWAY_URL}/api/assistant/status`, { headers: auth(who) });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

/** Every stream ends with exactly one terminal event (done or error), and it is the last one. */
function assertTerminal(r, type) {
  assert.equal(r.status, 200, `chat: ${r.status} ${r.raw.slice(0, 300)}`);
  assert.ok(r.raw.startsWith(': ok\n\n'), 'the stream starts with ": ok"');
  const terminal = r.events.filter((e) => e.event === 'done' || e.event === 'error');
  assert.equal(terminal.length, 1, `one terminal event: ${JSON.stringify(r.events.map((e) => e.event))}`);
  assert.equal(r.events.at(-1), terminal[0]);
  if (type) assert.equal(terminal[0].event, type, `terminal ${JSON.stringify(terminal[0])}`);
  assert.doesNotMatch(r.raw, /\[src:/, 'no [src:] tag reaches the client');
  return terminal[0];
}

const script = (...steps) => `/fake ${JSON.stringify({ steps })}`;

async function firstLead(who, filter) {
  const res = await fetch(`${GATEWAY_URL}/api/leads/search`, {
    method: 'POST', headers: { ...auth(who), 'content-type': 'application/json' }, body: JSON.stringify({ filter: { ...filter, limit: 1 } }),
  });
  assert.equal(res.status, 200, `search ${JSON.stringify(filter)}`);
  const item = (await res.json()).items[0];
  assert.ok(item, `no lead for ${JSON.stringify(filter)}`);
  return item;
}

/** Deletes a key in the stack's Redis (the assistant's DB index). */
function redisDel(key) {
  const [id] = composeContainers('redis');
  if (!id) throw new Error('no running redis container for this compose project');
  execFileSync('docker', ['exec', id, 'redis-cli', '-n', String(process.env.E2E_REDIS_DB || 0), 'DEL', key], { encoding: 'utf8' });
}

before(async () => {
  const health = await fetch(`${GATEWAY_URL}/readyz`).catch(() => null);
  assert.ok(health?.ok, 'gateway /readyz is not 200; is the stack up?');
  for (const who of ['rep1', 'rep2', 'rep3', 'manager']) S[who] = await login(`${who}@demo.local`);
  const st = await status(S.rep1);
  if (st.status === 502 || st.status === 404) {
    if (process.env.E2E_REQUIRE_ASSISTANT === '1') assert.fail(`the assistant is not reachable through the gateway (${st.status})`);
    skip = 'the assistant is not deployed (gateway answers 502)';
    return;
  }
  assert.equal(st.status, 200, `status: ${JSON.stringify(st.body)}`);
  S.status = st.body;
  if (st.body.provider !== 'fake') {
    skip = `the assistant uses ${st.body.provider ?? 'no provider'}; this suite runs only on the fake provider (no quota spent)`;
    return;
  }
  S.rep1Own = await firstLead(S.rep1, { scope: 'mine' });
  S.rep2Own = await firstLead(S.rep2, { scope: 'mine' });
  S.pool = await firstLead(S.rep1, { scope: 'unallocated' });
});

describe('assistant through the gateway (fake provider)', () => {
  test('status: available on the fake provider, with the caller\'s limits', async (t) => {
    if (skip) return t.skip(skip);
    assert.equal(S.status.available, true);
    assert.equal(S.status.reason, 'ok');
    assert.equal(S.status.provider, 'fake');
    assert.equal(typeof S.status.limits.perMinute, 'number');
    assert.equal(typeof S.status.limits.usedToday, 'number');
  });

  test('rep1 NL filter: tool apply_filter (scope mine, matchCount) -> token -> done', async (t) => {
    if (skip) return t.skip(skip);
    const r = await chat(S.rep1, "Master Elite contractors I haven't checked yet");
    assertTerminal(r, 'done');
    // `status` progress lines come first ("Thinking…", "Counting matching leads…"), then the contract as before.
    const evs = r.events.filter((e) => e.event !== 'status');
    assert.ok(r.events.slice(0, 2).every((e) => e.event === 'status'), `progress first: ${r.events.map((e) => e.event)}`);
    assert.deepEqual(evs.map((e) => e.event), ['tool', 'token', 'done']);
    const tool = evs[0].data;
    assert.equal(tool.name, 'apply_filter');
    assert.ok(leadFilterSchema.safeParse(tool.filter).success, `filter validates: ${JSON.stringify(tool.filter)}`);
    assert.equal(tool.filter.scope, 'mine');
    assert.deepEqual(tool.filter.certifications, ['gaf:master_elite']);
    assert.equal(tool.filter.unchecked, 'me');
    assert.equal(typeof tool.matchCount, 'number');
    assert.ok(tool.explanation.length <= 120);
    assert.match(r.text, /^(No leads match|1 lead matches|[\d,]+ leads match|Over [\d,]+ leads match)/);
    assert.equal(evs[2].data.promptVersion, 'assistant/v2');
  });

  test("lead Q&A: another rep's lead is 404 lead_not_found; a pool lead answers with citations for that lead", async (t) => {
    if (skip) return t.skip(skip);
    const hidden = await chat(S.rep1, 'Summarize this contractor', { page: 'profile', leadId: S.rep2Own.id });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, { error: 'lead_not_found' });

    const r = await chat(S.rep1, 'Summarize this contractor', { page: 'profile', leadId: S.pool.id });
    assertTerminal(r, 'done');
    const citations = r.events.filter((e) => e.event === 'citation').map((e) => e.data);
    assert.ok(citations.length >= 1, 'at least one citation');
    for (const c of citations) assert.equal(c.leadId, S.pool.id);
    assert.ok(citations.some((c) => c.field === 'details'));
    assert.ok(r.text.includes(S.pool.businessName.slice(0, 10)), 'the answer names the lead');
  });

  test("a rep's tool call naming another rep is refused: no apply_filter, and the reply says so", async (t) => {
    if (skip) return t.skip(skip);
    const r = await chat(S.rep1, script({ tool: 'applyListFilters', args: { filter: {}, repId: S.rep2.user.id, explanation: 'x' } }));
    assertTerminal(r, 'done');
    assert.ok(!r.events.some((e) => e.event === 'tool'), 'no tool event');
    assert.match(r.text, /couldn't apply/i);
  });

  test('a manager findLeads question streams text with /leads/ links', async (t) => {
    if (skip) return t.skip(skip);
    const r = await chat(S.manager, 'Which Master Elite leads should I call first?', { page: 'dashboard' });
    assertTerminal(r, 'done');
    assert.ok(!r.events.some((e) => e.event === 'tool'), 'findLeads does not change the screen');
    assert.match(r.text, /\]\(\/leads\/[0-9a-f-]{36}\)/);
    const links = r.text.match(/\(\/leads\/[0-9a-f-]{36}\)/g) ?? [];
    assert.ok(links.length <= 5);
  });

  test("applyListFilters counts only what the asker may see: a rep's preview is not the manager's", async (t) => {
    if (skip) return t.skip(skip);
    const filter = { certifications: ['gaf:master_elite'] };
    const step = script({ tool: 'applyListFilters', args: { filter: { ...filter, scope: 'all' }, explanation: 'Master Elite leads' } });
    const counts = {};
    for (const who of ['rep1', 'manager']) {
      const r = await chat(S[who], step, { page: 'leads' });
      assertTerminal(r, 'done');
      const tool = r.events.find((e) => e.event === 'tool')?.data;
      assert.equal(tool?.name, 'apply_filter', `${who}: ${JSON.stringify(r.events)}`);
      assert.equal(tool.filter.scope, 'all');
      counts[who] = tool.matchCount;
    }
    // The preview is the search the asker would run: a rep's "all" is mine + pool, a manager's is everything.
    const search = async (who, f) => {
      const res = await call('POST', '/api/leads/search', { token: S[who].token, body: { filter: { ...f, limit: 100 } } });
      assert.equal(res.status, 200);
      return res.body;
    };
    const rep1 = await search('rep1', filter);
    const manager = await search('manager', { ...filter, scope: 'all' });
    const rep2Own = await search('rep2', { ...filter, scope: 'mine' });
    assert.equal(counts.rep1, rep1.total, 'rep1 preview = rep1 search');
    assert.equal(counts.manager, manager.total, 'manager preview = manager search');
    assert.ok(rep1.items.every((l) => l.assignedRep?.id !== S.rep2.user.id), "rep1's results hold none of rep2's leads");
    if (rep2Own.total > 0) assert.ok(counts.rep1 < counts.manager, `rep1 ${counts.rep1} < manager ${counts.manager}`);
  });

  test("batch insights: lead.updated {fields:['insights']} reaches the owner only; the profile shows it, no version bump", async (t) => {
    if (skip) return t.skip(skip);
    const id = S.rep1Own.id;
    const before = await call('GET', `/api/leads/${id}`, { token: S.rep1.token });
    assert.equal(before.status, 200);
    const owner = await new EventStream(S.rep1.token).open();
    const other = await new EventStream(S.rep2.token).open();
    try {
      const out = await pipeline(['insights', id], 'pipeline insights (fake provider)');
      assert.equal(out.stats.generated, 1, JSON.stringify(out.stats));
      assert.deepEqual(out.versions_after, out.versions_before, 'insight writes never bump companies.version');
      const isInsight = (m) => m.event === 'lead.updated' && eventCompanyIds(m).includes(id);
      const msg = await owner.waitFor(isInsight, 15_000);
      assert.deepEqual(msg.data.payload.fields, ['insights']);
      assert.equal(msg.data.payload.material, false);
      record('insights write -> SSE delivery', msg.wall - out.committed_at_ms);
      const after = await call('GET', `/api/leads/${id}`, { token: S.rep1.token });
      assert.equal(after.status, 200);
      assert.equal(after.body.version, before.body.version, 'same version: no "changed while you were editing" 409');
      const ins = after.body.insights;
      assert.ok(ins?.businessSummary && ins.salesRecommendation, `insights: ${JSON.stringify(ins)}`);
      assert.match(ins.model, /fake/);
      assert.match(ins.promptVersion, /^insights\/v\d+$/);
      assert.ok(ins.citedFacts.length >= 1);
      await sleep(1500);
      assert.ok(!other.events.some((m) => eventCompanyIds(m).includes(id)), "rep2's stream never carries rep1's lead");
    } finally {
      owner.close();
      other.close();
    }
  });

  test('territory brief: quiet until an alert, then the digest with the fake AI rewrite; scope rules', async (t) => {
    if (skip) return t.skip(skip);
    const county = psql(`SELECT county_fips FROM companies WHERE assigned_rep_id = '${S.rep1.user.id}'
      AND county_fips IS NOT NULL ORDER BY priority_score DESC NULLS LAST LIMIT 1`, 'psql (rep1 county)');
    assert.match(county, /^\d{5}$/, 'rep1 has a lead with a county');
    const brief = async (who, scope) => {
      const q = scope ? `?scope=${encodeURIComponent(scope)}` : '';
      return call('GET', `/api/territory-brief${q}`, { token: S[who].token });
    };
    const run = await pipeline(['briefing', '--alert-county', county], 'pipeline briefing (fake provider)');
    try {
      assert.ok(run.result.scopes >= 2, JSON.stringify(run.result));
      assert.ok(run.result.rewritten >= 1, `a fake rewrite was stored: ${JSON.stringify(run.result)}`);
      const mine = await brief('rep1');
      assert.equal(mine.status, 200);
      const b = mine.body.brief;
      assert.ok(b, 'rep1 has a brief');
      assert.equal(b.scope, `rep:${S.rep1.user.id}`);
      assert.equal(b.quiet, false);
      assert.equal(b.stale, false);
      // The alert is in the stored digest. Its sentence is the lowest priority in the text (brief v3: at most 3
      // sentences / 400 characters), so a busy seeded book can push it out of digestText.
      const event = psql(`SELECT digest->'weather'->'alerts'->0->>'event' FROM territory_briefs
        WHERE scope = 'rep:${S.rep1.user.id}'`, 'psql (rep1 digest alert)');
      assert.equal(event, 'Severe Thunderstorm Warning');
      assert.ok(b.digestText.length > 0);
      assert.equal(b.source, 'ai');
      assert.ok(b.text.length > 0 && b.text.length <= 400);
      assert.doesNotMatch(b.text, /\byou(r)?\b/i, 'neutral voice');
      // Scope rules: a rep sees only their own brief; a manager sees the team's and any rep's.
      assert.equal((await brief('rep1', 'team')).status, 403);
      assert.equal((await brief('rep1', `rep:${S.rep2.user.id}`)).status, 403);
      assert.equal((await brief('rep1', 'bogus')).status, 400);
      const team = await brief('manager');
      assert.equal(team.status, 200);
      assert.equal(team.body.brief.scope, 'team');
      assert.equal(team.body.brief.quiet, false);
      const asManager = await brief('manager', `rep:${S.rep1.user.id}`);
      assert.equal(asManager.status, 200);
      assert.equal(asManager.body.brief.text, b.text);
    } finally {
      if (run.alert) await pipeline(['briefing', '--clear-alert', run.alert], 'pipeline briefing (cleanup)');
    }
  });

  test('a rep\'s note queues one delayed insights job for that lead (crm-write hook); a burst merges into it', async (t) => {
    if (skip) return t.skip(skip);
    const id = S.rep1Own.id;
    const key = `insights:company:${id}`;
    psql(`DELETE FROM jobs WHERE dedupe_key = '${key}';`, 'psql (cleanup)');
    try {
      for (const text of ['e2e: owner now wants a TPO quote', 'e2e: and seam tape']) {
        const res = await call('POST', `/api/leads/${id}/notes`, { token: S.rep1.token, body: { text } });
        assert.equal(res.status, 201);
      }
      const rows = psql(`SELECT kind || '|' || status || '|' || (params->'company_ids'->>0) || '|' ||
        (extract(epoch FROM run_after - created_at) >= 50) FROM jobs WHERE dedupe_key = '${key}';`, 'psql (insights job)');
      assert.equal(rows, `insights|queued|${id}|true`, 'one queued insights job, about a minute out');
    } finally {
      psql(`DELETE FROM jobs WHERE dedupe_key = '${key}' AND status = 'queued';`, 'psql (cleanup)');
    }
  });

  test('spoofed identity headers from the client are ignored', async (t) => {
    if (skip) return t.skip(skip);
    // rep2 claims to be rep1 (and a manager): the gateway re-sets identity, so rep1's lead stays invisible.
    const r = await chat(S.rep2, 'Summarize this contractor', { page: 'profile', leadId: S.rep1Own.id }, {
      headers: { 'x-user-id': S.rep1.user.id, 'x-user-role': 'manager', 'x-internal-token': 'forged' },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'lead_not_found' });
  });

  test('a provider quota error ends the stream with ai_quota_exhausted, and status reports it', async (t) => {
    if (skip) return t.skip(skip);
    const key = `ai:prov:exhausted:${S.status.provider}:${S.status.model}`;
    try {
      const r = await chat(S.rep2, script({ error: 'quota' }));
      const end = assertTerminal(r, 'error');
      assert.equal(end.data.code, 'ai_quota_exhausted');
      assert.equal(end.data.retryable, false);
      assert.ok(!Number.isNaN(Date.parse(end.data.resetsAt)), 'resetsAt is a date');
      assert.doesNotMatch(end.data.message, /scripted|429/i, 'server copy, not provider text');
      const st = await status(S.rep2);
      assert.equal(st.body.available, false);
      assert.equal(st.body.reason, 'quota_exhausted');
      assert.equal(st.body.resetsAt, end.data.resetsAt);
    } finally {
      redisDel(key);
    }
    assert.equal((await status(S.rep2)).body.reason, 'ok');
  });

  test('the 7th request within a minute gets 429 rate_limited with Retry-After', async (t) => {
    if (skip) return t.skip(skip);
    const perMinute = S.status.limits.perMinute;
    const seen = [];
    let limited = null;
    for (let i = 0; i < perMinute + 1 && !limited; i++) {
      const r = await chat(S.rep3, 'Show me Master Elite roofers');
      seen.push(r.status);
      if (r.status === 429) limited = r;
      else assertTerminal(r, 'done');
    }
    assert.ok(limited, `no 429 after ${seen.length} requests: ${seen.join(',')}`);
    assert.equal(seen.length, perMinute + 1, `429 on request ${seen.length}, expected ${perMinute + 1}`);
    assert.equal(limited.body.error, 'rate_limited');
    assert.equal(typeof limited.body.retryAfterMs, 'number');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});
