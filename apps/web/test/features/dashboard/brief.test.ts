import { describe, expect, it } from 'vitest';
import { qk } from '@/api/queries';
import { BRIEF_STALE_MS, briefNote, visibleBrief } from '@/features/dashboard/TerritoryBrief';
import { invalidationsFor } from '@/live/eventMap';
import { makeBrief } from './fixtures';

describe('territory brief', () => {
  it('is shown only when it has something fresh to say', () => {
    expect(visibleBrief(makeBrief())).not.toBeNull();
    expect(visibleBrief(null)).toBeNull();
    expect(visibleBrief(undefined)).toBeNull();
    expect(visibleBrief(makeBrief({ quiet: true }))).toBeNull();
    expect(visibleBrief(makeBrief({ stale: true }))).toBeNull();
    expect(visibleBrief(makeBrief({ text: '' }))).toBeNull();
  });

  it('the ⓘ says where it came from', () => {
    expect(briefNote(makeBrief())).toBe('Summary of the latest data poll and weather alerts.');
    const now = Date.parse('2026-10-19T19:00:00Z');
    const ai = makeBrief({ source: 'ai', model: 'gemini:gemini-3.8-flash', generatedAt: '2026-10-19T17:00:00Z', promptVersion: 'briefing/v1' });
    expect(briefNote(ai, now)).toBe('Summary of the latest data poll and weather, written by AI from the facts · gemini-3.8-flash · 2 hours ago');
    expect(briefNote(makeBrief({ source: 'ai', model: null, generatedAt: null }), now))
      .toBe('Summary of the latest data poll and weather, written by AI from the facts');
  });

  it('is cached for ten minutes and refreshed when a pipeline run completes', () => {
    expect(BRIEF_STALE_MS).toBe(10 * 60_000);
    expect(qk.territoryBrief('mine')).toEqual(['territory-brief', 'mine']);
    expect(invalidationsFor({ type: 'pipeline.run_completed', companyIds: [] })).toContainEqual(qk.territoryBriefAll);
    expect(invalidationsFor({ type: 'lead.updated', companyIds: ['x'] })).not.toContainEqual(qk.territoryBriefAll);
  });
});
