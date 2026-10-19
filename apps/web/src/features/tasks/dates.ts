// Follow-up days. Like the server (SALES_TIME_ZONE), "today" and "this week" are reps' calendar days in New York,
// whatever the browser's zone; due dates go to the API as YYYY-MM-DD ("due all of that day").
export const SALES_TIME_ZONE = 'America/New_York';

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: SALES_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_MS = 86_400_000;

/** The calendar day (YYYY-MM-DD) an instant falls on in the reps' time zone. */
export function salesDay(at: Date | string | number): string {
  return ymd.format(new Date(at));
}

export const today = (now: Date = new Date()) => salesDay(now);

const utcOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
};

export function addDays(day: string, n: number): string {
  return new Date(utcOf(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(utcOf(v));

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';

export const BUCKETS: readonly Bucket[] = ['overdue', 'today', 'tomorrow', 'week', 'later'];

export const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
};

/** Where an open task's due date falls: "this week" is the rest of the next 7 days, as on the server. */
export function bucketOf(dueAt: string, now: Date = new Date()): Bucket {
  const d = daysBetween(today(now), salesDay(dueAt));
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 7) return 'week';
  return 'later';
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const weekdayMonthDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Mon, Oct 20". */
export const formatDay = (day: string) => weekdayMonthDay.format(utcOf(day));

/** A due date as a rep says it: "Today", "Tomorrow", "Thu", "Oct 30", "3 days overdue". */
export function dueText(dueAt: string, now: Date = new Date()): string {
  const day = salesDay(dueAt);
  const d = daysBetween(today(now), day);
  if (d < -1) return `${-d} days overdue`;
  if (d === -1) return 'Yesterday';
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d < 7) return weekday.format(utcOf(day));
  return (day.slice(0, 4) === today(now).slice(0, 4) ? monthDay : monthDayYear).format(utcOf(day));
}

/** "Done today", "Done yesterday", "Done Oct 12". */
export function doneText(doneAt: string, now: Date = new Date()): string {
  const day = salesDay(doneAt);
  const d = daysBetween(day, today(now));
  if (d <= 0) return 'Done today';
  if (d === 1) return 'Done yesterday';
  if (d < 7) return `Done ${weekday.format(utcOf(day))}`;
  return `Done ${(day.slice(0, 4) === today(now).slice(0, 4) ? monthDay : monthDayYear).format(utcOf(day))}`;
}

export type DuePreset = 'today' | 'tomorrow' | 'in3' | 'nextWeek';

export const PRESET_LABELS: Record<DuePreset, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  in3: 'In 3 days',
  nextWeek: 'Next week',
};

const PRESET_DAYS: Record<DuePreset, number> = { today: 0, tomorrow: 1, in3: 3, nextWeek: 7 };

export function presetDay(preset: DuePreset, now: Date = new Date()): string {
  return addDays(today(now), PRESET_DAYS[preset]);
}

/** A follow-up date choice: a preset, or a day picked on the calendar ('' until one is). */
export type DueChoice = { preset: DuePreset } | { preset: 'date'; day: string };

export function dayOfChoice(choice: DueChoice, now: Date = new Date()): string | null {
  if (choice.preset !== 'date') return presetDay(choice.preset, now);
  return isDay(choice.day) ? choice.day : null;
}

/** Why a chosen day can't be used, or null. */
export function dueError(choice: DueChoice, now: Date = new Date()): string | null {
  const day = dayOfChoice(choice, now);
  if (!day) return 'Pick a date.';
  if (daysBetween(today(now), day) < 0) return 'Pick today or a later date.';
  return null;
}
