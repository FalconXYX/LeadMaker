// Manager-only writes for the Territories page. A territory is a schedules row of kind 'pipeline'
// (params {postal_code, radius_miles, also_zips?}), so `leadmaker worker` fires it like any schedule and
// `leadmaker schedule list` shows it; every_hours NULL is "manual only".
import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import {
  defaultTerritoryName, sql, TERRITORY_ALSO_ZIPS_MAX, TERRITORY_EVERY_HOURS_MAX, TERRITORY_JOB_KIND,
  TERRITORY_RADIUS_MAX, TERRITORY_RADIUS_MIN, territoryFromRow, territorySql, US_ZIP,
  type Territory, type TerritoryRow, type TerritoryRunResult,
} from '@leadmaker/shared';
import { actorOf, requireManager, type Actor } from '../auth.ts';
import { HttpError, notFound, parse, pgCode } from '../http.ts';
import type { Tx } from '../tx.ts';
import type { Deps } from '../app.ts';
import { areaDedupeKey, formatG } from './refresh.ts';

const zip = z.string().trim().regex(US_ZIP, 'a 5-digit US ZIP code');
const fields = {
  name: z.string().trim().min(1).max(128),
  zip,
  radiusMiles: z.number().min(TERRITORY_RADIUS_MIN).max(TERRITORY_RADIUS_MAX),
  alsoZips: z.array(zip).max(TERRITORY_ALSO_ZIPS_MAX),
  everyHours: z.number().positive().max(TERRITORY_EVERY_HOURS_MAX).nullable(),
  enabled: z.boolean(),
};
const createBody = z.object({
  ...fields,
  name: fields.name.optional(),
  alsoZips: fields.alsoZips.optional(),
  everyHours: fields.everyHours.default(null),
  enabled: fields.enabled.default(true),
}).strict();
const patchBody = z.object(fields).partial().strict();

type Params = { postal_code: string; radius_miles: number; also_zips?: string[] };

/** The schedule's params; the radius as the worker's dedupe key prints it, and also_zips without the main ZIP or repeats. */
function paramsFor(zipCode: string, radiusMiles: number, alsoZips: readonly string[]): Params {
  const also = [...new Set(alsoZips)].filter((z) => z !== zipCode);
  return { postal_code: zipCode, radius_miles: Number(formatG(radiusMiles)), ...(also.length ? { also_zips: also } : {}) };
}

/** leadmaker/jobs.py area_dedupe_key for the schedule's params, so "Run now" and the schedule merge into one job
 * (a schedule made with `leadmaker schedule add --params '{"sources": [...]}'` keys on its sources too). */
function territoryDedupeKey(p: Params & { sources?: unknown }): string {
  const key = areaDedupeKey(TERRITORY_JOB_KIND, p.postal_code, Number(p.radius_miles));
  const sources = Array.isArray(p.sources) ? [...p.sources].map(String).sort().join(',') : typeof p.sources === 'string' ? p.sources : '';
  return sources ? `${key.slice(0, -1)}${sources}` : key;
}

/** jsonb reorders keys, so params are compared field by field. */
const sameParams = (a: Params, b: Partial<Params>) => a.postal_code === b.postal_code
  && a.radius_miles === Number(b.radius_miles) && JSON.stringify(a.also_zips ?? []) === JSON.stringify(b.also_zips ?? []);

const territoryId = (raw: string): number => {
  if (!/^\d{1,9}$/.test(raw)) throw notFound();
  return Number(raw);
};

async function readTerritory(tx: Tx, id: number): Promise<Territory> {
  const q = territorySql(sql`AND s.id = ${id}::int`);
  const [row] = await tx.$queryRaw<TerritoryRow[]>(new Prisma.Sql(q.strings, q.values));
  if (!row) throw notFound();
  return territoryFromRow(row);
}

const audit = (tx: Tx, actor: Actor, entityId: string, action: string, changes: unknown) => tx.$executeRaw(Prisma.sql`
  INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type, actor_id)
  VALUES ('territory', ${entityId}, ${action}, ${JSON.stringify(changes)}::jsonb, 'user', ${actor.id}::uuid)`);

/** A taken name is a 409, not a 500. */
async function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (pgCode(err) === '23505') throw new HttpError(409, { error: 'territory_exists', details: 'a territory with this name already exists' });
    throw err;
  }
}

export function territoryRoutes({ write }: Deps): Router {
  const r = Router();

  r.post('/admin/territories', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const body = parse(createBody, req.body);
    const params = paramsFor(body.zip, body.radiusMiles, body.alsoZips ?? []);
    const name = body.name ?? defaultTerritoryName(params.postal_code, params.radius_miles);
    const out = await uniqueName(() => write(actor, async (tx) => {
      // A scheduled territory's first run is due now, as with `leadmaker schedule add`.
      const [{ id }] = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        INSERT INTO schedules (name, kind, params, every_hours, enabled, next_run_at)
        VALUES (${name}, ${TERRITORY_JOB_KIND}, ${JSON.stringify(params)}::jsonb, ${body.everyHours}::float8,
                ${body.enabled}, CASE WHEN ${body.everyHours}::float8 IS NULL THEN NULL ELSE now() END)
        RETURNING id`);
      await audit(tx, actor, String(id), 'created', { name, params, every_hours: body.everyHours, enabled: body.enabled });
      return readTerritory(tx, id);
    }));
    res.status(201).json(out satisfies Territory);
  });

  r.patch('/admin/territories/:id', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const id = territoryId(req.params.id);
    const body = parse(patchBody, req.body);
    const out = await uniqueName(() => write(actor, async (tx) => {
      const [cur] = await tx.$queryRaw<{ name: string; params: Partial<Params> & Record<string, unknown>; every_hours: number | null; enabled: boolean }[]>(Prisma.sql`
        SELECT name, params, every_hours, enabled FROM schedules
        WHERE id = ${id}::int AND kind = ${TERRITORY_JOB_KIND} FOR UPDATE`);
      if (!cur) throw notFound();
      const area = paramsFor(
        body.zip ?? String(cur.params.postal_code ?? ''),
        body.radiusMiles ?? Number(cur.params.radius_miles ?? 25),
        body.alsoZips ?? (Array.isArray(cur.params.also_zips) ? cur.params.also_zips : []),
      );
      // Params the page does not manage (a CLI schedule's --params, e.g. sources) are kept.
      const { also_zips: _old, ...rest } = cur.params;
      const params: Params = { ...rest, ...area };
      const everyHours = body.everyHours === undefined ? cur.every_hours : body.everyHours;
      const enabled = body.enabled ?? cur.enabled;
      const name = body.name ?? cur.name;
      // A new interval counts from the last scheduled run (due now if that is already past or there was none);
      // an unchanged one keeps its slot. Manual only clears it.
      const retimed = everyHours !== cur.every_hours;
      await tx.$executeRaw(Prisma.sql`
        UPDATE schedules SET name = ${name}, params = ${JSON.stringify(params)}::jsonb, every_hours = ${everyHours}::float8,
               enabled = ${enabled},
               next_run_at = CASE
                 WHEN ${everyHours}::float8 IS NULL THEN NULL
                 WHEN ${retimed} OR next_run_at IS NULL
                   THEN GREATEST(now(), COALESCE(last_enqueued_at + make_interval(secs => ${everyHours}::float8 * 3600), now()))
                 ELSE next_run_at END
        WHERE id = ${id}::int`);
      const changes: Record<string, [unknown, unknown]> = {};
      if (name !== cur.name) changes.name = [cur.name, name];
      if (!sameParams(params, cur.params)) changes.params = [cur.params, params];
      if (everyHours !== cur.every_hours) changes.every_hours = [cur.every_hours, everyHours];
      if (enabled !== cur.enabled) changes.enabled = [cur.enabled, enabled];
      if (Object.keys(changes).length) await audit(tx, actor, String(id), 'updated', changes);
      return readTerritory(tx, id);
    }));
    res.json(out satisfies Territory);
  });

  r.delete('/admin/territories/:id', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const id = territoryId(req.params.id);
    await write(actor, async (tx) => {
      // Its jobs stay (schedule_id is set to NULL), so the run history keeps them.
      const [gone] = await tx.$queryRaw<{ name: string; params: unknown }[]>(Prisma.sql`
        DELETE FROM schedules WHERE id = ${id}::int AND kind = ${TERRITORY_JOB_KIND} RETURNING name, params`);
      if (!gone) throw notFound();
      await audit(tx, actor, String(id), 'removed', { name: gone.name, params: gone.params });
    });
    res.status(204).end();
  });

  // "Run now": queues the territory's full refresh (the same job its schedule fires, so the two merge)
  // for the worker. A run of the same area that is still queued or running is returned instead.
  r.post('/admin/territories/:id/run', async (req, res) => {
    const actor = actorOf(res);
    requireManager(actor);
    const id = territoryId(req.params.id);
    const out = await write(actor, async (tx) => {
      const [t] = await tx.$queryRaw<{ params: Params & { sources?: unknown } }[]>(Prisma.sql`
        SELECT params FROM schedules WHERE id = ${id}::int AND kind = ${TERRITORY_JOB_KIND} FOR SHARE`);
      if (!t) throw notFound();
      const dedupeKey = territoryDedupeKey(t.params);
      const open = async () => (await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM jobs WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running') LIMIT 1`))[0];
      const existing = await open();
      if (existing) return { merged: true, jobId: existing.id };
      const [job] = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        INSERT INTO jobs (kind, params, dedupe_key, schedule_id, requested_by)
        VALUES (${TERRITORY_JOB_KIND}, ${JSON.stringify(t.params)}::jsonb, ${dedupeKey}, ${id}::int, ${actor.id}::uuid)
        ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING
        RETURNING id`);
      if (!job) return { merged: true, jobId: (await open())?.id };
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type, actor_id)
        VALUES ('job', ${String(job.id)}, 'created',
                ${JSON.stringify({ kind: TERRITORY_JOB_KIND, dedupe_key: dedupeKey, params: t.params, schedule_id: id })}::jsonb,
                'user', ${actor.id}::uuid)`);
      return { merged: false, jobId: job.id };
    });
    if (out.jobId === undefined) throw new HttpError(503, { error: 'retry', details: 'the matching run finished while merging; retry' });
    res.status(202).json({ jobId: String(out.jobId), merged: out.merged } satisfies TerritoryRunResult);
  });

  return r;
}
