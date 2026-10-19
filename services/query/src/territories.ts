// Manager-only reads for the Territories page: GET /admin/territories and GET /admin/runs.
// Both read the primary: a manager's edit or "Run now" must show on the next refetch, and the tables are tiny.
import {
  runStatus, sql, territoryFromRow, territorySql, type Run, type Territory, type TerritoryRow,
} from '@leadmaker/shared';
import { rows, type Db } from './db.ts';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function listTerritories(db: Db): Promise<Territory[]> {
  return (await rows<TerritoryRow>(db.primary, territorySql(sql``))).map(territoryFromRow);
}

interface RunRow {
  id: number;
  kind: string;
  params: { postal_code?: string; radius_miles?: number } | null;
  status: string;
  requester_name: string | null;
  created_at: Date;
  locked_at: Date | null;
  finished_at: Date | null;
  result: { stats?: { found?: unknown; new?: unknown; updated?: unknown } } | null;
  error: string | null;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function runOut(r: RunRow): Run {
  const status = runStatus(r.status);
  // jobs has no started_at: locked_at is when the worker claimed the current attempt. A job waiting for a
  // retry keeps its last attempt's lock time, so it reads as not started.
  const startedAt = status === 'queued' ? null : r.locked_at;
  const p = r.params ?? {};
  const s = r.result?.stats;
  const found = count(s?.found);
  const fresh = count(s?.new);
  const updated = count(s?.updated);
  return {
    jobId: String(r.id),
    kind: r.kind,
    territory: p.postal_code ? { zip: String(p.postal_code), radiusMiles: Number(p.radius_miles ?? 25) } : null,
    status,
    requestedBy: r.requester_name === null ? null : { name: r.requester_name },
    createdAt: r.created_at.toISOString(),
    startedAt: iso(startedAt),
    finishedAt: iso(r.finished_at),
    durationMs: startedAt && r.finished_at ? Math.max(0, r.finished_at.getTime() - startedAt.getTime()) : null,
    // Jobs that finished before the worker recorded these counts (or failed) have none.
    stats: found !== null && fresh !== null && updated !== null ? { found, new: fresh, updated } : null,
    error: status === 'succeeded' ? null : r.error,
  };
}

/** Refresh jobs (scrape, pipeline: the ones that read an area), newest first. */
export async function listRuns(db: Db, limit: number): Promise<Run[]> {
  const list = await rows<RunRow>(db.primary, sql`
    SELECT j.id, j.kind, j.params, j.status, u.name AS requester_name, j.created_at, j.locked_at, j.finished_at,
           j.result, j.error
    FROM jobs j LEFT JOIN users u ON u.id = j.requested_by
    WHERE j.kind IN ('scrape', 'pipeline')
    ORDER BY j.id DESC LIMIT ${limit}::int`);
  return list.map(runOut);
}
