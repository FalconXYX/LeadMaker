import type { PrismaClient } from '@leadmaker/db';
import { cacheKeys, KPI_EVENTS, LIST_CHANGING_EVENTS, type EventType } from '@leadmaker/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { VersionCoalescer } from './coalesce.ts';
import { deleteMatching } from './kpis.ts';
import { parseEntry, type StreamEvent } from './stream.ts';

// These change a lead's notes or per-user state without bumping companies.version, so the current
// version's profile entry is dropped too, in case it embeds them.
const UNVERSIONED_CHANGES = new Set(['note.added', 'state.changed']);
const movesKpis = (type: string) => KPI_EVENTS.includes(type as EventType);
const movesLists = (type: string) => LIST_CHANGING_EVENTS.includes(type as EventType);
// Events that can move team_dashboard_kpis (an activity is a state.changed); one refresh per burst.
const TEAM_KPI_EVENTS = new Set(['lead.allocated', 'state.changed', 'note.added', 'pipeline.run_completed']);

export type InvalidationDeps = {
  db: PrismaClient;
  redis: Redis;
  /** How many versions below the current one to delete (older entries expire by TTL). */
  versionWindow: number;
  /** Called once per batch holding TEAM_KPI_EVENTS (debounced team_dashboard_kpis refresh). */
  onTeamKpiChange: (type: string) => void;
  /** Holds back bumps of the shared list versions (all, pool); without it every bump goes out at once. */
  coalescer?: VersionCoalescer;
};

/**
 * The list versions (cacheKeys.leadsVersion*) a batch moves: 'all' always; per listed lead its current
 * owner's 'rep:{id}', or 'pool' when unallocated; for allocations also the owner before (payload, else
 * the last ended allocation) and 'pool' when the lead came from or went to it. An event that may touch
 * leads it does not list, or a lead that no longer exists, moves 'pool' and every rep holding leads.
 */
async function listVersionBumps(
  events: StreamEvent[], byId: Map<string, { assigned_rep_id: string | null }>, previous: { rep_id: string }[], db: PrismaClient,
): Promise<Set<string>> {
  const bumps = new Set<string>([cacheKeys.leadsVersionAll]);
  const owner = (rep: string | null) => (rep ? cacheKeys.leadsVersionRep(rep) : cacheKeys.leadsVersionPool);
  let coarse = false;
  for (const e of events.filter((e) => movesLists(e.type))) {
    coarse ||= e.incomplete;
    for (const id of e.companyIds) {
      const c = byId.get(id);
      if (c) bumps.add(owner(c.assigned_rep_id));
      else coarse = true;
    }
    if (e.type === 'lead.allocated') {
      if (e.assignedRepId !== undefined) bumps.add(owner(e.assignedRepId));
      bumps.add(owner(e.previousRepId ?? null));
    }
  }
  for (const p of previous) bumps.add(owner(p.rep_id));
  if (coarse) {
    bumps.add(cacheKeys.leadsVersionPool);
    const reps = await db.$queryRaw<{ id: string }[]>`
      SELECT u.id::text FROM users u WHERE EXISTS (SELECT 1 FROM companies c WHERE c.assigned_rep_id = u.id)`;
    for (const r of reps) bumps.add(owner(r.id));
  }
  return bumps;
}

/**
 * Cache effects of a batch of events; idempotent, so redelivery is harmless:
 * - INCR each list version the batch moves, once (listVersionBumps): those cached list pages become
 *   unreachable, other reps' stay; 'all' and 'pool' at most once per coalescing window (deps.coalescer),
 * - DEL lead:{id}:v{n} for versions below the lead's current one,
 * - for KPI_EVENTS: DEL kpi:rep:{user} for everyone the change touches (current and previous
 *   assignee, users named in the payload); kpi:team only changes with the view, so the refresher
 *   drops it after each refresh,
 * - TEAM_KPI_EVENTS: schedule a team_dashboard_kpis refresh (debounced, so the runs of one refresh
 *   job cost one),
 * - pipeline.run_completed: DEL every kpi:rep:*.
 * Batch-insights writes (lead.updated with fields ['insights'], Section 4) are skipped: they don't bump
 * companies.version and no list, KPI or cached profile body holds an insight (the profile reads it per request),
 * so a 424-lead batch must not churn every list cache.
 */
export async function invalidate(batch: StreamEvent[], deps: InvalidationDeps): Promise<void> {
  const events = batch.filter((e) => !e.insightsOnly);
  if (!events.length) return;
  const { db, redis, versionWindow } = deps;
  const companyIds = [...new Set(events.flatMap((e) => e.companyIds))];
  const reallocated = [...new Set(events.filter((e) => e.type === 'lead.allocated').flatMap((e) => e.companyIds))];

  const [companies, previous] = await Promise.all([
    companyIds.length
      ? db.companies.findMany({ where: { id: { in: companyIds } }, select: { id: true, assigned_rep_id: true, version: true } })
      : [],
    reallocated.length
      ? db.$queryRaw<{ rep_id: string }[]>`
          SELECT DISTINCT ON (company_id) rep_id::text
          FROM lead_allocations
          WHERE company_id = ANY(${reallocated}::uuid[]) AND ended_at IS NOT NULL
          ORDER BY company_id, ended_at DESC`
      : [],
  ]);

  const byId = new Map(companies.map((c) => [c.id, c]));
  const keys = new Set<string>();
  for (const e of events) {
    for (const id of e.companyIds) {
      const top = Math.max(byId.get(id)?.version ?? 0, e.versions.get(id) ?? 0);
      if (!top) continue;
      for (let v = Math.max(1, top - versionWindow); v < top; v++) keys.add(cacheKeys.leadProfile(id, v));
      if (UNVERSIONED_CHANGES.has(e.type)) keys.add(cacheKeys.leadProfile(id, top));
    }
  }
  const kpiEvents = events.filter((e) => movesKpis(e.type));
  if (kpiEvents.length) {
    const users = new Set(kpiEvents.flatMap((e) => e.users));
    for (const e of kpiEvents) {
      for (const id of e.companyIds) {
        const rep = byId.get(id)?.assigned_rep_id;
        if (rep) users.add(rep);
      }
    }
    for (const p of previous) users.add(p.rep_id);
    for (const u of users) keys.add(cacheKeys.kpiRep(u));
  }
  const bumps = events.some((e) => movesLists(e.type)) ? await listVersionBumps(events, byId, previous, db) : new Set<string>();

  const tx = redis.multi();
  for (const k of deps.coalescer ? deps.coalescer.take(bumps) : bumps) tx.incr(k);
  for (let i = 0, all = [...keys]; i < all.length; i += 500) tx.unlink(...all.slice(i, i + 500));
  const results = await tx.exec();
  for (const [err] of results ?? []) if (err) throw err;

  if (events.some((e) => e.type === 'pipeline.run_completed')) await deleteMatching(redis, cacheKeys.kpiRep('*'));
  const teamChange = events.find((e) => TEAM_KPI_EVENTS.has(e.type));
  if (teamChange) deps.onTeamKpiChange(teamChange.type);
}

export type ConsumerOptions = { stream: string; group: string; consumer: string; claimIdleMs: number; blockMs?: number };
export type ConsumerStats = { processed: number; lastReadAt: Date | null; lastError: string | null };

type Entry = [id: string, fields: string[] | null];

/**
 * Consumer group 'cache-invalidation' on the events stream. Reads its own pending entries first
 * (after a crash), then new ones; entries left pending by a dead consumer are reclaimed with
 * XAUTOCLAIM once idle for claimIdleMs. Entries are acked only after their effects are applied.
 */
export class InvalidationConsumer {
  readonly stats: ConsumerStats = { processed: 0, lastReadAt: null, lastError: null };
  private running = false;
  private loop?: Promise<void>;
  private blocking: Redis;
  private deps: InvalidationDeps;
  private opts: ConsumerOptions;
  private log: Logger;

  /** `blocking` must be a dedicated connection: XREADGROUP BLOCK holds it. */
  constructor(blocking: Redis, deps: InvalidationDeps, opts: ConsumerOptions, log: Logger) {
    this.blocking = blocking;
    this.deps = deps;
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

  /**
   * After the group or the whole stream was deleted (XGROUP DESTROY, FLUSHDB, Redis restarted without
   * its data): recreate it at the end, as at startup. Entries written in between are not seen; the
   * caches they would have invalidated expire by TTL.
   */
  private async recreateGroup(): Promise<boolean> {
    this.log.warn({ stream: this.opts.stream, group: this.opts.group }, 'consumer group missing; recreating it');
    try {
      await this.ensureGroup();
      return true;
    } catch (err) {
      this.log.error({ err }, 'could not recreate the consumer group');
      return false;
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

  async handle(entries: Entry[]): Promise<void> {
    if (!entries.length) return;
    const events = entries
      .map(([id, fields]) => (fields ? parseEntry(id, fields) : null))
      .filter((e) => e !== null);
    await invalidate(events, this.deps);
    await this.blocking.xack(this.opts.stream, this.opts.group, ...entries.map(([id]) => id));
    this.stats.processed += entries.length;
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
    // Only after the effects are applied, so /healthz degrades while invalidation keeps failing.
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
        if (cursor !== '>') cursor = entries.length ? entries[entries.length - 1][0] : '>';
        this.stats.lastError = null;
      } catch (err) {
        if (!this.running) break;
        if (String(err).includes('NOGROUP') && (await this.recreateGroup())) {
          cursor = '0';
          continue;
        }
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.log.error({ err }, 'cache invalidation failed; retrying');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
