// Timing badges: a line-for-line port of leadmaker/signals/timing.py (the rules and their reasons live
// there). Computed per request from the county's regional_signals so a badge follows the clock (an alert
// expiring, a 7-day lookback ending) without a pipeline run or a lead version bump.
// test/timing.test.ts pins parity with the Python rules on golden cases generated from it.
import type { TimingBadge } from '@leadmaker/shared';

type Json = Record<string, any>;

export interface TimingLead {
  state?: string | null;
  county_fips?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  tags?: unknown[] | null;
  enrichment?: Record<string, { status?: string | null; data?: Json | null } | null | undefined> | null;
}

export interface SignalRow {
  county_fips?: string | null;
  kind: string;
  source?: string | null;
  payload?: Json | null;
  valid_from?: string | Date | null;
  valid_to?: string | Date | null;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ALERT_LOOKBACK = 7 * DAY;
const RECENT_STORM = 30 * DAY;
const EXTENDED_ALERT = 12 * HOUR;
const LSR_CONFIRM = 6 * HOUR;

const STORM_ROOFER_SERVICES = new Set(['storm_damage', 'insurance_claims', 'emergency_service']);
const STORM_TAG_SERVICES = STORM_ROOFER_SERVICES;
const NEW_CONSTRUCTION = 'new_construction';
const ROOF_DAMAGE_HAZARDS = new Set(['tornado', 'tropical', 'thunderstorm', 'wind', 'winter', 'coastal']);
const WARNING_ONLY_HAZARDS = new Set(['winter', 'coastal']);
const DELAY_HAZARDS = new Set(['winter', 'cold', 'flood']);
const ROOF_STORM_KINDS = new Set(['wind', 'hail', 'tornado', 'tropical', 'winter']);
const SEVERE_GUST_MPH = 58;
const SEVERE_HAIL_IN = 1.0;
const MEASURED_WIND_TYPES = new Set(['TSTM WND GST', 'NON-TSTM WND GST', 'HIGH SUST WINDS']);
const STRUCTURE_RE = /\b(?:roofs?|homes?|houses?|structures?)\b/i;
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEASON_STATES = new Set(['NY', 'NJ']);

/** Python truthiness for JSON values. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

const ISO_TZ = /(Z|[+-]\d{2}(:?\d{2})?)$/i;

/** datetime.fromisoformat, naive values taken as UTC; null when unparseable. */
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

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

/** GeoJSON Polygon / MultiPolygon contains the point? null without a usable geometry. */
export function pointInGeometry(lat: number, lon: number, geometry: unknown): boolean | null {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return null;
  const g = geometry as Json;
  const coords = truthy(g.coordinates) ? g.coordinates : [];
  let polys: number[][][][] = g.type === 'Polygon' ? [coords] : g.type === 'MultiPolygon' ? coords : [];
  polys = polys.filter((q) => truthy(q) && q[0].length >= 4);
  if (!polys.length) return null;
  return polys.some((q) => inRing(lon, lat, q[0]) && !q.slice(1).some((h) => inRing(lon, lat, h)));
}

function leadPoint(lead: TimingLead): [number, number] | null {
  const lat = Number(lead.latitude);
  const lon = Number(lead.longitude);
  if (lead.latitude == null || lead.longitude == null || lead.latitude === '' || lead.longitude === '') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? [lat, lon] : null;
}

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

export function alertLevel(event: string | null | undefined): string {
  const e = (event || '').toLowerCase();
  if (e.endsWith('warning')) return 'warning';
  return e.endsWith('watch') ? 'watch' : 'advisory';
}

export function leadServices(lead: TimingLead): Set<string> {
  const found = new Set<string>();
  for (const source of ['website_crawl', 'llm_extract']) {
    const row = (lead.enrichment || {})[source];
    if (truthy(row) && row?.status === 'ok') {
      const services = (row.data || {}).services;
      if (truthy(services)) for (const s of services as unknown[]) found.add(String(s));
    }
  }
  let stormTag = false;
  for (const t of lead.tags || []) {
    if (!t || typeof t !== 'object' || Array.isArray(t) || !truthy((t as Json).value)) continue;
    const key = String((t as Json).key || '');
    if (key.startsWith('service:')) found.add(key.split(':').slice(1).join(':'));
    else if (key === 'storm_insurance') stormTag = true;
  }
  if (stormTag && ![...found].some((s) => STORM_TAG_SERVICES.has(s))) found.add('storm_damage');
  return found;
}

function leadState(lead: TimingLead): string | null {
  const st = (lead.state || '').toUpperCase();
  if (st) return st;
  return ({ '34': 'NJ', '36': 'NY' } as Record<string, string>)[String(lead.county_fips || '').slice(0, 2)] ?? null;
}

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** "Oct 16 18:05 ET" */
function when(dt: Date | null): string {
  if (!dt) return 'unknown';
  const p = Object.fromEntries(ET.formatToParts(dt).map((x) => [x.type, x.value]));
  return `${p.month} ${p.day} ${p.hour}:${p.minute} ET`;
}

function badge(key: string, label: string, reason: string, source: string, severity: TimingBadge['severity']): TimingBadge {
  return { key, label, reason, source, severity };
}

interface Alert {
  event: string;
  family: string;
  active: boolean;
  start: Date | null;
  onset: Date | null;
  end: Date | null;
  level: string;
  geometry: unknown;
  source: string | null | undefined;
  here?: boolean | null;
}

function cmp(a: (boolean | number)[], b: (boolean | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function alerts(signals: SignalRow[], now: Date): Alert[] {
  const out: Alert[] = [];
  for (const s of signals) {
    if (s.kind !== 'active_alert') continue;
    const p = s.payload || {};
    const fam = hazardFamily(p.event);
    if (fam === null) continue;
    const start = parseDt(s.valid_from);
    const end = parseDt(s.valid_to);
    const onset = parseDt(p.onset) || start;
    if (onset !== null && onset.getTime() > now.getTime() + 2 * DAY) continue;
    const active = end === null || end > now;
    if (!active && now.getTime() - end!.getTime() > ALERT_LOOKBACK) continue;
    out.push({ event: p.event, family: fam, active, start, onset, end, level: alertLevel(p.event),
               geometry: p.geometry, source: s.source });
  }
  const key = (a: Alert) => [!a.active, a.level !== 'warning', -((a.end?.getTime() ?? now.getTime() + 365 * DAY) / 1000)];
  return out.sort((a, b) => cmp(key(a), key(b)));
}

function roofDamaging(a: Alert): boolean {
  if (!ROOF_DAMAGE_HAZARDS.has(a.family)) return false;
  if (WARNING_ONLY_HAZARDS.has(a.family) && a.level !== 'warning') return false;
  return a.active || a.level !== 'watch';
}

function historyEvents(signals: SignalRow[]): Json[] {
  for (const s of signals) if (s.kind === 'storm_history') return [...((s.payload || {}).recent_events || [])];
  return [];
}

const byValidDesc = (a: Json, b: Json) => {
  const x = a.valid || '';
  const y = b.valid || '';
  return x < y ? 1 : x > y ? -1 : 0;
};

function confirmingReports(a: Alert, events: Json[], now: Date): Json[] {
  const starts = [a.start, a.onset].filter((t): t is Date => t !== null);
  if (!starts.length) return [];
  const lo = Math.min(...starts.map((t) => t.getTime())) - LSR_CONFIRM;
  const hi = (a.end || now).getTime() + LSR_CONFIRM;
  const out: Json[] = [];
  for (const e of events) {
    const last = parseDt(e.valid);
    const first = parseDt(e.first_valid) || last;
    if (ROOF_STORM_KINDS.has(e.kind) && last && first && first.getTime() <= hi && last.getTime() >= lo) out.push(e);
  }
  return out.sort(byValidDesc);
}

function gustMph(e: Json): number {
  if (truthy(e.gust_mph)) return Number(e.gust_mph);
  if (MEASURED_WIND_TYPES.has(e.event_type) && truthy(e.magnitude)) {
    const unit = String(e.unit || '').toLowerCase();
    return Number(e.magnitude) * (['kt', 'kts', 'knots'].includes(unit) ? 1.15078 : 1);
  }
  return 0;
}

function significant(e: Json): boolean {
  if (e.kind === 'tornado' || e.kind === 'tropical') return true;
  if (e.kind === 'hail' && (e.magnitude || 0) >= SEVERE_HAIL_IN) return true;
  return gustMph(e) >= SEVERE_GUST_MPH || truthy(e.structure) || STRUCTURE_RE.test(e.narrative || '');
}

function alertPhrase(a: Alert, now: Date): string {
  if (a.active) {
    if (a.onset && a.onset > now) return `${a.event} from ${when(a.onset)} until ${when(a.end)}`;
    return `${a.event} in effect until ${when(a.end)}`;
  }
  const days = Math.max(0, Math.floor((now.getTime() - a.end!.getTime()) / DAY));
  const ago = days === 0 ? 'today' : `${days} day${days !== 1 ? 's' : ''} ago`;
  return `${a.event} ended ${when(a.end)} (${ago})`;
}

function season(month: number): [string, string] {
  if (month === 1 || month === 2)
    return ['Q1: planning & new accounts',
      'Q1 is the distributor trough and planning window: push new-account and credit applications; '
      + 'GAF Rewards proofs are due 3/31.'];
  if (month === 3)
    return ['Pre-season: set up credit',
      'The season ramps Mar-Apr: set up or refresh credit before the rush and confirm delivery windows; '
      + 'GAF Rewards proofs are due 3/31.'];
  if (month >= 4 && month <= 10)
    return ['In season: service & storm response',
      'Apr-Nov is NY/NJ install season (shingles need ~50 F to seal): service plays, share gains '
      + 'and fast storm response.'];
  if (month === 11)
    return ['Season wind-down: pre-buy',
      'Nov-Dec: pre-buy ahead of manufacturer price increases and next-year planning while the '
      + 'season winds down.'];
  return ['Pre-buy & next-year planning',
    "Nov-Dec: pre-buy ahead of manufacturer price increases and plan next year's volume."];
}

function sortedStr(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function timingBadges(lead: TimingLead, signalRows: SignalRow[], nowInput: Date | string): TimingBadge[] {
  const now = parseDt(nowInput) || new Date();
  const county = lead.county_fips;
  const signals = county ? signalRows.filter((s) => !s.county_fips || s.county_fips === county) : signalRows;
  const services = leadServices(lead);
  const stormServices = sortedStr([...services].filter((s) => STORM_ROOFER_SERVICES.has(s)));
  const stormRoofer = stormServices.length > 0;
  const badges: TimingBadge[] = [];

  const all = alerts(signals, now);
  const history = historyEvents(signals);
  const roof = all.filter(roofDamaging);
  const point = leadPoint(lead);
  for (const a of roof) a.here = point ? pointInGeometry(point[0], point[1], a.geometry) : null;
  roof.sort((a, b) => Number(a.here === false) - Number(b.here === false));
  if (roof.length) {
    const top = roof[0];
    const nearby = top.here === false;
    const others = sortedStr(new Set(roof.slice(1)
      .filter((a) => a.event !== top.event && (a.here === false) === nearby).map((a) => a.event)));
    const extra = others.length ? `; also ${others.join(', ')}` : '';
    const where = nearby ? ' nearby (it covered part of this county, not this address)' : ' in this county';
    if (stormRoofer) {
      const listed = stormServices.join(', ').replaceAll('_', ' ');
      const recent = top.active ? '' : ' (recent)';
      if (nearby) {
        badges.push(badge(
          'storm_response', `Storm nearby: ${top.event}${recent}`,
          `NWS ${alertPhrase(top, now)}${where}${extra}. Lists ${listed}: worth a check-in, not a storm-response push.`,
          top.source || 'nws', 'low',
        ));
      } else {
        let severity: TimingBadge['severity'] = 'medium';
        let proof = '';
        if (top.level === 'warning') {
          const reports = confirmingReports(top, history, now);
          if (reports.length) {
            const r = reports[0];
            const n = reports.reduce((sum, e) => sum + Math.trunc(Number(e.report_count) || 1), 0);
            const at = truthy(r.location) ? ` at ${r.location}` : '';
            severity = 'high';
            proof = `; ${n} NWS storm report${n !== 1 ? 's' : ''} in this county confirm${n === 1 ? 's' : ''} it `
              + `(latest ${r.event_type || r.kind}${at}, ${when(parseDt(r.valid))})`;
          } else {
            proof = '; no NWS storm reports in this county confirm damage yet';
          }
        }
        badges.push(badge(
          'storm_response', `Storm response: ${top.event}${recent}`,
          `NWS ${alertPhrase(top, now)}${where}${extra}${proof}. Lists ${listed}: expect repair and `
          + 'claim work -- lead with stock and fast delivery.',
          top.source || 'nws', severity,
        ));
      }
    } else {
      badges.push(badge(
        'weather_alert', `Severe weather${nearby ? ' nearby' : ''}: ${top.event}`,
        `NWS ${alertPhrase(top, now)}${where}${extra}.`, top.source || 'nws', 'low',
      ));
    }
  }
  if (services.has(NEW_CONSTRUCTION)) {
    const delays = all.filter((a) => a.active && DELAY_HAZARDS.has(a.family) && (
      a.family !== 'flood' || (a.onset && a.end && a.end.getTime() - a.onset.getTime() >= EXTENDED_ALERT)));
    if (delays.length) {
      const d = delays[0];
      badges.push(badge(
        'weather_delays', 'Weather delays likely',
        `NWS ${alertPhrase(d, now)}: new-construction schedules likely slip -- confirm delivery `
        + 'dates rather than push new orders.', d.source || 'nws', 'medium',
      ));
    }
  }

  for (const s of signals) {
    if (s.kind !== 'storm_history') continue;
    const p = s.payload || {};
    const events = (p.recent_events || []) as Json[];
    const cutoff = new Date(now.getTime() - RECENT_STORM).toISOString().slice(0, 10);
    const recent = events.filter((e) => (e.date || '') >= cutoff && ROOF_STORM_KINDS.has(e.kind));
    const reports = recent.reduce((sum, e) => sum + Math.trunc(Number(e.report_count) || 1), 0);
    if (!recent.length || (reports < 2 && !recent.some(significant))) continue;
    const key = (e: Json) => [e.date || '', e.valid || ''];
    const last = recent.reduce((best, e) => {
      const [a, b] = key(e);
      const [x, y] = key(best);
      return a > x || (a === x && b > y) ? e : best;
    });
    const capped = recent.length >= events.length && recent.length >= 10 ? '+' : '';
    const where = truthy(last.location) ? ` at ${last.location}` : '';
    badges.push(badge(
      'recent_storm', 'Recent storm activity',
      `${reports}${capped} roof-relevant storm report${reports !== 1 ? 's' : ''} in this county in the last `
      + `30 days; latest ${last.date} ${last.event_type || last.kind}${where} `
      + `(${last.source === 'lsr' ? 'NWS storm report' : 'NOAA Storm Events'}).`,
      s.source || 'noaa_storm_events',
      stormRoofer ? 'medium' : 'low',
    ));
    break;
  }

  const state = leadState(lead);
  if (state && SEASON_STATES.has(state)) {
    const [label, reason] = season(now.getUTCMonth() + 1);
    badges.push(badge('season', label, reason, 'calendar', 'info'));
  }

  return badges.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}
