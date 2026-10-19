// The top ranking reasons behind a priority score, phrased with the lead's own values ("GAF Master Elite",
// "200+ reviews") rather than the driver names. The lead list, the allocation queue and the briefing share it.
import type { LeadSummary } from '@/api/types';
import { humanize } from './format';

/** priority_drivers names -> the tag that carries the concrete value. */
const DRIVER_TAGS: Record<string, string> = {
  'GAF tier': 'gaf_tier',
  'Review volume': 'review_volume',
  Maturity: 'maturity',
  Reputation: 'reputation',
  Proximity: 'distance_band',
  'Decision-maker': 'decision_maker',
  Size: 'size',
  Website: 'website',
};

export interface Reason {
  driver: string;
  label: string;
}

/** The top ranking reasons, phrased with the lead's own values ("GAF Master Elite", "200+ reviews"). */
export function rankingReasons(lead: Pick<LeadSummary, 'priorityDrivers' | 'tags'>, max = 2): Reason[] {
  const byKey = new Map((lead.tags ?? []).map((t) => [t.key, t]));
  return (lead.priorityDrivers ?? []).slice(0, max).map((driver) => {
    const tag = byKey.get(DRIVER_TAGS[driver] ?? '');
    let label = driver;
    if (tag) {
      if (tag.key === 'decision_maker') label = 'Decision-maker found';
      else if (tag.key === 'distance_band') label = `${tag.label} away`;
      else if (tag.key === 'size') label = `${humanize(String(tag.value))} company`;
      else label = tag.label;
    }
    return { driver, label };
  });
}
