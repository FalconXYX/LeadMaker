// Assistant limits (§7.10). Redis keys live under `ai:`; user days are sales-team (America/New_York) days.
//   per user:  minute token bucket (pre-stream 429), concurrent streams (429), daily requests and tokens (SSE error),
//              daily provider calls (the user's share of the global budget: callBudget wraps each model's budget)
//   global:    provider RPM bucket (wait <= 2 s, else ai_rate_limited) and RPD counter (over budget -> the provider
//              is marked exhausted until its quota day resets: midnight Pacific for Gemini, UTC otherwise)
// When Redis is unreachable every operation falls back to in-memory counters in this instance: per-user limits fail
// open across instances, and the global budget becomes this instance's own (it also counts every call it made).
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { UserLimitReached, type ProviderBudget } from './engine.ts';
import type { Logger } from './log.ts';
import { LlmQuotaExceeded, LlmRateLimited } from './llm/types.ts';
import { PACIFIC_TZ, SALES_TZ, dateIn, nextMidnight } from './time.ts';

export interface BucketDecision { allowed: boolean; retryAfterMs: number }

/** The few counter operations the limits need; Redis-backed, in-memory, or Redis with in-memory fallback. */
export interface CounterStore {
  bucket(key: string, ratePerSecond: number, burst: number): Promise<BucketDecision>;
  incrBy(key: string, n: number, ttlMs: number): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Same token bucket as the gateway's (Redis server time, one round trip): {allowed, ms until the next token}.
const TOKEN_BUCKET = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return {allowed, wait}
`;
const TOKEN_BUCKET_SHA = createHash('sha1').update(TOKEN_BUCKET).digest('hex');

// INCRBY that sets the TTL on first use (and keeps a TTL if one got lost).
const INCR_TTL = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v
`;
const INCR_TTL_SHA = createHash('sha1').update(INCR_TTL).digest('hex');

export class RedisStore implements CounterStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async #script(sha: string, src: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await this.#redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!String(err).includes('NOSCRIPT')) throw err;
      return this.#redis.eval(src, keys.length, ...keys, ...args);
    }
  }

  async bucket(key: string, ratePerSecond: number, burst: number): Promise<BucketDecision> {
    const [allowed, wait] = (await this.#script(TOKEN_BUCKET_SHA, TOKEN_BUCKET, [key], [ratePerSecond, burst])) as number[];
    return { allowed: allowed === 1, retryAfterMs: Number(wait) };
  }

  async incrBy(key: string, n: number, ttlMs: number): Promise<number> {
    return Number(await this.#script(INCR_TTL_SHA, INCR_TTL, [key], [Math.round(n), Math.round(ttlMs)]));
  }

  async decr(key: string): Promise<number> {
    const v = await this.#redis.decr(key);
    if (v < 0) await this.#redis.set(key, '0', 'KEEPTTL');
    return Math.max(0, v);
  }

  async get(key: string): Promise<string | null> {
    return this.#redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.#redis.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)));
  }

  async del(key: string): Promise<void> {
    await this.#redis.del(key);
  }
}

export class MemoryStore implements CounterStore {
  readonly #now: () => number;
  readonly #values = new Map<string, { value: string; expires: number }>();
  readonly #buckets = new Map<string, { tokens: number; ts: number }>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #read(key: string): string | null {
    const e = this.#values.get(key);
    if (!e) return null;
    if (e.expires <= this.#now()) {
      this.#values.delete(key);
      return null;
    }
    return e.value;
  }

  async bucket(key: string, ratePerSecond: number, burst: number): Promise<BucketDecision> {
    const now = this.#now();
    const s = this.#buckets.get(key) ?? { tokens: burst, ts: now };
    s.tokens = Math.min(burst, s.tokens + (Math.max(0, now - s.ts) * ratePerSecond) / 1000);
    s.ts = now;
    this.#buckets.set(key, s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil(((1 - s.tokens) * 1000) / ratePerSecond) };
  }

  async incrBy(key: string, n: number, ttlMs: number): Promise<number> {
    const cur = this.#read(key);
    const e = this.#values.get(key);
    const v = Number(cur ?? 0) + n;
    this.#values.set(key, { value: String(v), expires: cur !== null && e ? e.expires : this.#now() + ttlMs });
    return v;
  }

  async decr(key: string): Promise<number> {
    const cur = this.#read(key);
    if (cur === null) return 0;
    const v = Math.max(0, Number(cur) - 1);
    this.#values.get(key)!.value = String(v);
    return v;
  }

  async get(key: string): Promise<string | null> {
    return this.#read(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#values.set(key, { value, expires: this.#now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.#values.delete(key);
    this.#buckets.delete(key);
  }
}

/** Redis first; on any Redis error the in-memory store answers (warned at most once a minute). */
export class FallbackStore implements CounterStore {
  readonly #primary: CounterStore;
  readonly #memory: CounterStore;
  readonly #log?: Logger;
  #warnedAt = 0;

  constructor(primary: CounterStore, memory: CounterStore = new MemoryStore(), log?: Logger) {
    this.#primary = primary;
    this.#memory = memory;
    this.#log = log;
  }

  async #run<T>(op: (s: CounterStore) => Promise<T>): Promise<T> {
    try {
      return await op(this.#primary);
    } catch (err) {
      if (Date.now() - this.#warnedAt > 60_000) {
        this.#warnedAt = Date.now();
        this.#log?.warn({ err: (err as Error)?.message }, 'redis unavailable; assistant limits use in-memory counters');
      }
      return op(this.#memory);
    }
  }

  bucket(key: string, r: number, b: number) { return this.#run((s) => s.bucket(key, r, b)); }
  incrBy(key: string, n: number, ttl: number) { return this.#run((s) => s.incrBy(key, n, ttl)); }
  decr(key: string) { return this.#run((s) => s.decr(key)); }
  get(key: string) { return this.#run((s) => s.get(key)); }
  set(key: string, v: string, ttl: number) { return this.#run((s) => s.set(key, v, ttl)); }
  del(key: string) { return this.#run((s) => s.del(key)); }
}

// ---- per user ---------------------------------------------------------------------------------------------

export interface UserLimitsConfig {
  perMinute: number;
  /** Bucket capacity (requests allowed back to back). */
  burst: number;
  maxStreams: number;
  perDay: number;
  tokensPerDay: number;
  /** Provider calls a day (the user's share of the global budget); 0 = no per-user call cap. */
  callsPerDay?: number;
}

const DAY_TTL_MS = 48 * 3600_000;
const STREAM_TTL_MS = 120_000;

export class UserLimits {
  readonly #store: CounterStore;
  readonly cfg: UserLimitsConfig;

  constructor(store: CounterStore, cfg: UserLimitsConfig) {
    this.#store = store;
    this.cfg = cfg;
  }

  /** One request from the per-minute bucket. */
  minute(userId: string): Promise<BucketDecision> {
    return this.#store.bucket(`ai:rl:user:${userId}`, this.cfg.perMinute / 60, Math.max(1, this.cfg.burst));
  }

  /** Claims a stream slot; release() frees it (idempotent). */
  async openStream(userId: string): Promise<{ allowed: boolean; release: () => Promise<void> }> {
    const key = `ai:streams:${userId}`;
    const n = await this.#store.incrBy(key, 1, STREAM_TTL_MS);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.#store.decr(key).catch(() => 0);
    };
    if (n > this.cfg.maxStreams) {
      await release();
      return { allowed: false, release: async () => {} };
    }
    return { allowed: true, release };
  }

  #day(userId: string, now: Date): string {
    return `${userId}:${dateIn(SALES_TZ, now)}`;
  }

  /** Counts this request; over = the daily request or token cap is already reached. */
  async countRequest(userId: string, now: Date): Promise<{ requests: number; over: boolean }> {
    const requests = await this.#store.incrBy(`ai:day:user:${this.#day(userId, now)}`, 1, DAY_TTL_MS);
    const tokens = Number(await this.#store.get(`ai:tok:user:${this.#day(userId, now)}`) ?? 0);
    return { requests, over: requests > this.cfg.perDay || tokens >= this.cfg.tokensPerDay };
  }

  async addTokens(userId: string, tokens: number, now: Date): Promise<void> {
    if (tokens > 0) await this.#store.incrBy(`ai:tok:user:${this.#day(userId, now)}`, tokens, DAY_TTL_MS);
  }

  async usedToday(userId: string, now: Date): Promise<number> {
    return Number(await this.#store.get(`ai:day:user:${this.#day(userId, now)}`) ?? 0);
  }

  /** Provider calls this user made today (every tool round and retry counts). */
  async callsToday(userId: string, now: Date): Promise<number> {
    return Number(await this.#store.get(`ai:calls:user:${this.#day(userId, now)}`) ?? 0);
  }

  /**
   * The budget one request uses: the user's daily provider-call share first (UserLimitReached when spent, without
   * touching the global budget), then the model's global budget, then the call is counted against the user.
   * Requests count once (countRequest) but can make up to maxToolRounds calls each, so the share is in calls.
   */
  callBudget(userId: string, inner: ProviderBudget | null, now: () => Date = () => new Date()): ProviderBudget {
    const key = () => `ai:calls:user:${this.#day(userId, now())}`;
    const cap = this.cfg.callsPerDay ?? 0;
    const store = this.#store;
    return {
      async acquire(signal?: AbortSignal) {
        if (cap > 0 && Number(await store.get(key()) ?? 0) >= cap) throw new UserLimitReached('daily AI call share used');
        await inner?.acquire(signal);
        if (cap > 0) await store.incrBy(key(), 1, DAY_TTL_MS);
      },
      async reportQuotaExhausted(resetsAt: Date | null) {
        await inner?.reportQuotaExhausted(resetsAt);
      },
    };
  }
}

// ---- global provider budget --------------------------------------------------------------------------------

export interface BudgetConfig {
  /** Requests per minute across instances; 0 = off. */
  rpm: number;
  /** Requests per quota day; 0 = off. */
  rpd: number;
  /** IANA zone of the provider's quota day (Gemini: America/Los_Angeles). */
  dayTz: string;
  /** Longest wait for an RPM slot. */
  maxWaitMs?: number;
}

const BILLING_BACKOFF_MS = 15 * 60_000;

export class ProviderBudgetLimiter implements ProviderBudget {
  readonly #store: CounterStore;
  readonly #fp: string;
  readonly cfg: BudgetConfig;
  readonly #now: () => Date;

  constructor(store: CounterStore, fingerprint: string, cfg: BudgetConfig, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#fp = fingerprint;
    this.cfg = cfg;
    this.#now = now;
  }

  get exhaustedKey(): string {
    return `ai:prov:exhausted:${this.#fp}`;
  }

  /** When the provider's quota is known to be spent: until when (null = not exhausted). */
  async exhaustedUntil(): Promise<Date | null> {
    const v = await this.#store.get(this.exhaustedKey);
    if (!v) return null;
    const at = new Date(v);
    return Number.isFinite(at.getTime()) && at > this.#now() ? at : null;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const exhausted = await this.exhaustedUntil();
    if (exhausted) throw new LlmQuotaExceeded('provider budget exhausted', { provider: 'budget', resetsAt: exhausted });
    if (this.cfg.rpm > 0) {
      const maxWait = this.cfg.maxWaitMs ?? 2000;
      let decision = await this.#store.bucket(`ai:prov:rpm:${this.#fp}`, this.cfg.rpm / 60, this.cfg.rpm);
      if (!decision.allowed) {
        if (decision.retryAfterMs > maxWait) {
          throw new LlmRateLimited('provider per-minute budget', { provider: 'budget', retryAfterMs: decision.retryAfterMs });
        }
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, decision.retryAfterMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          }, { once: true });
        });
        decision = await this.#store.bucket(`ai:prov:rpm:${this.#fp}`, this.cfg.rpm / 60, this.cfg.rpm);
        if (!decision.allowed) {
          throw new LlmRateLimited('provider per-minute budget', { provider: 'budget', retryAfterMs: decision.retryAfterMs });
        }
      }
    }
    if (this.cfg.rpd > 0) {
      const now = this.#now();
      const resetsAt = nextMidnight(this.cfg.dayTz, now);
      const used = await this.#store.incrBy(`ai:prov:day:${this.#fp}:${dateIn(this.cfg.dayTz, now)}`, 1, resetsAt.getTime() - now.getTime() + 3600_000);
      if (used > this.cfg.rpd) {
        await this.#markExhausted(resetsAt);
        throw new LlmQuotaExceeded('provider daily budget used up', { provider: 'budget', resetsAt });
      }
    }
  }

  async reportQuotaExhausted(resetsAt: Date | null): Promise<void> {
    const now = this.#now();
    await this.#markExhausted(resetsAt && resetsAt > now ? resetsAt : new Date(now.getTime() + BILLING_BACKOFF_MS));
  }

  async #markExhausted(until: Date): Promise<void> {
    await this.#store.set(this.exhaustedKey, until.toISOString(), Math.max(1000, until.getTime() - this.#now().getTime()));
  }
}

/** The quota day of a provider: Gemini's free tier resets at midnight Pacific; others count UTC days. */
export function quotaDayTz(provider: string): string {
  return provider === 'gemini' ? PACIFIC_TZ : 'UTC';
}
