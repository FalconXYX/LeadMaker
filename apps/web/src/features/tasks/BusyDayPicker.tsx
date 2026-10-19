// The busy-aware follow-up picker: a small month calendar where each day shows how many follow-ups are already on it
// (bold roof-tile from HEAVY_DAY up), and a line saying what is already on the chosen day, so a rep spreads the week
// out instead of stacking six calls on Thursday. Arrow keys move a day or a week, Home / End jump to the week's ends,
// Page Up / Page Down change month, Enter or Space picks. The native date input beside it stays as the fallback.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { Task, TaskScope } from './api';
import { HEAVY_DAY, addMonths, groupByDay, longDay, monthLabel, monthStart, monthWeeks, sameMonth, weekStart } from './calendar';
import { addDays, daysBetween, formatDay, isDay, today } from './dates';
import { TASK_TYPE_META } from './model';
import { useCalendarTasks } from './queries';

/** Open follow-ups by day for `scope` (the caller's by default): the load the picker shows. */
export function useBusyDays(scope: TaskScope = 'mine', enabled = true) {
  const cal = useCalendarTasks(scope, { done: false, enabled });
  const byDay = useMemo(() => groupByDay(cal.tasks.filter((t) => !t.doneAt)), [cal.tasks]);
  return { byDay, isLoading: cal.isLoading };
}

const loadWord = (n: number) => `${n} ${n === 1 ? 'follow-up' : 'follow-ups'}`;
const WEEKDAY_HEADS = [['Mo', 'Monday'], ['Tu', 'Tuesday'], ['We', 'Wednesday'], ['Th', 'Thursday'], ['Fr', 'Friday'], ['Sa', 'Saturday'], ['Su', 'Sunday']] as const;

export function BusyMonth({
  value, onSelect, byDay, min, label = 'Pick a day', className,
}: {
  /** The chosen day (YYYY-MM-DD), or '' for none. */
  value: string;
  onSelect: (day: string) => void;
  byDay: ReadonlyMap<string, readonly Task[]>;
  /** The earliest day that can be picked. */
  min?: string;
  label?: string;
  className?: string;
}) {
  const start = isDay(value) ? value : min ?? today();
  const [month, setMonth] = useState(() => monthStart(start));
  const [focusDay, setFocusDay] = useState(start);
  const grid = useRef<HTMLTableElement>(null);
  const wantFocus = useRef(false);

  // A day typed into the date input (or chosen as a preset) brings its month into view.
  useEffect(() => {
    if (!isDay(value)) return;
    setFocusDay(value);
    setMonth((m) => (sameMonth(m, value) ? m : monthStart(value)));
  }, [value]);

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, month]);

  const tooEarly = (day: string) => !!min && daysBetween(min, day) < 0;
  const moveFocus = (day: string) => {
    wantFocus.current = true;
    setFocusDay(day);
    if (!sameMonth(day, month)) setMonth(monthStart(day));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => weekStart(focusDay),
      End: () => addDays(weekStart(focusDay), 6),
      PageUp: () => clampToMonth(focusDay, addMonths(focusDay, -1)),
      PageDown: () => clampToMonth(focusDay, addMonths(focusDay, 1)),
    };
    const next = step[e.key];
    if (!next) return;
    e.preventDefault();
    moveFocus(next());
  };
  const showMonth = (n: number) => {
    const m = addMonths(month, n);
    setMonth(m);
    setFocusDay(clampToMonth(focusDay, m));
  };
  // Keep a tabbable day in the shown month.
  const tabDay = sameMonth(focusDay, month) ? focusDay : month;
  const weeks = monthWeeks(month);

  return (
    <div className={cn('w-full max-w-[19rem] rounded-xl border border-border bg-surface p-2.5 shadow-xs', className)} role="group" aria-label={label}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <IconButton size="sm" label="Previous month" icon={<ChevronLeft />} onClick={() => showMonth(-1)} disabled={!!min && daysBetween(min, addDays(month, -1)) < 0} />
        <p className="text-sm font-semibold text-fg" aria-live="polite">{monthLabel(month)}</p>
        <IconButton size="sm" label="Next month" icon={<ChevronRight />} onClick={() => showMonth(1)} />
      </div>
      <table ref={grid} role="grid" aria-label={monthLabel(month)} className="w-full table-fixed border-collapse" onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {WEEKDAY_HEADS.map(([short, long]) => (
              <th key={short} scope="col" abbr={long} className="pb-1 text-center text-[11px] font-medium text-muted">{short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const n = byDay.get(day)?.length ?? 0;
                const heavy = n >= HEAVY_DAY;
                const selected = day === value;
                const disabled = tooEarly(day);
                const outside = !sameMonth(day, month);
                const isToday = day === today();
                return (
                  <td key={day} role="gridcell" aria-selected={selected} className="p-0.5">
                    <button
                      type="button"
                      data-day={day}
                      data-load={n}
                      tabIndex={day === tabDay ? 0 : -1}
                      aria-disabled={disabled || undefined}
                      aria-label={`${longDay(day)}${isToday ? ' (today)' : ''}, ${n ? `${loadWord(n)} already${heavy ? ', a busy day' : ''}` : 'nothing planned'}`}
                      onClick={() => {
                        setFocusDay(day);
                        if (!disabled) onSelect(day);
                      }}
                      className={cn(
                        'flex h-10 w-full flex-col items-center justify-center rounded-lg text-sm tabular transition-colors focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:outline-none',
                        selected ? 'bg-accent font-semibold text-accent-fg' : 'hover:bg-hover',
                        !selected && isToday && 'font-semibold text-accent',
                        !selected && !isToday && (outside ? 'text-subtle' : 'text-fg'),
                        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                      )}
                    >
                      <span className="leading-none">{Number(day.slice(8))}</span>
                      <span
                        aria-hidden
                        data-testid={n ? 'day-load' : undefined}
                        className={cn(
                          'mt-0.5 h-3.5 min-w-3.5 rounded-full px-1 text-[10px] leading-[14px]',
                          !n && 'invisible',
                          selected ? 'bg-accent-fg/20 text-accent-fg' : heavy ? 'bg-roof-soft font-bold text-roof' : 'text-muted',
                        )}
                      >
                        {n || ''}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The same day of the month in `target`'s month (the 31st becomes the month's last day). */
function clampToMonth(day: string, target: string): string {
  const first = monthStart(target);
  const last = addDays(addMonths(first, 1), -1);
  const wanted = `${first.slice(0, 8)}${day.slice(8)}`;
  return isDay(wanted) && sameMonth(wanted, first) ? wanted : last;
}

/** "Already on Thu, Oct 23: Call · Bergen Roofing, Visit · Garden State Roofing", or that the day is free. */
export function BusyLine({
  day, byDay, who, loading, max = 4,
}: { day: string; byDay: ReadonlyMap<string, readonly Task[]>; who?: string; loading?: boolean; max?: number }) {
  if (loading) return null;
  const items = byDay.get(day) ?? [];
  const when = formatDay(day);
  if (!items.length) {
    return <p className="text-xs text-muted" aria-live="polite">{who ? `${who} has nothing else on ${when} yet.` : `Nothing else on ${when} yet.`}</p>;
  }
  const heavy = items.length >= HEAVY_DAY;
  return (
    <p className="text-xs text-muted" aria-live="polite" data-testid="busy-line">
      {heavy && <span className="font-semibold text-roof">Busy day. </span>}
      <span className="font-medium text-fg">{who ? `${who} already has on ${when}` : `Already on ${when}`}:</span>{' '}
      {items.slice(0, max).map((t, i) => (
        <span key={t.id}>
          {i > 0 && ', '}
          {(TASK_TYPE_META[t.type] ?? TASK_TYPE_META.todo).label} · {t.companyName}
        </span>
      ))}
      {items.length > max && ` +${items.length - max} more`}
    </p>
  );
}
