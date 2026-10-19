import { cacheKeys } from '@leadmaker/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// Every manager's cached lists hang on 'all' and every rep's on 'pool', so under steady writes each bump of these
// orphans most of the list cache. Each rep's own counter only orphans that rep's lists and is never held.
export const COALESCED_VERSIONS: readonly string[] = [cacheKeys.leadsVersionAll, cacheKeys.leadsVersionPool];

/**
 * Bumps the shared list versions at most once per windowMs each. A bump after a quiet window goes out with its
 * batch; bumps inside the window collapse into one trailing INCR at the window's end, so the last change always
 * lands within windowMs. A failed trailing INCR is retried a window later. windowMs 0: nothing is held.
 */
export class VersionCoalescer {
  private readonly redis: Redis;
  private readonly windowMs: number;
  private readonly log: Logger;
  private readonly keys: ReadonlySet<string>;
  private readonly last = new Map<string, number>();
  private readonly held = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  /** INCRs held back into a trailing bump, since start. */
  coalesced = 0;

  constructor(redis: Redis, windowMs: number, log: Logger, keys: readonly string[] = COALESCED_VERSIONS) {
    this.redis = redis;
    this.windowMs = windowMs;
    this.log = log;
    this.keys = new Set(keys);
  }

  /** Of the versions a batch moves, those to INCR now; the rest are held for a trailing bump. */
  take(keys: Iterable<string>, now = Date.now()): string[] {
    const out: string[] = [];
    for (const key of keys) {
      if (!this.keys.has(key) || this.windowMs <= 0) {
        out.push(key);
        continue;
      }
      const last = this.last.get(key);
      if (this.held.has(key)) {
        this.coalesced++;
      } else if (last === undefined || now - last >= this.windowMs) {
        this.last.set(key, now);
        out.push(key);
      } else {
        this.coalesced++;
        this.hold(key, last + this.windowMs - now);
      }
    }
    return out;
  }

  /** At startup: a trailing bump a previous process held may have died with it. */
  async bumpAll(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.keys].map(async (key) => {
      this.last.set(key, now);
      await this.redis.incr(key);
    }));
  }

  /** Sends the held bumps now and holds no more (shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    const keys = [...this.held.keys()];
    for (const key of keys) clearTimeout(this.held.get(key));
    this.held.clear();
    await Promise.all(keys.map((key) => this.redis.incr(key).catch((err: unknown) => {
      this.log.warn({ err, key }, 'held list version bump lost at shutdown');
    })));
  }

  private hold(key: string, delayMs: number): void {
    if (this.stopped) return;
    this.held.set(key, setTimeout(() => void this.fire(key), Math.max(0, delayMs)));
  }

  private async fire(key: string): Promise<void> {
    this.held.delete(key);
    this.last.set(key, Date.now());
    try {
      await this.redis.incr(key);
    } catch (err) {
      this.log.warn({ err, key }, 'trailing list version bump failed; retrying');
      this.hold(key, this.windowMs);
    }
  }
}
