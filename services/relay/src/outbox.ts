import type { PrismaClient } from '@leadmaker/db';
import type { Redis } from 'ioredis';
import pg from 'pg';
import type { Logger } from 'pino';
import { entryFields, type OutboxRow } from './stream.ts';

export type PublishOptions = { stream: string; maxLen: number; batchSize: number };

/**
 * Claims up to batchSize unpublished rows (SKIP LOCKED, so concurrent relays never take the same
 * row), XADDs them in one MULTI and marks them published in the same transaction. If Redis fails
 * nothing is marked; if the commit fails after XADD the rows go out again (at-least-once).
 */
export async function publishBatch(db: PrismaClient, redis: Redis, opts: PublishOptions): Promise<number> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id::text AS id, event_type, company_id::text AS company_id, payload, created_at
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT ${opts.batchSize}
      FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return 0;
    const multi = redis.multi();
    for (const r of rows) multi.xadd(opts.stream, 'MAXLEN', '~', opts.maxLen, '*', ...entryFields(r));
    const results = await multi.exec();
    if (!results) throw new Error('XADD transaction was aborted');
    for (const [err] of results) if (err) throw err;
    await tx.$executeRaw`UPDATE outbox_events SET published_at = NOW() WHERE id = ANY(${rows.map((r) => r.id)}::bigint[])`;
    return rows.length;
  }, { maxWait: 10_000, timeout: 30_000 });
}

export type PublisherStats = { published: number; lastSuccessAt: Date | null; lastError: string | null };

/** Drains the outbox whenever woken (LISTEN 'outbox_events') and on a fallback poll. */
export class OutboxPublisher {
  readonly stats: PublisherStats = { published: 0, lastSuccessAt: null, lastError: null };
  private running = false;
  private woken = false;
  private interrupt?: () => void;
  private loop?: Promise<void>;
  private db: PrismaClient;
  private redis: Redis;
  private opts: PublishOptions & { pollIntervalMs: number };
  private log: Logger;

  constructor(db: PrismaClient, redis: Redis, opts: PublishOptions & { pollIntervalMs: number }, log: Logger) {
    this.db = db;
    this.redis = redis;
    this.opts = opts;
    this.log = log;
  }

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.interrupt?.();
    await this.loop;
  }

  wake(): void {
    this.woken = true;
    this.interrupt?.();
  }

  /** Publishes until the outbox is empty; returns the number of rows published. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await publishBatch(this.db, this.redis, this.opts);
      total += n;
      if (n < this.opts.batchSize) return total;
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      this.woken = false;
      try {
        const n = await this.drain();
        this.stats.published += n;
        this.stats.lastSuccessAt = new Date();
        this.stats.lastError = null;
        failures = 0;
        if (n) this.log.debug({ published: n }, 'outbox published');
      } catch (err) {
        failures++;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.log.error({ err }, 'outbox publish failed');
      }
      if (this.woken || !this.running) continue;
      const delay = failures ? Math.min(this.opts.pollIntervalMs * 2 ** failures, 30_000) : this.opts.pollIntervalMs;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.interrupt = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.interrupt = undefined;
    }
  }
}

/** LISTEN on 'outbox_events' with reconnects; a missed notification only costs one poll interval. */
export function listenForOutbox(url: string, onNotify: () => void, log: Logger): { close(): Promise<void> } {
  let client: pg.Client | undefined;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const connect = async (attempt: number) => {
    const c = new pg.Client({ connectionString: url });
    c.on('notification', onNotify);
    c.on('error', (err) => {
      log.warn({ err: err.message }, 'outbox LISTEN connection lost');
      reconnect(1);
    });
    try {
      await c.connect();
      await c.query('LISTEN outbox_events');
      if (closed) {
        await c.end();
        return;
      }
      client = c;
      onNotify();
    } catch (err) {
      log.warn({ err: (err as Error).message, attempt }, 'outbox LISTEN failed');
      c.end().catch(() => {});
      reconnect(attempt + 1);
    }
  };
  const reconnect = (attempt: number) => {
    if (closed || retry) return;
    client?.end().catch(() => {});
    client = undefined;
    retry = setTimeout(() => {
      retry = undefined;
      void connect(attempt);
    }, Math.min(1000 * 2 ** attempt, 30_000));
  };

  void connect(0);
  return {
    async close() {
      closed = true;
      clearTimeout(retry);
      await client?.end().catch(() => {});
    },
  };
}
