// Preset views (client-side), plus matching the current URL against them and the saved views (savedViews.ts).
import type { LeadFilter } from '@/api/types';
import { normalizeQuery, viewQuery } from './useLeadsUrl';

export type PresetId = 'follow-ups-due' | 'never-contacted' | 'interested-quoting' | 'win-back' | 'updated-last-poll' | 'storm-ready';

export interface PresetView {
  id: PresetId;
  name: string;
  /** The quick-view chip's label. */
  short: string;
  description: string;
}

/** Sales work first; the weather view goes last. */
export const PRESETS: readonly PresetView[] = [
  { id: 'follow-ups-due', name: 'Follow-ups due', short: 'Follow-ups due', description: 'Leads with a follow-up due today (or overdue, or this week), soonest first' },
  { id: 'never-contacted', name: 'Never contacted', short: 'Never contacted', description: 'No call, email or visit logged yet, best first' },
  { id: 'interested-quoting', name: 'Interested & quoting', short: 'Interested & quoting', description: 'Open deals: interested or pricing a job' },
  { id: 'win-back', name: 'Lapsed customers (win-back)', short: 'Win-back', description: 'Former customers to win back, longest since contact first' },
  { id: 'updated-last-poll', name: 'New in last poll', short: 'New in last poll', description: 'New or materially changed in the latest pipeline run' },
  { id: 'storm-ready', name: 'Storm-ready', short: 'Storm-ready', description: 'Storm / emergency roofers with an NWS storm alert in the last 7 days' },
];

export const STORM_TAGS = ['work_type:storm_emergency', 'service:emergency_service'];

/** The filter (and alert flag) a preset applies; presets slice whichever view is open (the scope is kept). */
export function presetFilter(id: PresetId): { filter: LeadFilter; alert: boolean } {
  switch (id) {
    case 'follow-ups-due':
      return { filter: { followUp: 'today', sort: { by: 'next_follow_up', dir: 'asc' } }, alert: false };
    case 'never-contacted':
      return { filter: { unserviced: 'team' }, alert: false };
    case 'interested-quoting':
      return { filter: { stages: ['interested', 'quoting'], sort: { by: 'next_follow_up', dir: 'asc' } }, alert: false };
    case 'win-back':
      return { filter: { accountStatus: ['lapsed_customer'], sort: { by: 'last_contacted', dir: 'asc' } }, alert: false };
    case 'updated-last-poll':
      return { filter: { updatedInLastPoll: true, sort: { by: 'last_change', dir: 'desc' } }, alert: false };
    case 'storm-ready':
      return { filter: { tagsAny: STORM_TAGS }, alert: true };
  }
}

/** Applies a preset on top of the current filter's scope. */
export function applyPreset(current: LeadFilter, id: PresetId) {
  const { filter, alert } = presetFilter(id);
  return { filter: { ...filter, scope: current.scope }, alert };
}

/** Follow-ups due comes in three windows; the API's buckets don't overlap, except that "week" includes today. */
export const DUE_BUCKETS = ['overdue', 'today', 'week'] as const satisfies readonly NonNullable<LeadFilter['followUp']>[];
export type DueBucket = (typeof DUE_BUCKETS)[number];

/** The preset the current URL matches exactly, if any (Follow-ups due in any of its windows). */
export function activePreset(current: LeadFilter, alert: boolean): PresetView | null {
  const cur = normalizeQuery(viewQuery(current, alert));
  return PRESETS.find((p) => {
    const applied = applyPreset(current, p.id);
    const f = p.id === 'follow-ups-due' && (DUE_BUCKETS as readonly string[]).includes(current.followUp ?? '')
      ? { ...applied.filter, followUp: current.followUp }
      : applied.filter;
    return normalizeQuery(viewQuery(f, applied.alert)) === cur;
  }) ?? null;
}

/** The preset or saved view the current URL matches exactly, if any. */
export function activeViewName(
  current: LeadFilter,
  alert: boolean,
  saved: readonly { name: string; query: string }[],
): string | null {
  const preset = activePreset(current, alert);
  if (preset) return preset.name;
  const cur = normalizeQuery(viewQuery(current, alert));
  return saved.find((v) => normalizeQuery(v.query) === cur)?.name ?? null;
}
