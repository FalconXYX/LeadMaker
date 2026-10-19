// Calendar maths for follow-ups: weeks run Monday to Sunday, days are the reps' calendar days in New York (see dates.ts),
// and every helper works on YYYY-MM-DD strings so the browser's own zone never shifts a task to the wrong day.
import type { Task } from './api';
import { SALES_TIME_ZONE, addDays, daysBetween, salesDay, today } from './dates';

const utcOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};

/** The Monday on or before `day`. */
export function weekStart(day: string): string {
  const dow = (utcOf(day).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return addDays(day, -dow);
}

/** The seven days (Monday first) of the week holding `day`. */
export function weekDays(day: string): string[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** `day`'s month moved by `n` months (on the 1st). */
export function addMonths(day: string, n: number): string {
  const d = utcOf(monthStart(day));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole weeks (Monday first) covering `day`'s month: 4 to 6 rows of 7 days. */
export function monthWeeks(day: string): string[][] {
  const first = monthStart(day);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let start = weekStart(first); daysBetween(start, last) >= 0; start = addDays(start, 7)) weeks.push(weekDays(start));
  return weeks;
}

export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC' });
const monthYearFmt = fmt({ month: 'long', year: 'numeric' });
const monthDayFmt = fmt({ month: 'short', day: 'numeric' });
const longDayFmt = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
const weekdayFmt = fmt({ weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: SALES_TIME_ZONE, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: SALES_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "October 2026". */
export const monthLabel = (day: string) => monthYearFmt.format(utcOf(day));
/** "Monday, October 20". */
export const longDay = (day: string) => longDayFmt.format(utcOf(day));
/** "Mon". */
export const weekdayShort = (day: string) => weekdayFmt.format(utcOf(day));
/** "Oct 20 – 26, 2026", or "Oct 27 – Nov 2, 2026" across a month. */
export function weekLabel(day: string): string {
  const [first, last] = [weekStart(day), addDays(weekStart(day), 6)];
  const end = sameMonth(first, last) ? String(Number(last.slice(8))) : monthDayFmt.format(utcOf(last));
  return `${monthDayFmt.format(utcOf(first))} – ${end}, ${last.slice(0, 4)}`;
}

/**
 * The time a follow-up is due, when one was set ("2:30 PM"). A follow-up saved as a plain day is stored at midnight in
 * New York, so midnight means "no time".
 */
export function timeOf(dueAt: string): string | null {
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return null;
  const clock = nyClock.format(at);
  return clock === '00:00' || clock === '24:00' ? null : timeFmt.format(at);
}

export type CalendarState = 'open' | 'overdue' | 'done';

export function stateOf(t: Task, now: Date = new Date()): CalendarState {
  if (t.doneAt) return 'done';
  return daysBetween(today(now), salesDay(t.dueAt)) < 0 ? 'overdue' : 'open';
}

/** Tasks by the day they are due, each day earliest first (timed ones by time, then by company). */
export function groupByDay(tasks: readonly Task[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const t of tasks) {
    const day = salesDay(t.dueAt);
    const list = out.get(day);
    if (list) list.push(t);
    else out.set(day, [t]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt)
      || Date.parse(a.dueAt) - Date.parse(b.dueAt)
      || a.companyName.localeCompare(b.companyName));
  }
  return out;
}

/** Two reads (open, then done) merged without duplicates: a task just ticked off can sit in both for a moment. */
export function mergeTasks(open: readonly Task[], done: readonly Task[]): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const t of [...open, ...done]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** How busy a day looks in the picker: 4 or more follow-ups is a heavy day. */
export const HEAVY_DAY = 4;

// ---- reps ---------------------------------------------------------------------------------------------------------

/** Distinct theme colours for reps (stage tokens; roof-tile stays reserved for overdue). Full class names for Tailwind. */
export const REP_COLORS = [
  { dot: 'bg-stage-new-fill', chip: 'border-l-stage-new-fill', text: 'text-stage-new' },
  { dot: 'bg-stage-interested-fill', chip: 'border-l-stage-interested-fill', text: 'text-stage-interested' },
  { dot: 'bg-stage-won-fill', chip: 'border-l-stage-won-fill', text: 'text-stage-won' },
  { dot: 'bg-stage-contacted-fill', chip: 'border-l-stage-contacted-fill', text: 'text-stage-contacted' },
  { dot: 'bg-info', chip: 'border-l-info', text: 'text-info' },
  { dot: 'bg-stage-lost-fill', chip: 'border-l-stage-lost-fill', text: 'text-stage-lost' },
] as const;
export type RepColor = (typeof REP_COLORS)[number];

export interface CalendarRep {
  id: string;
  name: string;
  color: RepColor;
}

/** Every rep named by `known` or assigned a task, sorted by name, each with a stable colour. */
export function repsOf(known: ReadonlyArray<{ id: string; name: string }>, tasks: readonly Task[]): CalendarRep[] {
  const m = new Map<string, string>();
  for (const r of known) m.set(r.id, r.name);
  for (const t of tasks) if (!m.has(t.assignee.id)) m.set(t.assignee.id, t.assignee.name);
  return [...m]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name], i) => ({ id, name, color: REP_COLORS[i % REP_COLORS.length]! }));
}

export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Jordan 3 · Sam 1": each rep's follow-ups on one day, busiest first. */
export function repLoad(tasks: readonly Task[], reps: readonly CalendarRep[]): { rep: CalendarRep; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.assignee.id, (counts.get(t.assignee.id) ?? 0) + 1);
  return reps
    .filter((r) => counts.has(r.id))
    .map((rep) => ({ rep, count: counts.get(rep.id)! }))
    .sort((a, b) => b.count - a.count || a.rep.name.localeCompare(b.rep.name));
}
