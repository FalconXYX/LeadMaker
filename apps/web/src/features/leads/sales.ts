// The sales side of the lead list: stages, follow-ups, last contact. The constants are lib/labels' runtime copies of
// the shared ones; this adds defensive readers for older bodies and the pure date wording the cells use.
import type { FollowUp, LeadSummary, NextTask, SalesStage, TaskType } from '@/api/types';
import { isSalesStage } from '@/lib/labels';

export type { FollowUp, NextTask, SalesStage, TaskType };
export {
  FOLLOW_UPS, FOLLOW_UP_LABELS, SALES_STAGES, STAGE_HINTS, STAGE_LABELS, TASK_TYPES, TASK_TYPE_LABELS,
} from '@/lib/labels';
export const isStage = isSalesStage;

/** Stage colours (theme tokens), so a stage reads the same in the pill, the filter dot and the menu. */
export const STAGE_TONE: Record<SalesStage, { pill: string; dot: string }> = {
  new: { pill: 'bg-stage-new-soft text-stage-new', dot: 'bg-stage-new' },
  contacted: { pill: 'bg-stage-contacted-soft text-stage-contacted', dot: 'bg-stage-contacted' },
  interested: { pill: 'bg-stage-interested-soft text-stage-interested', dot: 'bg-stage-interested' },
  quoting: { pill: 'bg-stage-quoting-soft text-stage-quoting', dot: 'bg-stage-quoting' },
  won: { pill: 'bg-stage-won-soft text-stage-won', dot: 'bg-stage-won' },
  lost: { pill: 'bg-stage-lost-soft text-stage-lost', dot: 'bg-stage-lost' },
};

// A body from an older service may lack the sales fields: read them defensively.
type Partial3 = Partial<Pick<LeadSummary, 'salesStage' | 'lastContactedAt' | 'nextTask'>>;

export function stageOf(lead: LeadSummary): SalesStage {
  const s = (lead as Partial3).salesStage;
  return isStage(s) ? s : 'new';
}

export function lastContactedOf(lead: LeadSummary): string | null {
  const v = (lead as Partial3).lastContactedAt;
  return typeof v === 'string' && v ? v : null;
}

export function nextTaskOf(lead: LeadSummary): NextTask | null {
  const t = (lead as Partial3).nextTask;
  return t && typeof t === 'object' && typeof t.dueAt === 'string' ? t : null;
}

// ---- dates ------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days from today to the date (negative: past). */
export function daysFromToday(iso: string, now = Date.now()): number {
  return Math.round((startOfDay(Date.parse(iso)) - startOfDay(now)) / DAY);
}

export interface FollowUpText {
  label: string;
  tone: 'overdue' | 'today' | 'soon' | 'later';
}

/** "Overdue 2d", "Today", "Tomorrow", "Thu", "Oct 30". */
export function followUpText(dueAt: string, now = Date.now()): FollowUpText | null {
  if (Number.isNaN(Date.parse(dueAt))) return null;
  const n = daysFromToday(dueAt, now);
  if (n < 0) return { label: `Overdue ${-n}d`, tone: 'overdue' };
  if (n === 0) return { label: 'Today', tone: 'today' };
  if (n === 1) return { label: 'Tomorrow', tone: 'soon' };
  const d = new Date(dueAt);
  if (n < 7) return { label: weekday.format(d), tone: 'soon' };
  return { label: d.getFullYear() === new Date(now).getFullYear() ? monthDay.format(d) : monthDayYear.format(d), tone: 'later' };
}

/** "Today", "Yesterday", "3 days ago", "2 weeks ago", "4 months ago"; null: never. */
export function lastContactedText(iso: string | null, now = Date.now()): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const n = -daysFromToday(iso, now);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.floor(n / 7)} weeks ago`;
  if (n < 365) return `${Math.floor(n / 30)} months ago`;
  return 'Over a year ago';
}

/** The local date `days` ago as YYYY-MM-DD (what the dashboard links send as notContactedSince). */
export function daysAgoDate(days: number, now = Date.now()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 7 or 30 when notContactedSince is that many days back (by local date), else null. */
export function notContactedDays(since: string | undefined, now = Date.now()): 7 | 30 | null {
  if (!since) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : Number.isNaN(Date.parse(since)) ? null : daysAgoDate(0, Date.parse(since));
  if (day === daysAgoDate(7, now)) return 7;
  if (day === daysAgoDate(30, now)) return 30;
  return null;
}

// ---- contact ------------------------------------------------------------------------------------------------

/** The decision-maker the pipeline found ("DM: Jane Roe (Owner)"), as name + role; null without one. */
export function decisionMaker(lead: Pick<LeadSummary, 'tags'>): { name: string; role: string | null; label: string } | null {
  const tag = (lead.tags ?? []).find((t) => t.key === 'decision_maker');
  const label = typeof tag?.label === 'string' ? tag.label : '';
  const m = /^(?:DM|Possible contact):\s*(.+)$/i.exec(label);
  if (!m) return null;
  const body = m[1]!.trim();
  const role = /\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*$/.exec(body);
  const name = (role ? body.slice(0, role.index) : body).trim();
  return name ? { name, role: role?.[1]?.trim() || null, label } : null;
}
