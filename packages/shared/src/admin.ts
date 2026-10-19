// Manager-only admin contract: territories (the areas the worker refreshes) and their run history.
// Reads are served by the query service, writes by crm-write; the gateway answers 403 to reps.
import { sql, type Sql } from './sql.ts';

/** A refresh job's state as the Territories page shows it ('dead', retries used up, reads as 'failed'). */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const satisfies readonly RunStatus[];

/** The job kind a territory's schedule and its "Run now" enqueue: scrape -> enrich -> counties -> tag -> AI insights. */
export const TERRITORY_JOB_KIND = 'pipeline';
export const TERRITORY_RADIUS_MIN = 1;
export const TERRITORY_RADIUS_MAX = 50;
/** Extra ZIPs a territory may cover besides its main one, each read with the same radius. */
export const TERRITORY_ALSO_ZIPS_MAX = 20;
/** Longest schedule interval the page offers: about a month. */
export const TERRITORY_EVERY_HOURS_MAX = 24 * 31;
export const US_ZIP = /^\d{5}$/;
export const ADMIN_RUNS_DEFAULT_LIMIT = 20;
export const ADMIN_RUNS_MAX_LIMIT = 100;

/** GET /api/admin/territories item: a schedules row of kind 'pipeline'. */
export interface Territory {
  id: string;
  name: string;
  zip: string;
  radiusMiles: number;
  alsoZips: string[];
  /** null: manual only (run from the page, never on a timer). */
  everyHours: number | null;
  enabled: boolean;
  /** The newest job of this territory (queued, running or finished). */
  lastRun: { jobId: string; status: RunStatus; finishedAt: string | null } | null;
  /** When the worker queues the next run; null when manual only or paused. */
  nextRunAt: string | null;
}

/** POST /api/admin/territories (201 Territory). 409 'territory_exists' when the name is taken. */
export interface TerritoryCreate {
  name?: string;
  zip: string;
  radiusMiles: number;
  alsoZips?: string[];
  everyHours: number | null;
  enabled: boolean;
}

/** PATCH /api/admin/territories/:id: any subset of the create fields (200 Territory). */
export type TerritoryPatch = Partial<TerritoryCreate>;

/** POST /api/admin/territories/:id/run: 202, the queued job, or the open one for the same area (merged). */
export interface TerritoryRunResult {
  jobId: string;
  merged: boolean;
}

/** GET /api/admin/runs?limit=20: refresh jobs (scrape, pipeline), newest first. */
export interface Run {
  jobId: string;
  kind: string;
  territory: { zip: string; radiusMiles: number } | null;
  status: RunStatus;
  requestedBy: { name: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Listings found, new leads, changed leads; null for runs recorded before the worker counted them. */
  stats: { found: number; new: number; updated: number } | null;
  error: string | null;
}

/** jobs.status -> RunStatus. */
export function runStatus(jobStatus: string): RunStatus {
  if (jobStatus === 'queued' || jobStatus === 'running' || jobStatus === 'succeeded') return jobStatus;
  return 'failed';
}

/** A territory's default name when none is given: "10013 (25 mi)". */
export function defaultTerritoryName(zip: string, radiusMiles: number): string {
  return `${zip} (${radiusMiles} mi)`;
}

/** A schedules row as territorySql selects it, with the territory's newest job. */
export interface TerritoryRow {
  id: number;
  name: string;
  params: { postal_code?: unknown; radius_miles?: unknown; also_zips?: unknown } | null;
  every_hours: number | null;
  enabled: boolean;
  next_run_at: Date | null;
  last_job_id: number | null;
  last_status: string | null;
  last_finished_at: Date | null;
}

/** Territories (schedules of kind TERRITORY_JOB_KIND) matching `where` (an AND clause, or empty), by name. */
export const territorySql = (where: Sql) => sql`
  SELECT s.id, s.name, s.params, s.every_hours, s.enabled, s.next_run_at,
         j.id AS last_job_id, j.status AS last_status, j.finished_at AS last_finished_at
  FROM schedules s
  LEFT JOIN LATERAL (
    SELECT id, status, finished_at FROM jobs WHERE schedule_id = s.id ORDER BY id DESC LIMIT 1) j ON TRUE
  WHERE s.kind = ${TERRITORY_JOB_KIND} ${where}
  ORDER BY s.name, s.id`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function territoryFromRow(r: TerritoryRow): Territory {
  const p = r.params ?? {};
  return {
    id: String(r.id),
    name: r.name,
    zip: String(p.postal_code ?? ''),
    radiusMiles: Number(p.radius_miles ?? 25),
    alsoZips: Array.isArray(p.also_zips) ? p.also_zips.map(String) : [],
    everyHours: r.every_hours === null ? null : Number(r.every_hours),
    enabled: r.enabled,
    lastRun: r.last_job_id === null
      ? null
      : { jobId: String(r.last_job_id), status: runStatus(r.last_status ?? 'failed'), finishedAt: iso(r.last_finished_at) },
    nextRunAt: r.enabled && r.every_hours !== null ? iso(r.next_run_at) : null,
  };
}
