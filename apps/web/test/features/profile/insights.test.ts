import { describe, expect, it } from 'vitest';
import { cleanPoints } from '@/features/profile/Insights';

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
