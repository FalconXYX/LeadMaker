// Weather as a small add-on: one line of alerts for the book's counties, details on demand.
import { ChevronDown, CloudSun, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { SignalsResponse } from '@/api/types';
import { Card, Skeleton } from '@/components/ui';
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

export function WeatherCard({
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
    <Card className={cn('px-4 py-4 sm:px-6 sm:py-5', className)}>
      <div className="flex items-start gap-3.5">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4', top ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-muted')}>
          {top ? <TriangleAlert aria-hidden /> : <CloudSun aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Weather</p>
          {headline === null ? (
            <div className="mt-1 space-y-1.5"><Skeleton className="h-3.5 w-72 max-w-full" /><Skeleton className="h-3 w-48" /></div>
          ) : (
            <>
              <p className="mt-0.5 text-sm font-medium text-fg">{headline}</p>
              {sub && <p className="text-sm text-muted">{sub}</p>}
              {!signals && !!error && <p className="text-xs text-muted">We’ll try again shortly.</p>}
            </>
          )}
        </div>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-accent hover:bg-surface-2"
          >
            {open ? 'Hide' : 'Details'}
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        )}
      </div>
      {open && hasDetails && (
        <div id={panelId} className="mt-4 grid gap-5 border-t border-border pt-4 md:grid-cols-2">
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
    </Card>
  );
}
