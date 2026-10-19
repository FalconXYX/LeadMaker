// Book health (who we can reach, who we have not called) and what the book is made of (tags, segments).
import { Link } from 'react-router';
import { formatNumber } from '@/lib/format';
import { SEGMENTS, SEGMENT_LABELS, isSegment, type Segment } from '@/lib/labels';
import { cn } from '@/lib/cn';
import type { DashboardScope, DashboardData, TopTag } from './api';
import { CardError, CardSkeleton, Meter, Section, pct } from './parts';
import { daysAgoDate, salesLeadsHref } from './sales';

interface Props {
  scope: DashboardScope;
  data: DashboardData | undefined;
  error: unknown;
  onRetry: () => void;
  now: number;
  className?: string;
}

export function BookHealthCard({ scope, data, error, onRetry, now, className }: Props) {
  return (
    <Section title="Book health" description="Can we reach them, and have we tried?" className={className} accent="amber">
      {!data ? (error ? <CardError error={error} onRetry={onRetry} /> : <CardSkeleton lines={6} />) : (() => {
        const c = data.coverage;
        const meters = [
          { label: 'Decision-maker found', value: c.withDecisionMaker },
          { label: 'Email on file', value: c.withEmail },
          { label: 'Phone on file', value: c.withPhone },
        ];
        const counts = [
          { label: 'Never contacted', value: data.neverContacted, to: salesLeadsHref(scope, { stages: ['new'], sort: { by: 'priority_score', dir: 'desc' } }), hint: 'Start with the highest priority' },
          { label: 'Not contacted in 30 days', value: data.notContacted30d, to: salesLeadsHref(scope, { notContactedSince: daysAgoDate(30, now), sort: { by: 'last_contacted', dir: 'asc' } }), hint: 'Easy check-in calls' },
          { label: 'New since last poll', value: data.newSinceLastPoll, to: salesLeadsHref(scope, { updatedInLastPoll: true, sort: { by: 'last_change', dir: 'desc' } }), hint: 'Fresh from the latest data' },
        ];
        return (
          <div>
            <ul className="space-y-4">
              {meters.map((m) => (
                <li key={m.label}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-fg">{m.label}</span>
                    <span className="text-muted tabular-nums"><span className="font-semibold text-fg">{pct(m.value, c.total)}%</span> · {formatNumber(m.value)} of {formatNumber(c.total)}</span>
                  </div>
                  <Meter value={m.value} max={c.total} label={`${m.label}: ${m.value} of ${c.total}`} />
                </li>
              ))}
            </ul>
            <ul className="mt-5 divide-y divide-border border-t border-border">
              {counts.map((k) => (
                <li key={k.label}>
                  <Link to={k.to} className="group flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg group-hover:text-accent">{k.label}</span>
                      <span className="block truncate text-xs text-muted">{k.hint}</span>
                    </span>
                    <span className="text-lg font-semibold text-fg tabular-nums">{formatNumber(k.value)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}
    </Section>
  );
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

export function BookMixCard({ scope, data, error, onRetry, className }: Omit<Props, 'now'>) {
  return (
    <Section title="What’s in the book" description="The most common tags and the priority mix" className={className} accent="sky">
      {!data ? (error ? <CardError error={error} onRetry={onRetry} /> : <CardSkeleton lines={6} />) : (() => {
        const tags = data.topTags.slice(0, 8);
        const tagMax = Math.max(1, ...tags.map((t) => t.count));
        const segTotal = data.segments.reduce((sum, x) => sum + x.count, 0);
        const segs = data.segments
          .flatMap((x) => (isSegment(x.segment) ? [{ segment: x.segment, count: x.count }] : []))
          .sort((a, b) => SEGMENTS.indexOf(a.segment) - SEGMENTS.indexOf(b.segment));
        return (
          <div className="grid gap-7 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-8">
            <div>
              <h3 className="mb-2.5 text-xs font-medium tracking-wide text-muted uppercase">Top tags</h3>
              {tags.length ? (
                <ul className="space-y-0.5">
                  {tags.map((t) => (
                    <li key={`${t.kind}:${t.key}`}>
                      <Link to={tagHref(scope, t)} className="group grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
                        <span className="truncate text-sm text-fg group-hover:text-accent">{t.label}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full bg-sky" style={{ width: `${(t.count / tagMax) * 100}%` }} />
                        </span>
                        <span className="text-right text-sm text-muted tabular-nums">{formatNumber(t.count)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">No tags yet. They appear after the pipeline tags your leads.</p>}
            </div>
            <div>
              <h3 className="mb-2.5 text-xs font-medium tracking-wide text-muted uppercase">Priority segments</h3>
              {segTotal > 0 ? (
                <>
                  <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={segs.map((x) => `${SEGMENT_LABELS[x.segment]} ${x.count}`).join(', ')}>
                    {segs.map((x) => <span key={x.segment} className={cn('h-full', SEG_BAR[x.segment])} style={{ width: `${(x.count / segTotal) * 100}%` }} />)}
                  </div>
                  <ul className="mt-4 space-y-0.5">
                    {segs.map((x) => (
                      <li key={x.segment}>
                        <Link to={salesLeadsHref(scope, { segment: [x.segment] })} className="group flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
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
              ) : <p className="text-sm text-muted">No segments yet.</p>}
            </div>
          </div>
        );
      })()}
    </Section>
  );
}
