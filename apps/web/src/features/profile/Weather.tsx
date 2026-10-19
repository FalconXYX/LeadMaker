import { CloudLightning, Newspaper, Radar, Siren } from 'lucide-react';
import { useState } from 'react';
import { useSignals } from '@/api/queries';
import type { RegionalSignal, TimingBadge as TimingBadgeData } from '@/api/types';
import { Badge, ErrorState, ExternalLink, Skeleton, TimingBadge, Tooltip, type BadgeVariant } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyFullName } from '@/lib/counties';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { TIMING_SEVERITY_LABELS, readableWeatherText } from '@/lib/labels';
import { useProfile } from './context';
import { sortTiming, sourceLabel, whyNow } from './lib';
import { SectionCard } from './ui';

/** One line for the header's facts strip: the strongest weather or season signal, details on the Weather tab. */
export function WeatherLine({ onDetails }: { onDetails: () => void }) {
  const { profile } = useProfile();
  const top = sortTiming(profile.timing)[0];
  if (!top) return <p className="text-muted">Quiet: no weather signal</p>;
  const urgent = top.severity === 'high' || top.severity === 'medium';
  return (
    <p className="flex min-w-0 items-center gap-1.5">
      <CloudLightning className={cn('size-3.5 shrink-0', urgent ? 'text-timing-medium' : 'text-subtle')} aria-hidden />
      <Tooltip content={readableWeatherText(top.reason)}>
        <span tabIndex={0} className="min-w-0 truncate rounded text-fg">{top.label}</span>
      </Tooltip>
      <button type="button" onClick={onDetails} className="shrink-0 text-xs font-medium text-accent hover:underline">
        Details
      </button>
    </p>
  );
}

const SEVERITY_BAR: Record<TimingBadgeData['severity'], string> = {
  high: 'bg-timing-high',
  medium: 'bg-timing-medium',
  low: 'bg-timing-low',
  info: 'bg-timing-info',
};

export function TimingCard() {
  const { profile } = useProfile();
  const badges = sortTiming(profile.timing);
  const implication = whyNow(profile)?.implication;
  return (
    <SectionCard title="Demand timing" icon={<CloudLightning />} description="Weather and season signals matched to this contractor’s work.">
      {implication && <p className="mb-4 text-sm text-fg"><span className="font-medium">What it means: </span>{implication}</p>}
      {badges.length === 0 ? (
        <p className="text-sm text-subtle">No weather or season signal for this lead right now.</p>
      ) : (
        <ul className="space-y-4">
          {badges.map((b) => (
            <li key={b.key} className="flex gap-3">
              <span className={cn('w-1 shrink-0 rounded-full', SEVERITY_BAR[b.severity])} aria-hidden="true" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <TimingBadge badge={b} />
                  <span className="text-xs text-muted">{TIMING_SEVERITY_LABELS[b.severity]} · {sourceLabel(b.source)}</span>
                </div>
                <p className="mt-1.5 text-sm text-fg">{readableWeatherText(b.reason)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function alertVariant(severity: string): BadgeVariant {
  const s = severity.toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'danger';
  if (s === 'moderate') return 'warning';
  if (s === 'minor') return 'info';
  return 'neutral';
}

/** The county's NWS alerts, storm history and local news (GET /api/signals, filtered to this county). */
export function CountySignals() {
  const { profile } = useProfile();
  const fips = profile.details.countyFips;
  const q = useSignals('all');
  const county = countyFullName(fips);

  if (q.isPending) {
    return (
      <SectionCard title="Weather in this county" icon={<Radar />}>
        <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-24" /></div>
      </SectionCard>
    );
  }
  if (q.isError) {
    return (
      <SectionCard title="Weather in this county" icon={<Radar />}>
        <ErrorState message="Weather signals are unavailable right now." onRetry={() => void q.refetch()} className="py-4" />
      </SectionCard>
    );
  }
  const inCounty = (r: RegionalSignal) => !!fips && r.countyFips === fips;
  const alerts = q.data.alerts.filter(inCounty);
  const storms = q.data.stormHistory.find(inCounty);
  const news = q.data.news.filter(inCounty);
  return (
    <>
      <AlertsCard alerts={alerts} county={county} />
      <StormHistoryCard signal={storms} county={county} />
      {news.length > 0 && <NewsCard items={news} county={county} />}
    </>
  );
}

const ACTIVE_BOX: Partial<Record<BadgeVariant, string>> = {
  danger: 'border-danger/30 bg-danger-soft/60',
  warning: 'border-warning/30 bg-warning-soft/60',
  info: 'border-info/30 bg-info-soft/60',
};

function AlertsCard({ alerts, county }: { alerts: RegionalSignal[]; county: string }) {
  const [all, setAll] = useState(false);
  const sorted = [...alerts].sort(
    (a, b) => Number(b.active) - Number(a.active) || Date.parse(b.validFrom ?? b.fetchedAt) - Date.parse(a.validFrom ?? a.fetchedAt),
  );
  const active = sorted.filter((a) => a.active);
  const rank: Record<string, number> = { danger: 0, warning: 1, info: 2, neutral: 3 };
  const worst = active.map((a) => alertVariant(str(a.payload.severity))).sort((x, y) => (rank[x] ?? 9) - (rank[y] ?? 9))[0];
  const shown = all ? sorted : sorted.slice(0, 4);
  return (
    <SectionCard
      title="Weather alerts"
      icon={<Siren />}
      description={`National Weather Service alerts for ${county}: in effect, upcoming, or ended in the last 7 days.`}
      actions={active.length > 0 ? <Badge variant={worst ?? 'info'}>{active.length} active</Badge> : undefined}
    >
      {sorted.length === 0 ? (
        <p className="text-sm text-subtle">No alerts for this county in the last 7 days.</p>
      ) : (
        <>
          <ul className="space-y-2.5">
            {shown.map((a) => {
              const p = a.payload;
              const severity = str(p.severity) || 'Unknown';
              const ends = str(p.ends) || str(p.expires) || a.validTo;
              const upcoming = !a.active && !a.expired;
              return (
                <li
                  key={a.id}
                  className={cn('rounded-lg border px-3 py-2.5', a.active ? ACTIVE_BOX[alertVariant(severity)] ?? 'border-border-strong' : 'border-border')}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{str(p.event) || 'Weather alert'}</span>
                    <Badge variant={alertVariant(severity)}>{severity}</Badge>
                    <span className="text-xs text-muted">
                      {a.active ? `In effect until ${formatDateTime(ends)}` : upcoming ? `Starts ${formatDateTime(str(p.onset) || a.validFrom)}` : `Ended ${formatRelative(ends)}`}
                    </span>
                  </div>
                  {str(p.headline) && <p className="mt-1 text-xs text-muted">{str(p.headline)}</p>}
                  {a.active && str(p.instruction) && <p className="mt-1 text-xs text-fg">{str(p.instruction)}</p>}
                </li>
              );
            })}
          </ul>
          {sorted.length > 4 && (
            <button type="button" onClick={() => setAll((x) => !x)} className="mt-2.5 text-xs font-medium text-accent hover:underline">
              {all ? 'Show fewer' : `Show all ${sorted.length} alerts`}
            </button>
          )}
        </>
      )}
    </SectionCard>
  );
}

interface StormEvent {
  date: string;
  kind: string;
  event_type: string;
  location: string;
  narrative: string;
  damage_usd: number;
  structure: boolean;
}

function toEvent(v: unknown): StormEvent | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return {
    date: str(o.date), kind: str(o.kind), event_type: str(o.event_type), location: str(o.location),
    narrative: str(o.narrative), damage_usd: num(o.damage_usd), structure: o.structure === true,
  };
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])\w/g, (m) => m.toUpperCase()).replace(/\bTstm\b/g, 'Thunderstorm').replace(/\bWnd\b/g, 'Wind').replace(/\bDmg\b/g, 'Damage');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function StormHistoryCard({ signal, county }: { signal: RegionalSignal | undefined; county: string }) {
  const [all, setAll] = useState(false);
  if (!signal) {
    return (
      <SectionCard title="Recent storms" icon={<CloudLightning />}>
        <p className="text-sm text-subtle">No storm history on file for {county}.</p>
      </SectionCard>
    );
  }
  const p = signal.payload;
  const counts = (typeof p.counts_24m === 'object' && p.counts_24m ? p.counts_24m : {}) as Record<string, unknown>;
  const recent = (Array.isArray(p.recent_events) ? p.recent_events : []).map(toEvent).filter((e): e is StormEvent => !!e);
  const notable = toEvent(p.notable_event);
  const tiles = [
    { label: 'Storm reports, 12 mo', value: num(p.events_12m) },
    { label: 'Wind, 24 mo', value: num(counts.wind) },
    { label: 'Hail, 24 mo', value: num(counts.hail) },
    { label: 'Flood, 24 mo', value: num(counts.flood) },
  ];
  const damage = num(p.property_damage_24m_usd);
  const shown = all ? recent : recent.slice(0, 4);
  return (
    <SectionCard
      title="Recent storms"
      icon={<CloudLightning />}
      description={`NOAA storm reports for ${county}${str(p.last_event_at) ? ` · latest ${formatDate(str(p.last_event_at))}` : ''}.`}
    >
      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-border bg-surface-2/60 px-3.5 py-2.5">
            <dt className="text-xs text-muted">{t.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold text-fg">{t.value}</dd>
          </div>
        ))}
      </dl>
      {damage > 0 && <p className="mt-2 text-xs text-muted">Reported property damage over 24 months: <span className="font-medium text-fg">{usd.format(damage)}</span></p>}
      {notable && notable.event_type && (
        <div className="mt-4 rounded-lg border border-border px-3.5 py-3">
          <p className="text-xs font-medium text-muted">Most notable, last 24 months</p>
          <p className="mt-0.5 text-sm font-medium text-fg">
            {titleCase(notable.event_type)} · {notable.location} · {formatDate(notable.date)}
            {notable.damage_usd > 0 && <span className="font-normal text-muted"> · {usd.format(notable.damage_usd)} damage</span>}
          </p>
          {notable.narrative && <p className="mt-0.5 text-xs text-muted">{notable.narrative}</p>}
        </div>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="mt-5 mb-2.5 text-xs font-semibold tracking-wide text-muted uppercase">Latest reports</h3>
          <ol className="space-y-3">
            {shown.map((e, i) => (
              <li key={`${e.date}-${e.location}-${i}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 text-sm">
                <time dateTime={e.date} className="text-xs text-muted tabular">{formatDate(e.date).replace(/, \d{4}$/, '')}</time>
                <div className="min-w-0">
                  <p className="font-medium text-fg">{titleCase(e.event_type || e.kind)} <span className="font-normal text-muted">· {e.location}</span></p>
                  {e.narrative && <p className="line-clamp-2 text-xs text-muted">{e.narrative}</p>}
                </div>
              </li>
            ))}
          </ol>
          {recent.length > 4 && (
            <button type="button" onClick={() => setAll((x) => !x)} className="mt-2.5 text-xs font-medium text-accent hover:underline">
              {all ? 'Show fewer' : `Show all ${recent.length} reports`}
            </button>
          )}
        </>
      )}
    </SectionCard>
  );
}

function NewsCard({ items, county }: { items: RegionalSignal[]; county: string }) {
  return (
    <SectionCard title="Local news" icon={<Newspaper />} description={`Roofing and housing news for ${county}, last 30 days.`}>
      <ul className="space-y-3">
        {items.slice(0, 5).map((n) => {
          const p = n.payload;
          return (
            <li key={n.id} className="text-sm">
              <ExternalLink href={str(p.url)} icon className="font-medium text-fg hover:text-accent hover:underline">
                {str(p.title) || 'News item'}
              </ExternalLink>
              <p className="text-xs text-muted">{[str(p.outlet), str(p.published_at) && formatDate(str(p.published_at))].filter(Boolean).join(' · ')}</p>
              {str(p.summary) && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{str(p.summary)}</p>}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
