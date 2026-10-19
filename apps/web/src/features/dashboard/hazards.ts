// Weather helpers: NWS event names as hazard families, ISO parsing for alert windows, and the timing badge
// (LeadSummary.timing, computed by the query service) that asks for action.
import type { TimingBadge } from '@/api/types';

const ISO_TZ = /(Z|[+-]\d{2}(:?\d{2})?)$/i;

/** ISO date/time, naive values taken as UTC; null when unparseable. */
export function parseDt(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v) return null;
  let s = v.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  if (!ISO_TZ.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** NWS event name -> hazard family (null for statements and hazards that do not touch roofs). */
export function hazardFamily(event: string | null | undefined): string | null {
  const e = (event || '').toLowerCase();
  if (!e || e.endsWith('statement')) return null;
  if (e.includes('tornado')) return 'tornado';
  if (['hurricane', 'tropical storm', 'storm surge', 'extreme wind'].some((k) => e.includes(k))) return 'tropical';
  if (e.includes('severe thunderstorm')) return 'thunderstorm';
  if (e.includes('high wind') || e === 'wind advisory') return 'wind';
  if (['winter storm', 'winter weather', 'blizzard', 'ice storm', 'lake effect snow', 'heavy snow', 'snow squall']
    .some((k) => e.includes(k))) return 'winter';
  if (e.includes('coastal flood')) return 'coastal';
  if (e.includes('flood')) return 'flood';
  if (['extreme cold', 'wind chill', 'cold weather'].some((k) => e.includes(k))) return 'cold';
  return null;
}

/** The most urgent badge that asks for action (high / medium / low); the calendar `info` badge never counts. */
export function actionableBadge(badges: readonly TimingBadge[] | undefined): TimingBadge | null {
  return badges?.find((b) => b.severity !== 'info') ?? null;
}
