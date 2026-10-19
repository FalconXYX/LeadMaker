// "Your leads at a glance": one card for what the book is made of. Who buys from us (accounts), whether we can reach
// them (contact info on file), what they do (the most common tags) and the priority mix, split by dividers.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatNumber } from '@/lib/format';
import { SEGMENTS, SEGMENT_LABELS, isSegment, type Segment } from '@/lib/labels';
import { cn } from '@/lib/cn';
import type { DashboardScope, DashboardData, TopTag } from './api';
import { CardError, CardSkeleton, Meter, MoreLink, Section, pct } from './parts';
import { salesLeadsHref } from './sales';

interface Props {
  scope: DashboardScope;
  data: DashboardData | undefined;
  error: unknown;
  onRetry: () => void;
  className?: string;
}

function tagHref(scope: DashboardScope, t: TopTag): string {
  if (t.kind === 'custom') return salesLeadsHref(scope, { customTags: [t.key] });
  return salesLeadsHref(scope, { tagsAll: [t.key] });
}

const SEG_BAR: Record<Segment, string> = {
  strategic: 'bg-seg-strategic',
  growth: 'bg-seg-growth',
  emerging: 'bg-seg-emerging',
  long_tail: 'bg-seg-long-tail',
};

const plural = (k: number, one: string, many = `${one}s`) => `${formatNumber(k)} ${k === 1 ? one : many}`;

function Part({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <h4 className="mb-2.5 text-xs font-medium tracking-wide text-muted uppercase">{title}</h4>
      {children}
    </div>
  );
}

export function BookOverviewCard({ scope, data, error, onRetry, className }: Props) {
  return (
    <Section title={scope === 'mine' ? 'Your leads at a glance' : 'Leads at a glance'} description="Who buys from us, who we can reach, and what they do" className={className} accent="sky" level={3}>
      {!data ? (error ? <CardError error={error} onRetry={onRetry} /> : <CardSkeleton lines={8} />) : (() => {
        const a = data.accounts;
        const c = data.coverage;
        const accounts = [
          { key: 'prospect', label: 'Prospects', value: a.prospect, hint: 'Not buying from us yet' },
          { key: 'existing_customer', label: 'Customers', value: a.existing_customer, hint: 'Buying today: sell them more' },
          { key: 'lapsed_customer', label: 'Lapsed', value: a.lapsed_customer, hint: 'Used to buy: win them back' },
        ] as const;
        const meters = [
          { label: 'Decision-maker found', value: c.withDecisionMaker },
          { label: 'Email on file', value: c.withEmail },
          { label: 'Phone on file', value: c.withPhone },
        ];
        const tags = data.topTags.slice(0, 8);
        const tagMax = Math.max(1, ...tags.map((t) => t.count));
        const segTotal = data.segments.reduce((sum, x) => sum + x.count, 0);
        const segs = data.segments
          .flatMap((x) => (isSegment(x.segment) ? [{ segment: x.segment, count: x.count }] : []))
          .sort((x, y) => SEGMENTS.indexOf(x.segment) - SEGMENTS.indexOf(y.segment));
        return (
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Part title="Who buys from us">
              <ul className="divide-y divide-border">
                {accounts.map((r) => (
                  <li key={r.key}>
                    <Link to={salesLeadsHref(scope, { accountStatus: [r.key] })} className="group flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg group-hover:text-accent">{r.label}</span>
                        <span className="block truncate text-xs text-muted">{r.hint}</span>
                      </span>
                      <span className="text-base font-semibold text-fg tabular-nums">{formatNumber(r.value)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                {a.lapsed_customer > 0
                  ? <MoreLink to={salesLeadsHref(scope, { accountStatus: ['lapsed_customer'], sort: { by: 'priority_score', dir: 'desc' } })}>Win back {plural(a.lapsed_customer, 'lapsed account')}</MoreLink>
                  : <span className="text-muted">No lapsed accounts</span>}
                {a.do_not_contact > 0 && <span className="text-xs text-muted">{formatNumber(a.do_not_contact)} do not contact</span>}
              </div>
            </Part>
            <Part title="Can we reach them?">
              <ul className="space-y-3">
                {meters.map((m) => (
                  <li key={m.label}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-fg">{m.label}</span>
                      <span className="text-muted tabular-nums"><span className="font-semibold text-fg">{pct(m.value, c.total)}%</span> · {formatNumber(m.value)} of {formatNumber(c.total)}</span>
                    </div>
                    <Meter className="h-1.5" value={m.value} max={c.total} label={`${m.label}: ${m.value} of ${c.total}`} />
                  </li>
                ))}
              </ul>
            </Part>
            <Part title="What they do most" className="border-t border-border pt-4">
              {tags.length ? (
                <ul className="space-y-0.5">
                  {tags.map((t) => (
                    <li key={`${t.kind}:${t.key}`}>
                      <Link to={tagHref(scope, t)} className="group grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-md px-1 py-1 hover:bg-surface-2">
                        <span className="truncate text-sm text-fg group-hover:text-accent" title={t.label}>{t.label}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full bg-sky" style={{ width: `${(t.count / tagMax) * 100}%` }} />
                        </span>
                        <span className="text-right text-sm text-muted tabular-nums">{formatNumber(t.count)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">No tags yet. They appear once LeadMaker has tagged your leads.</p>}
            </Part>
            <Part title="Priority mix" className="border-t border-border pt-4">
              {segTotal > 0 ? (
                <>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={segs.map((x) => `${SEGMENT_LABELS[x.segment]} ${x.count}`).join(', ')}>
                    {segs.map((x) => <span key={x.segment} className={cn('h-full', SEG_BAR[x.segment])} style={{ width: `${(x.count / segTotal) * 100}%` }} />)}
                  </div>
                  <ul className="mt-3 space-y-0.5">
                    {segs.map((x) => (
                      <li key={x.segment}>
                        <Link to={salesLeadsHref(scope, { segment: [x.segment] })} className="group flex items-center justify-between gap-2 rounded-md px-1 py-1 hover:bg-surface-2">
                          <span className="flex items-center gap-2 text-sm text-fg group-hover:text-accent">
                            <span className={cn('size-2.5 rounded-sm', SEG_BAR[x.segment])} aria-hidden />
                            {SEGMENT_LABELS[x.segment]}
                          </span>
                          <span className="text-sm text-muted tabular-nums">{formatNumber(x.count)} · {pct(x.count, segTotal)}%</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : <p className="text-sm text-muted">No priority groups yet.</p>}
            </Part>
          </div>
        );
      })()}
    </Section>
  );
}
