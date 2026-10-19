// Stage labels, the funnel order, and links from a dashboard number to the leads behind it.
import type { LeadFilter } from '@/api/types';
import { filterToSearchParams } from '@/lib/filterUrl';
import type { DashboardScope, SalesStage } from './api';

export { STAGE_LABELS } from '@/lib/labels';

/** The funnel left to right; "Not a fit" sits apart. */
export const FUNNEL: readonly SalesStage[] = ['new', 'contacted', 'interested', 'quoting', 'won'];

/** The lead list scope for a dashboard scope. */
export function leadScope(scope: DashboardScope): NonNullable<LeadFilter['scope']> {
  if (scope === 'mine') return 'mine';
  if (scope === 'team') return 'all';
  return { repId: scope.slice(4) };
}

/** "/leads?scope=mine&stage=quoting": the lead list's own URL params (lib/filterUrl). */
export function salesLeadsHref(scope: DashboardScope, f: Omit<LeadFilter, 'scope'> = {}): string {
  return `/leads?${filterToSearchParams({ ...f, scope: leadScope(scope) })}`;
}

/** The date `days` ago (YYYY-MM-DD, local), for notContactedSince. */
export function daysAgoDate(days: number, now = Date.now()): string {
  const d = new Date(now - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Whole days between two instants (calendar days in local time, never negative). */
export function daysBetween(fromIso: string, now: number): number {
  const a = new Date(fromIso);
  if (Number.isNaN(a.getTime())) return 0;
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86_400_000));
}

/** Work days elapsed this week (Mon 1 ... Fri 5, weekend 5): the share of the weekly goal due by today. */
export function weekPace(goal: number, now: number): number {
  const day = new Date(now).getDay();
  const worked = day === 0 || day === 6 ? 5 : day;
  return Math.round((goal * worked) / 5);
}
