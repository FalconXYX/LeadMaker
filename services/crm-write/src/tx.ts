import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Prisma, type PrismaClient } from '@leadmaker/db';
import {
  cacheKeys, canView, canWrite, READ_YOUR_WRITES_TTL_SECONDS, type EventType, type SalesStage, type UserRef,
} from '@leadmaker/shared';
import type { Actor } from './auth.ts';
import { forbidden, HttpError, isUuid, notFound, pgCode } from './http.ts';

export type Tx = Prisma.TransactionClient;
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type LeadRow = {
  id: string;
  assigned_rep_id: string | null;
  version: number;
  updated_at: Date;
  last_material_change_at: Date | null;
  sales_stage: SalesStage;
};

// deadlock_detected, serialization_failure: the transaction was rolled back and is safe to rerun.
const RETRYABLE = new Set(['40P01', '40001']);
const ATTEMPTS = 3;

/**
 * Runs fn in one transaction (rerun on deadlock), then marks the user's next reads for the primary
 * ('rw:{userId}', 5 s) so the query service never serves them a replica that lacks their own edit.
 */
export function writer(db: PrismaClient, redis: Redis | null, log: Logger) {
  return async <T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    let out: T;
    for (let attempt = 1; ; attempt++) {
      try {
        out = await db.$transaction(fn, { maxWait: 5000, timeout: 20000 });
        break;
      } catch (err) {
        const code = pgCode(err);
        if (!code || !RETRYABLE.has(code) || attempt >= ATTEMPTS) throw err;
        log.warn({ code, attempt }, 'write transaction rolled back; retrying');
      }
    }
    if (redis) {
      await redis.set(cacheKeys.readYourWrites(actor.id), Date.now().toString(), 'EX', READ_YOUR_WRITES_TTL_SECONDS)
        .catch((err: unknown) => log.warn({ err }, 'read-your-writes marker not set'));
    }
    return out;
  };
}

/**
 * Locks the lead row for the rest of the transaction and applies the visibility rule: a lead the
 * actor cannot see is 404, one they can see but not act on is 403. 'update' is for transactions
 * that later UPDATE companies (avoids share-lock upgrade deadlocks); 'share' blocks a concurrent
 * reassignment while an append-only row is written.
 */
export async function lockLead(tx: Tx, id: string, actor: Actor, lock: 'share' | 'update'): Promise<LeadRow> {
  if (!isUuid(id)) throw notFound();
  const mode = lock === 'update' ? Prisma.sql`FOR NO KEY UPDATE` : Prisma.sql`FOR SHARE`;
  const [lead] = await tx.$queryRaw<LeadRow[]>(Prisma.sql`
    SELECT id, assigned_rep_id, version, updated_at, last_material_change_at, sales_stage
    FROM companies WHERE id = ${id}::uuid ${mode}`);
  if (!lead || !canView(actor, lead.assigned_rep_id)) throw notFound();
  if (!canWrite(actor, lead.assigned_rep_id)) throw forbidden('lead is not allocated to you');
  return lead;
}

/** Bumps companies.version for a child-table change (contacts, overrides, tags); the trigger keeps it single. */
export async function bumpCompany(tx: Tx, id: string): Promise<{ version: number; updated_at: Date }> {
  const [row] = await tx.$queryRaw<{ version: number; updated_at: Date }[]>(Prisma.sql`
    UPDATE companies SET version = version + 1 WHERE id = ${id}::uuid RETURNING version, updated_at`);
  return row;
}

/**
 * Section 4: a write that can change a lead's AI-insight inputs (notes, calls/emails/visits, overrides, contacts,
 * custom fields and tags, stage) queues an `insights` job for that lead in the same transaction. The job waits
 * delaySeconds, so a burst of edits merges into one (dedupe key insights:company:<id>), and the worker regenerates only
 * if the lead's input_hash really changed (a task edit costs no model call). Off unless LEADMAKER_INSIGHTS_ON_EDIT=1.
 */
export type InsightsHook = { enabled: boolean; delaySeconds: number };
let insightsHook: InsightsHook = { enabled: false, delaySeconds: 60 };
const INSIGHT_EVENTS = new Set<string>(['note.added', 'override.set', 'lead.updated', 'tags.changed', 'state.changed']);

export function configureInsightsHook(hook: InsightsHook): void {
  insightsHook = hook;
}

export async function queueInsights(tx: Tx, companyId: string, delaySeconds = insightsHook.delaySeconds): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO jobs (kind, params, dedupe_key, priority, run_after)
    VALUES ('insights', jsonb_build_object('company_ids', jsonb_build_array(${companyId}::text)),
            ${`insights:company:${companyId}`}, 150, now() + make_interval(secs => ${delaySeconds}::float8))
    ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING`);
}

export async function emit(
  tx: Tx, actor: Actor, type: Exclude<EventType, 'pipeline.run_completed'>, companyId: string | null, data: Record<string, Json>,
): Promise<void> {
  const payload = {
    ...(companyId ? { company_id: companyId } : {}), ...data, actor_type: 'user', actor_id: actor.id, actor_name: actor.name,
  };
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO outbox_events (event_type, company_id, payload)
    VALUES (${type}, ${companyId}::uuid, ${JSON.stringify(payload)}::jsonb)`);
  // A checked/serviced toggle is a state change too, but only a logged activity is an insight input.
  if (insightsHook.enabled && companyId && INSIGHT_EVENTS.has(type) && (type !== 'state.changed' || data.activity_id)) {
    await queueInsights(tx, companyId);
  }
}

export type ActivityRow = { id: string; created_at: Date };

/** created_at is clock_timestamp(), taken after the lead lock, so a lead's feed follows commit order. */
export async function logActivity(
  tx: Tx, actor: Actor, companyId: string, actionType: string,
  extra: { outcome?: string | null; noteText?: string | null; fieldDiff?: Record<string, Json> | null } = {},
): Promise<ActivityRow> {
  const diff = extra.fieldDiff ? JSON.stringify(extra.fieldDiff) : null;
  const [row] = await tx.$queryRaw<ActivityRow[]>(Prisma.sql`
    INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, outcome, note_text, field_diff, created_at)
    VALUES (${companyId}::uuid, 'user', ${actor.id}::uuid, ${actionType}, ${extra.outcome ?? null},
            ${extra.noteText ?? null}, ${diff}::jsonb, clock_timestamp())
    RETURNING id, created_at`);
  return row;
}

type ChangedBy = { type: 'user' | 'pipeline' | 'system'; id: string | null; name: string | null; at: Date };

// Activity rows that change what a versioned read shows (state and notes do not bump versions).
const VERSIONED_ACTIONS = ['override', 'contact', 'custom_field', 'custom_tag', 'allocation', 'scraped_change', 'stage_changed'];

/** Who made the most recent versioned change: a user's activity row or a pipeline audit event. */
async function lastChangedBy(tx: Tx, companyId: string, contactId: string | null): Promise<ChangedBy | null> {
  const activity = contactId
    ? Prisma.sql`a.action_type IN ('override', 'contact') AND a.field_diff->>'contact_id' = ${contactId}`
    : Prisma.sql`a.action_type IN (${Prisma.join(VERSIONED_ACTIONS)})`;
  // Pipeline audit rows name a contact by its source_key; rep-added contacts have none.
  const audit = contactId
    ? Prisma.sql`AND e.entity_type = 'contact' AND e.entity_id = (SELECT source_key FROM contacts WHERE id = ${contactId}::uuid)`
    : Prisma.empty;
  const [row] = await tx.$queryRaw<ChangedBy[]>(Prisma.sql`
    SELECT type, id, name, at FROM (
      (SELECT a.actor_type AS type, a.user_id AS id, u.name, a.created_at AS at
         FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.company_id = ${companyId}::uuid AND ${activity}
        ORDER BY a.created_at DESC LIMIT 1)
      UNION ALL
      (SELECT e.actor_type, e.actor_id, u.name, e.at
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.company_id = ${companyId}::uuid ${audit}
        ORDER BY e.at DESC LIMIT 1)
    ) latest ORDER BY at DESC LIMIT 1`);
  return row ?? null;
}

/**
 * 409 for a stale version (shared VersionConflict): the current value, who made the last change
 * (changedBy is null when it was the pipeline; changedByType says which) and when the version moved.
 */
export async function conflict(
  tx: Tx, target: { companyId: string; contactId?: string },
  current: Record<string, Json>,
): Promise<HttpError> {
  const contactId = target.contactId ?? null;
  const [row] = contactId
    ? await tx.$queryRaw<{ version: number; updated_at: Date }[]>(Prisma.sql`
        SELECT version, updated_at FROM contacts WHERE id = ${contactId}::uuid`)
    : await tx.$queryRaw<{ version: number; updated_at: Date }[]>(Prisma.sql`
        SELECT version, updated_at FROM companies WHERE id = ${target.companyId}::uuid`);
  const by = await lastChangedBy(tx, target.companyId, contactId);
  const changedBy: UserRef | null = by?.type === 'user' && by.id ? { id: by.id, name: by.name ?? '' } : null;
  return new HttpError(409, {
    error: 'version_conflict',
    current: { version: row.version, ...current },
    changedBy,
    changedByType: by?.type ?? null,
    changedAt: row.updated_at.toISOString(),
  });
}
