import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Written } from './store.ts';
import { parseEntry, type NotifierEvent } from './stream.ts';

export type ConsumerOptions = {
  stream: string;
  group: string;
  consumer: string;
  claimIdleMs: number;
  maxAttempts: number;
  blockMs?: number;
};
export type ConsumerStats = { processed: number; notified: number; dropped: number; lastReadAt: Date | null; lastError: string | null };

type Entry = [id: string, fields: string[] | null];
export type Processor = (events: NotifierEvent[]) => Promise<Written[]>;

/**
 * Consumer group 'notifier' on the events stream, like the relay's cache consumer: own pending entries first,
 * then new ones; entries a dead consumer left pending are reclaimed with XAUTOCLAIM. Entries are acked only after
 * their notifications commit. A batch that fails is retried entry by entry while the database answers; an entry
 * that keeps failing (a bad event, not an outage) is logged and acked after maxAttempts.
 */
export class NotificationConsumer {
  readonly stats: ConsumerStats = { processed: 0, notified: 0, dropped: 0, lastReadAt: null, lastError: null };
  private running = false;
  private loop?: Promise<void>;
  private failures = new Map<string, number>();
  private blocking: Redis;
  private process: Processor;
  private healthy: () => Promise<boolean>;
  private opts: ConsumerOptions;
  private log: Logger;

  /** `blocking` must be a dedicated connection; `healthy` tells an outage (retry forever) from a bad event. */
  constructor(blocking: Redis, process: Processor, healthy: () => Promise<boolean>, opts: ConsumerOptions, log: Logger) {
    this.blocking = blocking;
    this.process = process;
    this.healthy = healthy;
    this.opts = opts;
    this.log = log;
  }

  /** Creates the group at the stream's end (and the stream) unless it exists. */
  async ensureGroup(): Promise<void> {
    try {
      await this.blocking.xgroup('CREATE', this.opts.stream, this.opts.group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.blocking.disconnect();
    await this.loop;
  }

  private async ack(ids: string[]): Promise<void> {
    if (ids.length) await this.blocking.xack(this.opts.stream, this.opts.group, ...ids);
  }

  async handle(entries: Entry[]): Promise<void> {
    if (!entries.length) return;
    const parsed = entries.map(([id, fields]) => ({ id, event: fields ? parseEntry(id, fields) : null }));
    const events = parsed.flatMap((p) => (p.event ? [p.event] : []));
    try {
      this.record(await this.process(events));
      await this.ack(entries.map(([id]) => id));
      this.stats.processed += entries.length;
      return;
    } catch (err) {
      if (!(await this.healthy())) throw err;
      this.log.warn({ err, entries: entries.length }, 'notification batch failed; retrying entry by entry');
    }
    for (const { id, event } of parsed) {
      try {
        if (event) this.record(await this.process([event]));
        this.failures.delete(id);
      } catch (err) {
        if (!(await this.healthy())) throw err;
        const n = (this.failures.get(id) ?? 0) + 1;
        if (n < this.opts.maxAttempts) {
          this.failures.set(id, n);
          this.log.warn({ err, streamId: id, attempt: n }, 'notification event failed; left pending');
          continue;
        }
        this.failures.delete(id);
        this.stats.dropped++;
        this.log.error({ err, streamId: id, type: event?.type, outboxId: event?.outboxId }, 'notification event dropped');
      }
      await this.ack([id]);
      this.stats.processed++;
    }
  }

  private record(written: Written[]) {
    this.stats.notified += written.length;
    if (written.length) this.log.debug({ notified: written.length }, 'notifications written');
  }

  async claimStale(): Promise<void> {
    let start = '0-0';
    do {
      const [next, entries] = (await this.blocking.xautoclaim(
        this.opts.stream, this.opts.group, this.opts.consumer, this.opts.claimIdleMs, start, 'COUNT', 100,
      )) as [string, Entry[]];
      await this.handle(entries);
      start = next;
    } while (start !== '0-0' && this.running);
  }

  /** One read: own pending entries from `cursor` ('0'), or new ones ('>'). Returns entries read. */
  async readOnce(cursor: string): Promise<Entry[]> {
    const { group, consumer, stream } = this.opts;
    const res = (cursor === '>'
      ? await this.blocking.xreadgroup('GROUP', group, consumer, 'COUNT', 200, 'BLOCK', this.opts.blockMs ?? 5000, 'STREAMS', stream, cursor)
      : await this.blocking.xreadgroup('GROUP', group, consumer, 'COUNT', 200, 'STREAMS', stream, cursor)
    ) as [string, Entry[]][] | null;
    const entries = res?.[0]?.[1] ?? [];
    await this.handle(entries);
    this.stats.lastReadAt = new Date();
    return entries;
  }

  private async run(): Promise<void> {
    let cursor = '0';
    let lastClaim = 0;
    while (this.running) {
      try {
        if (Date.now() - lastClaim >= this.opts.claimIdleMs / 2) {
          await this.claimStale();
          lastClaim = Date.now();
        }
        const entries = await this.readOnce(cursor);
        // Pending entries left after a failed pass are not re-read here; XAUTOCLAIM retries them once idle.
        if (cursor !== '>') cursor = entries.length ? entries[entries.length - 1][0] : '>';
        this.stats.lastError = null;
      } catch (err) {
        if (!this.running) break;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        if (String(err).includes('NOGROUP')) {
          // The stream or the group was deleted (e.g. Redis flushed): recreate it and carry on from the end.
          this.log.warn('consumer group missing; recreating it');
          const ok = await this.ensureGroup().then(() => true, (e) => {
            this.log.error({ err: e }, 'recreating the consumer group failed');
            return false;
          });
          cursor = '0';
          if (ok) continue;
        } else {
          this.log.error({ err }, 'notification consumer failed; retrying');
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
