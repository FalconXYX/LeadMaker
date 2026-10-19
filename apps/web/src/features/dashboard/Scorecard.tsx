// The sales scorecard: activity vs the weekly goal, follow-ups, the pipeline funnel and the account mix.
// Every number says what it is compared with and links to the leads behind it.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { activityTotal, type DashboardData, type DashboardScope, type Task } from './api';
import { CardError, CardSkeleton, CountLink, Meter, MoreLink, Section, pct } from './parts';
import { FUNNEL, STAGE_LABELS, salesLeadsHref, weekPace } from './sales';

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

const dayLetter = new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'UTC' });
const dayLong = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function ActivityCard(p: CardProps & { now: number }) {
  return (
    <Section
      title="Activity this week"
      description="Calls, emails and visits logged"
      className={p.className}
      accent="blue"
      action={<MoreLink to={salesLeadsHref(p.scope, { sort: { by: 'last_contacted', dir: 'desc' } })}>Contacted</MoreLink>}
    >
      {body(p, (d) => {
        const done = activityTotal(d.activity.thisWeek);
        const last = activityTotal(d.activity.lastWeek);
        const goal = d.activity.goalPerWeek;
        const pace = weekPace(goal, p.now);
        const diff = done - last;
        const status = done >= goal ? 'Goal reached' : done >= pace ? 'On pace' : `${formatNumber(pace - done)} behind pace`;
        const daily = d.activity.daily.slice(-14);
        const peak = Math.max(1, ...daily.map((x) => x.total));
        return (
          <div className="flex h-full flex-col">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-fg">
                <span className="text-3xl leading-none font-semibold tabular-nums">{formatNumber(done)}</span>
                <span className="ml-1.5 text-sm text-muted">of {formatNumber(goal)} goal</span>
              </p>
              <span className={cn('text-sm font-medium', done >= pace ? 'text-success' : 'text-warning')}>{status}</span>
            </div>
            <Meter className="mt-4" value={done} max={goal} marker={pace} tone={done >= goal ? 'success' : 'accent'} label={`${done} of ${goal} activities this week`} />
            <p className="mt-4 text-sm text-fg">
              {plural(d.activity.thisWeek.calls, 'call')} · {plural(d.activity.thisWeek.emails, 'email')} · {plural(d.activity.thisWeek.visits, 'visit')}
            </p>
            <p className="mt-1 text-sm text-muted">
              {diff === 0 ? `Same as last week (${formatNumber(last)})`
                : diff > 0 ? `${formatNumber(diff)} more than last week (${formatNumber(last)})`
                : `${formatNumber(-diff)} fewer than last week (${formatNumber(last)})`}
            </p>
            {daily.length > 0 && (
              <div className="mt-auto pt-5" aria-label="Activities per day, last 14 days" role="img">
                <div className="flex h-10 items-end gap-1">
                  {daily.map((x, i) => (
                    <span
                      key={x.date || i}
                      title={`${x.date ? dayLong.format(new Date(`${x.date}T00:00:00Z`)) : ''}: ${x.total}`}
                      className={cn('min-h-0.5 flex-1 rounded-sm', i >= daily.length - 7 ? 'bg-accent' : 'bg-sky')}
                      style={{ height: `${Math.max(4, (x.total / peak) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex gap-1 text-[10px] text-subtle" aria-hidden>
                  {daily.map((x, i) => <span key={x.date || i} className="flex-1 text-center">{x.date ? dayLetter.format(new Date(`${x.date}T00:00:00Z`)) : ''}</span>)}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

const dueFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export function FollowUpsCard(p: CardProps & { upcoming: readonly Task[] | undefined; showOwner?: boolean }) {
  return (
    <Section title="Follow-ups" description="Open follow-ups by due date" className={p.className} accent="roof" action={<MoreLink to="/tasks">Open list</MoreLink>}>
      {body(p, (d) => {
        const f = d.followUps;
        const href = (followUp: 'overdue' | 'today' | 'week') => salesLeadsHref(p.scope, { followUp, sort: { by: 'next_follow_up', dir: 'asc' } });
        const next = (p.upcoming ?? []).slice(0, 3);
        return (
          <div className="flex h-full flex-col">
            <div className="grid grid-cols-3 gap-2.5">
              <CountLink to={href('overdue')} value={f.overdue} label="Overdue" tone="danger" />
              <CountLink to={href('today')} value={f.today} label="Today" tone="warning" />
              <CountLink to={href('week')} value={f.week} label="This week" tone="accent" />
            </div>
            <p className="mt-4 text-sm text-muted">
              {f.overdue > 0
                ? `Clear the ${plural(f.overdue, 'overdue one')} first: those contractors are expecting to hear back.`
                : f.today > 0 ? 'Nothing overdue. Work through today’s list before lunch.'
                : f.week > 0 ? 'Nothing due today. Get ahead on this week’s follow-ups.'
                : 'No follow-ups scheduled. Book the next step whenever you log a call.'}
            </p>
            {next.length > 0 && (
              <div className="mt-auto pt-5">
                <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Coming up</h3>
                <ul className="space-y-2">
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
      })}
    </Section>
  );
}

export function PipelineCard(p: CardProps) {
  return (
    <Section
      title="Pipeline"
      description="Leads by sales stage"
      className={p.className}
      accent="violet"
      action={<MoreLink to={salesLeadsHref(p.scope, { stages: ['interested', 'quoting'] })}>Warm deals</MoreLink>}
    >
      {body(p, (d) => {
        const max = Math.max(1, ...FUNNEL.map((st) => d.pipeline[st]));
        const decided = d.pipeline.won + d.pipeline.lost;
        const warm = d.pipeline.interested + d.pipeline.quoting;
        return (
          <div>
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
                {warm > 0 ? `${plural(warm, 'warm deal')} in play` : 'No warm deals yet'}
                {decided > 0 && ` · ${pct(d.pipeline.won, decided)}% won of decided`}
              </span>
              <Link to={salesLeadsHref(p.scope, { stages: ['lost'] })} data-stage="lost" className="lm-stage inline-flex items-center gap-1.5 text-muted hover:text-accent hover:underline">
                <span className="lm-stage-dot size-2 rounded-full" aria-hidden />
                {STAGE_LABELS.lost} <span className="font-semibold text-fg tabular-nums">{formatNumber(d.pipeline.lost)}</span>
              </Link>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

export function AccountsCard(p: CardProps) {
  return (
    <Section title="Accounts" description="Prospects and customers in the book" className={p.className} accent="green">
      {body(p, (d) => {
        const a = d.accounts;
        const rows = [
          { key: 'prospect', label: 'Prospects', value: a.prospect, hint: 'Not buying from us yet' },
          { key: 'existing_customer', label: 'Customers', value: a.existing_customer, hint: 'Buying today: grow the share of wallet' },
          { key: 'lapsed_customer', label: 'Lapsed', value: a.lapsed_customer, hint: 'Used to buy: win them back' },
        ] as const;
        return (
          <div className="flex h-full flex-col">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.key}>
                  <Link to={salesLeadsHref(p.scope, { accountStatus: [r.key] })} className="group flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg group-hover:text-accent">{r.label}</span>
                      <span className="block truncate text-xs text-muted">{r.hint}</span>
                    </span>
                    <span className="text-lg font-semibold text-fg tabular-nums">{formatNumber(r.value)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-sm">
              {a.lapsed_customer > 0
                ? <MoreLink to={salesLeadsHref(p.scope, { accountStatus: ['lapsed_customer'], sort: { by: 'priority_score', dir: 'desc' } })}>Win back {plural(a.lapsed_customer, 'lapsed account')}</MoreLink>
                : <span className="text-muted">No lapsed accounts</span>}
              {a.do_not_contact > 0 && <span className="text-xs text-muted">{formatNumber(a.do_not_contact)} do not contact</span>}
            </div>
          </div>
        );
      })}
    </Section>
  );
}
