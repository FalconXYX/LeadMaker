import type { PrismaClient } from '@leadmaker/db';
import { dueTaskDrafts, loadContext, RULES } from './rules.ts';
import { writeDrafts, type Draft, type Written } from './store.ts';
import type { NotifierEvent } from './stream.ts';

/**
 * Turns a batch of events into notifications in one transaction. Each outbox id is claimed in
 * notifier_processed_events first, so a redelivered event (relay republish, consumer crash before XACK)
 * writes nothing twice; a failure rolls the claims back with everything else.
 */
export async function processEvents(db: PrismaClient, events: NotifierEvent[]): Promise<Written[]> {
  const relevant = events.filter((e) => Object.hasOwn(RULES, e.type));
  if (!relevant.length) return [];
  return db.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO notifier_processed_events (outbox_id)
      SELECT DISTINCT unnest(${relevant.map((e) => e.outboxId)}::bigint[])
      ON CONFLICT (outbox_id) DO NOTHING
      RETURNING outbox_id::text AS id`;
    const fresh = new Set(claimed.map((r) => r.id));
    const todo = relevant.filter((e) => fresh.delete(e.outboxId));
    if (!todo.length) return [];
    const ctx = await loadContext(tx, todo);
    const drafts: Draft[] = [];
    for (const e of todo) drafts.push(...await RULES[e.type](e, ctx));
    return writeDrafts(tx, drafts);
  }, { maxWait: 10_000, timeout: 60_000 });
}

/**
 * The task_due pass (every few minutes): notifies assignees of open tasks that came due. One instance at a time
 * (advisory lock); drafts are 'once', so a rerun or an overlapping instance writes nothing twice.
 */
export async function processDueTasks(db: PrismaClient, now = new Date()): Promise<Written[]> {
  return db.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('notifier:task_due', 0)) AS locked`;
    if (!locked) return [];
    return writeDrafts(tx, await dueTaskDrafts(tx, now));
  }, { maxWait: 10_000, timeout: 60_000 });
}

/** Drops processed-event claims past retention, state for overrides that are gone, and old read notifications. */
export async function prune(db: PrismaClient, retentionDays: number): Promise<number> {
  const [a, b, c] = await Promise.all([
    db.$executeRaw`DELETE FROM notifier_processed_events WHERE processed_at < NOW() - make_interval(days => ${retentionDays})`,
    db.$executeRaw`
      DELETE FROM notifier_state s WHERE s.key LIKE 'override:%'
        AND NOT EXISTS (SELECT 1 FROM field_overrides o WHERE 'override:' || o.id::text = s.key AND o.superseded_at IS NULL)`,
    db.$executeRaw`DELETE FROM notifications WHERE read_at < NOW() - INTERVAL '90 days'`,
  ]);
  return a + b + c;
}
