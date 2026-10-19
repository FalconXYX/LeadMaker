// Redis read-through helpers. The cache is an optimisation: every failure (Redis down, slow, bad JSON)
// falls back to the normal read path instead of failing the request. After a Redis failure the cache is
// skipped for a cooldown, so a slow Redis costs at most one command timeout per request.
import { Redis } from 'ioredis';
import { cacheKeys, listVersion, listVersionKeys, type Viewer } from '@leadmaker/shared';
import type { Logger } from './log.ts';

export function createRedis(url: string, commandTimeoutMs = 250): Redis {
  // Fail fast while disconnected rather than queueing requests behind a reconnect.
  return new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: commandTimeoutMs, lazyConnect: false });
}

export interface CacheOptions {
  cooldownMs?: number;
  /** Degradation is logged at most once per this many ms, with the count since the last line. */
  logEveryMs?: number;
}

export class Cache {
  readonly redis: Redis;
  readonly log: Logger;
  private readonly cooldownMs: number;
  private readonly logEveryMs: number;
  private downUntil = 0;
  private lastLog = 0;
  private unlogged = 0;
  /** Cache operations that fell back (failed, or skipped during a cooldown) since start. */
  degraded = 0;

  constructor(redis: Redis, log: Logger, opts: CacheOptions = {}) {
    this.redis = redis;
    this.log = log;
    this.cooldownMs = opts.cooldownMs ?? 1000;
    this.logEveryMs = opts.logEveryMs ?? 10_000;
  }

  get available(): boolean {
    return Date.now() >= this.downUntil;
  }

  private degrade(op: string, key: string, err?: unknown): void {
    this.degraded++;
    this.unlogged++;
    if (err !== undefined) this.downUntil = Date.now() + this.cooldownMs;
    const now = Date.now();
    if (now - this.lastLog < this.logEveryMs) return;
    this.log.warn({ err: (err as Error | undefined)?.message, op, key, degraded: this.unlogged }, 'cache unavailable, reading uncached');
    this.lastLog = now;
    this.unlogged = 0;
  }

  /** Runs one Redis command, or returns `fallback` (without calling Redis during a cooldown). */
  private async call<T>(op: string, key: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    if (!this.available) {
      this.degrade(op, key);
      return fallback;
    }
    try {
      return await fn();
    } catch (err) {
      this.degrade(op, key, err);
      return fallback;
    }
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const v = await this.call<string | null>('get', key, null, () => this.redis.get(key));
    if (v === null) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  /** Fire and forget: the response does not wait for the cache fill. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    void this.call('set', key, null, () => this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
  }

  /** SET NX with a TTL: true for the one caller that took the key; false when it is taken or Redis is unavailable. */
  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    return this.call('set', key, false, async () => (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK');
  }

  async unlock(key: string): Promise<void> {
    await this.call('del', key, 0, () => this.redis.del(key));
  }

  /** The version part of the viewer's list keys (listVersionKeys, one MGET); null when unknown, so don't cache. */
  async listVersion(viewer: Viewer): Promise<string | null> {
    const keys = listVersionKeys(viewer);
    return this.call('mget', keys.join(' '), null, async () => listVersion(await this.redis.mget(...keys)));
  }

  /**
   * True for a few seconds after the user's own write. Unknown (Redis down or slow) counts as false: the read
   * takes the normal path (the replica) uncached, rather than sending every read to the primary.
   */
  async recentlyWrote(userId: string): Promise<boolean> {
    const key = cacheKeys.readYourWrites(userId);
    return this.call('exists', key, false, async () => (await this.redis.exists(key)) === 1);
  }
}
