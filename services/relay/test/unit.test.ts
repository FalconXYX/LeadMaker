import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionCoalescer } from '../src/coalesce.ts';
import { loadConfig } from '../src/config.ts';
import { healthReport } from '../src/health.ts';
import { KpiRefresher } from '../src/kpis.ts';
import { entryFields, parseEntry } from '../src/stream.ts';
import { silent } from './helpers.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';

describe('stream entries', () => {
  it('encode outbox rows with LeadEvent field names', () => {
    const fields = entryFields({
      id: '42', event_type: 'lead.updated', company_id: A, payload: { actor_type: 'user', version: 3 },
      created_at: new Date('2026-10-18T12:00:00Z'),
    });
    expect(fields).toEqual([
      'id', '42', 'type', 'lead.updated', 'company_id', A,
      'payload', '{"actor_type":"user","version":3}', 'created_at', '2026-10-18T12:00:00.000Z',
    ]);
    expect(entryFields({ id: '1', event_type: 'pipeline.run_completed', company_id: null, payload: {}, created_at: new Date(0) })[5]).toBe('');
  });

  it('decode companies, versions and the users an event touches', () => {
    const one = parseEntry('1-0', entryFields({
      id: '7', event_type: 'lead.allocated', company_id: A,
      payload: { actor_type: 'user', actor_id: U, version: 4, assigned_rep_id: P, previous_rep_id: null },
      created_at: new Date(),
    }))!;
    expect(one).toMatchObject({ streamId: '1-0', outboxId: '7', type: 'lead.allocated', companyIds: [A], users: [P, U] });
    expect(one.versions).toEqual(new Map([[A, 4]]));

    const many = parseEntry('2-0', entryFields({
      id: '8', event_type: 'lead.updated', company_id: null,
      payload: { actor_type: 'pipeline', company_ids: [A, B, A, 'junk'], version: 9, versions: { [B]: 2 } },
      created_at: new Date(),
    }))!;
    expect(many.companyIds).toEqual([A, B]);
    expect(many.versions).toEqual(new Map([[B, 2]]));
    expect(many.users).toEqual([]);
  });

  it('keeps events whose payload is unreadable, and drops entries without a type', () => {
    expect(parseEntry('1-0', ['type', 'lead.updated', 'company_id', A, 'payload', '{oops'])).toMatchObject({ companyIds: [A] });
    expect(parseEntry('1-0', ['payload', '{}'])).toBeNull();
  });
});

describe('health', () => {
  const base = { published: 0, lastError: null, processed: 0 };
  const startedAt = new Date(1_000_000);
  const kpis = { refreshes: 0, lastRefreshAt: null, lastError: null };

  it('is ok while both loops progress and degraded when one stalls', () => {
    const now = 1_000_000 + 60_000;
    const ok = healthReport({
      publisher: { ...base, lastSuccessAt: new Date(now - 1000) },
      consumer: { ...base, lastReadAt: new Date(now - 1000) },
      kpis, startedAt, staleAfterMs: 30_000,
    }, now);
    expect(ok.status).toBe('ok');
    const stalled = healthReport({
      publisher: { ...base, lastSuccessAt: new Date(now - 45_000) },
      consumer: { ...base, lastReadAt: new Date(now - 1000) },
      kpis, startedAt, staleAfterMs: 30_000,
    }, now);
    expect(stalled).toMatchObject({ status: 'degraded', publisher: { ok: false }, consumer: { ok: true } });
  });

  it('gives a fresh process a grace period before its first success', () => {
    const report = healthReport({
      publisher: { ...base, lastSuccessAt: null }, consumer: { ...base, lastReadAt: null }, kpis, startedAt, staleAfterMs: 30_000,
    }, 1_000_000 + 5_000);
    expect(report.status).toBe('ok');
  });
});

describe('config', () => {
  it('defaults to the contract stream, port, refresh period and debounce', () => {
    expect(loadConfig({})).toMatchObject({ port: 8083, stream: 'events', consumerGroup: 'cache-invalidation', kpiRefreshIntervalMs: 300_000, kpiRefreshDebounceMs: 2000 });
    expect(() => loadConfig({ OUTBOX_BATCH_SIZE: '1.5' })).toThrow();
    expect(loadConfig({}).listVersionCoalesceMs).toBe(1000);
    expect(loadConfig({ LIST_VERSION_COALESCE_MS: '0' }).listVersionCoalesceMs).toBe(0);
    expect(() => loadConfig({ LIST_VERSION_COALESCE_MS: '-1' })).toThrow();
  });
});

describe('VersionCoalescer', () => {
  const ALL = 'leads:v:all';
  const POOL = 'leads:v:pool';
  const REP = `leads:v:rep:${U}`;
  const fakeRedis = (fail = 0) => {
    const incrs: string[] = [];
    let failures = fail;
    const redis = {
      incr: async (key: string) => {
        if (failures-- > 0) throw new Error('redis down');
        incrs.push(key);
        return incrs.length;
      },
    } as unknown as Redis;
    return { redis, incrs };
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bumps all and pool at most once per window, with one trailing bump for what came after the first', async () => {
    vi.useFakeTimers();
    const { redis, incrs } = fakeRedis();
    const c = new VersionCoalescer(redis, 1000, silent);
    expect(c.take([ALL, REP])).toEqual([ALL, REP]);
    vi.advanceTimersByTime(100);
    expect(c.take([ALL, REP])).toEqual([REP]);
    vi.advanceTimersByTime(400);
    expect(c.take([ALL, POOL, REP])).toEqual([POOL, REP]);
    expect(c.take([ALL])).toEqual([]);
    expect(incrs).toEqual([]);
    await vi.advanceTimersByTimeAsync(499);
    expect(incrs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(incrs).toEqual([ALL]);
    expect(c.coalesced).toBe(3);
    // the trailing bump opens the next window: a change right after it is held again, never lost
    expect(c.take([ALL])).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(incrs).toEqual([ALL, ALL]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(incrs).toEqual([ALL, ALL]);
    expect(c.take([ALL, POOL])).toEqual([ALL, POOL]);
  });

  it('never holds rep counters, or anything with a zero window', () => {
    const c = new VersionCoalescer(fakeRedis().redis, 1000, silent);
    for (let i = 0; i < 5; i++) expect(c.take([REP])).toEqual([REP]);
    const off = new VersionCoalescer(fakeRedis().redis, 0, silent);
    for (let i = 0; i < 3; i++) expect(off.take([ALL, POOL, REP])).toEqual([ALL, POOL, REP]);
  });

  it('retries a failed trailing bump and sends held bumps at shutdown', async () => {
    vi.useFakeTimers();
    const { redis, incrs } = fakeRedis(1);
    const c = new VersionCoalescer(redis, 1000, silent);
    c.take([POOL]);
    c.take([POOL]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(incrs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(incrs).toEqual([POOL]);
    c.take([ALL]);
    c.take([ALL]);
    await c.stop();
    expect(incrs).toEqual([POOL, ALL]);
    expect(c.take([ALL])).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(incrs).toEqual([POOL, ALL]);
  });
});

describe('KpiRefresher', () => {
  it('does not drop a request made while a refresh is finishing', async () => {
    // The request lands a few microtasks after the refresh's last await, as a run_completed handled on
    // the same Redis connection can.
    for (let depth = 0; depth < 12; depth++) {
      let calls = 0;
      let late: Promise<void> | undefined;
      const db = { $executeRawUnsafe: async () => ++calls } as unknown as PrismaClient;
      const redis = {
        unlink: async () => {
          if (!late) {
            let p = Promise.resolve();
            for (let i = 0; i < depth; i++) p = p.then(() => {});
            late = p.then(() => refresher.request('late'));
          }
          return 1;
        },
      } as unknown as Redis;
      const refresher = new KpiRefresher(db, redis, { intervalMs: 60_000, debounceMs: 60_000 }, silent);
      await refresher.request('first');
      await late;
      await refresher.stop();
      expect(calls, `request ${depth} microtasks after the last await`).toBe(2);
    }
  });
});
