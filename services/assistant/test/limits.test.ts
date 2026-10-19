// Limits on both stores. The Redis suite runs with TEST_REDIS_URL (npm run test:db: redis://localhost:56379/9) and
// refuses db 0, because it deletes its own ai:* keys.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FallbackStore, MemoryStore, ProviderBudgetLimiter, RedisStore, UserLimits, quotaDayTz, type CounterStore,
} from '../src/limits.ts';
import { LlmQuotaExceeded, LlmRateLimited } from '../src/llm/types.ts';
import { NOW } from './helpers.ts';

const USER = { perMinute: 6, burst: 6, maxStreams: 2, perDay: 3, tokensPerDay: 1000 };

function suite(name: string, makeStore: () => CounterStore, prefix: () => string) {
  describe(name, () => {
    it('per-minute bucket: 6 back to back, the 7th waits ~10 s', async () => {
      const limits = new UserLimits(makeStore(), USER);
      const u = `${prefix()}u1`;
      for (let i = 0; i < 6; i++) expect((await limits.minute(u)).allowed).toBe(true);
      const seventh = await limits.minute(u);
      expect(seventh.allowed).toBe(false);
      expect(seventh.retryAfterMs).toBeGreaterThan(5000);
      expect(seventh.retryAfterMs).toBeLessThanOrEqual(10_000);
    });

    it('stream slots are released on close (idempotently)', async () => {
      const limits = new UserLimits(makeStore(), USER);
      const u = `${prefix()}u2`;
      const a = await limits.openStream(u);
      const b = await limits.openStream(u);
      const c = await limits.openStream(u);
      expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, false]);
      await a.release();
      await a.release();
      expect((await limits.openStream(u)).allowed).toBe(true);
      expect((await limits.openStream(u)).allowed).toBe(false);
    });

    it('daily requests and tokens', async () => {
      const limits = new UserLimits(makeStore(), USER);
      const u = `${prefix()}u3`;
      expect(await limits.countRequest(u, NOW)).toEqual({ requests: 1, over: false });
      await limits.addTokens(u, 999, NOW);
      expect((await limits.countRequest(u, NOW)).over).toBe(false);
      await limits.addTokens(u, 1, NOW);
      expect((await limits.countRequest(u, NOW)).over).toBe(true);
      expect(await limits.usedToday(u, NOW)).toBe(3);
      const v = `${prefix()}u4`;
      for (let i = 0; i < 3; i++) expect((await limits.countRequest(v, NOW)).over).toBe(false);
      expect((await limits.countRequest(v, NOW)).over).toBe(true);
      // Tomorrow (ET) starts over.
      expect((await limits.countRequest(v, new Date('2026-10-20T04:30:00Z'))).requests).toBe(1);
    });

    it('global RPD: over budget marks the provider exhausted until the Pacific midnight', async () => {
      const store = makeStore();
      const fp = `${prefix()}gemini:m`;
      const budget = new ProviderBudgetLimiter(store, fp, { rpm: 0, rpd: 2, dayTz: quotaDayTz('gemini') }, () => NOW);
      await budget.acquire();
      await budget.acquire();
      const err = await budget.acquire().catch((e) => e);
      expect(err).toBeInstanceOf(LlmQuotaExceeded);
      expect(err.resetsAt.toISOString()).toBe('2026-10-20T07:00:00.000Z');
      expect((await budget.exhaustedUntil())?.toISOString()).toBe('2026-10-20T07:00:00.000Z');
      await expect(budget.acquire()).rejects.toBeInstanceOf(LlmQuotaExceeded);
      await store.del(budget.exhaustedKey);
    });

    it('reportQuotaExhausted marks the provider until resetsAt (billing: 15 min)', async () => {
      const store = makeStore();
      const budget = new ProviderBudgetLimiter(store, `${prefix()}anthropic:m`, { rpm: 0, rpd: 0, dayTz: 'UTC' }, () => NOW);
      expect(await budget.exhaustedUntil()).toBeNull();
      await budget.reportQuotaExhausted(null);
      expect((await budget.exhaustedUntil())!.getTime()).toBe(NOW.getTime() + 15 * 60_000);
      await store.del(budget.exhaustedKey);
    });

    it('global RPM: waits up to 2 s for a slot, else rate limited', async () => {
      const store = makeStore();
      const fast = new ProviderBudgetLimiter(store, `${prefix()}gemini:rpm60`, { rpm: 60, rpd: 0, dayTz: 'UTC' });
      for (let i = 0; i < 60; i++) await fast.acquire();
      const t = Date.now();
      await fast.acquire(); // the next token is ~1 s away
      expect(Date.now() - t).toBeGreaterThanOrEqual(500);
      const slow = new ProviderBudgetLimiter(store, `${prefix()}gemini:rpm1`, { rpm: 1, rpd: 0, dayTz: 'UTC' });
      await slow.acquire();
      await expect(slow.acquire()).rejects.toBeInstanceOf(LlmRateLimited);
    });
  });
}

suite('limits (in memory)', () => new MemoryStore(), () => '');

describe('Redis down', () => {
  it('falls back to in-memory counters and keeps limiting', async () => {
    const broken: CounterStore = new Proxy({} as CounterStore, { get: () => async () => { throw new Error('ECONNREFUSED'); } });
    const warnings: string[] = [];
    const store = new FallbackStore(broken, new MemoryStore(), { warn: (_o: object, m: string) => warnings.push(m) } as never);
    const limits = new UserLimits(store, USER);
    for (let i = 0; i < 6; i++) expect((await limits.minute('u')).allowed).toBe(true);
    expect((await limits.minute('u')).allowed).toBe(false);
    expect(warnings).toEqual(['redis unavailable; assistant limits use in-memory counters']);
  });
});

const redisUrl = process.env.TEST_REDIS_URL;
describe.skipIf(!redisUrl)('limits (Redis)', () => {
  let redis: Redis;
  const run = `t${Date.now().toString(36)}:`;
  beforeAll(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    if (!redis.options.db) throw new Error('refusing Redis db 0: TEST_REDIS_URL must select another db');
  });
  afterAll(async () => {
    const keys = await redis.keys(`ai:*${run}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  it('connects', async () => {
    expect(await redis.ping()).toBe('PONG');
  });
  suite('limits (Redis store)', () => new RedisStore(redis), () => run);
  it('stores keys under ai: with TTLs', async () => {
    const limits = new UserLimits(new RedisStore(redis), USER);
    await limits.countRequest(`${run}ttl`, NOW);
    const key = `ai:day:user:${run}ttl:2026-10-19`;
    expect(await redis.get(key)).toBe('1');
    expect(await redis.pttl(key)).toBeGreaterThan(47 * 3600_000);
    const s = await limits.openStream(`${run}ttl`);
    expect(await redis.pttl(`ai:streams:${run}ttl`)).toBeGreaterThan(100_000);
    await s.release();
    expect(await redis.get(`ai:streams:${run}ttl`)).toBe('0');
  });
});
