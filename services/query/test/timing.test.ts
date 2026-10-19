// Parity with leadmaker/signals/timing.py: test/fixtures/timing-golden.json holds the Python output for
// synthetic edge cases and real Section 1 leads/signals (regenerate with fixtures/timing_golden.py).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@leadmaker/db';
import { CountySignals } from '../src/lead-timing.ts';
import { parseDt, pointInGeometry, timingBadges, type SignalRow, type TimingLead } from '../src/timing.ts';

const golden = JSON.parse(readFileSync(new URL('./fixtures/timing-golden.json', import.meta.url), 'utf8')) as {
  signalSets: Record<string, SignalRow[]>;
  cases: { name: string; lead: TimingLead; signals: string; now: string; expected: unknown[] }[];
};

describe('timing badges match the Python rules', () => {
  it('covers every badge kind and severity', () => {
    const kinds = new Set(golden.cases.flatMap((c) => c.expected.map((b) => `${(b as { key: string }).key}:${(b as { severity: string }).severity}`)));
    for (const k of ['storm_response:high', 'storm_response:medium', 'storm_response:low', 'weather_alert:low',
      'weather_delays:medium', 'recent_storm:medium', 'recent_storm:low', 'season:info']) expect(kinds).toContain(k);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(timingBadges(c.lead, golden.signalSets[c.signals], c.now)).toEqual(c.expected);
  });
});

describe('timing helpers', () => {
  it('parses Postgres, SQLite and NWS timestamps, naive ones as UTC', () => {
    expect(parseDt('2026-10-16 20:02:00.000000')?.toISOString()).toBe('2026-10-16T20:02:00.000Z');
    expect(parseDt('2026-10-16T20:02:00.123456+00:00')?.toISOString()).toBe('2026-10-16T20:02:00.123Z');
    expect(parseDt('2026-10-16T16:02:00-04:00')?.toISOString()).toBe('2026-10-16T20:02:00.000Z');
    expect(parseDt('2026-10-16')?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect([parseDt('soon'), parseDt(null), parseDt('')]).toEqual([null, null, null]);
  });

  it('ignores unusable geometries', () => {
    expect(pointInGeometry(40.7, -74, null)).toBeNull();
    expect(pointInGeometry(40.7, -74, { type: 'Point', coordinates: [-74, 40.7] })).toBeNull();
    expect(pointInGeometry(40.7, -74, { type: 'Polygon', coordinates: [[[-74, 40], [-73, 40], [-74, 40]]] })).toBeNull();
  });
});

describe('CountySignals', () => {
  const fakeClient = (fail = 0) => {
    const reads: unknown[][] = [];
    let failures = fail;
    const client = {
      $queryRaw: async (q: { values: unknown[] }) => {
        reads.push(q.values);
        if (failures-- > 0) throw new Error('db down');
        const counties = q.values[0] as string[];
        return counties.map((c) => ({ county_fips: c, kind: 'storm_history', payload: { c } }));
      },
    } as unknown as PrismaClient;
    return { client, reads };
  };

  it('reads each county once per TTL, missing counties of a page in one statement, concurrent callers sharing it', async () => {
    const { client, reads } = fakeClient();
    const cache = new CountySignals(1000);
    const [a, b] = await Promise.all([cache.get(client, ['36061', '34003'], 0), cache.get(client, ['36061'], 10)]);
    expect(reads).toEqual([[['36061', '34003']]]);
    expect(a.get('34003')).toEqual([{ county_fips: '34003', kind: 'storm_history', payload: { c: '34003' } }]);
    expect(b.get('36061')).toHaveLength(1);
    await cache.get(client, ['36061', '36047'], 500);
    expect(reads.at(-1)).toEqual([['36047']]);
    await cache.get(client, ['36061', '36047'], 1200);
    expect(reads.at(-1)).toEqual([['36061']]);
    expect(reads).toHaveLength(3);
  });

  it('forgets a failed read, so the next request retries it', async () => {
    const { client, reads } = fakeClient(1);
    const cache = new CountySignals(60_000);
    await expect(cache.get(client, ['36061'], 0)).rejects.toThrow('db down');
    expect((await cache.get(client, ['36061'], 1)).get('36061')).toHaveLength(1);
    expect(reads).toHaveLength(2);
  });
});
