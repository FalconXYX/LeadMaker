// Follow-ups on a calendar: a Monday-to-Sunday week (the default) or a month, with prev / next / today. Each day lists
// its follow-ups as compact chips (type, company, time when one was set); overdue ones are roof-tile, done ones are
// struck through, and a chip opens its lead. In team scope each rep has a colour, a legend and a filter, and the week's
// day headers say who has how many ("Jordan 3 · Sam 1").
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '@/api/errors';
import { Button, Card, ErrorState, IconButton, Segmented, Select, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { Task, TaskScope } from './api';
import {
  addMonths, firstNameOf, groupByDay, longDay, monthLabel, monthWeeks, repLoad, repsOf, sameMonth, stateOf, timeOf,
  weekDays, weekLabel, weekdayShort, type CalendarRep,
} from './calendar';
import { addDays, salesDay, today } from './dates';
import { TASK_TYPE_META } from './model';
import { TaskTypeIcon } from './parts';
import { useCalendarTasks } from './queries';

export type CalendarView = 'week' | 'month';

export interface TaskCalendarProps {
  scope: TaskScope;
  /** Reps to colour-code and filter by in team scope (anyone else with a task is added). */
  reps?: ReadonlyArray<{ id: string; name: string }>;
  /** The clock (tests; the dashboard passes its ticking `now`). */
  now?: number;
  className?: string;
}

/** Chips a day shows before "+N more". */
export const WEEK_DAY_LIMIT = 6;
export const MONTH_DAY_LIMIT = 3;

const VIEWS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
] as const;

const NO_REPS: ReadonlyArray<{ id: string; name: string }> = [];

export function TaskCalendar({ scope, reps: knownReps = NO_REPS, now: nowProp, className }: TaskCalendarProps) {
  const now = useMemo(() => new Date(nowProp ?? Date.now()), [nowProp]);
  const todayDay = today(now);
  const [view, setView] = useState<CalendarView>('week');
  const [anchor, setAnchor] = useState(todayDay);
  const [repFilter, setRepFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const cal = useCalendarTasks(scope);

  const team = scope === 'team';
  const reps = useMemo(() => (team ? repsOf(knownReps, cal.tasks) : []), [team, knownReps, cal.tasks]);
  const repById = useMemo(() => new Map(reps.map((r) => [r.id, r])), [reps]);
  const visible = useMemo(
    () => (team && repFilter !== 'all' ? cal.tasks.filter((t) => t.assignee.id === repFilter) : cal.tasks),
    [cal.tasks, team, repFilter],
  );
  const byDay = useMemo(() => groupByDay(visible), [visible]);

  const days = view === 'week' ? weekDays(anchor) : monthWeeks(anchor).flat();
  const first = days[0]!;
  const overdueBefore = visible.filter((t) => stateOf(t, now) === 'overdue' && salesDay(t.dueAt) < first).length;

  const move = (n: number) => {
    setExpanded(new Set());
    setAnchor((a) => (view === 'week' ? addDays(a, 7 * n) : addMonths(a, n)));
  };
  const openWeek = (day: string) => {
    setView('week');
    setAnchor(day);
    setExpanded(new Set([day]));
  };
  const label = view === 'week' ? weekLabel(anchor) : monthLabel(anchor);
  const showsToday = view === 'week' ? days.includes(todayDay) : sameMonth(anchor, todayDay);

  return (
    <Card className={cn('flex min-w-0 flex-col', className)} role="region" aria-label="Follow-up calendar">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconButton size="sm" variant="secondary" label={view === 'week' ? 'Previous week' : 'Previous month'} icon={<ChevronLeft />} onClick={() => move(-1)} />
          <IconButton size="sm" variant="secondary" label={view === 'week' ? 'Next week' : 'Next month'} icon={<ChevronRight />} onClick={() => move(1)} />
          <Button size="sm" disabled={showsToday && anchor === todayDay} onClick={() => { setAnchor(todayDay); setExpanded(new Set()); }}>Today</Button>
          <h3 className="ml-1.5 truncate text-[15px] font-semibold text-fg" aria-live="polite">{label}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {team && reps.length > 0 && (
            <Select
              aria-label="Show follow-ups for"
              selectSize="sm"
              className="min-w-36"
              value={repFilter}
              onValueChange={setRepFilter}
              options={[{ value: 'all', label: 'All reps' }, ...reps.map((r) => ({ value: r.id, label: r.name }))]}
            />
          )}
          <Segmented label="Calendar view" size="sm" value={view} onChange={(v) => { setView(v); setExpanded(new Set()); }} options={VIEWS} />
        </div>
      </div>

      {(team && reps.length > 0) || overdueBefore > 0 || cal.capped ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pt-3 text-xs text-muted sm:px-6">
          {team && reps.length > 0 && (
            <ul aria-label="Rep colours" className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
              {reps.map((r) => (
                <li key={r.id} className={cn('inline-flex items-center gap-1.5', repFilter !== 'all' && repFilter !== r.id && 'opacity-50')}>
                  <span className={cn('size-2.5 rounded-full', r.color.dot)} aria-hidden />
                  {r.name}
                </li>
              ))}
            </ul>
          )}
          {overdueBefore > 0 && (
            <p className="font-medium text-roof">
              {overdueBefore} overdue {overdueBefore === 1 ? 'follow-up' : 'follow-ups'} from before {view === 'week' ? 'this week' : 'this month'}
            </p>
          )}
          {cal.capped && <p>Showing the first follow-ups only: the busiest far-off days may have more.</p>}
        </div>
      ) : null}

      <div className="px-4 pt-3.5 pb-5 sm:px-6 sm:pt-4 sm:pb-6">
        {cal.error && !cal.tasks.length ? (
          <ErrorState message={errorMessage(cal.error)} onRetry={cal.refetch} className="py-8" />
        ) : view === 'week' ? (
          <WeekGrid
            days={days}
            todayDay={todayDay}
            byDay={byDay}
            now={now}
            loading={cal.isLoading}
            repById={team ? repById : null}
            showLoad={team && repFilter === 'all'}
            reps={reps}
            expanded={expanded}
            onToggle={(day) => setExpanded((s) => {
              const next = new Set(s);
              if (next.has(day)) next.delete(day);
              else next.add(day);
              return next;
            })}
          />
        ) : (
          <MonthGrid
            days={days}
            anchor={anchor}
            todayDay={todayDay}
            byDay={byDay}
            now={now}
            loading={cal.isLoading}
            repById={team ? repById : null}
            onOpenWeek={openWeek}
          />
        )}
      </div>
    </Card>
  );
}

const countWord = (n: number) => `${n} ${n === 1 ? 'follow-up' : 'follow-ups'}`;

function WeekGrid({
  days, todayDay, byDay, now, loading, repById, showLoad, reps, expanded, onToggle,
}: {
  days: string[];
  todayDay: string;
  byDay: Map<string, Task[]>;
  now: Date;
  loading: boolean;
  repById: Map<string, CalendarRep> | null;
  showLoad: boolean;
  reps: readonly CalendarRep[];
  expanded: ReadonlySet<string>;
  onToggle: (day: string) => void;
}) {
  return (
    <ol className="grid grid-cols-1 overflow-hidden rounded-xl border border-border md:grid-cols-7">
      {days.map((day, i) => {
        const items = byDay.get(day) ?? [];
        const isToday = day === todayDay;
        const open = expanded.has(day);
        const shown = open ? items : items.slice(0, WEEK_DAY_LIMIT);
        const load = showLoad ? repLoad(items, reps) : [];
        return (
          <li
            key={day}
            data-day={day}
            aria-label={`${longDay(day)}${isToday ? ' (today)' : ''}, ${countWord(items.length)}`}
            className={cn(
              'flex min-w-0 flex-col gap-2 p-2.5 md:min-h-44',
              i > 0 && 'border-t border-divider md:border-t-0 md:border-l',
              isToday && 'bg-accent-soft/40',
            )}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('text-xs font-medium', isToday ? 'text-accent' : 'text-muted')}>{weekdayShort(day)}</span>
                <span
                  className={cn(
                    'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm font-semibold tabular',
                    isToday ? 'bg-accent text-accent-fg' : 'text-fg',
                  )}
                >
                  {Number(day.slice(8))}
                </span>
                {isToday && <span className="text-xs font-medium text-accent">Today</span>}
              </div>
              {load.length > 0 && (
                <p className="truncate text-[11px] text-muted" data-testid="rep-load" title={load.map((l) => `${l.rep.name} ${l.count}`).join(' · ')}>
                  {load.map((l, j) => (
                    <span key={l.rep.id}>
                      {j > 0 && ' · '}
                      <span className={cn('font-medium', l.rep.color.text)}>{firstNameOf(l.rep.name)}</span> {l.count}
                    </span>
                  ))}
                </p>
              )}
            </div>
            {loading ? (
              <Skeleton className="h-6 w-full" />
            ) : (
              <ul className="flex min-w-0 flex-col gap-1">
                {shown.map((t) => <li key={t.id} className="min-w-0"><TaskChip task={t} now={now} rep={repById?.get(t.assignee.id)} /></li>)}
              </ul>
            )}
            {!loading && items.length > WEEK_DAY_LIMIT && (
              <button type="button" onClick={() => onToggle(day)} className="self-start text-xs font-medium text-accent hover:underline">
                {open ? 'Show fewer' : `+${items.length - WEEK_DAY_LIMIT} more`}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MonthGrid({
  days, anchor, todayDay, byDay, now, loading, repById, onOpenWeek,
}: {
  days: string[];
  anchor: string;
  todayDay: string;
  byDay: Map<string, Task[]>;
  now: Date;
  loading: boolean;
  repById: Map<string, CalendarRep> | null;
  onOpenWeek: (day: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid grid-cols-7 border-b border-divider bg-surface-2 text-center text-[11px] font-medium text-muted" aria-hidden>
        {WEEKDAY_HEADS.map((d) => <span key={d} className="py-1.5">{d}</span>)}
      </div>
      <ol className="grid grid-cols-7">
        {days.map((day, i) => {
          const items = byDay.get(day) ?? [];
          const isToday = day === todayDay;
          const outside = !sameMonth(day, anchor);
          const overdue = items.some((t) => stateOf(t, now) === 'overdue');
          return (
            <li
              key={day}
              data-day={day}
              aria-label={`${longDay(day)}${isToday ? ' (today)' : ''}, ${countWord(items.length)}`}
              className={cn(
                'flex min-h-16 min-w-0 flex-col gap-1 p-1 sm:min-h-24 sm:p-1.5',
                i % 7 > 0 && 'border-l border-divider',
                i >= 7 && 'border-t border-divider',
                outside && 'bg-surface-2/60',
                isToday && 'bg-accent-soft/40',
              )}
            >
              <span
                className={cn(
                  'inline-flex size-6 items-center justify-center self-start rounded-full text-xs font-semibold tabular',
                  isToday ? 'bg-accent text-accent-fg' : outside ? 'text-subtle' : 'text-fg',
                )}
              >
                {Number(day.slice(8))}
              </span>
              {!loading && items.length > 0 && (
                <>
                  {/* Phones: the day's count; wider screens: the first chips, then "+N more". */}
                  <button
                    type="button"
                    onClick={() => onOpenWeek(day)}
                    aria-label={`Open the week of ${longDay(day)}`}
                    className={cn('self-start rounded-full px-1.5 text-[11px] font-semibold tabular sm:hidden', overdue ? 'bg-roof-soft text-roof' : 'bg-surface-3 text-muted')}
                  >
                    {items.length}
                  </button>
                  <ul className="hidden min-w-0 flex-col gap-1 sm:flex">
                    {items.slice(0, MONTH_DAY_LIMIT).map((t) => (
                      <li key={t.id} className="min-w-0"><TaskChip task={t} now={now} rep={repById?.get(t.assignee.id)} dense /></li>
                    ))}
                  </ul>
                  {items.length > MONTH_DAY_LIMIT && (
                    <button type="button" onClick={() => onOpenWeek(day)} className="hidden self-start text-[11px] font-medium text-accent hover:underline sm:inline">
                      +{items.length - MONTH_DAY_LIMIT} more
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One follow-up on the calendar: type, company and time; opens the lead. */
export function TaskChip({ task, now, rep, dense }: { task: Task; now: Date; rep?: CalendarRep; dense?: boolean }) {
  const state = stateOf(task, now);
  const time = timeOf(task.dueAt);
  const meta = TASK_TYPE_META[task.type] ?? TASK_TYPE_META.todo;
  const type = meta.label;
  const Icon = meta.icon;
  const label = [
    `${type}: ${task.companyName}`,
    time && `at ${time}`,
    task.title,
    rep && `for ${rep.name}`,
    state === 'overdue' ? 'overdue' : state === 'done' ? 'done' : null,
  ].filter(Boolean).join(', ');
  return (
    <Link
      to={`/leads/${task.companyId}`}
      aria-label={label}
      title={`${task.title}${rep ? ` · ${rep.name}` : ''}`}
      data-state={state}
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-surface text-xs text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-hover',
        dense ? 'px-1 py-0.5' : 'px-1.5 py-1',
        rep && 'border-l-[3px]',
        rep?.color.chip,
        state === 'overdue' && 'bg-roof-soft text-roof hover:bg-roof-soft',
        state === 'done' && 'bg-surface-2 text-muted line-through opacity-75',
      )}
    >
      {dense
        ? <Icon className={cn('size-3 shrink-0', state === 'overdue' ? 'text-roof' : 'text-muted')} aria-hidden />
        : <TaskTypeIcon type={task.type} size="xs" className={cn(state === 'overdue' && 'bg-surface text-roof', state === 'done' && 'opacity-70')} />}
      <span className="min-w-0 flex-1 truncate font-medium">{task.companyName}</span>
      {time && <span className={cn('shrink-0 tabular', state === 'overdue' ? 'text-roof' : 'text-muted')}>{time}</span>}
    </Link>
  );
}
