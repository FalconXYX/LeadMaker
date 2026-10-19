import type { PrismaClient } from '@leadmaker/db';
import { cacheKeys } from '@leadmaker/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** Deletes every key matching pattern (SCAN, never KEYS). */
export async function deleteMatching(redis: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    if (keys.length) deleted += await redis.unlink(...keys);
    cursor = next;
  } while (cursor !== '0');
  return deleted;
}

export type KpiStats = { refreshes: number; lastRefreshAt: Date | null; lastError: string | null };
export type KpiRefreshOptions = { intervalMs: number; debounceMs: number };

/**
 * REFRESH MATERIALIZED VIEW CONCURRENTLY team_dashboard_kpis on a timer, and debounceMs after the first
 * of a burst of changes (schedule: CRM writes, pipeline.run_completed), so a bulk allocation or the
 * runs of one refresh job cost one refresh. One refresh at a time: requests during a refresh coalesce
 * into one more; across relay replicas Postgres serialises refreshes on the view's lock. kpi:team,
 * which is built from the view alone, is dropped once each refresh has committed.
 */
export class KpiRefresher {
  readonly stats: KpiStats = { refreshes: 0, lastRefreshAt: null, lastError: null };
  private current?: Promise<void>;
  private again = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private db: PrismaClient;
  private redis: Redis;
  private opts: KpiRefreshOptions;
  private log: Logger;

  constructor(db: PrismaClient, redis: Redis, opts: KpiRefreshOptions, log: Logger) {
    this.db = db;
    this.redis = redis;
    this.opts = opts;
    this.log = log;
  }

  start(): void {
    this.timer = setInterval(() => void this.request('interval'), this.opts.intervalMs);
    void this.request('startup');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    await this.current;
  }

  /**
   * Refreshes debounceMs after the first call of a burst; later calls ride along. The window is
   * fixed, not sliding, so a steady stream of changes cannot postpone the refresh indefinitely.
   */
  schedule(reason: string): void {
    if (this.debounce || this.stopped) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.request(reason);
    }, this.opts.debounceMs);
  }

  request(reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          // The refresh snapshots after this point, so it covers every change seen so far.
          clearTimeout(this.debounce);
          this.debounce = undefined;
          await this.refreshOnce(reason);
        } while (this.again && !this.stopped);
      } finally {
        // In the same tick as the last check of `again`, so a request arriving now starts a new refresh.
        this.current = undefined;
      }
    })();
    return this.current;
  }

  private async refreshOnce(reason: string): Promise<void> {
    const started = Date.now();
    try {
      await this.db.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY team_dashboard_kpis');
      await this.redis.unlink(cacheKeys.kpiTeam);
      this.stats.refreshes++;
      this.stats.lastRefreshAt = new Date();
      this.stats.lastError = null;
      this.log.info({ reason, durationMs: Date.now() - started }, 'team_dashboard_kpis refreshed');
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.log.error({ err, reason }, 'team_dashboard_kpis refresh failed; retrying');
      this.schedule('retry');
    }
  }
}
