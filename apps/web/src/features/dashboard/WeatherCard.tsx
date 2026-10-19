// Weather as one quiet line in the dashboard's AI briefing banner: the top alert for the book's counties (or the
// storm history), with the full list of alerts and storm reports on demand.
import { ChevronDown, CloudSun, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { SignalsResponse } from '@/api/types';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyName } from '@/lib/counties';
import { formatNumber } from '@/lib/format';
import { demandHazard, groupAlerts, stormSummaries, type AlertGroup } from './signals';

const timeFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const SALES_ANGLE: Record<ReturnType<typeof demandHazard>, string> = {
  storm: 'Repair crews there may need tarps, underlayment and shingles fast.',
  flood: 'Expect leak calls: a good moment to pitch underlayment, flashing and sealants.',
  winter: 'Snow and ice: pitch ice & water shield and emergency repair stock.',
  cold: 'Shingles need about 50°F to seal, so installs may slip: talk pre-buy and winter stock.',
  other: 'Worth a mention on today’s calls in those areas.',
};

function places(counties: readonly string[]): string {
  const names = counties.map((c) => countyName(c, { state: false }));
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function alertLine(a: AlertGroup): string {
  const until = a.status === 'upcoming' && a.onset ? `from ${timeFmt.format(a.onset)}` : a.ends ? `until ${timeFmt.format(a.ends)}` : '';
  return `${a.event} in ${places(a.counties)}${until ? ` ${until}` : ''}`;
}

export function WeatherLine({
  signals, isLoading, error, who, now, className,
}: { signals: SignalsResponse | undefined; isLoading: boolean; error: unknown; who: 'your' | 'the team’s'; now: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const active = useMemo(() => groupAlerts(signals?.alerts ?? [], new Date(now)).filter((a) => a.status !== 'ended'), [signals, now]);
  const storms = useMemo(() => stormSummaries(signals?.stormHistory ?? []).filter((s) => s.events12m > 0), [signals]);
  const leadsIn = (counties: readonly string[]) =>
    (signals?.counties ?? []).filter((c) => counties.includes(c.countyFips)).reduce((s, c) => s + c.leadCount, 0);

  const top = active[0];
  const headline = !signals
    ? (isLoading ? null : 'Weather is unavailable right now.')
    : top
      ? active.length === 1 ? alertLine(top) : `${alertLine(top)}, and ${active.length - 1} more alert${active.length > 2 ? 's' : ''}`
      : `No weather alerts in ${who} counties right now.`;
  const sub = top
    ? `${formatNumber(leadsIn(top.counties))} of ${who} leads are there. ${SALES_ANGLE[demandHazard(top.event)]}`
    : storms[0] ? `Most storm reports in the last year: ${countyName(storms[0].countyFips, { state: false })} (${storms[0].events12m}).` : null;
  const hasDetails = active.length > 0 || storms.length > 0;

  return (
    <div className={cn('text-sm', className)} data-testid="weather-line">
      <div className="flex items-start gap-2">
        <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', top ? 'text-warning' : 'text-muted')}>
          {top ? <TriangleAlert aria-label="Weather alert" /> : <CloudSun aria-label="Weather" />}
        </span>
        {headline === null ? (
          <div className="min-w-0 flex-1 pt-0.5"><Skeleton className="h-3.5 w-72 max-w-full" /></div>
        ) : (
          <p className="min-w-0 flex-1 text-muted">
            <span className={cn('font-medium', top ? 'text-fg' : 'text-muted')}>{headline}</span>
            {sub && <> {sub}</>}
            {!signals && !!error && <> We’ll try again shortly.</>}
            {hasDetails && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={panelId}
                className="ml-1.5 inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
              >
                {open ? 'Hide weather' : 'Weather details'}
                <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
              </button>
            )}
          </p>
        )}
      </div>
      {open && hasDetails && (
        <div id={panelId} className="mt-3 grid gap-5 border-t border-accent/15 pt-3 pl-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Active alerts</h3>
            {active.length ? (
              <ul className="space-y-2.5">
                {active.map((a) => (
                  <li key={a.key} className="text-sm">
                    <p className="font-medium text-fg">{alertLine(a)}</p>
                    <p className="text-muted">{formatNumber(leadsIn(a.counties))} leads in the area. {SALES_ANGLE[demandHazard(a.event)]}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">None right now.</p>}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Storm reports, last 12 months</h3>
            {storms.length ? (
              <ul className="space-y-1.5 text-sm">
                {storms.slice(0, 5).map((s) => (
                  <li key={s.countyFips} className="flex justify-between gap-3">
                    <span className="truncate text-fg">{countyName(s.countyFips)}</span>
                    <span className="shrink-0 text-muted tabular-nums">{formatNumber(s.events12m)}{s.lastEvent ? ` · last: ${s.lastEvent.label.toLowerCase()}` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No storm reports.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
