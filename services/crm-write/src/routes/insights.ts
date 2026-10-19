import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { canView, type InsightsRefreshResult } from '@leadmaker/shared';
import { actorOf } from '../auth.ts';
import { HttpError, isUuid, notFound } from '../http.ts';
import type { Deps } from '../app.ts';

/** leadmaker/jobs.py MANUAL_INSIGHTS_PRIORITY: claimed before refreshes (100) and AI follow-ups (150, 200). */
export const MANUAL_INSIGHTS_PRIORITY = 10;
export const manualInsightsKey = (companyId: string) => `insights:company:${companyId}:manual`;

type Job = { id: number; created_at: Date };

/**
 * POST /api/leads/:id/insights/refresh: a rep's "Refresh" on a profile. Queues an `insights` job that runs now
 * (run_after = now, priority 10) with params {company_ids: [id], force: true, requested_by}; the worker skips the
 * input_hash check for it (force) and runs it on its own small daily allowance (LEADMAKER_MANUAL_INSIGHTS_PER_DAY),
 * then emits the usual lead.updated {fields: ['insights']}. The requester lives in params only, not
 * jobs.requested_by: this is not an area refresh, so it neither counts against the hourly refresh limit nor sends
 * "refresh done/failed" notifications. A second press while the job is open merges into it (free). Each user may
 * queue manualInsightsPerUserPerDay of them per rolling day; past that, 429 'try_again_later'.
 */
export function insightsRoutes({ write, config }: Deps): Router {
  const r = Router();

  r.post('/leads/:id/insights/refresh', async (req, res) => {
    const actor = actorOf(res);
    const raw = String(req.params.id);
    if (!isUuid(raw)) throw notFound();
    const id = raw.toLowerCase();
    const dedupeKey = manualInsightsKey(id);
    const limit = config.manualInsightsPerUserPerDay;
    const out = await write(actor, async (tx) => {
      const [lead] = await tx.$queryRaw<{ assigned_rep_id: string | null; account_status: string }[]>(Prisma.sql`
        SELECT assigned_rep_id, account_status FROM companies WHERE id = ${id}::uuid`);
      if (!lead || !canView(actor, lead.assigned_rep_id)) throw notFound();
      // The worker never sends a do-not-contact lead to the model, so a refresh would never land.
      if (lead.account_status === 'do_not_contact') throw new HttpError(409, { error: 'insights_unavailable' });
      // One requester at a time, so two simultaneous presses cannot both pass at limit - 1.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`insights-refresh:${actor.id}`}, 0))`);
      const open = async () => (await tx.$queryRaw<Job[]>(Prisma.sql`
        SELECT id, created_at FROM jobs WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running') LIMIT 1`))[0];
      const existing = await open();
      if (existing) return { merged: true, job: existing };
      if (limit > 0) {
        const [w] = await tx.$queryRaw<{ n: number; retry_after: number | null }[]>(Prisma.sql`
          SELECT count(*)::int AS n,
                 ceil(extract(epoch FROM min(created_at) + interval '1 day' - now()))::int AS retry_after
          FROM jobs
          WHERE kind = 'insights' AND dedupe_key LIKE 'insights:company:%:manual'
            AND params->>'requested_by' = ${actor.id}::text AND created_at > now() - interval '1 day'`);
        if (w.n >= limit) {
          throw new HttpError(429, { error: 'try_again_later' }, { 'Retry-After': String(Math.max(1, w.retry_after ?? 3600)) });
        }
      }
      const [job] = await tx.$queryRaw<Job[]>(Prisma.sql`
        INSERT INTO jobs (kind, params, dedupe_key, priority, max_attempts, run_after)
        VALUES ('insights',
                jsonb_build_object('company_ids', jsonb_build_array(${id}::text), 'force', true,
                                   'requested_by', ${actor.id}::text),
                ${dedupeKey}, ${MANUAL_INSIGHTS_PRIORITY}, 1, now())
        ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING
        RETURNING id, created_at`);
      if (!job) return { merged: true, job: await open() };
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type, actor_id)
        VALUES ('job', ${String(job.id)}, 'created',
                ${JSON.stringify({ kind: 'insights', dedupe_key: dedupeKey, params: { company_ids: [id], force: true } })}::jsonb,
                'user', ${actor.id}::uuid)`);
      return { merged: false, job };
    });
    if (!out.job) throw new HttpError(503, { error: 'retry', details: 'the matching job finished while merging; retry' });
    res.status(202).json({
      jobId: out.job.id, requestedAt: out.job.created_at.toISOString(), merged: out.merged,
    } satisfies InsightsRefreshResult);
  });

  return r;
}
