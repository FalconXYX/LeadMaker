// GET /territory-brief?scope=mine|team|rep:<id>: the dashboard's one-paragraph territory briefing (TerritoryBrief).
// The worker (leadmaker/briefing) stores a deterministic digest per scope in territory_briefs and, when a provider is
// configured, AI rewrites keyed by the digest's hash in territory_brief_rewrites. This serves the rewrite only while it
// matches the current digest, else the digest text (an empty ai_text is the worker's marker for a rewrite that failed
// validation, never served). Cached per scope for TERRITORY_BRIEF_TTL_SECONDS and shared by
// everyone allowed that scope (no outbox event: the web refetches on pipeline.run_completed); the named leads are
// filtered by the viewer's visibility on every request, and staleness follows the clock.
import {
  cacheKeys, isManager, isUuid, sql, TERRITORY_BRIEF_TTL_SECONDS, visibilitySql, type BriefScope, type TerritoryBrief,
  type TerritoryBriefResponse, type Viewer,
} from '@leadmaker/shared';
import type { Cache } from './cache.ts';
import { one, rows, type Db } from './db.ts';
import { badRequest, forbidden } from './errors.ts';
import { iso } from './search.ts';

/** A brief computed longer ago than this means the worker isn't running: the web renders nothing. */
export const BRIEF_STALE_MS = 36 * 3600 * 1000;
const MAX_BRIEF_LEADS = 20;

/**
 * The brief scope a request may read. Reps: 'mine' or 'rep:<self>' (anything else 403); managers: 'team' (also for
 * 'mine') or any 'rep:<id>'. Default 'mine'. Not a scope at all: 400.
 */
export function briefScope(viewer: Viewer, raw: string | undefined): BriefScope {
  const value = (raw ?? 'mine').trim();
  let scope: BriefScope;
  if (value === 'mine') scope = isManager(viewer) ? 'team' : `rep:${viewer.id.toLowerCase()}`;
  else if (value === 'team') scope = 'team';
  else if (value.startsWith('rep:') && isUuid(value.slice(4))) scope = `rep:${value.slice(4).toLowerCase()}`;
  else throw badRequest('invalid scope; expected mine, team or rep:<user id>');
  if (!isManager(viewer) && scope !== `rep:${viewer.id.toLowerCase()}`) throw forbidden();
  return scope;
}

interface BriefRow {
  scope: string;
  digest: { poll?: { finished_at?: unknown } | null; leads?: unknown } | null;
  digest_text: string;
  quiet: boolean;
  computed_at: string;
  ai_text: string | null;
  generated_at: string | null;
  model: string | null;
  prompt_version: string | null;
}

export function briefQuery(scope: BriefScope) {
  return sql`
    SELECT b.scope, b.digest, b.digest_text, b.digest_hash, b.quiet, b.computed_at,
           r.ai_text, r.generated_at, r.model, r.prompt_version
    FROM territory_briefs b
    LEFT JOIN LATERAL (SELECT ai_text, generated_at, model, prompt_version FROM territory_brief_rewrites r
                       WHERE r.scope = b.scope AND r.digest_hash = b.digest_hash AND r.ai_text <> ''
                       ORDER BY generated_at DESC LIMIT 1) r ON TRUE
    WHERE b.scope = ${scope}`;
}

function digestLeads(leads: unknown): { id: string; name: string }[] {
  if (!Array.isArray(leads)) return [];
  const out: { id: string; name: string }[] = [];
  for (const l of leads as { id?: unknown; name?: unknown }[]) {
    if (!l || typeof l.id !== 'string' || !isUuid(l.id)) continue;
    const id = l.id.toLowerCase();
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, name: typeof l.name === 'string' ? l.name : '' });
    if (out.length >= MAX_BRIEF_LEADS) break;
  }
  return out;
}

/** The scope's brief before the per-viewer parts (leads unfiltered, stale unset). */
export function briefFromRow(scope: BriefScope, r: BriefRow): TerritoryBrief {
  const finished = r.digest?.poll?.finished_at;
  return {
    scope,
    text: r.ai_text ?? r.digest_text,
    source: r.ai_text !== null ? 'ai' : 'digest',
    quiet: r.quiet,
    stale: false,
    digestText: r.digest_text,
    computedAt: iso(r.computed_at)!,
    generatedAt: iso(r.generated_at),
    model: r.model,
    promptVersion: r.prompt_version,
    pollFinishedAt: typeof finished === 'string' && !Number.isNaN(Date.parse(finished)) ? iso(finished) : null,
    leads: digestLeads(r.digest?.leads),
  };
}

export async function getTerritoryBrief(
  db: Db, cache: Cache, viewer: Viewer, rawScope: string | undefined, now = new Date(),
): Promise<{ result: TerritoryBriefResponse; cache: 'hit' | 'miss' }> {
  const scope = briefScope(viewer, rawScope);
  const key = cacheKeys.territoryBrief(scope);
  let doc = await cache.getJson<TerritoryBriefResponse>(key);
  const hit = doc !== undefined;
  if (!doc) {
    const row = await one<BriefRow>(db.replica, briefQuery(scope));
    doc = { brief: row ? briefFromRow(scope, row) : null };
    await cache.setJson(key, doc, TERRITORY_BRIEF_TTL_SECONDS);
  }
  const brief = doc.brief;
  if (!brief) return { result: { brief: null }, cache: hit ? 'hit' : 'miss' };
  // One query: leads reallocated away from a rep since the digest was computed, or deleted, drop out.
  let leads = brief.leads;
  if (leads.length) {
    const visible = new Set((await rows<{ id: string }>(db.replica, sql`
      SELECT c.id::text AS id FROM companies c
      WHERE c.id = ANY(${leads.map((l) => l.id)}::uuid[]) AND ${visibilitySql(viewer, 'view', 'c')}`)).map((r) => r.id));
    leads = leads.filter((l) => visible.has(l.id));
  }
  const stale = now.getTime() - Date.parse(brief.computedAt) > BRIEF_STALE_MS;
  return { result: { brief: { ...brief, stale, leads } }, cache: hit ? 'hit' : 'miss' };
}
