import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  authenticateInternal, cacheKeys, canAllocate, canonicalJson, canView, canWrite, countyName, EVENT_TYPES, eventCompanyIds,
  ident, isEventType, isOutboxEventType, join, KPI_EVENTS, LEAD_CHANGING_EVENTS, LEAD_EVENT_TYPES, leadFacetsKey,
  leadFilterJsonSchema, leadFilterSchema, leadListKey, LIST_CHANGING_EVENTS, listVersion, listVersionKeys,
  limitsFromEnv, NOTIFICATION_CREATED, parseTagRef, raw, sql, tagRef, visibilitySql, canEditView, canSeeView, canShareView,
} from '../src/index.ts';

const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const OTHER = 'e1817cb3-f647-416d-9c20-084a9ab62324';
const MANAGER = { id: '8b974b0a-101c-47cf-bdfe-1aed4786febc', role: 'manager' as const };

describe('sql builder', () => {
  it('binds values and numbers placeholders across nested fragments', () => {
    const inner = sql`b = ${2} AND c = ${'x'}`;
    const q = sql`SELECT * FROM t WHERE a = ${1} AND ${inner} AND d IN (${join([sql`${3}`, sql`${4}`])})`;
    expect(q.compile()).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3 AND d IN ($4, $5)',
      values: [1, 2, 'x', 3, 4],
    });
    expect(q.strings.length).toBe(q.values.length + 1);
  });

  it('never puts values into the text', () => {
    const evil = "'; DROP TABLE companies; --";
    expect(sql`SELECT ${evil}`.compile()).toEqual({ text: 'SELECT $1', values: [evil] });
  });

  it('joins empty lists to nothing and rejects bad identifiers', () => {
    expect(sql`a${join([])}b`.compile().text).toBe('ab');
    expect(raw('x').compile()).toEqual({ text: 'x', values: [] });
    expect(() => ident('c; DROP')).toThrow('invalid SQL identifier');
    expect(ident('companies').compile().text).toBe('companies');
  });
});

describe('visibility rule', () => {
  it('lets a rep view own and unallocated leads and write only own', () => {
    expect([canView(REP, REP.id), canView(REP, null), canView(REP, OTHER)]).toEqual([true, true, false]);
    expect([canWrite(REP, REP.id), canWrite(REP, null), canWrite(REP, OTHER)]).toEqual([true, false, false]);
    expect(canAllocate(REP)).toBe(false);
  });

  it('lets a manager view, write and allocate everything', () => {
    expect([canView(MANAGER, OTHER), canWrite(MANAGER, null), canAllocate(MANAGER)]).toEqual([true, true, true]);
  });

  it('compiles to a parameterised condition', () => {
    expect(visibilitySql(REP).compile()).toEqual({
      text: '(c.assigned_rep_id = $1::uuid OR c.assigned_rep_id IS NULL)', values: [REP.id],
    });
    expect(visibilitySql(REP, 'write', 'co').compile()).toEqual({ text: '(co.assigned_rep_id = $1::uuid)', values: [REP.id] });
    expect(visibilitySql(MANAGER).compile()).toEqual({ text: 'TRUE', values: [] });
    expect(visibilitySql({ id: REP.id, role: 'admin' as never }).compile().text).toBe('FALSE');
    expect(() => visibilitySql(REP, 'view', 'c) OR (1=1')).toThrow();
  });
});

describe('internal auth', () => {
  const headers = { 'x-internal-token': 'secret', 'x-user-id': REP.id.toUpperCase(), 'x-user-role': 'rep' };

  it('accepts the gateway headers', () => {
    expect(authenticateInternal(headers, 'secret')).toEqual({ ok: true, viewer: REP });
  });

  it.each([
    [{ ...headers, 'x-internal-token': 'wrong' }, 'invalid internal token'],
    [{ ...headers, 'x-internal-token': undefined }, 'invalid internal token'],
    [{ ...headers, 'x-user-id': 'rep1' }, 'X-User-Id'],
    [{ ...headers, 'x-user-role': 'admin' }, 'X-User-Role'],
  ])('rejects %o', (h, error) => {
    const r = authenticateInternal(h, 'secret');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(error);
  });
});

describe('cache keys', () => {
  it('hashes equal filters equally regardless of key order', () => {
    const a = cacheKeys.leadList('u', 3, { size: ['small'], sort: { by: 'rating', dir: 'asc' }, text: undefined });
    const b = cacheKeys.leadList('u', 3, { sort: { dir: 'asc', by: 'rating' }, size: ['small'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^leads:q:u:3:[0-9a-f]{40}$/);
    expect(cacheKeys.leadList('u', 3, { size: ['large'] })).not.toBe(a);
    expect(canonicalJson({ b: 1, a: [1, { d: null, c: 'x' }] })).toBe('{"a":[1,{"c":"x","d":null}],"b":1}');
  });

  it('uses the contract key formats', () => {
    expect(cacheKeys.leadProfile('id1', 7)).toBe('lead:id1:v7');
    expect([cacheKeys.kpiRep('u'), cacheKeys.kpiTeam, cacheKeys.readYourWrites('u')]).toEqual(['kpi:rep:u', 'kpi:team', 'rw:u']);
    expect([cacheKeys.leadsVersionAll, cacheKeys.leadsVersionPool, cacheKeys.leadsVersionRep('u')])
      .toEqual(['leads:v:all', 'leads:v:pool', 'leads:v:rep:u']);
    expect([cacheKeys.signals('shared', 'pool'), cacheKeys.userRole('u')]).toEqual(['signals:shared:pool', 'user:u:role']);
  });

  it('shares managers\' list entries unless the filter is personal; reps\' stay per user', () => {
    const other = { ...MANAGER, id: OTHER };
    expect(leadListKey(MANAGER, 3, { size: ['small'] })).toBe(leadListKey(other, 3, { size: ['small'] }));
    expect(leadListKey(MANAGER, 3, { size: ['small'] })).toMatch(/^leads:q:mgr:3:[0-9a-f]{40}$/);
    for (const personal of [{ scope: 'mine' as const }, { unchecked: 'me' as const }, { unserviced: 'me' as const }])
      expect(leadListKey(MANAGER, 3, personal)).toBe(cacheKeys.leadList(MANAGER.id, 3, personal));
    expect(leadListKey(REP, 3, {})).toBe(cacheKeys.leadList(REP.id, 3, {}));
  });

  it('keys lists and facet counts by counties and minPriority too', () => {
    const base = { segment: ['growth' as const] };
    const keys = [base, { ...base, counties: ['36061'] }, { ...base, counties: ['34003'] }, { ...base, minPriority: 70 },
      { ...base, minPriority: 80 }];
    expect(new Set(keys.map((f) => leadListKey(MANAGER, 3, f))).size).toBe(keys.length);
    expect(new Set(keys.map((f) => leadFacetsKey(REP, 3, f))).size).toBe(keys.length);
  });

  it('keys facet counts like lists, without the page fields', () => {
    const k = (f: object) => leadFacetsKey(MANAGER, 3, f);
    expect(k({ segment: ['growth'], limit: 5, cursor: 'x', sort: { by: 'rating', dir: 'asc' } })).toBe(k({ segment: ['growth'] }));
    expect(k({ segment: ['growth'] })).toMatch(/^leads:facets:mgr:3:[0-9a-f]{40}$/);
    expect(leadFacetsKey(MANAGER, 3, { scope: 'mine' })).toContain(`leads:facets:${MANAGER.id}:`);
    expect(leadFacetsKey(REP, '1.2', {})).toContain(`leads:facets:${REP.id}:1.2:`);
    expect(cacheKeys.leadMap('mgr', 4, 'all')).toBe('leads:map:mgr:4:all');
  });

  it('versions a rep\'s lists by their own leads and the pool, and managers\' by every lead', () => {
    expect(listVersionKeys(REP)).toEqual([`leads:v:rep:${REP.id}`, 'leads:v:pool']);
    expect(listVersionKeys(MANAGER)).toEqual(['leads:v:all']);
    expect(listVersion(['4', null])).toBe('4.0');
    expect(listVersion([7])).toBe('7');
    expect(leadListKey(REP, listVersion(['4', '2']), {})).toMatch(new RegExp(`^leads:q:${REP.id}:4\\.2:[0-9a-f]{40}$`));
    // a user who changes role never reads the other role's entries: '4' and '4.0' differ
    expect(cacheKeys.leadList(REP.id, listVersion([4]), {})).not.toBe(cacheKeys.leadList(REP.id, listVersion([4, null]), {}));
    expect(LIST_CHANGING_EVENTS).not.toContain('note.added');
    expect(LIST_CHANGING_EVENTS).toContain('state.changed');
  });
});

describe('events', () => {
  it('lists notification.created among the outbox types but in no lead-event list', () => {
    expect(EVENT_TYPES).toEqual([...LEAD_EVENT_TYPES, 'notification.created']);
    expect(NOTIFICATION_CREATED).toBe('notification.created');
    for (const list of [LEAD_CHANGING_EVENTS, LIST_CHANGING_EVENTS, KPI_EVENTS]) expect(list).not.toContain(NOTIFICATION_CREATED);
    expect([isEventType(NOTIFICATION_CREATED), isOutboxEventType(NOTIFICATION_CREATED)]).toEqual([false, true]);
    expect([isEventType('lead.updated'), isOutboxEventType('lead.updated'), isOutboxEventType('nope')]).toEqual([true, true, false]);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('match the outbox_events event_type CHECK', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'outbox_events_event_type_check'`);
      expect([...rows[0].def.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort()).toEqual([...EVENT_TYPES].sort());
    } finally {
      await client.end();
    }
  });

  it('collects every company an event touches', () => {
    expect(eventCompanyIds({ company_id: 'a', payload: { actor_type: 'user', actor_id: null, company_ids: ['b', 'a'] } }))
      .toEqual(['a', 'b']);
    expect(eventCompanyIds({ company_id: null, payload: { actor_type: 'pipeline', actor_id: null } })).toEqual([]);
  });
});

describe('limits', () => {
  it('reads the bulk and refresh limits from the services\' environment, with their defaults', () => {
    expect(limitsFromEnv({})).toEqual({
      maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500, refreshPerHour: 20, weeklyActivityGoal: 25,
    });
    expect(limitsFromEnv({
      MAX_BULK_ALLOCATION: '120', MAX_BULK_TAG: '50', LEADMAKER_USER_JOBS_PER_HOUR: '3', WEEKLY_ACTIVITY_GOAL: '40',
    })).toEqual({ maxBulkAllocation: 120, maxBulkTag: 50, maxBulkUnallocate: 120, refreshPerHour: 3, weeklyActivityGoal: 40 });
    expect(() => limitsFromEnv({ WEEKLY_ACTIVITY_GOAL: '0' })).toThrow(/WEEKLY_ACTIVITY_GOAL/);
    expect(limitsFromEnv({ LEADMAKER_USER_JOBS_PER_HOUR: '-1' }).refreshPerHour).toBe(0);
    expect(() => limitsFromEnv({ MAX_BULK_TAG: '0' })).toThrow(/MAX_BULK_TAG/);
    expect(() => limitsFromEnv({ MAX_BULK_ALLOCATION: '2.5' })).toThrow(/MAX_BULK_ALLOCATION/);
  });
});

describe('saved view permissions', () => {
  it('lets owners see and edit their views, everyone see shared ones and managers edit and share them', () => {
    const mine = { ownerId: REP.id, isShared: false };
    const theirs = { ownerId: OTHER, isShared: false };
    const shared = { ownerId: OTHER, isShared: true };
    expect([canSeeView(REP, mine), canSeeView(REP, theirs), canSeeView(REP, shared)]).toEqual([true, false, true]);
    expect([canEditView(REP, mine), canEditView(REP, theirs), canEditView(REP, shared)]).toEqual([true, false, false]);
    expect([canSeeView(MANAGER, theirs), canEditView(MANAGER, theirs), canEditView(MANAGER, shared)]).toEqual([false, false, true]);
    expect([canShareView(REP), canShareView(MANAGER)]).toEqual([false, true]);
  });
});

describe('county names', () => {
  it('names Northeast counties with their state, and nothing else', () => {
    expect(countyName('34003')).toBe('Bergen County, NJ');
    expect(countyName('36061')).toBe('New York County, NY');
    expect(countyName('12086')).toBeNull();
    expect(countyName(null)).toBeNull();
  });
});

describe('LeadFilter schema', () => {
  it('accepts the full design filter', () => {
    const f = {
      scope: { repId: OTHER }, tagsAll: ['service:metal_roofing', 'gaf_tier=master_elite'], tagsAny: ['region=Staten Island'],
      customTags: ['hot'], customFields: [{ key: 'po', op: 'gte', value: 5 }, { key: 'x', op: 'exists' }],
      certifications: ['gaf:master_elite'], size: ['small'], segment: ['long_tail'], accountStatus: ['prospect'],
      materials: ['metal_roofing'], services: ['storm_damage'], minRating: 4.5, minYearsInBusiness: 10,
      near: { zip: '10013', radiusMiles: 25 }, unchecked: 'me', unserviced: 'team', updatedSince: '2026-10-01',
      updatedInLastPoll: true, text: ' acme ', sort: { by: 'distance', dir: 'asc' }, cursor: 'abc', limit: 25,
    };
    const parsed = leadFilterSchema.parse(f);
    expect(parsed.text).toBe('acme');
    expect(leadFilterSchema.parse({ updatedSince: '2026-10-01T12:00:00Z' }).updatedSince).toBe('2026-10-01T12:00:00Z');
  });

  it.each([
    [{ scope: 'everything' }],
    [{ sort: { by: 'distance', dir: 'asc' } }],
    [{ customFields: [{ key: 'po', op: 'gte' }] }],
    [{ customFields: [{ key: 'po', op: 'gte', value: true }] }],
    [{ customFields: [{ key: 'po', op: 'contains', value: 3 }] }],
    [{ tagsAll: ['bad tag'] }],
    [{ tagsAll: ['size='] }],
    [{ near: { zip: '1001', radiusMiles: 5 } }],
    [{ limit: 500 }],
    [{ updatedSince: 'yesterday' }],
    [{ updatedInLastPoll: 'yes' }],
    [{ minRating: 6 }],
    [{ certifications: ['master_elite'] }],
    [{ unknownKey: 1 }],
  ])('rejects %o', (f) => {
    expect(leadFilterSchema.safeParse(f).success).toBe(false);
  });

  it('parses and builds tag refs', () => {
    expect(parseTagRef('service:metal_roofing')).toEqual({ key: 'service:metal_roofing' });
    expect(parseTagRef('distance_band=0-5')).toEqual({ key: 'distance_band', value: '0-5' });
    expect(tagRef('gaf_tier', 'master_elite')).toBe('gaf_tier=master_elite');
  });

  it('ships an up-to-date JSON Schema export', () => {
    const file = JSON.parse(readFileSync(new URL('../schema/lead-filter.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(leadFilterJsonSchema());
    expect(file.additionalProperties).toBe(false);
    expect(Object.keys(file.properties)).toContain('near');
  });
});
