import { describe, expect, it } from 'vitest';
import { cleanPoints } from '@/features/profile/Insights';
import {
  ATTEMPT_ERROR, REFRESH_ERROR, REFRESH_TIMEOUT_MS, attemptOf, isFailedAttempt, isNewerInsight,
} from '@/features/profile/insightsRefresh';

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

  it('the failure lines name no limit', () => {
    expect(REFRESH_ERROR).toBe('Couldn’t refresh right now. Try again in a moment.');
    expect(ATTEMPT_ERROR).toBe('Couldn’t update the insights this time. Try again.');
    for (const line of [REFRESH_ERROR, ATTEMPT_ERROR]) expect(line).not.toMatch(/quota|limit|3:00|resets/i);
  });

  it('waits at most 100 s (3 manual model calls)', () => {
    expect(REFRESH_TIMEOUT_MS).toBe(100_000);
  });
});

describe('isFailedAttempt', () => {
  const at = Date.parse('2026-10-19T15:00:00Z');
  it('is true only for an error written after the request', () => {
    expect(isFailedAttempt({ status: 'error', at: '2026-10-19T15:00:03Z' }, at)).toBe(true);
    expect(isFailedAttempt({ status: 'error', at: '2026-10-19T15:00:00Z' }, at)).toBe(false);
    expect(isFailedAttempt({ status: 'error', at: '2026-10-19T14:59:00Z' }, at)).toBe(false); // an earlier run
    expect(isFailedAttempt({ status: 'ok', at: '2026-10-19T15:00:03Z' }, at)).toBe(false);
    expect(isFailedAttempt({ status: 'error', at: 'soon' }, at)).toBe(false);
    expect(isFailedAttempt(null, at)).toBe(false);
    expect(isFailedAttempt(undefined, at)).toBe(false);
  });

  it('attemptOf reads the profile field, or null when an older service leaves it out', () => {
    expect(attemptOf({ insightAttempt: { status: 'error', at: '2026-10-19T15:00:03Z' } })).toEqual({ status: 'error', at: '2026-10-19T15:00:03Z' });
    expect(attemptOf({ insightAttempt: null })).toBeNull();
    expect(attemptOf({})).toBeNull();
  });
});
