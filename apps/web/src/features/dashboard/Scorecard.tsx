// The sales scorecard: follow-ups and this week's activity vs the goal (beside Today's calls), and the pipeline
// funnel. Every number says what it is compared with and links to the leads behind it.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { activityTotal, type DashboardData, type DashboardScope, type Task } from './api';
import { CardError, CardSkeleton, CountLink, Meter, MoreLink, Section, pct } from './parts';
import { FUNNEL, STAGE_LABELS, daysAgoDate, salesLeadsHref, weekPace } from './sales';

interface CardProps {
  scope: DashboardScope;
  data: DashboardData | undefined;
  error: unknown;
  onRetry: () => void;
  className?: string;
}

const plural = (k: number, one: string, many = `${one}s`) => `${formatNumber(k)} ${k === 1 ? one : many}`;

function body(p: CardProps, render: (d: DashboardData) => ReactNode, lines = 4) {
  if (p.data) return render(p.data);
  if (p.error) return <CardError error={p.error} onRetry={p.onRetry} />;
  return <CardSkeleton lines={lines} />;
}

const dueFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** A heading inside a merged card: the card is one box, each part gets a title and a plain line. */
function PartHeading({ id, title, description, action }: { id?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h3 id={id} className="text-[15px] leading-tight font-semibold text-fg">{title}</h3>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2.5 text-sm">{action}</div>}
    </div>
  );
}

/**
 * The column beside Today's calls: Follow-ups, then This week (activity vs goal, compressed to one row of numbers and
 * a slim bar), then the three most recent touches. One card with dividers, so it reads as one block, not three.
 */
export function TodaySidePanel(p: CardProps & { upcoming: readonly Task[] | undefined; showOwner?: boolean; now: number; recent: ReactNode }) {
  return (
    <Card className={cn('flex min-w-0 flex-col border-t-4 border-t-roof', p.className)} role="region" aria-labelledby="follow-ups-title">
      <div className="px-4 pt-4 pb-5 sm:px-6 sm:pt-5">
        <PartHeading id="follow-ups-title" title="Follow-ups" description={p.scope === 'mine' ? 'Calls and tasks you’ve scheduled' : 'Scheduled calls and tasks'} action={<MoreLink to="/tasks">See all</MoreLink>} />
        <div className="mt-3.5">{body(p, (d) => <FollowUpsBody p={p} d={d} />, 3)}</div>
      </div>
      <div className="border-t border-border px-4 pt-4 pb-5 sm:px-6" role="region" aria-labelledby="this-week-title">
        <PartHeading id="this-week-title" title="This week" description={`Calls, emails and visits against ${p.scope === 'mine' ? 'your' : 'the'} goal`} />
        <div className="mt-3.5">{body(p, (d) => <WeekBody d={d} now={p.now} />, 2)}</div>
      </div>
      <div className="mt-auto border-t border-border px-4 pt-4 pb-5 sm:px-6">{p.recent}</div>
    </Card>
  );
}

function FollowUpsBody({ p, d }: { p: CardProps & { upcoming: readonly Task[] | undefined; showOwner?: boolean }; d: DashboardData }) {
  const f = d.followUps;
  const href = (followUp: 'overdue' | 'today' | 'week') => salesLeadsHref(p.scope, { followUp, sort: { by: 'next_follow_up', dir: 'asc' } });
  const next = (p.upcoming ?? []).slice(0, 3);
  return (
    <div>
      <div className="grid grid-cols-3 gap-2.5">
        <CountLink to={href('overdue')} value={f.overdue} label="Overdue" tone="danger" className="py-2.5" />
        <CountLink to={href('today')} value={f.today} label="Due today" tone="warning" className="py-2.5" />
        <CountLink to={href('week')} value={f.week} label="This week" tone="accent" className="py-2.5" />
      </div>
      <p className="mt-3 text-sm text-muted">
        {f.overdue > 0
          ? `Clear the ${plural(f.overdue, 'overdue one')} first: those contractors are expecting to hear back.`
          : f.today > 0 ? 'Nothing overdue. Work through today’s list before lunch.'
          : f.week > 0 ? 'Nothing due today. Get ahead on this week’s follow-ups.'
          : 'No follow-ups scheduled. Book the next step whenever you log a call.'}
      </p>
      {next.length > 0 && (
        <div className="mt-3.5">
          <h4 className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">Coming up</h4>
          <ul className="space-y-1.5">
            {next.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate" title={`${t.companyName} · ${t.title}${p.showOwner ? ` · ${t.assignee.name}` : ''}`}>
                  <Link to={`/leads/${t.companyId}`} className="font-medium text-fg hover:text-accent hover:underline">{t.companyName}</Link>
                  <span className="text-muted"> · {t.title}{p.showOwner ? ` · ${t.assignee.name}` : ''}</span>
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{dueFmt.format(new Date(t.dueAt))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WeekBody({ d, now }: { d: DashboardData; now: number }) {
  const done = activityTotal(d.activity.thisWeek);
  const last = activityTotal(d.activity.lastWeek);
  const goal = d.activity.goalPerWeek;
  const pace = weekPace(goal, now);
  const diff = done - last;
  const status = done >= goal ? 'Goal reached' : done >= pace ? 'On track' : `${formatNumber(pace - done)} behind schedule`;
  const stats = [
    { label: 'Calls', value: d.activity.thisWeek.calls },
    { label: 'Emails', value: d.activity.thisWeek.emails },
    { label: 'Visits', value: d.activity.thisWeek.visits },
  ];
  return (
    <div>
      <dl className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Done</dt>
          <dd className="mt-0.5 whitespace-nowrap text-fg"><span className="text-xl leading-none font-semibold tabular-nums">{formatNumber(done)}</span><span className="ml-1 text-sm text-muted">of {formatNumber(goal)} goal</span></dd>
        </div>
        {stats.map((x) => (
          <div key={x.label} className="min-w-0 text-right">
            <dt className="text-xs text-muted">{x.label}</dt>
            <dd className="mt-0.5 text-xl leading-none font-semibold text-fg tabular-nums">{formatNumber(x.value)}</dd>
          </div>
        ))}
      </dl>
      <Meter className="mt-3 h-1.5" value={done} max={goal} marker={pace} tone={done >= goal ? 'success' : 'accent'} label={`${done} of ${goal} activities this week`} />
      <p className="mt-2 flex flex-wrap justify-between gap-x-3 text-sm">
        <span className={cn('font-medium', done >= pace ? 'text-success' : 'text-warning')}>{status}</span>
        <span className="text-muted">
          {diff === 0 ? `Same as last week (${formatNumber(last)})`
            : diff > 0 ? `${formatNumber(diff)} more than last week (${formatNumber(last)})`
            : `${formatNumber(-diff)} fewer than last week (${formatNumber(last)})`}
        </span>
      </p>
    </div>
  );
}

export function PipelineCard(p: CardProps & { now: number }) {
  return (
    <Section
      title="Sales stages"
      description="How many leads sit at each step, from first call to won"
      className={p.className}
      accent="violet"
      level={3}
      action={<MoreLink to={salesLeadsHref(p.scope, { stages: ['interested', 'quoting'] })}>See warm deals</MoreLink>}
    >
      {body(p, (d) => {
        const max = Math.max(1, ...FUNNEL.map((st) => d.pipeline[st]));
        const decided = d.pipeline.won + d.pipeline.lost;
        const warm = d.pipeline.interested + d.pipeline.quoting;
        const toWork = [
          { label: 'Never contacted', value: d.neverContacted, to: salesLeadsHref(p.scope, { stages: ['new'], sort: { by: 'priority_score', dir: 'desc' } }), hint: 'Highest priority first' },
          { label: 'No contact in 30 days', value: d.notContacted30d, to: salesLeadsHref(p.scope, { notContactedSince: daysAgoDate(30, p.now), sort: { by: 'last_contacted', dir: 'asc' } }), hint: 'Easy check-in calls' },
          { label: 'New or updated', value: d.newSinceLastPoll, to: salesLeadsHref(p.scope, { updatedInLastPoll: true, sort: { by: 'last_change', dir: 'desc' } }), hint: 'From the latest data refresh' },
        ];
        return (
          <div className="flex h-full flex-col">
            <ol className="space-y-1.5" aria-label="Sales funnel">
              {FUNNEL.map((st, i) => {
                const count = d.pipeline[st];
                const prev = i > 0 ? d.pipeline[FUNNEL[i - 1]!] : null;
                return (
                  <li key={st}>
                    <Link
                      to={salesLeadsHref(p.scope, { stages: [st] })}
                      data-stage={st}
                      className="lm-stage group grid grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3 rounded-md px-1.5 py-2 hover:bg-surface-2"
                      aria-label={`${STAGE_LABELS[st]}: ${count} leads`}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-fg group-hover:text-accent">
                        <span className="lm-stage-dot size-2 shrink-0 rounded-full" aria-hidden />
                        {STAGE_LABELS[st]}
                      </span>
                      <span className="h-5 overflow-hidden rounded bg-surface-2">
                        <span className="lm-stage-bar block h-full rounded" style={{ width: `${Math.max(count ? 2 : 0, (count / max) * 100)}%` }} />
                      </span>
                      <span className="text-right text-sm font-semibold text-fg tabular-nums">
                        {formatNumber(count)}
                        {prev !== null && prev > 0 && i > 1 && <span className="sr-only"> ({pct(count, prev)}% of {STAGE_LABELS[FUNNEL[i - 1]!]})</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-border pt-4 text-sm">
              <span className="text-muted">
                {warm > 0 ? `${plural(warm, 'warm deal')} open` : 'No warm deals yet'}
                {decided > 0 && ` · won ${pct(d.pipeline.won, decided)}% of closed deals`}
              </span>
              <Link to={salesLeadsHref(p.scope, { stages: ['lost'] })} data-stage="lost" className="lm-stage inline-flex items-center gap-1.5 text-muted hover:text-accent hover:underline">
                <span className="lm-stage-dot size-2 rounded-full" aria-hidden />
                {STAGE_LABELS.lost} <span className="font-semibold text-fg tabular-nums">{formatNumber(d.pipeline.lost)}</span>
              </Link>
            </div>
            <div className="mt-auto pt-5">
              <h4 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Still to work</h4>
              <ul className="divide-y divide-border">
                {toWork.map((k) => (
                  <li key={k.label}>
                    <Link to={k.to} className="group flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg group-hover:text-accent">{k.label}</span>
                        <span className="block truncate text-xs text-muted">{k.hint}</span>
                      </span>
                      <span className="text-base font-semibold text-fg tabular-nums">{formatNumber(k.value)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </Section>
  );
}
