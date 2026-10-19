import { describe, expect, it } from 'vitest';
import { cleanPoints } from '@/features/profile/Insights';
import { REFRESH_ERROR, isNewerInsight } from '@/features/profile/insightsRefresh';

describe('cleanPoints', () => {
  it('keeps the talking points that have text, trimmed', () => {
    expect(cleanPoints(['  Ask about crews. ', '', '   ', 42, null, 'Follow up on deliveries.'])).toEqual([
      'Ask about crews.', 'Follow up on deliveries.',
    ]);
  });

  it('treats a missing or malformed list as empty', () => {
    expect(cleanPoints(undefined)).toEqual([]);
    expect(cleanPoints(null)).toEqual([]);
    expect(cleanPoints('not a list' as unknown as string[])).toEqual([]);
  });
});

describe('isNewerInsight', () => {
  const at = Date.parse('2026-10-19T15:00:00Z');
  it('is true only for a valid time after the request', () => {
    expect(isNewerInsight('2026-10-19T15:00:01Z', at)).toBe(true);
    expect(isNewerInsight('2026-10-19T15:00:00Z', at)).toBe(false);
    expect(isNewerInsight('2026-10-19T14:00:00Z', at)).toBe(false);
    expect(isNewerInsight(null, at)).toBe(false);
    expect(isNewerInsight('soon', at)).toBe(false);
    expect(isNewerInsight('2026-10-19T14:00:00Z', Number.NEGATIVE_INFINITY)).toBe(true); // Generate: any insight counts
  });

  it('the failure line names no limit', () => {
    expect(REFRESH_ERROR).toBe('Couldn’t refresh right now. Try again in a moment.');
    expect(REFRESH_ERROR).not.toMatch(/quota|limit|3:00|resets/i);
  });
});
