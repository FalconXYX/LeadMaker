// Sales pipeline on one lead: stages, follow-up tasks and the "last contacted · next follow-up" line.
// Pure (no React), so it is unit-tested.
import type { LeadProfile, SalesStage, Task, TaskType } from '@/api/types';
import { STAGE_LABELS, isSalesStage } from '@/lib/labels';

export { STAGE_HINTS, TASK_TYPE_LABELS } from '@/lib/labels';

export type { SalesStage, Task, TaskType };

/** The funnel, in order; 'lost' (Not a fit) sits outside it. */
export const FUNNEL = ['new', 'contacted', 'interested', 'quoting', 'won'] as const satisfies readonly SalesStage[];

export function stageLabel(v: unknown): string {
  return isSalesStage(v) ? STAGE_LABELS[v] : typeof v === 'string' && v ? v : 'Unknown';
}

export type SalesFields = Pick<LeadProfile, 'salesStage' | 'stageChangedAt' | 'lastContactedAt' | 'tasks'>;

/** The profile's sales fields, defaulted for a service that does not send them yet. */
export function salesOf(profile: LeadProfile): SalesFields {
  const p = profile as Partial<SalesFields>;
  return {
    salesStage: isSalesStage(p.salesStage) ? p.salesStage : 'new',
    stageChangedAt: p.stageChangedAt ?? null,
    lastContactedAt: p.lastContactedAt ?? null,
    tasks: Array.isArray(p.tasks) ? p.tasks : [],
  };
}

export function withSales(profile: LeadProfile, patch: Partial<SalesFields>): LeadProfile {
  return { ...profile, ...patch };
}

// ---- dates ------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from today to the date (negative: in the past). */
export function daysFromToday(iso: string, now = Date.now()): number {
  return Math.round((startOfDay(Date.parse(iso)) - startOfDay(now)) / DAY);
}

/** "Today", "Tomorrow", "Yesterday", "Thu" (within a week), "Oct 30", "Oct 30, 2027". */
export function dayWord(iso: string, now = Date.now()): string {
  const n = daysFromToday(iso, now);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const d = new Date(iso);
  if (Math.abs(n) < 7) return weekday.format(d);
  return d.getFullYear() === new Date(now).getFullYear() ? monthDay.format(d) : monthDayYear.format(d);
}

/** Midnight means "some time that day": no clock time is shown for it. */
function hasClock(iso: string): boolean {
  const d = new Date(iso);
  return d.getHours() !== 0 || d.getMinutes() !== 0;
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'done';

export function dueState(task: Pick<Task, 'dueAt' | 'doneAt'>, now = Date.now()): DueState {
  if (task.doneAt) return 'done';
  const n = daysFromToday(task.dueAt, now);
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return n < 7 ? 'soon' : 'later';
}

/** "Overdue · Tue", "Today 3:00 PM", "Thu", "Oct 30". */
export function dueText(task: Pick<Task, 'dueAt' | 'doneAt'>, now = Date.now()): string {
  const word = dayWord(task.dueAt, now);
  const state = dueState(task, now);
  if (state === 'overdue') return `Overdue · due ${word === 'Yesterday' ? 'yesterday' : word}`;
  const n = daysFromToday(task.dueAt, now);
  return n <= 1 && hasClock(task.dueAt) ? `${word} ${clock.format(new Date(task.dueAt))}` : word;
}

// ---- tasks ------------------------------------------------------------------------------------------------

export function openTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => !t.doneAt).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export function doneTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.doneAt).sort((a, b) => Date.parse(b.doneAt!) - Date.parse(a.doneAt!));
}

export function nextTask(tasks: readonly Task[]): Task | null {
  return openTasks(tasks)[0] ?? null;
}

export type ReschedulePreset = 'tomorrow' | 'in3' | 'nextMonday' | 'in2weeks';

export const RESCHEDULE_PRESETS: { value: ReschedulePreset; label: string }[] = [
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'in3', label: 'In 3 days' },
  { value: 'nextMonday', label: 'Next Monday' },
  { value: 'in2weeks', label: 'In 2 weeks' },
];

/** The new due date, keeping the task's time of day. */
export function rescheduleDate(preset: ReschedulePreset, dueAt: string, now = Date.now()): string {
  const due = new Date(dueAt);
  const d = new Date(startOfDay(now));
  if (preset === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (preset === 'in3') d.setDate(d.getDate() + 3);
  else if (preset === 'in2weeks') d.setDate(d.getDate() + 14);
  else d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  d.setHours(due.getHours(), due.getMinutes(), 0, 0);
  return d.toISOString();
}

/** A yyyy-mm-dd from a date input, at the task's time of day. */
export function onDay(day: string, dueAt: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const due = new Date(dueAt);
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, due.getHours(), due.getMinutes()).toISOString();
}

/** yyyy-mm-dd in local time, for a date input's value. */
export function toDayInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Task rows with a done change applied (optimistic). */
export function markDone(tasks: readonly Task[], id: string, done: boolean, at = new Date().toISOString()): Task[] {
  return tasks.map((t) => (t.id === id ? { ...t, doneAt: done ? at : null } : t));
}
