// Timing badges for many leads at once (list pages, the map) with the profile's rules (timing.ts). A list page
// reads its rows' enrichment services in the search statement and its counties' signals from CountySignals.
import type { PrismaClient } from '@leadmaker/db';
import { sql, type Sql, type TimingBadge } from '@leadmaker/shared';
import { rows } from './db.ts';
import { timingBadges, type SignalRow, type TimingLead } from './timing.ts';

/** The regional_signals rows a lead's badges read, as the profile reads them; `county` is a condition on rs.county_fips. */
export function signalRowsSql(county: Sql): Sql {
  return sql`
    SELECT rs.county_fips, rs.kind, rs.source, rs.payload, rs.valid_from, rs.valid_to
    FROM regional_signals rs
    WHERE ${county} AND rs.kind IN ('active_alert', 'storm_history')
      AND (rs.kind = 'storm_history' OR rs.valid_to IS NULL OR rs.valid_to > now() - interval '8 days')
    ORDER BY rs.valid_from DESC NULLS LAST, rs.id`;
}

/** {source: {status, data: {services}}} of the lead's website_crawl / llm_extract enrichments (what the badges read). */
export function enrichmentSql(companyId: Sql): Sql {
  return sql`
    SELECT json_object_agg(e.source, json_build_object(
             'status', e.status, 'data', json_build_object('services', COALESCE(e.data->'services', '[]'::jsonb))))
    FROM enrichments e WHERE e.company_id = ${companyId} AND e.source IN ('website_crawl', 'llm_extract')`;
}

export function byCounty(signals: SignalRow[]): Map<string, SignalRow[]> {
  const out = new Map<string, SignalRow[]>();
  for (const s of signals) {
    if (!s.county_fips) continue;
    const list = out.get(s.county_fips) ?? [];
    list.push(s);
    out.set(s.county_fips, list);
  }
  return out;
}

/** A lead's badges from its county's rows; a lead without a county reads none (as the profile). */
export function badgesFor(lead: TimingLead, signals: Map<string, SignalRow[]>, now: Date): TimingBadge[] {
  return timingBadges(lead, lead.county_fips ? signals.get(lead.county_fips) ?? [] : [], now);
}

export const COUNTY_SIGNALS_TTL_MS = 30_000;

/**
 * Each county's signal rows, kept in process for ttlMs (alerts are polled every 15 min), so a list page costs
 * no extra read once its counties are known; the missing ones of a page are read in one statement. Badges are
 * still computed per request, so they follow the clock.
 */
export class CountySignals {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { at: number; rows: Promise<SignalRow[]> }>();

  constructor(ttlMs = COUNTY_SIGNALS_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(client: PrismaClient, counties: string[], now = Date.now()): Promise<Map<string, SignalRow[]>> {
    const missing = [...new Set(counties)].filter((c) => {
      const e = this.entries.get(c);
      return !e || now - e.at >= this.ttlMs;
    });
    if (missing.length) {
      const load = rows<SignalRow>(client, signalRowsSql(sql`rs.county_fips = ANY(${missing}::bpchar[])`)).then(byCounty);
      for (const c of missing) {
        const entry = { at: now, rows: load.then((m) => m.get(c) ?? []) };
        this.entries.set(c, entry);
        entry.rows.catch(() => {
          if (this.entries.get(c) === entry) this.entries.delete(c);
        });
      }
    }
    return new Map(await Promise.all(counties.map(async (c) => [c, await this.entries.get(c)!.rows] as const)));
  }
}

/** Badges per lead id; each lead carries its enrichment (enrichmentSql) and county. */
export async function timingFor(
  signals: CountySignals, client: PrismaClient, leads: (TimingLead & { id: string })[], now = new Date(),
): Promise<Map<string, TimingBadge[]>> {
  const counties = [...new Set(leads.flatMap((l) => (l.county_fips ? [l.county_fips] : [])))];
  const byCountyRows = counties.length ? await signals.get(client, counties, now.getTime()) : new Map<string, SignalRow[]>();
  return new Map(leads.map((l) => [l.id, badgesFor({ ...l, enrichment: l.enrichment ?? {} }, byCountyRows, now)]));
}
