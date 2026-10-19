// Manager view of the team: each rep's book, pipeline, activity against the goal, overdue follow-ups and wins.
import { ChevronRight, Users } from 'lucide-react';
import { Link } from 'react-router';
import { Avatar, EmptyState, Skeleton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { SALES_STAGES } from '@/lib/labels';
import type { TeamRepRow } from './api';
import { CardError, Meter, MoreLink, Section } from './parts';
import { FUNNEL, STAGE_LABELS, salesLeadsHref, weekPace } from './sales';

export interface TeamTableProps {
  reps: readonly TeamRepRow[] | undefined;
  goalPerWeek: number;
  poolSize: number | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onSelectRep: (repId: string) => void;
  now: number;
  className?: string;
}

function MiniFunnel({ row }: { row: TeamRepRow }) {
  const total = SALES_STAGES.reduce((s, st) => s + row.pipeline[st], 0);
  const label = FUNNEL.map((st) => `${STAGE_LABELS[st]} ${row.pipeline[st]}`).join(' · ');
  return (
    <Tooltip content={`${label} · ${STAGE_LABELS.lost} ${row.pipeline.lost}`}>
      <span className="flex h-2.5 w-full min-w-24 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={label}>
        {total > 0 && SALES_STAGES.map((st) => (row.pipeline[st] ? (
          <span key={st} data-stage={st} className="lm-stage lm-stage-bar h-full" style={{ width: `${(row.pipeline[st] / total) * 100}%` }} />
        ) : null))}
      </span>
    </Tooltip>
  );
}

function ActivityVsGoal({ done, goal, pace }: { done: number; goal: number; pace: number }) {
  return (
    <div className="min-w-28">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-fg tabular-nums">{formatNumber(done)}<span className="font-normal text-muted"> / {formatNumber(goal)}</span></span>
        <span className={cn(done >= pace ? 'text-success' : 'text-warning')}>{done >= goal ? 'Goal met' : done >= pace ? 'On pace' : 'Behind'}</span>
      </div>
      <Meter value={done} max={goal} marker={pace} tone={done >= goal ? 'success' : 'accent'} label={`${done} of ${goal} activities`} />
    </div>
  );
}

export function TeamTable({ reps, goalPerWeek, poolSize, isLoading, error, onRetry, onSelectRep, now, className }: TeamTableProps) {
  const pace = weekPace(goalPerWeek, now);
  const rows = [...(reps ?? [])].sort((a, b) => a.rep.name.localeCompare(b.rep.name));
  return (
    <Section
      id="team"
      title="Reps"
      description={`Weekly goal: ${formatNumber(goalPerWeek)} calls, emails and visits per rep`}
      level={3}
      className={className}
      accent="blue"
      bodyClassName="px-0 pb-3"
      action={poolSize !== undefined && (
        <span className="text-muted">
          <span className="font-semibold text-fg tabular-nums">{formatNumber(poolSize)}</span> unassigned leads ·{' '}
          <MoreLink to="/allocation">Assign leads</MoreLink>
        </span>
      )}
    >
      {isLoading && !reps ? (
        <div className="space-y-3 px-4 sm:px-6" aria-hidden>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : error && !reps ? (
        <CardError error={error} onRetry={onRetry} />
      ) : !rows.length ? (
        <EmptyState compact icon={<Users />} title="No reps yet" description="Reps appear here once they have leads allocated." />
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium tracking-wide text-muted uppercase">
                  <th className="py-2.5 pr-3.5 pl-6 font-medium">Rep</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Leads</th>
                  <th className="w-[26%] px-3.5 py-2.5 font-medium">Sales stages</th>
                  <th className="w-[20%] px-3.5 py-2.5 font-medium">This week vs goal</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Overdue</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Won this month</th>
                  <th className="py-2.5 pr-6 pl-3.5"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.rep.id} className="hover:bg-surface-2/60">
                    <td className="py-3 pr-3.5 pl-6">
                      <button type="button" onClick={() => onSelectRep(r.rep.id)} className="flex items-center gap-2.5 text-left font-medium text-fg hover:text-accent">
                        <Avatar name={r.rep.name} size={26} />
                        {r.rep.name}
                      </button>
                    </td>
                    <td className="px-3.5 py-3 text-right tabular-nums">
                      <Link to={salesLeadsHref(`rep:${r.rep.id}`)} className="text-fg hover:text-accent hover:underline">{formatNumber(r.assigned)}</Link>
                    </td>
                    <td className="px-3.5 py-3">
                      <div className="flex items-center gap-2">
                        <MiniFunnel row={r} />
                        <span className="shrink-0 text-xs text-muted tabular-nums">{formatNumber(r.pipeline.interested + r.pipeline.quoting)} warm</span>
                      </div>
                    </td>
                    <td className="px-3.5 py-3"><ActivityVsGoal done={r.activityThisWeek} goal={goalPerWeek} pace={pace} /></td>
                    <td className="px-3.5 py-3 text-right tabular-nums">
                      <Link
                        to={salesLeadsHref(`rep:${r.rep.id}`, { followUp: 'overdue', sort: { by: 'next_follow_up', dir: 'asc' } })}
                        className={cn('hover:underline', r.overdue > 0 ? 'font-semibold text-roof' : 'text-muted')}
                      >
                        {formatNumber(r.overdue)}
                      </Link>
                    </td>
                    <td className="px-3.5 py-3 text-right tabular-nums">
                      <Link to={salesLeadsHref(`rep:${r.rep.id}`, { stages: ['won'] })} className="text-fg hover:text-accent hover:underline">{formatNumber(r.wonThisMonth)}</Link>
                    </td>
                    <td className="py-3 pr-6 pl-3.5 text-right">
                      <button type="button" onClick={() => onSelectRep(r.rep.id)} className="inline-flex items-center gap-0.5 text-sm font-medium text-accent hover:underline">
                        View<ChevronRight className="size-3.5" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border md:hidden">
            {rows.map((r) => (
              <li key={r.rep.id} className="space-y-3 px-4 py-3.5 sm:px-6">
                <div className="flex items-center justify-between gap-2">
                  <button type="button" onClick={() => onSelectRep(r.rep.id)} className="flex items-center gap-2.5 font-medium text-fg">
                    <Avatar name={r.rep.name} size={26} />{r.rep.name}
                  </button>
                  <span className="text-sm text-muted tabular-nums">{formatNumber(r.assigned)} leads</span>
                </div>
                <MiniFunnel row={r} />
                <ActivityVsGoal done={r.activityThisWeek} goal={goalPerWeek} pace={pace} />
                <p className="flex gap-4 text-sm">
                  <span className={r.overdue > 0 ? 'font-semibold text-roof' : 'text-muted'}>{formatNumber(r.overdue)} overdue</span>
                  <span className="text-muted">{formatNumber(r.wonThisMonth)} won this month</span>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
