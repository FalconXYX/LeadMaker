// Cross-service end-to-end suite: talks only to the gateway (GATEWAY_URL) and discovers every lead through
// search. Pipeline steps run the real Python pipeline (pipeline.py in the worker image) against E2E_DB; psql
// is used only for cleanup. Run with tests/integration_stack/run.sh (or compose.sh for the whole chain).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  call, COMPOSE_PROJECT, composeContainers, DB_NAME, eventCompanyIds, EventStream, isUuid, latencyReport, login, pipeline,
  PIPELINE_MODE, psql, record, RUN_ID, sleep,
} from './lib.mjs';

const SSE_DEADLINE_MS = 5000;
const S = { poolAllocated: new Set(), contacts: [] };
const N = {};  // notifications block
// The compose project 'leadmaker' with its 'leadmaker' database is the shared demo stack.
const SHARED_DEMO_DB = DB_NAME === 'leadmaker' && COMPOSE_PROJECT === 'leadmaker';
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const search = (who, filter, step) => call('POST', '/api/leads/search', { token: who.token, body: { filter }, step });
const profile = (who, id) => call('GET', `/api/leads/${id}`, { token: who.token });
const kpis = (who) => call('GET', '/api/kpis', { token: who.token });
const ok = (r, status, what) => assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);

async function searchAll(who, filter, maxPages = 25) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const r = await search(who, { ...filter, limit: 200, ...(cursor ? { cursor } : {}) });
    ok(r, 200, 'search page');
    items.push(...r.body.items);
    if (!r.body.nextCursor) return { items, total: r.body.total, complete: true };
    cursor = r.body.nextCursor;
  }
  return { items, total: items.length, complete: false };
}

async function poll(fn, until, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (until(last)) return last;
    await sleep(150);
  }
  return last;
}

// A tag whose ref the server matches literally (it also coerces numeric/boolean-looking strings).
const plainTag = (t) => /^[a-z0-9_:.-]+$/i.test(t.key)
  && (t.value === true || (typeof t.value === 'string' && t.value.trim() !== '' && !/^(true|false)$/.test(t.value)
      && !Number.isFinite(Number(t.value))));
const tagRef = (t) => (t.value === true ? t.key : `${t.key}=${t.value}`);
const hasTag = (item, t) => item.tags.some((x) => x.key === t.key
  && (t.value === true ? x.value !== false : JSON.stringify(x.value) === JSON.stringify(t.value)
      || (Array.isArray(x.value) && x.value.includes(t.value))));

before(async () => {
  const health = await fetch(`${process.env.GATEWAY_URL || 'http://localhost:8080'}/readyz`).catch(() => null);
  assert.ok(health?.ok, 'gateway /readyz is not 200; is the stack up?');
  for (const who of ['rep1', 'rep2', 'rep3', 'manager']) S[who] = await login(`${who}@demo.local`);

  const own = await search(S.rep1, { scope: 'mine', limit: 50 });
  ok(own, 200, 'rep1 own leads');
  assert.ok(own.body.items.length >= 9, `rep1 needs >= 9 allocated leads, has ${own.body.items.length}`);
  // The lifecycle lead needs a reputation tag the pipeline steps can flip (rating over >= 10 reviews).
  const life = own.body.items.find((i) => i.reviewCount >= 10 && i.rating !== null && i.tags.some((t) => t.key === 'reputation'));
  assert.ok(life, 'rep1 needs an allocated lead with a reputation tag over >= 10 reviews');
  S.life = life.id;
  [S.tagged, S.move1, S.move2, S.ryw, S.contactLead, S.cat1, S.cat2, S.noteLead] = own.body.items
    .filter((i) => i.id !== S.life).map((i) => i.id);
  S.ownIds = new Set(own.body.items.map((i) => i.id));

  const pool = await search(S.rep1, { scope: 'unallocated', limit: 5 });
  ok(pool, 200, 'unallocated leads');
  assert.ok(pool.body.items.length >= 3, 'need >= 3 unallocated leads');
  S.unallocated = pool.body.items[0].id;
  [S.poolWatched, S.poolNotified] = pool.body.items.slice(1).map((i) => i.id);

  const rep2 = await search(S.manager, { scope: { repId: S.rep2.user.id }, limit: 5 });
  ok(rep2, 200, "rep2's leads (as manager)");
  assert.ok(rep2.body.items.length >= 1, 'rep2 needs >= 1 allocated lead');
  S.rep2Lead = rep2.body.items[0].id;
  S.rep2Ids = new Set(rep2.body.items.map((i) => i.id));

  S.sse1 = await new EventStream(S.rep1.token).open();
  S.sse2 = await new EventStream(S.rep2.token).open();
});


async function cleanupStep(what, fn) {
  try {
    const r = await fn();
    if (r && r.status >= 300) console.error(`cleanup: ${what}: ${r.status} ${JSON.stringify(r.body)}`);
  } catch (err) {
    console.error(`cleanup: ${what}: ${err.message}`);
  }
}

const roleTtlSeconds = () => Number(process.env.USER_ROLE_TTL_SECONDS || 30);

/** Puts the manager's role back and waits until the gateway serves manager endpoints again (its role cache expires). */
async function restoreManagerRole() {
  psql(`UPDATE users SET role = 'manager' WHERE id = '${S.manager.user.id}';`, 'psql: restore manager role');
  S.demoted = false;
  const r = await poll(() => call('GET', '/api/users', { token: S.manager.token, step: 'role freshness poll' }),
    (x) => x.status === 200, (roleTtlSeconds() + 5) * 1000);
  return r;
}

// Best effort: puts back what the suite changed (notes and activity are append-only and stay).
after(async () => {
  S.sse1?.close();
  S.sse2?.close();
  S.sse3?.close();
  const step = 'cleanup';
  const rep1 = S.rep1?.token;
  if (S.demoted) await cleanupStep('restore manager role', restoreManagerRole);
  for (const { id, token } of S.views ?? []) {
    await cleanupStep('delete saved view', () => call('DELETE', `/api/views/${id}`, { token, step }));
  }
  for (const id of S.tasks ?? []) {
    await cleanupStep('delete task', async () => {
      const r = await call('DELETE', `/api/tasks/${id}?version=1`, { token: S.manager.token, step });
      if (r.status !== 409) return r.status === 404 ? null : r;
      return call('DELETE', `/api/tasks/${id}?version=${r.body.current.version}`, { token: S.manager.token, step });
    });
  }
  for (const [id, stage] of Object.entries(S.stages ?? {})) {
    await cleanupStep('restore sales stage', async () => {
      const p = await profile(S.manager, id);
      return call('PUT', `/api/leads/${id}/stage`, { token: S.manager.token, body: { stage, version: p.body.version }, step });
    });
  }
  if (S.prefs) {
    await cleanupStep('restore preferences', async () => {
      const cur = await call('GET', '/api/preferences', { token: rep1, step });
      return call('PUT', '/api/preferences', { token: rep1, body: { prefs: S.prefs, version: cur.body.version }, step });
    });
  }
  for (const id of S.renameTags ?? []) {
    await cleanupStep('delete renamed tag', () => call('DELETE', `/api/custom-tags/${id}`, { token: rep1, step }));
  }
  for (const id of S.poolAllocated) {
    await cleanupStep('return lead to the pool', () => call('DELETE', `/api/allocations/${id}`, { token: S.manager.token, step }));
  }
  if (N.prefs) {
    await cleanupStep('restore notification preferences', () => call('PUT', '/api/notifications/preferences', {
      token: rep1, body: { items: N.prefs }, step,
    }));
  }
  for (const { id, leadId } of S.contacts) {
    await cleanupStep('delete rep contact', async () => {
      const p = await profile(S.rep1, leadId);
      const version = p.body?.contacts?.find((c) => c.id === id)?.version;
      return call('DELETE', `/api/contacts/${id}?version=${version}`, { token: rep1, step });
    });
  }
  if (S.catTag) {
    for (const id of S.catTag.leads) {
      await cleanupStep('untag catalog lead', () => call('DELETE', `/api/leads/${id}/custom-tags/${S.catTag.id}`, { token: rep1, step }));
    }
  }
  if (S.catField) {
    for (const id of S.catField.leads) {
      await cleanupStep('clear catalog custom field', async () => {
        const p = await profile(S.rep1, id);
        return call('PUT', `/api/leads/${id}/custom-fields/${S.catField.key}`, { token: rep1, body: { value: null, version: p.body.version }, step });
      });
    }
  }
  if (S.moved) {
    await cleanupStep('reallocate to rep1', () => call('POST', '/api/allocations', {
      token: S.manager.token, body: { companyIds: S.moved, repId: S.rep1.user.id }, step,
    }));
    for (const id of S.moved) {
      await cleanupStep('untag moved lead', () => call('DELETE', `/api/leads/${id}/custom-tags/${S.moveTagId}`, { token: S.manager.token, step }));
    }
  }
  if (S.restoreListing) {  // the pipeline puts back the original listing and tags
    const { id, previous } = S.restoreListing;
    await cleanupStep('replay original listing', () => pipeline(['replay', id,
      ...Object.entries(previous).flatMap(([k, v]) => ['--set', `${k}=${JSON.stringify(v)}`])], step));
    await cleanupStep('re-tag', () => pipeline(['tag-job'], step));
  }
  if (S.refreshJobs?.length) {  // nothing ran them (the worker is stopped); drop them so the hourly window resets
    await cleanupStep('drop queued refresh jobs', () => psql(
      `DELETE FROM jobs WHERE status = 'queued' AND id IN (${S.refreshJobs.map(Number).join(', ')});`, step));
  }
  if (S.repContact) {
    await cleanupStep('delete rep contact', () => call('DELETE', `/api/contacts/${S.repContact.id}?version=${S.repContact.version}`,
      { token: rep1, step }));
  }
  if (S.overridden) {
    await cleanupStep('clear phone override', async () => {
      const p = await profile(S.rep1, S.overridden);
      return call('DELETE', `/api/leads/${S.overridden}/overrides/phone?version=${p.body.version}`, { token: rep1, step });
    });
  }
  if (S.customTag) {
    const { id, tagId } = S.customTag;
    await cleanupStep('untag lead', () => call('DELETE', `/api/leads/${id}/custom-tags/${tagId}`, { token: rep1, step }));
    await cleanupStep('clear custom field', async () => {
      const p = await profile(S.rep1, id);
      return call('PUT', `/api/leads/${id}/custom-fields/e2e_score`, { token: rep1, body: { value: null, version: p.body.version }, step });
    });
  }
  console.log(`\nPer-step latency against ${process.env.GATEWAY_URL || 'http://localhost:8080'}:\n${latencyReport()}\n`);
});

test('1 auth: dev-login, 401 without a token, spoofed identity headers ignored', async () => {
  for (const who of ['rep1', 'manager']) {
    assert.ok(S[who].token.split('.').length === 3, `${who} got a JWT`);
    assert.equal(S[who].user.email, `${who}@demo.local`);
  }
  assert.equal(S.rep1.user.role, 'rep');
  assert.equal(S.manager.user.role, 'manager');
  const unknown = await call('POST', '/auth/dev-login', { body: { email: `nobody-${RUN_ID}@demo.local` } });
  ok(unknown, 401, 'dev-login unknown email');

  for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/leads/search'], ['GET', '/api/kpis'],
    ['GET', '/api/events'], ['POST', `/api/leads/${S.life}/notes`], ['GET', '/api/users']]) {
    const r = await call(method, path, { body: method === 'POST' ? {} : undefined, step: 'unauthenticated' });
    ok(r, 401, `${method} ${path} without a token`);
  }
  const forged = {
    'X-User-Id': S.manager.user.id, 'X-User-Role': 'manager', 'X-Internal-Token': 'dev-internal-token-change-me',
  };
  ok(await call('GET', '/api/users', { headers: forged, step: 'unauthenticated' }), 401, 'identity headers without a token');
  ok(await call('GET', '/api/me', { token: `${S.rep1.token}x`, step: 'unauthenticated' }), 401, 'tampered JWT');

  const me = await call('GET', '/api/me', { token: S.rep1.token, headers: forged });
  ok(me, 200, 'GET /api/me with forged headers');
  assert.equal(me.body.id, S.rep1.user.id, 'identity comes from the JWT, not X-User-Id');
  assert.equal(me.body.role, 'rep');
  ok(await call('GET', '/api/users', { token: S.rep1.token, headers: forged }), 403, 'rep + forged manager headers: GET /api/users');
  const all = await call('POST', '/api/leads/search', { token: S.rep1.token, headers: forged, body: { filter: { scope: 'all' } } });
  ok(all, 403, 'rep + forged manager headers: scope all');
  const peek = await call('GET', `/api/leads/${S.rep2Lead}`, { token: S.rep1.token, headers: forged });
  ok(peek, 404, "rep + forged manager headers: another rep's lead");
});

test("2 search: rep sees only own + unallocated; tags, segment, near, unchecked 'me', stable cursor", async () => {
  const me = S.rep1.user.id;
  const all = await searchAll(S.rep1, {});
  assert.ok(all.items.length > 0, 'rep1 sees leads');
  for (const item of all.items) {
    assert.ok(item.assignedRep === null || item.assignedRep.id === me,
      `lead ${item.id} is allocated to ${item.assignedRep?.name}, not rep1 or unallocated`);
    assert.equal(item.canWrite, item.assignedRep?.id === me, `canWrite on ${item.id}`);
  }
  for (const id of S.rep2Ids) assert.ok(!all.items.some((i) => i.id === id), `rep2's lead ${id} leaked into rep1's search`);
  if (all.complete) {
    const [mine, pool] = await Promise.all([search(S.rep1, { scope: 'mine', limit: 1 }), search(S.rep1, { scope: 'unallocated', limit: 1 })]);
    assert.equal(all.total, mine.body.total + pool.body.total, 'total = mine + unallocated');
    assert.equal(all.items.length, all.total);
  }

  const withTag = all.items.find((i) => i.tags.some(plainTag));
  assert.ok(withTag, 'some visible lead has a system tag');
  const tag = withTag.tags.find(plainTag);
  const byTag = await search(S.rep1, { tagsAll: [tagRef(tag)], limit: 200 }, 'search: tagsAll');
  ok(byTag, 200, 'tagsAll');
  assert.ok(byTag.body.items.some((i) => i.id === withTag.id), `tag ${tagRef(tag)} search includes ${withTag.id}`);
  for (const i of byTag.body.items) assert.ok(hasTag(i, tag), `${i.id} lacks tag ${tagRef(tag)}`);

  const withSegment = all.items.find((i) => i.segment);
  assert.ok(withSegment, 'some visible lead has a segment');
  const bySegment = await search(S.rep1, { segment: [withSegment.segment], limit: 200 }, 'search: segment');
  ok(bySegment, 200, 'segment');
  assert.ok(bySegment.body.items.length > 0);
  for (const i of bySegment.body.items) assert.equal(i.segment, withSegment.segment);

  const anchor = all.items.find((i) => i.assignedRep?.id === me && /^\d{5}/.test(i.postalCode ?? ''));
  assert.ok(anchor, 'an own lead with a ZIP code');
  const zip = anchor.postalCode.slice(0, 5);
  const radiusMiles = 5;
  const near = await search(S.rep1, { near: { zip, radiusMiles }, sort: { by: 'distance', dir: 'asc' }, limit: 200 }, 'search: near');
  ok(near, 200, 'near');
  assert.ok(near.body.items.some((i) => i.id === anchor.id), `near ${zip} includes ${anchor.id}`);
  let prev = -1;
  for (const i of near.body.items) {
    assert.ok(i.distanceMiles !== null && i.distanceMiles <= radiusMiles + 0.01, `${i.id} at ${i.distanceMiles} mi`);
    assert.ok(i.distanceMiles >= prev, 'sorted by distance');
    prev = i.distanceMiles;
    assert.ok(i.assignedRep === null || i.assignedRep.id === me, 'near respects visibility');
  }

  const unchecked = await search(S.rep1, { scope: 'mine', unchecked: 'me', limit: 200 }, "search: unchecked 'me'");
  ok(unchecked, 200, "unchecked 'me'");
  for (const i of unchecked.body.items) {
    assert.equal(i.mine.checked, false, `${i.id} is checked but matched unchecked 'me'`);
    assert.equal(i.assignedRep?.id, me);
  }

  const pages = [];
  let cursor;
  for (let p = 0; p < 3; p++) {
    const r = await search(S.rep1, { limit: 5, ...(cursor ? { cursor } : {}) }, 'search: page');
    ok(r, 200, `page ${p + 1}`);
    pages.push(r.body.items.map((i) => i.id));
    if (p === 1) {
      const again = await search(S.rep1, { limit: 5, cursor }, 'search: page');
      assert.deepEqual(again.body.items.map((i) => i.id), pages[1], 'same cursor -> same page');
    }
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  const flat = pages.flat();
  assert.equal(new Set(flat).size, flat.length, 'no lead repeats across pages');
  const one = await search(S.rep1, { limit: flat.length }, 'search: page');
  assert.deepEqual(one.body.items.map((i) => i.id), flat, 'pages concatenate to one big page');
});

test('3 unallocated lead: view only (note 403); another rep\'s lead: 404', async () => {
  const p = await profile(S.rep1, S.unallocated);
  ok(p, 200, 'profile of an unallocated lead');
  assert.equal(p.body.allocation.current, null);
  assert.equal(p.body.permissions.canWrite, false);
  ok(await call('POST', `/api/leads/${S.unallocated}/notes`, { token: S.rep1.token, body: { text: 'nope' } }), 403, 'note on unallocated');
  ok(await call('POST', `/api/leads/${S.unallocated}/state`, { token: S.rep1.token, body: { checked: true } }), 403, 'state on unallocated');
  ok(await call('POST', `/api/leads/${S.unallocated}/contacts`, { token: S.rep1.token, body: { name: 'nope' } }), 403, 'contact on unallocated');

  ok(await profile(S.rep1, S.rep2Lead), 404, "rep1 reads rep2's lead");
  ok(await call('POST', `/api/leads/${S.rep2Lead}/notes`, { token: S.rep1.token, body: { text: 'nope' } }), 404, "note on rep2's lead");
  ok(await call('POST', `/api/leads/${S.rep2Lead}/contacts`, { token: S.rep1.token, body: { name: 'nope' } }), 404, "contact on rep2's lead");
  ok(await profile(S.rep1, '00000000-0000-4000-8000-000000000000'), 404, 'unknown lead');
  ok(await profile(S.manager, S.rep2Lead), 200, 'manager reads any lead');
});

test('4 own lead: note, call, checked; profile attribution; KPIs move', async () => {
  const id = S.life;
  ok(await call('POST', `/api/leads/${id}/state`, { token: S.rep1.token, body: { checked: false, serviced: false } }), 200, 'reset state');
  const k0 = await kpis(S.rep1);
  ok(k0, 200, 'kpis before');
  assert.equal(k0.body.team, undefined, 'reps get no team KPIs');

  const text = `e2e note ${RUN_ID}`;
  const note = await call('POST', `/api/leads/${id}/notes`, { token: S.rep1.token, body: { text } });
  ok(note, 201, 'add note');
  assert.equal(note.body.note.userId, S.rep1.user.id);
  const contact = await call('POST', `/api/leads/${id}/contacts`, {
    token: S.rep1.token, body: { name: `E2E Contact ${RUN_ID}`, title: 'Owner', phone: '(555) 030-0000' },
  });
  ok(contact, 201, 'add contact');
  assert.equal(contact.body.contact.source, 'rep');
  S.repContact = contact.body.contact;
  const act = await call('POST', `/api/leads/${id}/activities`, {
    token: S.rep1.token, body: { type: 'call', outcome: 'connected', note: `call ${RUN_ID}` },
  });
  ok(act, 201, 'log call');
  assert.equal(act.body.state.serviced, true);
  const checked = await call('POST', `/api/leads/${id}/state`, { token: S.rep1.token, body: { checked: true } });
  ok(checked, 200, 'mark checked');
  assert.equal(checked.body.state.checked, true);

  const p = await profile(S.rep1, id);
  ok(p, 200, 'profile');
  const n = p.body.notes.find((x) => x.text === text);
  assert.ok(n, 'note in profile');
  assert.deepEqual(n.user, { id: S.rep1.user.id, name: S.rep1.user.name });
  const call1 = p.body.activity.find((a) => a.type === 'call' && a.text === `call ${RUN_ID}`);
  assert.ok(call1, 'call in activity');
  assert.equal(call1.user.id, S.rep1.user.id);
  assert.equal(call1.outcome, 'connected');
  assert.ok(p.body.activity.some((a) => a.type === 'checked' && a.user?.id === S.rep1.user.id), 'checked in activity');
  assert.ok(p.body.contacts.some((c) => c.id === S.repContact.id && c.source === 'rep'), 'rep contact in profile');
  assert.equal(p.body.state.mine.checked, true);
  assert.equal(p.body.state.mine.serviced, true);
  assert.equal(p.body.state.team.serviced, true);
  assert.ok(p.body.state.team.byUser.some((u) => u.user.id === S.rep1.user.id && u.checked && u.serviced), 'team.byUser has rep1');

  const k1 = await kpis(S.rep1);
  ok(k1, 200, 'kpis after');
  assert.equal(k1.body.mine.allocated, k0.body.mine.allocated);
  assert.equal(k1.body.mine.unserviced, k0.body.mine.unserviced - 1, 'unserviced -1');
  assert.equal(k1.body.mine.unchecked, k0.body.mine.unchecked - 1, 'unchecked -1');
  S.kpiAfterCheck = k1.body.mine;

  const unchecked = await searchAll(S.rep1, { scope: 'mine', unchecked: 'me' });
  assert.ok(!unchecked.items.some((i) => i.id === id), "checked lead left unchecked 'me'");
});

test('5 override: current version 200, stale version 409 {current, changedBy, changedAt}', async () => {
  const id = S.life;
  const before = await profile(S.rep1, id);
  ok(before, 200, 'profile');
  const seen = before.body.version;
  S.overridePhone = `(555) 010-${String(Date.now() % 10000).padStart(4, '0')}`;
  const put = await call('PUT', `/api/leads/${id}/overrides/phone`, { token: S.rep1.token, body: { value: S.overridePhone, version: seen } });
  ok(put, 200, 'override with current version');
  S.overridden = id;
  assert.ok(put.body.companyVersion > seen, 'version bumped');

  const p = await profile(S.rep1, id);
  assert.equal(p.body.fields.phone.value, S.overridePhone);
  assert.equal(p.body.fields.phone.overridden, true);
  assert.equal(p.body.fields.phone.sourceChangedSinceEdit, false);
  assert.equal(p.body.fields.phone.editedBy.id, S.rep1.user.id);
  assert.equal(p.body.version, put.body.companyVersion);

  const stale = await call('PUT', `/api/leads/${id}/overrides/phone`, { token: S.rep1.token, body: { value: '(555) 999-0000', version: seen } });
  ok(stale, 409, 'override with stale version');
  assert.equal(typeof stale.body.current, 'object');
  assert.equal(stale.body.current.version, put.body.companyVersion);
  assert.equal(stale.body.current.value, S.overridePhone);
  assert.equal(stale.body.changedBy?.id, S.rep1.user.id);
  assert.ok(!Number.isNaN(Date.parse(stale.body.changedAt)), 'changedAt is a timestamp');
  const after = await profile(S.rep1, id);
  assert.equal(after.body.fields.phone.value, S.overridePhone, 'stale write changed nothing');
});

test('6 pipeline re-scrape (upsert_contractors): SSE lead.updated, override kept, sourceChangedSinceEdit, unchecked again', async () => {
  const id = S.life;
  assert.ok(isUuid(id));
  const before = await profile(S.rep1, id);
  ok(before, 200, 'profile');
  const reputation = before.body.systemTags.find((t) => t.key === 'reputation')?.value;
  S.newRating = reputation === 'mixed' ? 4.9 : 4.0;
  S.expectReputation = S.newRating === 4.0 ? 'mixed' : 'excellent';
  const scraped = `(555) 020-${String(Date.now() % 10000).padStart(4, '0')}`;

  // The pipeline's own write path (Repository.upsert_contractors), as a GAF re-scrape reporting a new phone
  // number and rating would: content hash, audit, material-change stamp, outbox event, all in one transaction.
  S.replayAt = Date.now();
  const out = await pipeline(['replay', id, '--set', `gaf_phone=${JSON.stringify(scraped)}`, '--set', `gaf_rating=${S.newRating}`],
    `pipeline: re-scrape one listing (${PIPELINE_MODE})`);
  S.restoreListing = { id, previous: out.previous };
  Object.assign(S, { replayRunId: out.run_id, scrapedPhone: scraped });
  assert.equal(out.counts.changed, 1, `listing changed: ${JSON.stringify(out.counts)}`);
  assert.ok(out.version > before.body.version, 'version bumped by the trigger');

  const msg = await S.sse1.waitFor((m) => m.event === 'lead.updated' && eventCompanyIds(m).includes(id)
    && m.data.payload?.actor_type === 'pipeline' && m.data.payload?.run_id === out.run_id, SSE_DEADLINE_MS);
  record('pipeline commit -> SSE lead.updated (rep1)', Math.max(0, msg.wall - out.committed_at_ms));
  assert.equal(msg.data.payload.version, out.version);
  assert.equal(msg.data.payload.material, true);
  assert.ok(['phone', 'rating'].every((f) => msg.data.payload.fields.includes(f)), `fields ${msg.data.payload.fields}`);
  const done = await S.sse1.waitFor((m) => m.event === 'pipeline.run_completed' && m.data.payload?.run_id === out.run_id, SSE_DEADLINE_MS);
  assert.ok(eventCompanyIds(done).includes(id), 'run_completed lists the lead');
  S.pipelineMsgId = msg.id;

  const p = await profile(S.rep1, id);
  ok(p, 200, 'profile after the re-scrape');
  assert.equal(p.body.version, out.version);
  assert.equal(p.body.fields.phone.value, S.overridePhone, 'override kept');
  assert.equal(p.body.fields.phone.overridden, true);
  assert.equal(p.body.fields.phone.scraped, scraped);
  assert.equal(p.body.fields.phone.sourceChangedSinceEdit, true);
  assert.equal(p.body.details.rating, S.newRating);
  assert.equal(p.body.state.mine.checked, false, 'material change resets checked');
  assert.equal(p.body.state.mine.serviced, true, 'serviced survives');
  assert.equal(p.body.systemTags.find((t) => t.key === 'reputation')?.value, reputation, 'tags wait for the tag job');
  const change = p.body.activity.find((a) => a.type === 'scraped_change' && a.fieldDiff?.run_id === out.run_id);
  assert.equal(change?.actorType, 'pipeline', 'the re-scrape is in the lead history');
  const kept = p.body.contacts.find((c) => c.id === S.repContact.id);
  assert.deepEqual([kept?.source, kept?.name.value, kept?.version], ['rep', S.repContact.name, S.repContact.version],
    "the pipeline leaves a rep's contact alone");

  const k = await poll(() => kpis(S.rep1), (r) => r.body?.mine?.unchecked === S.kpiAfterCheck.unchecked + 1);
  assert.equal(k.body.mine.unchecked, S.kpiAfterCheck.unchecked + 1, 'KPI unchecked +1 after the material change (cache invalidated)');
});

test('7 pipeline tag job (jobs table + worker loop): tags follow the new rating, SSE to all, team KPIs refreshed', async () => {
  const id = S.life;
  const before = await profile(S.rep1, id);
  const out = await pipeline(['tag-job', '--requested-by', S.manager.user.id], `pipeline: tag job, all leads (${PIPELINE_MODE})`);
  const runId = out.result.tag.run_id;
  assert.ok(out.result.tag.tagged > 0, `tagged ${out.result.tag.tagged}`);

  const msg = await S.sse1.waitFor((m) => m.event === 'lead.updated' && eventCompanyIds(m).includes(id)
    && m.data.payload?.actor_type === 'pipeline' && m.data.payload?.run_id === runId, SSE_DEADLINE_MS);
  record('tag job start -> SSE lead.updated (rep1)', Math.max(0, msg.wall - out.started_at_ms));
  const done1 = await S.sse1.waitFor((m) => m.event === 'pipeline.run_completed' && m.data.payload?.run_id === runId, SSE_DEADLINE_MS);
  const done2 = await S.sse2.waitFor((m) => m.event === 'pipeline.run_completed' && m.data.payload?.run_id === runId, SSE_DEADLINE_MS);
  assert.ok(eventCompanyIds(done1).includes(id), "rep1's run_completed lists the lead");
  assert.ok(!eventCompanyIds(done2).some((cid) => S.ownIds.has(cid)), "rep2's run_completed lists none of rep1's leads");

  const p = await profile(S.rep1, id);
  ok(p, 200, 'profile after the tag job');
  assert.ok(p.body.version > before.body.version, 'tag change bumped the version');
  const rep = p.body.systemTags.find((t) => t.key === 'reputation');
  assert.equal(rep?.value, S.expectReputation, `reputation tag recomputed: ${JSON.stringify(rep)}`);
  assert.match(rep.reason, new RegExp(`rating ${S.newRating}`), 'reason names the new rating');
  assert.equal(rep.source, 'gaf');
  assert.equal(p.body.fields.phone.value, S.overridePhone, 'override still kept');
  assert.equal(p.body.fields.phone.sourceChangedSinceEdit, true);

  // run_completed makes the relay refresh team_dashboard_kpis; the manager's rep1 row then equals rep1's live KPIs.
  const mine = (await kpis(S.rep1)).body.mine;
  const team = await poll(() => kpis(S.manager), (r) => {
    const row = r.body?.team?.reps?.find((x) => x.repId === S.rep1.user.id);
    return row && Date.parse(r.body.team.refreshedAt) >= out.committed_at_ms - 1000 && row.unchecked === mine.unchecked;
  }, 10_000);
  const row = team.body.team.reps.find((x) => x.repId === S.rep1.user.id);
  assert.ok(Date.parse(team.body.team.refreshedAt) >= out.committed_at_ms - 1000, `team KPIs refreshed after the run (${team.body.team.refreshedAt})`);
  for (const k of ['allocated', 'unchecked', 'unserviced', 'updated_in_last_poll']) {
    assert.equal(row[k], mine[k], `team view ${k} for rep1 = rep1's live ${k}`);
  }
});

test("8 SSE visibility: rep2 never receives events for rep1's leads", async () => {
  const note = await call('POST', `/api/leads/${S.rep2Lead}/notes`, { token: S.manager.token, body: { text: `mgr ${RUN_ID}` } });
  ok(note, 201, "manager note on rep2's lead");
  await S.sse2.waitFor((m) => m.event === 'note.added' && eventCompanyIds(m).includes(S.rep2Lead), SSE_DEADLINE_MS);
  assert.ok(S.sse1.events.length > 0, 'rep1 received events');
  const leaked = S.sse2.events.filter((m) => eventCompanyIds(m).some((cid) => S.ownIds.has(cid)));
  assert.deepEqual(leaked.map((m) => `${m.event} ${eventCompanyIds(m)}`), [], "rep2 saw rep1's leads");
  assert.ok(!S.sse2.events.some((m) => m.id === S.pipelineMsgId), 'rep2 did not get the pipeline update');
  assert.ok(!S.sse1.events.some((m) => eventCompanyIds(m).includes(S.rep2Lead)), "rep1 saw rep2's lead");
});

test('9 manager bulk-allocates by filter to rep2: rep1 loses access, history recorded, notes stay', async () => {
  const [m1, m2] = [S.move1, S.move2];
  const text = `before move ${RUN_ID}`;
  ok(await call('POST', `/api/leads/${m1}/notes`, { token: S.rep1.token, body: { text } }), 201, 'rep1 note before move');
  const tag = await call('POST', '/api/custom-tags', { token: S.manager.token, body: { name: `e2e-move-${RUN_ID}` } });
  ok(tag, 201, 'manager creates tag');
  S.moveTagId = tag.body.tag.id;
  for (const id of [m1, m2]) {
    ok(await call('POST', `/api/leads/${id}/custom-tags`, { token: S.manager.token, body: { tagId: tag.body.tag.id } }), 201, 'tag lead');
  }
  const filter = { scope: { repId: S.rep1.user.id }, customTags: [tag.body.tag.name] };
  const preview = await search(S.manager, filter);
  assert.deepEqual(preview.body.items.map((i) => i.id).sort(), [m1, m2].sort(), 'filter selects the two leads');

  const [k1, k2] = await Promise.all([kpis(S.rep1), kpis(S.rep2)]);
  const res = await call('POST', '/api/allocations/by-filter', { token: S.manager.token, body: { filter, repId: S.rep2.user.id } });
  ok(res, 200, 'allocate by filter');
  const allocatedAt = Date.now();
  S.moved = [m1, m2];
  assert.equal(res.body.matched, 2);
  assert.deepEqual(res.body.allocated.map((a) => a.companyId).sort(), [m1, m2].sort());
  for (const a of res.body.allocated) assert.equal(a.previousRepId, S.rep1.user.id);

  await S.sse1.waitFor((m) => m.event === 'lead.allocated' && eventCompanyIds(m).includes(m1), SSE_DEADLINE_MS);
  await S.sse2.waitFor((m) => m.event === 'lead.allocated' && eventCompanyIds(m).includes(m1), SSE_DEADLINE_MS);

  // Contract: a lead allocated to another rep is invisible to rep1, so writes are 404 (not 403).
  ok(await call('POST', `/api/leads/${m1}/notes`, { token: S.rep1.token, body: { text: 'after' } }), 404, 'rep1 note after move');
  ok(await call('POST', `/api/leads/${m2}/state`, { token: S.rep1.token, body: { checked: true } }), 404, 'rep1 state after move');
  ok(await profile(S.rep1, m1), 404, 'rep1 profile after move');
  const gone = await search(S.rep1, { customTags: [tag.body.tag.name] });
  ok(gone, 200, 'rep1 search');
  assert.equal(gone.body.total, 0, 'moved leads left rep1 search');
  const theirs = await search(S.rep2, { scope: 'mine', customTags: [tag.body.tag.name] });
  assert.deepEqual(theirs.body.items.map((i) => i.id).sort(), [m1, m2].sort(), "in rep2's search");
  ok(await call('POST', `/api/leads/${m2}/notes`, { token: S.rep2.token, body: { text: `rep2 ${RUN_ID}` } }), 201, 'rep2 can write now');

  const p = await profile(S.manager, m1);
  ok(p, 200, 'manager profile');
  assert.equal(p.body.allocation.current.rep.id, S.rep2.user.id);
  assert.equal(p.body.allocation.current.allocatedBy.id, S.manager.user.id);
  const ended = p.body.allocation.history.find((h) => h.rep.id === S.rep1.user.id && h.endedAt);
  assert.ok(ended, 'ended rep1 allocation in history');
  assert.equal(ended.endedBy.id, S.manager.user.id);
  assert.ok(p.body.notes.some((n) => n.text === text && n.user.id === S.rep1.user.id), 'rep1 note stayed with the lead');
  assert.ok(p.body.activity.some((a) => a.type === 'allocation' && a.user?.id === S.manager.user.id), 'allocation activity');
  const p2 = await profile(S.rep2, m1);
  assert.ok(p2.body.notes.some((n) => n.text === text), 'new owner sees the old note');

  const [a1, a2] = await Promise.all([kpis(S.rep1), kpis(S.rep2)]);
  assert.equal(a1.body.mine.allocated, k1.body.mine.allocated - 2, 'rep1 allocated -2');
  assert.equal(a2.body.mine.allocated, k2.body.mine.allocated + 2, 'rep2 allocated +2');

  // lead.allocated makes the relay refresh team_dashboard_kpis (debounced, no pipeline run): within the 5 s target.
  const teamRow = (r) => r.body?.team?.reps?.find((x) => x.repId === S.rep2.user.id);
  const team = await poll(() => kpis(S.manager), (r) => teamRow(r)?.allocated === a2.body.mine.allocated,
    Math.max(250, allocatedAt + SSE_DEADLINE_MS - Date.now()));
  assert.equal(teamRow(team)?.allocated, a2.body.mine.allocated, 'team KPIs show the allocation within 5 s');
});

test('10 custom tag and custom field: write with version, filterable', async () => {
  const id = S.tagged;
  const name = `e2e-${RUN_ID}`;
  const tag = await call('POST', '/api/custom-tags', { token: S.rep1.token, body: { name } });
  ok(tag, 201, 'create custom tag');
  assert.equal(tag.body.created, true);
  const again = await call('POST', '/api/custom-tags', { token: S.rep1.token, body: { name: name.toUpperCase() } });
  ok(again, 200, 'same name, other case');
  assert.equal(again.body.tag.id, tag.body.tag.id);
  const link = await call('POST', `/api/leads/${id}/custom-tags`, { token: S.rep1.token, body: { tagId: tag.body.tag.id } });
  ok(link, 201, 'attach tag');
  S.customTag = { id, tagId: tag.body.tag.id };

  for (const ref of [name, tag.body.tag.id]) {
    const r = await search(S.rep1, { customTags: [ref] }, 'search: customTags');
    assert.deepEqual(r.body.items.map((i) => i.id), [id], `customTags [${ref}]`);
    assert.ok(r.body.items[0].customTags.some((t) => t.id === tag.body.tag.id));
  }
  const p = await profile(S.rep1, id);
  const ct = p.body.customTags.find((t) => t.id === tag.body.tag.id);
  assert.ok(ct, 'tag on profile');
  assert.equal(ct.addedBy.id, S.rep1.user.id);

  const value = Date.now() % 1_000_000;
  const put = await call('PUT', `/api/leads/${id}/custom-fields/e2e_score`, { token: S.rep1.token, body: { value, version: p.body.version } });
  ok(put, 200, 'custom field with current version');
  assert.equal(put.body.version, p.body.version + 1);
  const stale = await call('PUT', `/api/leads/${id}/custom-fields/e2e_score`, { token: S.rep1.token, body: { value: 1, version: p.body.version } });
  ok(stale, 409, 'custom field with stale version');
  assert.equal(stale.body.current.version, put.body.version);
  assert.equal(stale.body.current.value, value);
  assert.ok(stale.body.changedAt);

  const eq = await search(S.rep1, { customFields: [{ key: 'e2e_score', op: 'eq', value }] }, 'search: customFields');
  assert.deepEqual(eq.body.items.map((i) => i.id), [id], 'customFields eq');
  const gte = await search(S.rep1, { scope: 'mine', customFields: [{ key: 'e2e_score', op: 'gte', value }] }, 'search: customFields');
  assert.ok(gte.body.items.some((i) => i.id === id), 'customFields gte');
  const miss = await search(S.rep1, { customFields: [{ key: 'e2e_score', op: 'eq', value: value + 1 }] }, 'search: customFields');
  assert.ok(!miss.body.items.some((i) => i.id === id), 'customFields eq other value');
  const p2 = await profile(S.rep1, id);
  assert.equal(p2.body.customFields.e2e_score, value);
});

test('11 refresh: same area merges; hourly limit -> 429 with Retry-After', async (t) => {
  // The jobs are real: a running worker would scrape these areas live, so the shared stack's worker must be stopped.
  if (DB_NAME === 'leadmaker' && process.env.E2E_ALLOW_WORKER !== '1') {
    assert.deepEqual(composeContainers('worker'), [], 'stop the compose worker first (compose.sh does), or set E2E_ALLOW_WORKER=1');
  }
  S.refreshJobs = [];
  const area = { postal_code: process.env.E2E_REFRESH_ZIP || '00000', radius_miles: 5 };
  const first = await call('POST', '/api/refresh', { token: S.rep3.token, body: area });
  if (first.status === 429) {
    t.diagnostic('rep3 already at the hourly limit with no open job for the area: merge not checked');
  } else {
    assert.ok([200, 202].includes(first.status), `first refresh: ${first.status} ${JSON.stringify(first.body)}`);
    S.refreshJobs.push(first.body.job.id);
    const second = await call('POST', '/api/refresh', { token: S.rep3.token, body: area });
    ok(second, 200, 'second refresh, same area');
    assert.equal(second.body.merged, true);
    assert.equal(second.body.job.id, first.body.job.id, 'merged into the same job');
  }
  const max = Number(process.env.E2E_REFRESH_MAX || 60);
  const base = Date.now() % 9000;
  let limited = first.status === 429 ? first : null;
  let created = 0;
  for (let i = 0; !limited && i < max; i++) {
    const zip = `0${String((base + i) % 10000).padStart(4, '0')}`;
    const r = await call('POST', '/api/refresh', { token: S.rep3.token, body: { postal_code: zip, radius_miles: 3 } });
    if (r.status === 429) limited = r;
    else {
      assert.ok([200, 202].includes(r.status), `refresh ${zip}: ${r.status} ${JSON.stringify(r.body)}`);
      created += r.status === 202 ? 1 : 0;
      S.refreshJobs.push(r.body.job.id);
    }
  }
  assert.ok(limited, `no 429 after ${max} distinct areas`);
  t.diagnostic(`429 after ${created} new jobs; limit ${limited.body?.details?.limit}`);
  assert.equal(limited.body.error, 'rate_limited');
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/, 'Retry-After in seconds');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('12 reps cannot call manager endpoints', async () => {
  const rep = { token: S.rep1.token };
  ok(await call('GET', '/api/users', rep), 403, 'GET /api/users');
  ok(await call('GET', '/api/allocations/suggestions', rep), 403, 'GET /api/allocations/suggestions');
  ok(await call('POST', '/api/allocations', { ...rep, body: { companyIds: [S.unallocated], repId: S.rep1.user.id } }), 403, 'POST /api/allocations');
  ok(await call('POST', '/api/allocations/by-filter', { ...rep, body: { filter: { scope: 'unallocated' }, repId: S.rep1.user.id } }), 403, 'POST /api/allocations/by-filter');
  ok(await call('DELETE', `/api/allocations/${S.ryw}`, rep), 403, 'DELETE /api/allocations/:id');
  const p = await profile(S.rep1, S.unallocated);
  assert.equal(p.body.allocation.current, null, 'unallocated lead still unallocated');
  const users = await call('GET', '/api/users', { token: S.manager.token });
  ok(users, 200, 'manager GET /api/users');
  assert.ok(users.body.items.some((u) => u.id === S.rep1.user.id));
  const k = await kpis(S.manager);
  ok(k, 200, 'manager kpis');
  assert.ok(Array.isArray(k.body.team?.reps), 'managers get team KPIs');
});

test('13 read-your-writes: the next read after a write reflects it', async () => {
  const id = S.ryw;
  const p0 = await profile(S.rep1, id);
  ok(p0, 200, 'profile');
  await profile(S.rep1, id);
  const filter = { scope: 'mine', text: p0.body.fields.business_name.value };
  await search(S.rep1, filter, 'search: warm cache');
  await search(S.rep1, filter, 'search: warm cache');

  const text = `ryw ${RUN_ID}`;
  ok(await call('POST', `/api/leads/${id}/notes`, { token: S.rep1.token, body: { text } }), 201, 'note');
  const p1 = await profile(S.rep1, id);
  assert.ok(p1.body.notes.some((n) => n.text === text), 'note visible on the very next profile read');

  const city = `E2E City ${RUN_ID}`;
  const put = await call('PUT', `/api/leads/${id}/overrides/city`, { token: S.rep1.token, body: { value: city, version: p1.body.version } });
  ok(put, 200, 'override city');
  const s = await search(S.rep1, filter, 'search: after write');
  const item = s.body.items.find((i) => i.id === id);
  assert.ok(item, 'lead still in search');
  assert.equal(item.city, city, 'search shows the override immediately');
  assert.equal(item.version, put.body.companyVersion);
  const p2 = await profile(S.rep1, id);
  assert.equal(p2.body.fields.city.value, city);
  assert.equal(p2.body.version, put.body.companyVersion);

  const del = await call('DELETE', `/api/leads/${id}/overrides/city?version=${put.body.companyVersion}`, { token: S.rep1.token });
  ok(del, 200, 'clear override');
  const p3 = await profile(S.rep1, id);
  assert.equal(p3.body.fields.city.overridden, false, 'cleared override visible immediately');
});

test("14 rep contact: create on an own lead, override it with its version; pool lead 403, another rep's lead 404", async () => {
  const id = S.contactLead;
  const name = `E2E Person ${RUN_ID}`;
  const created = await call('POST', `/api/leads/${id}/contacts`, {
    token: S.rep1.token, body: { name, title: 'Office Manager', email: `e2e-${RUN_ID}@example.com` },
  });
  ok(created, 201, 'create contact on an own lead');
  const contact = created.body.contact;
  S.contacts.push({ id: contact.id, leadId: id });
  assert.ok(isUuid(contact.id));
  assert.deepEqual([contact.source, contact.companyId, contact.name, contact.title], ['rep', id, name, 'Office Manager']);
  assert.ok(Number.isInteger(contact.version), 'contact has a version');

  const p = await profile(S.rep1, id);
  ok(p, 200, 'profile');
  assert.equal(p.body.version, created.body.version, 'profile at the lead version the create returned');
  const shown = p.body.contacts.find((c) => c.id === contact.id);
  assert.ok(shown, 'contact in the profile');
  assert.deepEqual([shown.source, shown.name.value, shown.title.value, shown.title.overridden, shown.version],
    ['rep', name, 'Office Manager', false, contact.version]);

  const title = `Owner ${RUN_ID}`;
  const put = await call('PUT', `/api/contacts/${contact.id}/overrides/title`, { token: S.rep1.token, body: { value: title, version: contact.version } });
  ok(put, 200, 'override the contact title with its version');
  assert.equal(put.body.contactVersion, contact.version + 1, 'contact version bumped');
  assert.ok(put.body.companyVersion > created.body.version, 'lead version bumped');
  const stale = await call('PUT', `/api/contacts/${contact.id}/overrides/title`, { token: S.rep1.token, body: { value: 'Stale', version: contact.version } });
  ok(stale, 409, 'override with the stale contact version');
  assert.equal(stale.body.current?.value, title);

  const p2 = await profile(S.rep1, id);
  const edited = p2.body.contacts.find((c) => c.id === contact.id);
  assert.deepEqual([edited.title.value, edited.title.scraped, edited.title.overridden, edited.title.editedBy?.id, edited.version],
    [title, 'Office Manager', true, S.rep1.user.id, put.body.contactVersion]);
  assert.equal(edited.name.value, name, 'other fields untouched');

  const body = { name: `Nope ${RUN_ID}` };
  ok(await call('POST', `/api/leads/${S.unallocated}/contacts`, { token: S.rep1.token, body }), 403, 'create on an unallocated lead');
  ok(await call('POST', `/api/leads/${S.rep2Lead}/contacts`, { token: S.rep1.token, body }), 404, "create on rep2's lead");
  ok(await call('PUT', `/api/contacts/${contact.id}/overrides/title`, { token: S.rep2.token, body: { value: 'x', version: put.body.contactVersion } }),
    404, "rep2 overrides rep1's contact");
});

const SIGNAL_LISTS = { alerts: 'active_alert', stormHistory: 'storm_history', news: 'news' };

/** Checks a SignalsResponse; returns its counties as countyFips -> leadCount. */
function checkSignals(body, scope) {
  assert.equal(body.scope, scope, 'scope echoed');
  assert.ok(isIso(body.generatedAt), 'generatedAt');
  assert.ok(Array.isArray(body.counties), 'counties');
  const counties = new Map();
  for (const c of body.counties) {
    assert.match(c.countyFips, /^\d{5}$/);
    assert.ok(Number.isInteger(c.leadCount) && c.leadCount > 0, `leadCount ${c.leadCount}`);
    assert.ok(!counties.has(c.countyFips), `county ${c.countyFips} listed once`);
    counties.set(c.countyFips, c.leadCount);
  }
  const slack = 120_000;  // answers are cached for up to 60 s
  for (const [list, kind] of Object.entries(SIGNAL_LISTS)) {
    assert.ok(Array.isArray(body[list]), `${list} is an array`);
    for (const s of body[list]) {
      assert.equal(s.kind, kind, `${list} holds ${kind}`);
      assert.ok(counties.has(s.countyFips), `${scope} ${list} ${s.id} is for county ${s.countyFips}, not one of the scope's`);
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.source, 'string');
      assert.ok(s.payload && typeof s.payload === 'object' && !Array.isArray(s.payload), 'payload object');
      assert.ok((s.validFrom === null || isIso(s.validFrom)) && (s.validTo === null || isIso(s.validTo)) && isIso(s.fetchedAt), 'timestamps');
      assert.equal(typeof s.active, 'boolean');
      assert.equal(typeof s.expired, 'boolean');
    }
  }
  const sortAt = (s) => Date.parse(s.validFrom ?? s.fetchedAt);
  for (const list of ['alerts', 'news']) {
    for (let i = 1; i < body[list].length; i++) assert.ok(sortAt(body[list][i - 1]) >= sortAt(body[list][i]), `${list} newest first`);
  }
  for (const s of body.alerts) assert.ok(s.validTo === null || Date.parse(s.validTo) > Date.now() - 7 * 86_400_000 - slack, `alert ${s.id} ended > 7 days ago`);
  for (const s of body.news) assert.ok(sortAt(s) > Date.now() - 30 * 86_400_000 - slack, `news ${s.id} older than 30 days`);
  for (const s of body.stormHistory) assert.deepEqual([s.active, s.expired], [true, false], 'storm summaries are current');
  assert.equal(new Set(body.stormHistory.map((s) => s.countyFips)).size, body.stormHistory.length, 'one storm summary per county');
  return counties;
}

const byCounty = (items) => items.reduce((m, i) => (i.countyFips ? m.set(i.countyFips, (m.get(i.countyFips) ?? 0) + 1) : m), new Map());
const sortedEntries = (m) => [...m].sort(([a], [b]) => a.localeCompare(b));

test('15 signals: rep1 mine vs pool, manager all; SignalsResponse shape; counties follow the leads', async (t) => {
  const get = (who, scope) => call('GET', `/api/signals${scope ? `?scope=${scope}` : ''}`, { token: who.token, step: `GET /api/signals?scope=${scope ?? ''}` });
  const rs = { mine: await get(S.rep1, 'mine'), pool: await get(S.rep1, 'pool'), repAll: await get(S.rep1, 'all'), all: await get(S.manager, 'all') };
  for (const [k, r] of Object.entries(rs)) ok(r, 200, `signals ${k}`);
  const mine = checkSignals(rs.mine.body, 'mine');
  const pool = checkSignals(rs.pool.body, 'pool');
  const repAll = checkSignals(rs.repAll.body, 'all');
  const all = checkSignals(rs.all.body, 'all');
  assert.equal((await get(S.rep1)).body.scope, 'mine', "a rep's default scope");
  assert.equal((await get(S.manager)).body.scope, 'all', "a manager's default scope");
  ok(await get(S.rep1, 'everything'), 400, 'unknown scope');
  ok(await call('GET', '/api/signals', {}), 401, 'no token');

  const [own, unallocated, everything] = await Promise.all([
    searchAll(S.rep1, { scope: 'mine' }), searchAll(S.rep1, { scope: 'unallocated' }), searchAll(S.manager, {}),
  ]);
  const ownC = byCounty(own.items);
  const poolC = byCounty(unallocated.items);
  for (const c of mine.keys()) assert.ok(ownC.has(c), `rep1's signals county ${c} has none of rep1's leads`);
  for (const c of pool.keys()) assert.ok(poolC.has(c), `pool signals county ${c} has no unallocated lead`);
  for (const c of new Set([...mine.keys(), ...pool.keys()])) {
    assert.equal(repAll.get(c), (mine.get(c) ?? 0) + (pool.get(c) ?? 0), `rep1 'all' in ${c} = mine + pool`);
    assert.ok(all.get(c) >= repAll.get(c), `manager 'all' in ${c} covers rep1's view`);
  }
  assert.deepEqual([...repAll.keys()].filter((c) => !mine.has(c) && !pool.has(c)), [], "rep1 'all' has only mine and pool counties");
  assert.ok(mine.size > 0 && all.size >= mine.size, 'counties present');

  // Exact counts when nothing came from the 60 s cache (an allocation since then would make a cached answer stale).
  const fresh = Object.values(rs).every((r) => r.headers.get('x-cache') === 'miss');
  if (fresh && own.complete && unallocated.complete && everything.complete) {
    assert.deepEqual(sortedEntries(mine), sortedEntries(ownC), "rep1 'mine' counties and counts = rep1's leads");
    assert.deepEqual(sortedEntries(pool), sortedEntries(poolC), "'pool' counties and counts = the unallocated leads");
    assert.deepEqual(sortedEntries(all), sortedEntries(byCounty(everything.items)), "manager 'all' = every lead");
  } else {
    t.diagnostic(`exact county counts not compared (x-cache ${Object.values(rs).map((r) => r.headers.get('x-cache'))})`);
  }
});

test('16 catalogs: GET /api/custom-tags and /api/custom-fields/keys count a tag and a field the test adds', async () => {
  const leads = [S.cat1, S.cat2];
  const name = `e2e-cat-${RUN_ID}`;
  const created = await call('POST', '/api/custom-tags', { token: S.rep1.token, body: { name } });
  ok(created, 201, 'create tag');
  const tagId = created.body.tag.id;
  S.catTag = { id: tagId, leads: [] };
  const tagRow = async (who) => {
    const r = await call('GET', '/api/custom-tags', { token: who.token });
    ok(r, 200, 'GET /api/custom-tags');
    assert.ok(Array.isArray(r.body.items));
    return r.body.items.find((i) => i.id === tagId);
  };
  const fresh = await tagRow(S.rep1);
  assert.ok(fresh, 'new tag listed');
  assert.deepEqual([fresh.name, fresh.createdBy, fresh.leadCount], [name, { id: S.rep1.user.id, name: S.rep1.user.name }, 0]);
  assert.ok(isIso(fresh.createdAt));
  for (const id of leads) {
    ok(await call('POST', `/api/leads/${id}/custom-tags`, { token: S.rep1.token, body: { tagId } }), 201, 'attach tag');
    S.catTag.leads.push(id);
  }
  assert.equal((await tagRow(S.rep1)).leadCount, 2, "rep1's count");
  assert.equal((await tagRow(S.manager)).leadCount, 2, "manager's count");
  assert.equal((await tagRow(S.rep2)).leadCount, 0, "rep2 sees the tag but none of rep1's leads");

  const key = `e2e_k_${RUN_ID}`;
  S.catField = { key, leads: [] };
  for (const [i, id] of leads.entries()) {
    const p = await profile(S.rep1, id);
    ok(await call('PUT', `/api/leads/${id}/custom-fields/${key}`, { token: S.rep1.token, body: { value: i + 1, version: p.body.version } }),
      200, 'set custom field');
    S.catField.leads.push(id);
  }
  const keyRow = async (who) => {
    const r = await call('GET', '/api/custom-fields/keys', { token: who.token });
    ok(r, 200, 'GET /api/custom-fields/keys');
    assert.ok(Array.isArray(r.body.items));
    for (let i = 1; i < r.body.items.length; i++) assert.ok(r.body.items[i - 1].leadCount >= r.body.items[i].leadCount, 'most used first');
    return r.body.items.find((k) => k.key === key);
  };
  assert.deepEqual(await keyRow(S.rep1), { key, leadCount: 2, valueType: 'number' }, "rep1's key");
  assert.deepEqual(await keyRow(S.manager), { key, leadCount: 2, valueType: 'number' }, "manager's key");
  assert.equal(await keyRow(S.rep2), undefined, 'rep2 sees no lead with the key');

  const p = await profile(S.rep1, S.cat2);
  ok(await call('PUT', `/api/leads/${S.cat2}/custom-fields/${key}`, { token: S.rep1.token, body: { value: 'text', version: p.body.version } }),
    200, 'set a string value');
  assert.deepEqual(await keyRow(S.rep1), { key, leadCount: 2, valueType: 'mixed' }, 'number + string = mixed');
});

test('17 activity feed: the re-scrape is a pipeline row with a field diff; ?before= pages back without repeats', async () => {
  assert.ok(S.replayRunId, 'needs the re-scrape of test 6');
  const id = S.life;
  const feed = (who, q = '') => call('GET', `/api/leads/${id}/activity${q}`, { token: who.token, step: 'GET /api/leads/:id/activity' });
  const head = await feed(S.rep1, '?limit=100');
  ok(head, 200, 'activity');
  const change = head.body.items.find((a) => a.type === 'scraped_change' && a.fieldDiff?.run_id === S.replayRunId);
  assert.ok(change, `the re-scrape (run ${S.replayRunId}) is in the activity feed`);
  assert.deepEqual([change.actorType, change.actorLabel, change.user], ['pipeline', 'pipeline', null]);
  const diff = change.fieldDiff;
  assert.ok(['phone', 'rating'].every((f) => diff.fields.includes(f)), `fields ${diff.fields}`);
  assert.equal(diff.to.phone, S.scrapedPhone);
  assert.notEqual(diff.from.phone, S.scrapedPhone);
  assert.equal(Number(diff.to.rating), S.newRating);
  assert.ok(isIso(change.createdAt));

  const limit = 3;
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 6; i++) {
    const r = await feed(S.rep1, `?limit=${limit}${cursor ? `&before=${cursor}` : ''}`);
    ok(r, 200, `page ${i + 1}`);
    assert.ok(r.body.items.length <= limit);
    if (cursor) {
      const anchor = pages.flat().at(-1);
      for (const a of r.body.items) assert.ok(Date.parse(a.createdAt) <= Date.parse(anchor.createdAt), `${a.id} is not older than the cursor`);
    }
    pages.push(r.body.items);
    if (r.body.nextCursor) assert.equal(r.body.nextCursor, r.body.items.at(-1).id, 'nextCursor is the last entry');
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  const flat = pages.flat();
  assert.ok(pages.length >= 2, `paged (${flat.length} entries)`);
  assert.equal(new Set(flat.map((a) => a.id)).size, flat.length, 'no entry repeats across pages');
  for (let i = 1; i < flat.length; i++) assert.ok(Date.parse(flat[i - 1].createdAt) >= Date.parse(flat[i].createdAt), 'newest first');
  assert.deepEqual(flat.map((a) => a.id), head.body.items.slice(0, flat.length).map((a) => a.id), 'pages concatenate to one big page');

  const only = await feed(S.rep1, '?type=scraped_change&limit=100');
  ok(only, 200, 'type filter');
  assert.ok(only.body.items.every((a) => a.type === 'scraped_change') && only.body.items.some((a) => a.id === change.id), 'type=scraped_change');
  ok(await feed(S.rep1, '?before=not-a-cursor'), 400, 'malformed cursor');
  const other = (await call('GET', `/api/leads/${S.contactLead}/activity?limit=1`, { token: S.rep1.token })).body.items[0];
  ok(await feed(S.rep1, `?before=${other.id}`), 400, "another lead's entry as the cursor");
  ok(await feed(S.rep2), 404, "rep2 reads rep1's lead activity");
});

test('18 pool watchers: allocating a pool lead tells other reps it left the pool, not who got it', async () => {
  const id = S.poolWatched;
  S.sse3 = await new EventStream(S.rep3.token).open();
  ok(await profile(S.rep3, id), 200, 'rep3 views the pool lead');
  const t0 = Date.now();
  const res = await call('POST', '/api/allocations', { token: S.manager.token, body: { companyIds: [id], repId: S.rep2.user.id } });
  ok(res, 200, 'allocate a pool lead to rep2');
  S.poolAllocated.add(id);
  assert.deepEqual(res.body.allocated.map((a) => [a.companyId, a.previousRepId]), [[id, null]]);

  const allocated = (m) => m.event === 'lead.allocated' && m.wall >= t0 && eventCompanyIds(m).includes(id);
  const msg = await S.sse3.waitFor(allocated, SSE_DEADLINE_MS);
  record('allocation -> SSE lead.allocated (pool watcher)', msg.wall - t0);
  assert.equal(msg.data.payload?.left_pool, true, `left_pool on rep3's event: ${JSON.stringify(msg.data)}`);
  assert.ok(!JSON.stringify(msg.data).includes(S.rep2.user.id), `rep3's event names the new rep: ${JSON.stringify(msg.data)}`);
  const owner = await S.sse2.waitFor(allocated, SSE_DEADLINE_MS);
  assert.equal(owner.data.payload.assigned_rep_id, S.rep2.user.id, 'the new owner gets the full event');
  ok(await profile(S.rep3, id), 404, 'rep3 can no longer open it');

  ok(await call('DELETE', `/api/allocations/${id}`, { token: S.manager.token }), 200, 'back to the pool');
  S.poolAllocated.delete(id);
  ok(await profile(S.rep3, id), 200, 'rep3 views it again');
});

const NOTIFICATION_TYPES = ['allocated', 'reassigned_away', 'source_changed', 'manager_note', 'refresh_done', 'refresh_failed', 'pool_grew', 'storm_alert',
  'task_assigned', 'task_due'];
/** The payload of a notification.created SSE message, else null. */
const notice = (m) => (m.event === 'notification.created' ? m.data?.payload ?? null : null);
const isNotice = (m, userId, type, since) => {
  const p = notice(m);
  return !!p && p.user_id === userId && p.type === type && m.wall >= since;
};
const notifications = (who, q = '') => call('GET', `/api/notifications${q}`, { token: who.token, step: 'GET /api/notifications' });

async function allNotifications(who, maxPages = 20) {
  const items = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const r = await notifications(who, `?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    ok(r, 200, 'notifications page');
    items.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return items;
}

describe('19 notifications (services/notifier through the gateway)', () => {
  before(async () => {
    const probe = await notifications(S.rep2, '?limit=1');
    if (probe.status === 404 || probe.status === 502) {
      N.skip = `GET /api/notifications -> ${probe.status}: the notifier is not deployed behind this gateway (host mode may not run it yet)`;
      console.log(`# notifications block skipped: ${N.skip}`);
      return;
    }
    ok(probe, 200, 'GET /api/notifications');
    for (const k of ['items', 'nextCursor', 'unreadCount']) assert.ok(k in probe.body, `notifications response has ${k}`);
  });

  test('allocation: the new rep gets notification.created over SSE within 5 s and an unread feed row', async (t) => {
    if (N.skip) return t.skip(N.skip);
    const id = S.poolNotified;
    const t0 = Date.now();
    const res = await call('POST', '/api/allocations', { token: S.manager.token, body: { companyIds: [id], repId: S.rep2.user.id } });
    ok(res, 200, 'allocate a pool lead to rep2');
    S.poolAllocated.add(id);
    const msg = await S.sse2.waitFor((m) => isNotice(m, S.rep2.user.id, 'allocated', t0), SSE_DEADLINE_MS);
    record('allocation -> SSE notification.created (rep2)', msg.wall - t0);
    N.rep2Id = notice(msg).notification_id;
    assert.ok(isUuid(N.rep2Id), `notification_id ${N.rep2Id}`);

    const unread = await notifications(S.rep2, '?unread=1&limit=100');
    ok(unread, 200, 'unread notifications');
    const item = unread.body.items.find((i) => i.id === N.rep2Id);
    assert.ok(item, 'the notification is in the unread feed');
    assert.deepEqual([item.type, item.companyId, item.readAt], ['allocated', id, null]);
    assert.ok(item.title && typeof item.body === 'string', 'title and body');
    assert.ok(unread.body.unreadCount >= 1, `unreadCount ${unread.body.unreadCount}`);
  });

  test("isolation: rep1 never receives rep2's notification events and cannot read or mark rep2's rows", async (t) => {
    if (N.skip) return t.skip(N.skip);
    assert.ok(N.rep2Id, "needs rep2's notification");
    await sleep(500);
    const foreign = S.sse1.events.filter((m) => notice(m) && notice(m).user_id !== S.rep1.user.id);
    assert.deepEqual(foreign.map((m) => JSON.stringify(notice(m))), [], "rep1's stream carried other users' notifications");
    assert.ok(!(await allNotifications(S.rep1)).some((i) => i.id === N.rep2Id), "rep2's row in rep1's feed");
    const mark = await call('POST', '/api/notifications/read', { token: S.rep1.token, body: { ids: [N.rep2Id] } });
    assert.ok(mark.status < 300 || mark.status === 404, `rep1 marks rep2's row: ${mark.status} ${JSON.stringify(mark.body)}`);
    if (mark.status === 200 && 'updated' in mark.body) assert.equal(mark.body.updated, 0, "rep1 updated rep2's row");
    const still = await notifications(S.rep2, '?unread=1&limit=100');
    assert.ok(still.body.items.some((i) => i.id === N.rep2Id), "rep2's row is still unread");
  });

  test('mark read: unreadCount drops; {all: true} clears it', async (t) => {
    if (N.skip) return t.skip(N.skip);
    const before = await notifications(S.rep2, '?unread=1&limit=100');
    ok(before, 200, 'unread before');
    const r = await call('POST', '/api/notifications/read', { token: S.rep2.token, body: { ids: [N.rep2Id] } });
    ok(r, 200, 'mark one read');
    const after = await notifications(S.rep2, '?unread=1&limit=100');
    assert.ok(after.body.unreadCount < before.body.unreadCount, `unreadCount ${before.body.unreadCount} -> ${after.body.unreadCount}`);
    assert.ok(!after.body.items.some((i) => i.id === N.rep2Id), 'left the unread feed');
    if (typeof r.body?.unreadCount === 'number') assert.equal(r.body.unreadCount, after.body.unreadCount);
    const read = (await allNotifications(S.rep2)).find((i) => i.id === N.rep2Id);
    assert.ok(isIso(read?.readAt), `readAt ${read?.readAt}`);

    ok(await call('POST', '/api/notifications/read', { token: S.rep2.token, body: { all: true } }), 200, 'mark all read');
    const none = await notifications(S.rep2, '?unread=1');
    assert.deepEqual([none.body.unreadCount, none.body.items.length], [0, 0], 'nothing unread');
    ok(await call('POST', '/api/notifications/read', { token: S.rep2.token, body: {} }), 400, 'empty body');
  });

  test("manager note on a rep1 lead notifies rep1 ('manager_note')", async (t) => {
    if (N.skip) return t.skip(N.skip);
    const id = S.noteLead;
    const text = `manager note ${RUN_ID}`;
    const t0 = Date.now();
    ok(await call('POST', `/api/leads/${id}/notes`, { token: S.manager.token, body: { text } }), 201, 'manager note');
    const msg = await S.sse1.waitFor((m) => isNotice(m, S.rep1.user.id, 'manager_note', t0), SSE_DEADLINE_MS);
    record('manager note -> SSE notification.created (rep1)', msg.wall - t0);
    const nid = notice(msg).notification_id;
    const item = (await notifications(S.rep1, '?unread=1&limit=100')).body.items.find((i) => i.id === nid);
    assert.ok(item, 'unread in rep1 feed');
    assert.deepEqual([item.type, item.companyId], ['manager_note', id]);
    assert.ok(item.body.includes(text), `body quotes the note: ${item.body}`);
    assert.ok(!S.sse2.events.some((m) => notice(m)?.notification_id === nid), 'rep2 did not get it');
  });

  test("the re-scrape of a field rep1 overrode notified rep1 ('source_changed')", async (t) => {
    if (N.skip) return t.skip(N.skip);
    assert.ok(S.replayAt, 'needs the re-scrape of test 6');
    const msg = await S.sse1.waitFor((m) => isNotice(m, S.rep1.user.id, 'source_changed', S.replayAt), SSE_DEADLINE_MS);
    record('pipeline commit -> SSE notification.created source_changed (rep1)', Math.max(0, msg.wall - S.replayAt));
    const item = (await allNotifications(S.rep1)).find((i) => i.id === notice(msg).notification_id);
    assert.ok(item, 'in rep1 feed');
    assert.deepEqual([item.type, item.companyId], ['source_changed', S.life]);
    assert.match(JSON.stringify(item.data?.fields), /phone/, `names the field: ${JSON.stringify(item.data)}`);
  });

  test('preferences: a disabled type is suppressed; enabled again, it is delivered', async (t) => {
    if (N.skip) return t.skip(N.skip);
    const prefs = (body) => call(body ? 'PUT' : 'GET', '/api/notifications/preferences', { token: S.rep1.token, body });
    const enabled = (r) => r.body.items.find((i) => i.type === 'manager_note')?.enabled;
    const got = await prefs();
    ok(got, 200, 'GET preferences');
    assert.deepEqual(got.body.items.map((i) => i.type).sort(), [...NOTIFICATION_TYPES].sort(), 'one entry per type');
    N.prefs = got.body.items.map(({ type, enabled: on }) => ({ type, enabled: on }));
    ok(await prefs({ items: [{ type: 'no_such_type', enabled: false }] }), 400, 'unknown type');

    const off = await prefs({ items: [{ type: 'manager_note', enabled: false }] });
    ok(off, 200, 'disable manager_note');
    assert.equal(enabled(off), false);
    assert.equal(enabled(await prefs()), false, 'persisted');
    const t0 = Date.now();
    ok(await call('POST', `/api/leads/${S.noteLead}/notes`, { token: S.manager.token, body: { text: `muted ${RUN_ID}` } }), 201, 'manager note');
    await S.sse1.waitFor((m) => m.event === 'note.added' && m.wall >= t0 && eventCompanyIds(m).includes(S.noteLead), SSE_DEADLINE_MS);
    await assert.rejects(S.sse1.waitFor((m) => isNotice(m, S.rep1.user.id, 'manager_note', t0), SSE_DEADLINE_MS),
      /no matching SSE event/, 'a disabled type was delivered');

    const on = await prefs({ items: [{ type: 'manager_note', enabled: true }] });
    ok(on, 200, 'enable manager_note');
    assert.equal(enabled(on), true);
    const t1 = Date.now();
    ok(await call('POST', `/api/leads/${S.noteLead}/notes`, { token: S.manager.token, body: { text: `unmuted ${RUN_ID}` } }), 201, 'manager note');
    await S.sse1.waitFor((m) => isNotice(m, S.rep1.user.id, 'manager_note', t1), SSE_DEADLINE_MS);
  });
});

test('20 role freshness: a demoted manager loses manager endpoints within USER_ROLE_TTL_SECONDS', async (t) => {
  if (SHARED_DEMO_DB) return t.skip('demotes the manager: private stacks only (E2E_DB/E2E_COMPOSE_PROJECT name the shared demo database)');
  const ttl = roleTtlSeconds();
  const mgr = { token: S.manager.token };
  ok(await call('GET', '/api/users', mgr), 200, 'manager GET /api/users (role cached as manager)');
  S.demoted = true;
  psql(`UPDATE users SET role = 'rep' WHERE id = '${S.manager.user.id}';`, 'psql: demote manager');
  const t0 = Date.now();
  let failure = null;
  try {
    const r = await poll(() => call('GET', '/api/users', { ...mgr, step: 'role freshness poll' }), (x) => x.status === 403, (ttl + 5) * 1000);
    const ms = Date.now() - t0;
    record('demotion -> manager endpoints 403', ms);
    t.diagnostic(`403 after ${ms} ms (USER_ROLE_TTL_SECONDS=${ttl})`);
    ok(r, 403, `GET /api/users within ${ttl + 5} s of the demotion (token still says manager)`);
    ok(await call('GET', '/api/allocations/suggestions', mgr), 403, 'GET /api/allocations/suggestions');
    ok(await call('POST', '/api/allocations', { ...mgr, body: { companyIds: [S.unallocated], repId: S.rep1.user.id } }), 403, 'POST /api/allocations');
    ok(await call('POST', '/api/leads/search', { ...mgr, body: { filter: { scope: 'all' } } }), 403, 'search scope all');
    const k = await kpis(S.manager);
    ok(k, 200, 'kpis');
    assert.equal(k.body.team, undefined, 'no team KPIs for a rep');
  } catch (err) {
    failure = err;
  }
  const back = await restoreManagerRole();
  if (failure) throw failure;
  ok(back, 200, `manager endpoints back within ${ttl + 5} s of the restore`);
});

test('21 bulk unassign: DELETE /api/allocations with a body returns leads to the pool; SSE names the actor', async () => {
  const config = await call('GET', '/api/config', { token: S.rep1.token });
  ok(config, 200, 'GET /api/config');
  for (const k of ['maxBulkAllocation', 'maxBulkTag', 'maxBulkUnallocate', 'refreshPerHour', 'userRoleTtlSeconds'])
    assert.equal(typeof config.body[k], 'number', `config.${k}`);
  const used = new Set([S.unallocated, S.poolWatched, S.poolNotified, ...S.poolAllocated]);
  const pool = await search(S.rep1, { scope: 'unallocated', limit: 20 });
  const ids = pool.body.items.map((i) => i.id).filter((id) => !used.has(id)).slice(0, 2);
  assert.equal(ids.length, 2, 'two spare pool leads');
  const alloc = await call('POST', '/api/allocations', { token: S.manager.token, body: { companyIds: ids, repId: S.rep3.user.id } });
  ok(alloc, 200, 'allocate two pool leads to rep3');
  ids.forEach((id) => S.poolAllocated.add(id));
  const k3 = await kpis(S.rep3);
  ok(await profile(S.rep1, ids[0]), 404, "rep1 cannot open rep3's lead");

  ok(await call('DELETE', '/api/allocations', { token: S.rep3.token, body: { companyIds: ids } }), 403, 'reps cannot unassign');
  const many = Array.from({ length: config.body.maxBulkUnallocate + 1 }, (_, i) => `7d9f3c1a-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const big = await call('DELETE', '/api/allocations', { token: S.manager.token, body: { companyIds: many } });
  ok(big, 400, 'more than maxBulkUnallocate');
  assert.equal(big.body.error, 'too_many_leads');

  const t0 = Date.now();
  const res = await call('DELETE', '/api/allocations', { token: S.manager.token, body: { companyIds: [...ids, S.unallocated] } });
  ok(res, 200, 'bulk unassign through the gateway');
  ids.forEach((id) => S.poolAllocated.delete(id));
  assert.deepEqual(res.body.unallocated.map((u) => [u.companyId, u.previousRepId]).sort(), ids.map((id) => [id, S.rep3.user.id]).sort());
  assert.deepEqual(res.body.unchanged, [S.unallocated]);

  // rep1 watches the pool: both leads come back to it, with who did it.
  for (const id of ids) {
    const msg = await S.sse1.waitFor((m) => m.event === 'lead.allocated' && m.wall >= t0 && eventCompanyIds(m).includes(id), SSE_DEADLINE_MS);
    assert.equal(msg.data.payload.assigned_rep_id, null, 'back in the pool');
    assert.equal(msg.data.payload.previous_rep_id, S.rep3.user.id);
    assert.equal(msg.data.payload.actor_name, S.manager.user.name, `actor_name on the event: ${JSON.stringify(msg.data)}`);
  }
  const p = await profile(S.rep1, ids[0]);
  ok(p, 200, 'rep1 views the released lead');
  assert.equal(p.body.allocation.current, null);
  ok(await call('POST', `/api/leads/${ids[1]}/notes`, { token: S.rep3.token, body: { text: 'x' } }), 403, 'rep3 lost write access');
  const after3 = await kpis(S.rep3);
  assert.equal(after3.body.mine.allocated, k3.body.mine.allocated - 2, 'rep3 allocated -2');
});

test('22 custom tags: rename keeps links and bumps versions, 409 on a clash, delete unlinks everywhere', async () => {
  const id = S.cat2;
  const mk = async (name) => {
    const r = await call('POST', '/api/custom-tags', { token: S.rep1.token, body: { name } });
    ok(r, 201, `create tag ${name}`);
    (S.renameTags ??= []).push(r.body.tag.id);
    return r.body.tag;
  };
  const tag = await mk(`e2e-rename-${RUN_ID}`);
  const other = await mk(`e2e-other-${RUN_ID}`);
  ok(await call('POST', `/api/leads/${id}/custom-tags`, { token: S.rep1.token, body: { tagId: tag.id } }), 201, 'tag own lead');
  const before = await profile(S.rep1, id);

  ok(await call('PATCH', `/api/custom-tags/${tag.id}`, { token: S.rep2.token, body: { name: 'hijack' } }), 403, 'not the creator');
  const clash = await call('PATCH', `/api/custom-tags/${tag.id}`, { token: S.rep1.token, body: { name: other.name.toUpperCase() } });
  ok(clash, 409, 'name taken (ignoring case)');
  const t0 = Date.now();
  const newName = `e2e-renamed-${RUN_ID}`;
  const renamed = await call('PATCH', `/api/custom-tags/${tag.id}`, { token: S.rep1.token, body: { name: newName } });
  ok(renamed, 200, 'rename by its creator');
  assert.equal(renamed.body.previousName, tag.name);
  assert.deepEqual(renamed.body.leads, [{ companyId: id, version: before.body.version + 1 }]);
  const msg = await S.sse1.waitFor((m) => m.event === 'tags.changed' && m.wall >= t0 && eventCompanyIds(m).includes(id), SSE_DEADLINE_MS);
  assert.equal(msg.data.payload.renamed, true);
  assert.equal(msg.data.payload.actor_name, S.rep1.user.name);
  const p = await profile(S.rep1, id);
  assert.equal(p.body.version, before.body.version + 1, 'the profile cache moved with the version');
  assert.ok(p.body.customTags.some((t) => t.id === tag.id && t.name === newName), 'profile shows the new name');
  const found = await search(S.rep1, { customTags: [newName] });
  assert.deepEqual(found.body.items.map((i) => i.id), [id], 'search by the new name');

  const del = await call('DELETE', `/api/custom-tags/${tag.id}`, { token: S.rep1.token });
  ok(del, 200, 'delete by its creator');
  assert.deepEqual(del.body.leads.map((l) => l.companyId), [id]);
  S.renameTags = S.renameTags.filter((x) => x !== tag.id);
  const p2 = await profile(S.rep1, id);
  assert.ok(!p2.body.customTags.some((t) => t.id === tag.id), 'unlinked from the lead');
  assert.ok(p2.body.activity.some((a) => a.type === 'custom_tag' && a.user?.id === S.rep1.user.id), 'untag activity row');
  const list = await call('GET', '/api/custom-tags', { token: S.rep1.token });
  assert.ok(!list.body.items.some((t) => t.id === tag.id), 'gone from the catalog');
  ok(await call('DELETE', `/api/custom-tags/${other.id}`, { token: S.rep1.token }), 200, 'delete the other tag');
  S.renameTags = S.renameTags.filter((x) => x !== other.id);
});

test('23 saved views and preferences: own and shared views, manager-only sharing, optimistic preferences', async () => {
  const own = await search(S.rep1, { scope: 'mine', limit: 50 });
  const county = own.body.items.find((i) => i.countyFips && i.priorityScore >= 1)?.countyFips;
  assert.ok(county, 'an own scored lead with a county');
  const filter = { scope: 'mine', counties: [county], minPriority: 1 };
  const create = (who, body) => call('POST', '/api/views', { token: who.token, body });
  const track = (r, who) => {
    if (r.status === 201) (S.views ??= []).push({ id: r.body.view.id, token: who.token });
    return r;
  };
  const mine = track(await create(S.rep1, { name: `e2e-view-${RUN_ID}`, filter, sort: { by: 'rating', dir: 'desc' } }), S.rep1);
  ok(mine, 201, 'rep1 saves a view');
  assert.deepEqual(mine.body.view.filter, filter);
  ok(await create(S.rep1, { name: `e2e-view-${RUN_ID}`, filter: {} }), 409, 'same name again');
  ok(await create(S.rep1, { name: `e2e-share-${RUN_ID}`, filter: {}, isShared: true }), 403, 'reps cannot share');
  ok(await create(S.rep1, { name: `e2e-bad-${RUN_ID}`, filter: { counties: ['NY'] } }), 400, 'invalid LeadFilter');
  const team = track(await create(S.manager, { name: `e2e-team-${RUN_ID}`, filter: { scope: 'unallocated' }, isShared: true }), S.manager);
  ok(team, 201, 'manager shares a view');

  const views1 = await call('GET', '/api/views', { token: S.rep1.token });
  ok(views1, 200, 'GET /api/views');
  const byId = new Map(views1.body.items.map((v) => [v.id, v]));
  assert.equal(byId.get(mine.body.view.id)?.mine, true);
  assert.deepEqual([byId.get(team.body.view.id)?.isShared, byId.get(team.body.view.id)?.canEdit], [true, false]);
  const views2 = await call('GET', '/api/views', { token: S.rep2.token });
  assert.ok(views2.body.items.some((v) => v.id === team.body.view.id), 'rep2 sees the shared view');
  assert.ok(!views2.body.items.some((v) => v.id === mine.body.view.id), "rep2 never sees rep1's private view");

  // The saved filter runs as is: counties and minPriority apply.
  const applied = await search(S.rep1, { ...mine.body.view.filter, sort: mine.body.view.sort });
  ok(applied, 200, 'search with the saved view');
  assert.ok(applied.body.items.length > 0, 'the view matches leads');
  assert.ok(applied.body.items.every((i) => i.countyFips === county && i.priorityScore >= 1), 'counties and minPriority applied');

  ok(await call('PATCH', `/api/views/${team.body.view.id}`, { token: S.rep1.token, body: { name: 'mine now' } }), 403, "rep1 edits the team's view");
  ok(await call('PATCH', `/api/views/${mine.body.view.id}`, { token: S.rep2.token, body: { name: 'x' } }), 404, "rep2 edits rep1's view");
  const renamed = await call('PATCH', `/api/views/${mine.body.view.id}`, { token: S.rep1.token, body: { name: `e2e-view2-${RUN_ID}` } });
  ok(renamed, 200, 'rep1 renames own view');
  assert.deepEqual(renamed.body.view.filter, filter, 'filter kept');
  for (const [r, who] of [[mine, S.rep1], [team, S.manager]]) {
    ok(await call('DELETE', `/api/views/${r.body.view.id}`, { token: who.token }), 200, 'delete view');
    S.views = S.views.filter((v) => v.id !== r.body.view.id);
  }

  const cur = await call('GET', '/api/preferences', { token: S.rep1.token });
  ok(cur, 200, 'GET /api/preferences');
  S.prefs = cur.body.prefs;
  const saved = await call('PUT', '/api/preferences', { token: S.rep1.token, body: { prefs: { ...cur.body.prefs, e2e: RUN_ID }, version: cur.body.version } });
  ok(saved, 200, 'PUT with the current version');
  assert.equal(saved.body.version, cur.body.version + 1);
  const stale = await call('PUT', '/api/preferences', { token: S.rep1.token, body: { prefs: {}, version: cur.body.version } });
  ok(stale, 409, 'PUT with a stale version');
  assert.equal(stale.body.current.version, saved.body.version);
  assert.equal(stale.body.current.prefs.e2e, RUN_ID);
  const read = await call('GET', '/api/preferences', { token: S.rep1.token });
  assert.equal(read.body.prefs.e2e, RUN_ID, 'read back');
  ok(await call('PUT', '/api/preferences', { token: S.rep1.token, body: { prefs: S.prefs, version: saved.body.version } }), 200, 'restore');
  delete S.prefs;
});

const STAGES = ['new', 'contacted', 'interested', 'quoting', 'won', 'lost'];
const nyDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
  .format(new Date(Date.now() + offsetDays * 86_400_000));

/** A rep1 lead the earlier tests leave alone, optionally matching more of a LeadFilter. */
async function spareLead(extra = {}) {
  const r = await search(S.rep1, { scope: 'mine', limit: 200, ...extra });
  ok(r, 200, 'search spare lead');
  const used = new Set([S.life, S.tagged, S.move1, S.move2, S.ryw, S.contactLead, S.cat1, S.cat2, S.noteLead, ...(S.salesLeads ?? [])]);
  const lead = r.body.items.find((i) => !used.has(i.id));
  if (lead) (S.salesLeads ??= []).push(lead.id);
  return lead;
}

test('24 sales stage: PUT with the lead version (409 stale), SSE, filter and facets; a first call moves new to contacted', async () => {
  const lead = await spareLead();
  assert.ok(lead, 'rep1 has a spare lead');
  assert.ok(STAGES.includes(lead.salesStage), `LeadSummary.salesStage: ${lead.salesStage}`);
  assert.ok('lastContactedAt' in lead && 'nextTask' in lead, 'LeadSummary has lastContactedAt and nextTask');
  const p0 = await profile(S.rep1, lead.id);
  ok(p0, 200, 'profile');
  for (const k of ['salesStage', 'stageChangedAt', 'lastContactedAt']) assert.ok(k in p0.body, `LeadProfile.${k}`);
  assert.ok(Array.isArray(p0.body.tasks), 'LeadProfile.tasks');
  (S.stages ??= {})[lead.id] = p0.body.salesStage;
  const target = p0.body.salesStage === 'quoting' ? 'interested' : 'quoting';

  const t0 = Date.now();
  const moved = await call('PUT', `/api/leads/${lead.id}/stage`, { token: S.rep1.token, body: { stage: target, version: p0.body.version } });
  ok(moved, 200, 'PUT stage');
  assert.deepEqual([moved.body.stage, moved.body.version], [target, p0.body.version + 1]);
  assert.ok(isIso(moved.body.stageChangedAt), 'stageChangedAt');
  const msg = await S.sse1.waitFor((m) => m.event === 'lead.updated' && eventCompanyIds(m).includes(lead.id)
    && m.data.payload?.fields?.includes('sales_stage') && m.wall >= t0, SSE_DEADLINE_MS);
  assert.equal(msg.data.payload.actor_name, S.rep1.user.name);
  const stale = await call('PUT', `/api/leads/${lead.id}/stage`, { token: S.rep1.token, body: { stage: 'won', version: p0.body.version } });
  ok(stale, 409, 'stale version');
  assert.deepEqual([stale.body.current.stage, stale.body.current.version], [target, moved.body.version]);
  ok(await call('PUT', `/api/leads/${lead.id}/stage`, { token: S.rep1.token, body: { stage: 'closed', version: moved.body.version } }), 400, 'unknown stage');
  ok(await call('PUT', `/api/leads/${S.rep2Lead}/stage`, { token: S.rep1.token, body: { stage: 'won', version: 1 } }), 404, "another rep's lead");
  ok(await call('PUT', `/api/leads/${S.unallocated}/stage`, { token: S.rep1.token, body: { stage: 'won', version: 1 } }), 403, 'pool lead');

  const p1 = await profile(S.rep1, lead.id);
  assert.equal(p1.body.salesStage, target);
  const row = p1.body.activity.find((a) => a.type === 'stage_changed');
  assert.deepEqual(row?.fieldDiff?.sales_stage, [p0.body.salesStage, target], 'stage_changed in the activity feed');
  const found = await poll(() => search(S.rep1, { scope: 'mine', stages: [target], limit: 200 }),
    (r) => r.body?.items?.some((i) => i.id === lead.id));
  assert.ok(found.body.items.every((i) => i.salesStage === target), 'stages filter');
  assert.ok(found.body.items.some((i) => i.id === lead.id), 'the moved lead matches its new stage');
  const facets = await call('POST', '/api/leads/facets', { token: S.rep1.token, body: { filter: { scope: 'mine' } } });
  ok(facets, 200, 'facets');
  assert.deepEqual(facets.body.stages.map((f) => f.value), STAGES, 'stage facet lists every stage in order');
  assert.ok(facets.body.stages.find((f) => f.value === target).count >= 1);

  const fresh = await spareLead({ stages: ['new'] });
  if (!fresh) return;
  (S.stages ??= {})[fresh.id] = 'new';
  const act = await call('POST', `/api/leads/${fresh.id}/activities`, { token: S.rep1.token, body: { type: 'call', outcome: 'Connected' } });
  ok(act, 201, 'first call on a new lead');
  assert.deepEqual([act.body.salesStage, act.body.lastContactedAt], ['contacted', act.body.activity.createdAt]);
  const p2 = await profile(S.rep1, fresh.id);
  assert.deepEqual([p2.body.salesStage, p2.body.lastContactedAt], ['contacted', act.body.activity.createdAt]);
  const auto = p2.body.activity.find((a) => a.type === 'stage_changed');
  assert.equal(auto?.fieldDiff?.auto, true, 'the move is marked automatic');
});

test('25 tasks: create, list by due window, complete with the task version, permissions, task_assigned notification', async () => {
  const lead = await spareLead({ followUp: 'none' });
  assert.ok(lead, 'rep1 has a lead without open tasks');
  const create = (who, id, body) => call('POST', `/api/leads/${id}/tasks`, { token: who.token, body });
  const track = (r) => {
    if (r.status === 201) (S.tasks ??= []).push(r.body.task.id);
    return r;
  };
  const tasks = (who, q) => call('GET', `/api/tasks${q}`, { token: who.token, step: 'GET /api/tasks' });
  const title = `e2e task ${RUN_ID}`;
  const mine = track(await create(S.rep1, lead.id, { title, type: 'call', dueAt: nyDate(0), note: 'Ask about TPO' }));
  ok(mine, 201, 'rep1 adds a task');
  const t = mine.body.task;
  assert.deepEqual([t.companyId, t.title, t.type, t.doneAt, t.version, t.assignee.id, t.createdBy.id],
    [lead.id, title, 'call', null, 1, S.rep1.user.id, S.rep1.user.id]);
  for (const k of ['companyName', 'dueAt', 'note', 'createdAt', 'updatedAt']) assert.ok(k in t, `Task.${k}`);
  ok(await create(S.rep1, lead.id, { title, type: 'call', dueAt: nyDate(0), assigneeId: S.rep2.user.id }), 403, 'rep assigns another rep');
  ok(await create(S.rep1, S.unallocated, { title, type: 'call', dueAt: nyDate(0) }), 403, 'rep on a pool lead');
  ok(await create(S.rep1, S.rep2Lead, { title, type: 'call', dueAt: nyDate(0) }), 404, "rep on another rep's lead");
  ok(await create(S.rep1, lead.id, { title: '', type: 'call', dueAt: nyDate(0) }), 400, 'empty title');

  const today = await poll(() => tasks(S.rep1, '?scope=mine&due=today&status=open&limit=200'),
    (r) => r.body?.items?.some((x) => x.id === t.id));
  ok(today, 200, 'GET /api/tasks today');
  assert.ok('nextCursor' in today.body, 'TasksPage.nextCursor');
  assert.ok(today.body.items.some((x) => x.id === t.id), 'listed under today');
  assert.ok(today.body.items.every((x) => x.assignee.id === S.rep1.user.id && x.doneAt === null), 'only my open tasks');
  const overdue = await tasks(S.rep1, '?scope=mine&due=overdue&status=open&limit=200');
  assert.ok(!overdue.body.items.some((x) => x.id === t.id), 'not overdue');
  const listed = await poll(() => search(S.rep1, { scope: 'mine', followUp: 'today', limit: 200 }),
    (r) => r.body?.items?.some((i) => i.id === lead.id));
  assert.equal(listed.body.items.find((i) => i.id === lead.id)?.nextTask?.id, t.id, 'LeadSummary.nextTask');
  assert.ok((await profile(S.rep1, lead.id)).body.tasks.some((x) => x.id === t.id), 'LeadProfile.tasks');
  ok(await tasks(S.rep2, '?scope=team'), 403, 'reps cannot list the team');
  ok(await tasks(S.rep2, `?scope=rep:${S.rep1.user.id}`), 403, "reps cannot list another rep's tasks");
  ok(await call('PATCH', `/api/tasks/${t.id}`, { token: S.rep2.token, body: { done: true, version: 1 } }), 404, "rep2 changes rep1's task");

  const done = await call('PATCH', `/api/tasks/${t.id}`, { token: S.rep1.token, body: { done: true, version: 1 } });
  ok(done, 200, 'complete');
  assert.ok(isIso(done.body.task.doneAt) && done.body.task.version === 2, 'doneAt and version');
  const stale = await call('PATCH', `/api/tasks/${t.id}`, { token: S.rep1.token, body: { title: 'x', version: 1 } });
  ok(stale, 409, 'stale task version');
  assert.equal(stale.body.current.version, 2);
  const doneList = await poll(() => tasks(S.rep1, '?scope=mine&due=all&status=done&limit=200'), (r) => r.body?.items?.some((x) => x.id === t.id));
  assert.ok(doneList.body.items.some((x) => x.id === t.id), 'listed as done');
  const p = await profile(S.rep1, lead.id);
  assert.deepEqual(p.body.activity.filter((a) => a.fieldDiff?.task_id === t.id).map((a) => a.type).sort(), ['task_completed', 'task_created']);

  // A manager's task for rep1 notifies rep1, and shows in the manager's view of rep1 and of the team.
  const t0 = Date.now();
  const given = track(await create(S.manager, lead.id, { title: `${title} (from manager)`, type: 'visit', dueAt: nyDate(3), assigneeId: S.rep1.user.id }));
  ok(given, 201, 'manager assigns rep1');
  const byRep = await poll(() => tasks(S.manager, `?scope=rep:${S.rep1.user.id}&due=week&status=open&limit=200`),
    (r) => r.body?.items?.some((x) => x.id === given.body.task.id));
  assert.ok(byRep.body.items.some((x) => x.id === given.body.task.id), "manager lists rep1's tasks");
  ok(await tasks(S.manager, '?scope=team&due=all&status=open&limit=50'), 200, 'manager lists the team');
  if (!N.skip) {
    const msg = await S.sse1.waitFor((m) => isNotice(m, S.rep1.user.id, 'task_assigned', t0), SSE_DEADLINE_MS);
    record('manager task -> SSE notification.created (rep1)', msg.wall - t0);
  }
  const gone = await call('DELETE', `/api/tasks/${given.body.task.id}?version=${given.body.task.version}`, { token: S.rep1.token });
  ok(gone, 200, "rep1 deletes a task on their own lead");
  ok(await call('DELETE', `/api/tasks/${t.id}?version=2`, { token: S.rep1.token }), 200, 'delete');
  S.tasks = S.tasks.filter((id) => id !== t.id && id !== given.body.task.id);
});

test('26 dashboard: SalesDashboard shape for mine, rep:<id> and team; weeklyActivityGoal in /api/config', async () => {
  const config = await call('GET', '/api/config', { token: S.rep1.token });
  ok(config, 200, 'GET /api/config');
  assert.ok(Number.isInteger(config.body.weeklyActivityGoal) && config.body.weeklyActivityGoal > 0, 'weeklyActivityGoal');
  const dash = (who, scope) => call('GET', `/api/dashboard?scope=${scope}`, { token: who.token, step: 'GET /api/dashboard' });
  const counts = (c) => ['calls', 'emails', 'visits', 'notes'].every((k) => Number.isInteger(c?.[k]) && c[k] >= 0);
  const check = (d, scope) => {
    assert.equal(d.scope, scope);
    assert.deepEqual(d.pipeline.map((x) => x.stage), STAGES, 'pipeline: every stage in order');
    assert.ok(d.pipeline.every((x) => Number.isInteger(x.count)));
    for (const k of ['overdue', 'today', 'week']) assert.ok(Number.isInteger(d.followUps[k]), `followUps.${k}`);
    assert.ok(counts(d.activity.thisWeek) && counts(d.activity.lastWeek), 'activity counts');
    assert.ok(Number.isInteger(d.activity.goalPerWeek) && d.activity.goalPerWeek > 0, 'goalPerWeek');
    assert.equal(d.activity.daily.length, 14, '14 days');
    const days = d.activity.daily.map((x) => x.date);
    assert.ok(days.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) && [...days].sort().join() === days.join(), 'daily dates ascending');
    assert.equal(days.at(-1), nyDate(0), 'daily ends today');
    assert.ok(d.activity.daily.every(counts), 'daily counts');
    assert.deepEqual(Object.keys(d.accounts).sort(), ['do_not_contact', 'existing_customer', 'lapsed_customer', 'prospect']);
    for (const k of ['total', 'withDecisionMaker', 'withEmail', 'withPhone']) assert.ok(Number.isInteger(d.coverage[k]), `coverage.${k}`);
    for (const k of ['neverContacted', 'notContacted30d', 'newSinceLastPoll']) assert.ok(Number.isInteger(d[k]), k);
    assert.ok(d.topTags.every((x) => typeof x.key === 'string' && typeof x.label === 'string' && Number.isInteger(x.count)
      && ['system', 'custom'].includes(x.kind)), 'topTags');
    assert.deepEqual(d.segments.map((x) => x.segment), ['strategic', 'growth', 'emerging', 'long_tail']);
    assert.ok(isIso(d.generatedAt), 'generatedAt');
    return d.pipeline.reduce((n, x) => n + x.count, 0);
  };

  const mine = await dash(S.rep1, 'mine');
  ok(mine, 200, 'rep1 dashboard');
  const total = check(mine.body, 'mine');
  assert.equal(mine.body.reps, undefined, 'no rep rows outside team');
  assert.equal(mine.body.activity.goalPerWeek, config.body.weeklyActivityGoal, 'one rep: the weekly goal');
  const own = await searchAll(S.rep1, { scope: 'mine' });
  assert.equal(total, own.total, 'pipeline counts every allocated lead');
  assert.equal(mine.body.coverage.total, own.total);
  ok(await dash(S.rep1, 'team'), 403, 'reps cannot see the team dashboard');
  ok(await dash(S.rep1, `rep:${S.rep2.user.id}`), 403, "reps cannot see another rep's dashboard");
  ok(await dash(S.rep1, 'everyone'), 400, 'unknown scope');

  const ofRep1 = await dash(S.manager, `rep:${S.rep1.user.id}`);
  ok(ofRep1, 200, "manager views rep1's dashboard");
  check(ofRep1.body, `rep:${S.rep1.user.id}`);
  assert.deepEqual(ofRep1.body.pipeline, mine.body.pipeline, "same pipeline as rep1's own");
  const team = await dash(S.manager, 'team');
  ok(team, 200, 'team dashboard');
  check(team.body, 'team');
  const row = team.body.reps?.find((r) => r.rep.id === S.rep1.user.id);
  assert.ok(row, 'team rows include rep1');
  assert.equal(row.assigned, own.total);
  assert.deepEqual(row.pipeline.map((x) => x.stage), STAGES);
  for (const k of ['activityThisWeek', 'overdue', 'wonThisMonth']) assert.ok(Number.isInteger(row[k]), `reps[].${k}`);
});
