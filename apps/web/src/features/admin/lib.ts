// Pure helpers for the Admin page: form validation, schedule labels, run formatting, response normalizing.
import type { Run, RunStatus, Territory, TerritoryInput } from './types';

export const RADIUS_MIN = 1;
export const RADIUS_MAX = 50;
export const DEFAULT_RADIUS = 25;

const ZIP_RE = /^\d{5}$/;
export const isZip = (s: string) => ZIP_RE.test(s);

/** Preset schedules; any other interval an area already has is kept and shown as "Every N hours". */
export const SCHEDULES = [
  { value: 'daily', label: 'Daily', hours: 24 },
  { value: 'weekly', label: 'Weekly', hours: 168 },
  { value: 'manual', label: 'Manual only', hours: null },
] as const;

export function scheduleLabel(everyHours: number | null): string {
  if (everyHours == null) return 'Manual only';
  const preset = SCHEDULES.find((s) => s.hours === everyHours);
  if (preset) return preset.label;
  if (everyHours % 24 === 0) return `Every ${everyHours / 24} days`;
  return everyHours === 1 ? 'Every hour' : `Every ${everyHours} hours`;
}

export const ACTIVE: readonly RunStatus[] = ['queued', 'running'];
export const isActive = (s: RunStatus | null | undefined) => !!s && ACTIVE.includes(s);

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
};

const KIND_LABELS: Record<string, string> = {
  pipeline: 'Full refresh',
  refresh: 'Full refresh',
  scrape: 'Find contractors',
  counties: 'Match counties',
  tag: 'Tag leads',
  insights: 'AI insights',
};

export function kindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  const s = kind.replace(/[_-]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Run';
}

/** 850 ms -> "<1s", 72 s -> "1m 12s", 2 h 5 m -> "2h 5m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export const areaText = (zip: string, radiusMiles: number) => `${zip} · ${radiusMiles} mi`;

/** "07030, 07302 11201" -> ['07030', '07302', '11201'] plus the entries that are not ZIPs. */
export function parseZips(text: string): { zips: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const zips: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!isZip(p)) invalid.push(p);
    else if (!zips.includes(p)) zips.push(p);
  }
  return { zips, invalid };
}

// ---- the add / edit form ------------------------------------------------------------------

export interface AreaForm {
  name: string;
  zip: string;
  radius: string;
  alsoZips: string;
  everyHours: number | null;
  enabled: boolean;
}

export type AreaErrors = Partial<Record<'zip' | 'radius' | 'alsoZips', string>>;

export function formFrom(t: Territory | null): AreaForm {
  return t
    ? { name: t.name, zip: t.zip, radius: String(t.radiusMiles), alsoZips: t.alsoZips.join(', '), everyHours: t.everyHours, enabled: t.enabled }
    : { name: '', zip: '', radius: String(DEFAULT_RADIUS), alsoZips: '', everyHours: 24, enabled: true };
}

export function validateArea(f: AreaForm): AreaErrors {
  const errors: AreaErrors = {};
  const zip = f.zip.trim();
  if (!zip) errors.zip = 'Enter a ZIP code.';
  else if (!isZip(zip)) errors.zip = 'Use a 5-digit US ZIP code, like 10013.';
  const r = Number(f.radius);
  if (f.radius.trim() === '' || !Number.isInteger(r) || r < RADIUS_MIN || r > RADIUS_MAX) {
    errors.radius = `Pick a whole number of miles from ${RADIUS_MIN} to ${RADIUS_MAX}.`;
  }
  const { invalid } = parseZips(f.alsoZips);
  if (invalid.length) errors.alsoZips = `Not a 5-digit ZIP: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`;
  return errors;
}

/** The request body for a valid form (the main ZIP is never repeated in the extras). */
export function toInput(f: AreaForm): TerritoryInput {
  const zip = f.zip.trim();
  const name = f.name.trim();
  return {
    ...(name ? { name } : {}),
    zip,
    radiusMiles: Number(f.radius),
    alsoZips: parseZips(f.alsoZips).zips.filter((z) => z !== zip),
    everyHours: f.everyHours,
    enabled: f.enabled,
  };
}

/** Only the fields that changed, for PATCH. */
export function changedFields(before: Territory, input: TerritoryInput): Partial<TerritoryInput> {
  const out: Partial<TerritoryInput> = {};
  if ((input.name ?? '') !== before.name) out.name = input.name ?? '';
  if (input.zip !== before.zip) out.zip = input.zip;
  if (input.radiusMiles !== before.radiusMiles) out.radiusMiles = input.radiusMiles;
  const also = input.alsoZips ?? [];
  if (also.join(',') !== before.alsoZips.join(',')) out.alsoZips = also;
  if (input.everyHours !== before.everyHours) out.everyHours = input.everyHours;
  if (input.enabled !== before.enabled) out.enabled = input.enabled;
  return out;
}

// ---- response normalizing (an older or partial server never crashes the page) ---------------

const STATUSES: readonly RunStatus[] = ['queued', 'running', 'succeeded', 'failed'];
const asStatus = (v: unknown): RunStatus => (STATUSES.includes(v as RunStatus) ? (v as RunStatus) : 'queued');
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

function listOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const items = rec(body)?.items;
  return Array.isArray(items) ? items : [];
}

export function normalizeTerritory(v: unknown): Territory | null {
  const t = rec(v);
  const id = str(t?.id);
  const zip = str(t?.zip);
  if (!t || !id || !zip) return null;
  const last = rec(t.lastRun);
  return {
    id,
    name: str(t.name) ?? '',
    zip,
    radiusMiles: num(t.radiusMiles) ?? DEFAULT_RADIUS,
    alsoZips: Array.isArray(t.alsoZips) ? t.alsoZips.filter((z): z is string => typeof z === 'string') : [],
    everyHours: num(t.everyHours),
    enabled: t.enabled !== false,
    lastRun: last && str(last.jobId) ? { jobId: str(last.jobId)!, status: asStatus(last.status), finishedAt: str(last.finishedAt) } : null,
    nextRunAt: str(t.nextRunAt),
  };
}

export const normalizeTerritories = (body: unknown): Territory[] =>
  listOf(body).map(normalizeTerritory).filter((t): t is Territory => !!t);

export function normalizeRun(v: unknown): Run | null {
  const r = rec(v);
  const jobId = str(r?.jobId);
  if (!r || !jobId) return null;
  const area = rec(r.territory);
  const by = rec(r.requestedBy);
  const stats = rec(r.stats);
  return {
    jobId,
    kind: str(r.kind) ?? 'pipeline',
    territory: area && str(area.zip) ? { zip: str(area.zip)!, radiusMiles: num(area.radiusMiles) ?? DEFAULT_RADIUS } : null,
    status: asStatus(r.status),
    requestedBy: by && str(by.name) ? { name: str(by.name)! } : null,
    createdAt: str(r.createdAt) ?? '',
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    durationMs: num(r.durationMs),
    stats: stats ? { found: num(stats.found) ?? 0, new: num(stats.new) ?? 0, updated: num(stats.updated) ?? 0 } : null,
    error: str(r.error),
  };
}

export const normalizeRuns = (body: unknown): Run[] =>
  listOf(body).map(normalizeRun).filter((r): r is Run => !!r);

/** The area's own name, else its ZIP: what a run row calls it. */
export function territoryName(t: Pick<Territory, 'name' | 'zip'>): string {
  return t.name || `ZIP ${t.zip}`;
}
