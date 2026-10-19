// List timing badges: each lead carries its own (LeadSummary.timing, computed by the query service with the
// profile's rules, enrichment services included). The calendar "season" badge is the same for every NY/NJ
// lead, so the list leaves it out; a table cell shows a short label, the full label and reason in the tooltip.
import type { LeadSummary, TimingBadge } from '@/api/types';

const SEVERITY_RANK: Record<TimingBadge['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Badge keys that mean "a roof-damaging NWS alert is active or ended in the last 7 days". */
export const ALERT_BADGE_KEYS = new Set(['storm_response', 'weather_alert']);

export interface ListTimingBadge extends TimingBadge {
  /** Short label for a table cell; `label` and `reason` go in the tooltip. */
  short: string;
}

export function shortTimingLabel(b: Pick<TimingBadge, 'key' | 'label'>): string {
  const head = (b.label ?? '').split(':')[0]!.trim();
  switch (b.key) {
    case 'storm_response':
      return /nearby/i.test(head) ? 'Storm nearby' : 'Storm response';
    case 'weather_alert':
      return /nearby/i.test(head) ? 'Severe weather nearby' : 'Severe weather';
    case 'weather_delays':
      return 'Weather delays';
    case 'recent_storm':
      return 'Recent storms';
    default:
      return head || b.label;
  }
}

/** The lead's list badges, most severe first (empty when nothing applies). */
export function leadTiming(lead: Pick<LeadSummary, 'timing'>): ListTimingBadge[] {
  return (Array.isArray(lead.timing) ? lead.timing : [])
    .filter((b) => b && b.key !== 'season')
    .map((b) => ({ ...b, short: shortTimingLabel(b) }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

export function hasAlertBadge(badges: readonly ListTimingBadge[]): boolean {
  return badges.some((b) => ALERT_BADGE_KEYS.has(b.key));
}
