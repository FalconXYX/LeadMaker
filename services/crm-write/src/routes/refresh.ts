import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import type { RefreshResult } from '@leadmaker/shared';
import { actorOf } from '../auth.ts';
import { HttpError, parse } from '../http.ts';
import type { Deps } from '../app.ts';

/** Python's f"{x:g}" for the radius range accepted here: 6 significant digits, no trailing zeros (25, 12.5). */
export function formatG(n: number): string {
  return String(Number(n.toPrecision(6)));
}

/** leadmaker/jobs.py area_dedupe_key for a refresh: `{kind}:{postal_code}:{radius:g}:*` (no sources). */
export function areaDedupeKey(kind: string, postalCode: string, radiusMiles: number): string {
  return `${kind}:${postalCode}:${formatG(radiusMiles)}:*`;
}

const refreshBody = z.object({
  postal_code: z.string().regex(/^\d{5}$/, 'a 5-digit US ZIP code'),
  radius_miles: z.number().min(0.1).max(100),
});

type Job = { id: number; status: string; dedupe_key: string; created_at: Date };
const jobOut = (j: Job): RefreshResult['job'] => ({
  id: j.id, kind: 'scrape', status: j.status, dedupeKey: j.dedupe_key, createdAt: j.created_at.toISOString(),
});

export function refreshRoutes({ write, config }: Deps): Router {
  const r = Router();

  // Enqueues a scrape job for the Python worker. A request for an area that already has a queued or
  // running job merges into it and is free; otherwise it counts against the requester's hourly
  // limit (the same rolling-hour rule as leadmaker/jobs.py, shared via LEADMAKER_USER_JOBS_PER_HOUR).
  r.post('/refresh', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(refreshBody, req.body);
    // The job runs the radius its key names, so requests merged into it get exactly that area.
    const radius = Number(formatG(body.radius_miles));
    const dedupeKey = areaDedupeKey('scrape', body.postal_code, radius);
    const limit = config.userJobsPerHour;
    const out = await write(actor, async (tx) => {
      // One requester at a time, so two simultaneous requests cannot both pass at limit - 1.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`refresh:${actor.id}`}, 0))`);
      const open = async () => (await tx.$queryRaw<Job[]>(Prisma.sql`
        SELECT id, status, dedupe_key, created_at FROM jobs
        WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running') LIMIT 1`))[0];
      const existing = await open();
      if (existing) return { merged: true, job: existing };
      if (limit > 0) {
        const [w] = await tx.$queryRaw<{ n: number; retry_at: Date | null; retry_after: number | null }[]>(Prisma.sql`
          SELECT count(*)::int AS n, min(created_at) + interval '1 hour' AS retry_at,
                 ceil(extract(epoch FROM min(created_at) + interval '1 hour' - now()))::int AS retry_after
          FROM jobs WHERE requested_by = ${actor.id}::uuid AND created_at > now() - interval '1 hour'`);
        if (w.n >= limit) {
          throw new HttpError(429, {
            error: 'rate_limited',
            details: { limit, retryAt: w.retry_at?.toISOString() ?? null },
          }, { 'Retry-After': String(Math.max(1, w.retry_after ?? 3600)) });
        }
      }
      const [job] = await tx.$queryRaw<Job[]>(Prisma.sql`
        INSERT INTO jobs (kind, params, dedupe_key, requested_by)
        VALUES ('scrape',
                jsonb_build_object('postal_code', ${body.postal_code}::text, 'radius_miles', ${radius}::float8),
                ${dedupeKey}, ${actor.id}::uuid)
        ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING
        RETURNING id, status, dedupe_key, created_at`);
      if (!job) return { merged: true, job: await open() };
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type, actor_id)
        VALUES ('job', ${String(job.id)}, 'created',
                ${JSON.stringify({ kind: 'scrape', dedupe_key: dedupeKey, params: { ...body, radius_miles: radius } })}::jsonb,
                'user', ${actor.id}::uuid)`);
      return { merged: false, job };
    });
    if (!out.job) throw new HttpError(503, { error: 'retry', details: 'the matching job finished while merging; retry' });
    res.status(out.merged ? 200 : 202).json({ merged: out.merged, job: jobOut(out.job) } satisfies RefreshResult);
  });

  return r;
}
