import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import {
  and, FilterError, filterConditions, leadFilterSchema, needsMyState, sql, zctaCentroid, zipFallbackSql,
  type AllocatedLead, type AllocationByFilterResult, type AllocationResult, type BulkUnallocateResult, type LeadFilter,
  type Point, type Sql, type UnallocateResult,
} from '@leadmaker/shared';
import { z } from 'zod';
import { actorOf, requireManager, type Actor } from '../auth.ts';
import { badRequest, forbidden, isUuid, notFound, parse, uuid } from '../http.ts';
import type { Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

const tooMany = (matched: number, max: number) => badRequest('too_many_leads', { matched, max });

const prismaSql = (q: Sql) => new Prisma.Sql(q.strings, q.values);

/** filter.near's centre as the list resolves it: the shipped ZCTA point, else the visible companies' mean location. */
async function nearCenter(tx: Tx, filter: LeadFilter, actor: Actor): Promise<Point | undefined> {
  if (!filter.near) return undefined;
  const known = zctaCentroid(filter.near.zip);
  if (known) return known;
  const [row] = await tx.$queryRaw<{ lat: number | null; lng: number | null }[]>(prismaSql(zipFallbackSql(filter.near.zip, actor)));
  return row?.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : undefined;
}

/**
 * Every lead the filter matches for the actor (the list's own conditions, packages/shared filterConditions,
 * visibility first), row-locked in id order like every allocation, so concurrent writers never deadlock.
 * More than max matches is refused with the true count, before any lock is taken.
 */
async function lockMatching(tx: Tx, filter: LeadFilter, actor: Actor, max: number): Promise<LockedLead[]> {
  let where: Sql;
  try {
    where = and(filterConditions(filter, { viewer: actor, center: await nearCenter(tx, filter, actor) }));
  } catch (err) {
    if (!(err instanceof FilterError)) throw err;
    throw err.status === 403 ? forbidden(err.message) : badRequest('invalid_filter', err.message);
  }
  const from = needsMyState(filter)
    ? sql`companies c LEFT JOIN lead_rep_state ms ON ms.company_id = c.id AND ms.user_id = ${actor.id}::uuid`
    : sql`companies c`;
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>(prismaSql(sql`SELECT count(*)::int AS n FROM ${from} WHERE ${where}`));
  if (n > max) throw tooMany(n, max);
  const rows = await tx.$queryRaw<LockedLead[]>(prismaSql(sql`
    SELECT c.id, c.assigned_rep_id FROM ${from} WHERE ${where} ORDER BY c.id FOR NO KEY UPDATE OF c`));
  // More may match once the locks are held (a concurrent write in between).
  if (rows.length > max) throw tooMany(rows.length, max);
  return rows;
}

async function assertRep(q: Pick<Tx, '$queryRaw'>, repId: string): Promise<void> {
  const [user] = await q.$queryRaw<{ role: string }[]>(Prisma.sql`SELECT role FROM users WHERE id = ${repId}::uuid`);
  if (user?.role !== 'rep') throw badRequest('invalid_rep', 'repId must be a user with role rep');
}

type LockedLead = { id: string; assigned_rep_id: string | null };

/** Row-locks the leads in id order (as every multi-lead writer does); any unknown id is 404 with the missing ones. */
async function lockIds(tx: Tx, ids: string[]): Promise<LockedLead[]> {
  const rows = await tx.$queryRaw<LockedLead[]>(Prisma.sql`
    SELECT id, assigned_rep_id FROM companies WHERE id = ANY(${ids}::uuid[])
    ORDER BY id FOR NO KEY UPDATE`);
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw notFound('not_found', { missing });
  return rows;
}

/**
 * Allocates or reassigns locked leads to a rep: ends each open lead_allocations row, opens the new one, sets
 * companies.assigned_rep_id (so the two never drift), and writes an activity row and a lead.allocated event
 * per lead; the previous rep's open tasks move along. Leads already with the rep are left alone.
 */
async function moveLeads(tx: Tx, actor: Actor, rows: LockedLead[], repId: string) {
  const changed = rows.filter((r) => r.assigned_rep_id !== repId);
  const unchanged = rows.filter((r) => r.assigned_rep_id === repId).map((r) => r.id);
  let allocated: AllocatedLead[] = [];
  if (changed.length) {
    const ids = changed.map((r) => r.id);
    // Ended first, in its own statement: the one-open-row unique index is checked row by row.
    // Times are clock_timestamp() (after the row locks), not now(): a transaction that began before a
    // concurrent allocation committed would otherwise end that allocation before it started.
    await tx.$executeRaw(Prisma.sql`
      UPDATE lead_allocations SET ended_at = clock_timestamp(), ended_by = ${actor.id}::uuid
      WHERE company_id = ANY(${ids}::uuid[]) AND ended_at IS NULL`);
    const prev = JSON.stringify(changed.map((r) => ({ company_id: r.id, previous_rep_id: r.assigned_rep_id })));
    allocated = await tx.$queryRaw<AllocatedLead[]>(Prisma.sql`
      WITH prev AS (
        SELECT * FROM jsonb_to_recordset(${prev}::jsonb) AS p(company_id uuid, previous_rep_id uuid)
      ), alloc AS (
        INSERT INTO lead_allocations (company_id, rep_id, allocated_by, allocated_at)
        SELECT company_id, ${repId}::uuid, ${actor.id}::uuid, clock_timestamp() FROM prev
      ), upd AS (
        UPDATE companies c SET assigned_rep_id = ${repId}::uuid, version = c.version + 1
        FROM prev WHERE c.id = prev.company_id
        RETURNING c.id, c.version, prev.previous_rep_id
      ), act AS (
        INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
        SELECT id, 'user', ${actor.id}::uuid, 'allocation',
               jsonb_build_object('assigned_rep_id', jsonb_build_array(previous_rep_id, ${repId}::uuid)), clock_timestamp()
        FROM upd
      ), evt AS (
        INSERT INTO outbox_events (event_type, company_id, payload)
        SELECT 'lead.allocated', id, jsonb_build_object(
          'company_id', id, 'rep_id', ${repId}::uuid, 'assigned_rep_id', ${repId}::uuid,
          'previous_rep_id', previous_rep_id, 'actor_type', 'user', 'actor_id', ${actor.id}::uuid,
          'actor_name', ${actor.name}::text, 'version', version)
        FROM upd
      )
      SELECT id AS "companyId", previous_rep_id AS "previousRepId", version FROM upd ORDER BY id`);
    // The open tasks of the rep a lead leaves go with it to the new rep (they could no longer open it).
    await tx.$executeRaw(Prisma.sql`
      UPDATE tasks t SET assignee_id = ${repId}::uuid, version = t.version + 1, updated_at = clock_timestamp()
      FROM jsonb_to_recordset(${prev}::jsonb) AS p(company_id uuid, previous_rep_id uuid)
      WHERE t.company_id = p.company_id AND t.assignee_id = p.previous_rep_id AND t.done_at IS NULL`);
  }
  return { allocated, unchanged };
}

/**
 * Returns locked leads to the unallocated pool, keeping their history, notes and overrides: ends each open
 * lead_allocations row, clears companies.assigned_rep_id, and writes an activity row and a lead.allocated event
 * (assigned_rep_id null) per lead. Leads already in the pool are left alone.
 */
async function releaseLeads(tx: Tx, actor: Actor, rows: LockedLead[]): Promise<BulkUnallocateResult> {
  const changed = rows.filter((r) => r.assigned_rep_id !== null);
  const unchanged = rows.filter((r) => r.assigned_rep_id === null).map((r) => r.id);
  if (!changed.length) return { unallocated: [], unchanged };
  await tx.$executeRaw(Prisma.sql`
    UPDATE lead_allocations SET ended_at = clock_timestamp(), ended_by = ${actor.id}::uuid
    WHERE company_id = ANY(${changed.map((r) => r.id)}::uuid[]) AND ended_at IS NULL`);
  const prev = JSON.stringify(changed.map((r) => ({ company_id: r.id, previous_rep_id: r.assigned_rep_id })));
  const unallocated = await tx.$queryRaw<UnallocateResult[]>(Prisma.sql`
    WITH prev AS (
      SELECT * FROM jsonb_to_recordset(${prev}::jsonb) AS p(company_id uuid, previous_rep_id uuid)
    ), upd AS (
      UPDATE companies c SET assigned_rep_id = NULL, version = c.version + 1
      FROM prev WHERE c.id = prev.company_id
      RETURNING c.id, c.version, prev.previous_rep_id
    ), act AS (
      INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
      SELECT id, 'user', ${actor.id}::uuid, 'allocation',
             jsonb_build_object('assigned_rep_id', jsonb_build_array(previous_rep_id, NULL)), clock_timestamp()
      FROM upd
    ), evt AS (
      INSERT INTO outbox_events (event_type, company_id, payload)
      SELECT 'lead.allocated', id, jsonb_build_object(
        'company_id', id, 'rep_id', NULL, 'assigned_rep_id', NULL, 'previous_rep_id', previous_rep_id, 'version', version,
        'actor_type', 'user', 'actor_id', ${actor.id}::uuid, 'actor_name', ${actor.name}::text)
      FROM upd
    )
    SELECT id AS "companyId", previous_rep_id AS "previousRepId", version FROM upd ORDER BY id`);
  return { unallocated, unchanged };
}

const allocateBody = z.object({ companyIds: z.array(uuid).min(1), repId: uuid });
const byFilterBody = z.object({ filter: leadFilterSchema, repId: uuid });
const releaseBody = z.object({ companyIds: z.array(uuid).min(1) });

export function allocationRoutes({ write, config }: Deps): Router {
  const r = Router();
  const max = config.maxBulkAllocation;

  r.post('/allocations', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const body = parse(allocateBody, req.body);
    const ids = [...new Set(body.companyIds)];
    if (ids.length > max) throw tooMany(ids.length, max);
    const out = await write(actor, async (tx) => {
      await assertRep(tx, body.repId);
      return moveLeads(tx, actor, await lockIds(tx, ids), body.repId);
    });
    res.json({ repId: body.repId, ...out } satisfies AllocationResult);
  });

  // Bulk-assigns everything a filter matches (cursor, limit and sort ignored), resolved and moved in one
  // transaction on the primary, so exactly the leads that match when it commits move.
  r.post('/allocations/by-filter', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const body = parse(byFilterBody, req.body);
    const out = await write(actor, async (tx) => {
      await assertRep(tx, body.repId);
      return moveLeads(tx, actor, await lockMatching(tx, body.filter, actor, max), body.repId);
    });
    const matched = out.allocated.length + out.unchanged.length;
    res.json({ repId: body.repId, ...out, missing: [], matched } satisfies AllocationByFilterResult);
  });

  // Returns a lead to the unallocated pool.
  r.delete('/allocations/:companyId', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const id = req.params.companyId;
    if (!isUuid(id)) throw notFound();
    const out = await write(actor, async (tx) => {
      const [lead] = await tx.$queryRaw<LockedLead[]>(Prisma.sql`
        SELECT id, assigned_rep_id FROM companies WHERE id = ${id}::uuid FOR NO KEY UPDATE`);
      if (!lead) throw notFound();
      if (!lead.assigned_rep_id) throw notFound('not_allocated');
      const { unallocated: [one] } = await releaseLeads(tx, actor, [lead]);
      return one satisfies UnallocateResult;
    });
    res.json(out);
  });

  // The single release for many leads in one transaction; leads already in the pool are reported, unknown ids are 404.
  r.delete('/allocations', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const ids = [...new Set(parse(releaseBody, req.body).companyIds)];
    if (ids.length > config.maxBulkUnallocate) throw tooMany(ids.length, config.maxBulkUnallocate);
    const out = await write(actor, async (tx) => releaseLeads(tx, actor, await lockIds(tx, ids)));
    res.json(out satisfies BulkUnallocateResult);
  });

  return r;
}
