// Pure helpers over GET /api/signals: alert grouping, the hazard behind an alert, storm summaries.
import type { RegionalSignal } from '@/api/types';
import { hazardFamily, parseDt } from './hazards';

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---- alerts ------------------------------------------------------------------------

export type AlertTone = 'danger' | 'warning' | 'info' | 'neutral';
export type AlertStatus = 'active' | 'upcoming' | 'ended';

export interface AlertGroup {
  key: string;
  event: string;
  headline: string | null;
  /** NWS severity word (Extreme / Severe / Moderate / Minor / Unknown). */
  severity: string;
  tone: AlertTone;
  status: AlertStatus;
  onset: Date | null;
  ends: Date | null;
  counties: string[];
  instruction: string | null;
  sender: string | null;
  /** NWS issued this event for these counties more than once (updates, re-issues): shown once. */
  issued: number;
}

const SEVERITY_ORDER: Record<string, number> = { extreme: 0, severe: 1, moderate: 2, minor: 3 };

export function severityTone(severity: string): AlertTone {
  const s = severity.toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'danger';
  if (s === 'moderate') return 'warning';
  if (s === 'minor') return 'info';
  return 'neutral';
}

/** One entry per NWS alert (the API repeats an alert once per county it covers), most urgent first. */
export function groupAlerts(alerts: readonly RegionalSignal[], now: Date = new Date()): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const a of alerts) {
    const p = a.payload as Json;
    const event = str(p.event) || 'Weather alert';
    const key = str(p.url) || str(p.id) || `${event}|${a.validFrom}|${a.validTo}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.counties.includes(a.countyFips)) existing.counties.push(a.countyFips);
      continue;
    }
    const onset = parseDt(p.onset) ?? parseDt(a.validFrom);
    const ends = parseDt(a.validTo) ?? parseDt(p.ends) ?? parseDt(p.expires);
    const status: AlertStatus = a.expired || (ends && ends <= now) ? 'ended'
      : a.active || !onset || onset <= now ? 'active' : 'upcoming';
    const severity = str(p.severity) || 'Unknown';
    groups.set(key, {
      key, event, severity, status, onset, ends,
      headline: str(p.headline) || null,
      tone: severityTone(severity),
      counties: [a.countyFips],
      instruction: str(p.instruction) || null,
      sender: str(p.sender_name) || null,
      issued: 1,
    });
  }
  // The same event re-issued for the same counties reads as a duplicate: keep the latest one.
  const merged = new Map<string, AlertGroup>();
  for (const g of groups.values()) {
    const k = `${g.event}|${g.status}|${[...g.counties].sort().join(',')}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, g);
    else {
      const keep = (g.ends?.getTime() ?? 0) > (prev.ends?.getTime() ?? 0) ? g : prev;
      merged.set(k, { ...keep, issued: prev.issued + g.issued });
    }
  }
  const rank = (g: AlertGroup) => SEVERITY_ORDER[g.severity.toLowerCase()] ?? 9;
  return [...merged.values()].sort((a, b) =>
    (a.status === 'ended' ? 1 : 0) - (b.status === 'ended' ? 1 : 0)
    || rank(a) - rank(b)
    || (a.status === 'ended'
      ? (b.ends?.getTime() ?? 0) - (a.ends?.getTime() ?? 0)
      : (a.ends?.getTime() ?? Infinity) - (b.ends?.getTime() ?? Infinity)));
}

// ---- demand ------------------------------------------------------------------------

/** Hazard bucket for the demand copy (frost and freeze count as cold, unlike the timing rules). */
export function demandHazard(event: string): 'storm' | 'flood' | 'winter' | 'cold' | 'other' {
  const e = event.toLowerCase();
  if (e.includes('frost') || e.includes('freeze') || e.includes('cold') || e.includes('wind chill')) return 'cold';
  const fam = hazardFamily(event);
  if (fam === 'tornado' || fam === 'tropical' || fam === 'thunderstorm' || fam === 'wind') return 'storm';
  if (fam === 'flood' || fam === 'coastal') return 'flood';
  if (fam === 'winter') return 'winter';
  if (fam === 'cold') return 'cold';
  return 'other';
}

// ---- storm history -------------------------------------------------------------------

export interface StormSummary {
  countyFips: string;
  events12m: number;
  events24m: number;
  counts: { kind: string; count: number }[];
  lastEvent: { date: string; label: string; location: string | null } | null;
}

const KIND_LABELS: Record<string, string> = {
  wind: 'Wind', hail: 'Hail', flood: 'Flood', winter: 'Winter', tornado: 'Tornado', tropical: 'Tropical',
};

export const stormKindLabel = (k: string) => KIND_LABELS[k] ?? k;

export function stormSummaries(rows: readonly RegionalSignal[]): StormSummary[] {
  return rows
    .map((r) => {
      const p = r.payload as Json;
      const counts = Object.entries((p.counts_24m as Json | undefined) ?? {})
        .map(([kind, v]) => ({ kind, count: num(v) }))
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count);
      const last = p.last_event as Json | undefined;
      return {
        countyFips: r.countyFips,
        events12m: num(p.events_12m),
        events24m: num(p.events_24m),
        counts,
        lastEvent: last && str(last.date)
          ? { date: str(last.date), label: titleCaseEvent(str(last.event_type) || stormKindLabel(str(last.kind))), location: str(last.location) || null }
          : null,
      };
    })
    .sort((a, b) => b.events12m - a.events12m || b.events24m - a.events24m);
}

/** "NON-TSTM WND DMG" -> "Wind damage"; NCEI names ("Thunderstorm Wind") pass through. */
export function titleCaseEvent(t: string): string {
  const LSR: Record<string, string> = {
    'NON-TSTM WND DMG': 'Wind damage', 'TSTM WND DMG': 'Thunderstorm wind damage', 'TSTM WND GST': 'Thunderstorm gust',
    'NON-TSTM WND GST': 'Wind gust', 'FLASH FLOOD': 'Flash flood', 'COASTAL FLOOD': 'Coastal flood', 'FLOOD': 'Flood',
    'HAIL': 'Hail', 'TORNADO': 'Tornado', 'SNOW': 'Snow', 'HEAVY SNOW': 'Heavy snow', 'ICE STORM': 'Ice storm',
    'HIGH SUST WINDS': 'High winds', 'HEAVY RAIN': 'Heavy rain',
  };
  if (LSR[t]) return LSR[t]!;
  if (t === t.toUpperCase()) return t.charAt(0) + t.slice(1).toLowerCase();
  return t;
}
