import { describe, expect, it } from 'vitest';
import { leadFilterSchema } from '@leadmaker/shared';
import { buildSearchQuery, decodeCursor, encodeCursor } from '../src/filter-sql.ts';

const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const OTHER = 'e1817cb3-f647-416d-9c20-084a9ab62324';

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

describe('cursor', () => {
  it('round-trips and is bound to the sort', () => {
    const c = encodeCursor({ s: 'rating:asc', k: '4.5', id: OTHER });
    expect(decodeCursor(c, 'rating:asc')).toEqual({ s: 'rating:asc', k: '4.5', id: OTHER });
    expect(status(() => decodeCursor(c, 'rating:desc'))).toBe(400);
    expect(status(() => decodeCursor('not-a-cursor', 'rating:asc'))).toBe(400);
    expect(status(() => decodeCursor(encodeCursor({ s: 'rating:asc', k: '1', id: 'x' }), 'rating:asc'))).toBe(400);
  });
});

describe('search query', () => {
  it('is one parameterised statement with visibility first', () => {
    const filter = leadFilterSchema.parse({ text: "O'Brien", tagsAll: ['size=small'], minRating: 4, unchecked: 'me' });
    const { query, limit } = buildSearchQuery(filter, { viewer: REP });
    const { text, values } = query.compile();
    expect(text).toContain('(c.assigned_rep_id = $');
    expect(text).toContain('LEFT JOIN lead_rep_state ms');
    expect(text).not.toContain("O'Brien");
    expect(values).toContain("%O'Brien%");
    expect(values).toContain(REP.id);
    expect(limit).toBe(50);
  });

  it('needs a resolved centre for near and distance sorting', () => {
    const filter = leadFilterSchema.parse({ near: { zip: '10013', radiusMiles: 5 }, sort: { by: 'distance', dir: 'asc' } });
    expect(status(() => buildSearchQuery(filter, { viewer: REP }))).toBe(400);
    expect(buildSearchQuery(filter, { viewer: REP, center: { lat: 40.7, lng: -74 } }).signature).toBe('distance:asc:10013');
  });
});
