import { describe, expect, it } from 'vitest';
import { countyName, countyShort } from '@/lib/counties';
import { actionableBadge } from '@/features/dashboard/hazards';
import { demandHazard, groupAlerts, stormSummaries } from '@/features/dashboard/signals';
import { alertSignal, stormHistorySignal } from './fixtures';

const now = new Date('2026-10-18T20:00:00Z');

describe('groupAlerts', () => {
  it('shows an NWS alert once with every county it covers, active before ended, severe first', () => {
    const warning = alertSignal({ event: 'Severe Thunderstorm Warning', countyFips: '36047' });
    const sameInQueens = { ...warning, id: 'q', countyFips: '36081' };
    const frost = alertSignal({ event: 'Frost Advisory', severity: 'Minor', countyFips: '34003' });
    const old = alertSignal({ event: 'Flood Warning', countyFips: '34003', validTo: '2026-10-16T00:00:00Z', active: false, expired: true });
    const groups = groupAlerts([frost, old, warning, sameInQueens], now);
    expect(groups.map((g) => g.event)).toEqual(['Severe Thunderstorm Warning', 'Frost Advisory', 'Flood Warning']);
    expect(groups[0]).toMatchObject({ counties: ['36047', '36081'], tone: 'danger', status: 'active' });
    expect(groups[1]!.tone).toBe('info');
    expect(groups[2]!.status).toBe('ended');
  });

  it('folds re-issues of the same event for the same counties into one', () => {
    const a = alertSignal({ event: 'Special Weather Statement', severity: 'Moderate', url: 'u1', validTo: '2026-10-16T01:00:00Z', expired: true, active: false });
    const b = alertSignal({ event: 'Special Weather Statement', severity: 'Moderate', url: 'u2', validTo: '2026-10-16T03:00:00Z', expired: true, active: false });
    const groups = groupAlerts([a, b], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.issued).toBe(2);
    expect(groups[0]!.ends?.toISOString()).toBe('2026-10-16T03:00:00.000Z');
  });
});

describe('demandHazard and stormSummaries', () => {
  it('buckets NWS events by what they mean for roofing demand', () => {
    expect(demandHazard('Severe Thunderstorm Warning')).toBe('storm');
    expect(demandHazard('Flood Watch')).toBe('flood');
    expect(demandHazard('Winter Storm Warning')).toBe('winter');
    expect(demandHazard('Frost Advisory')).toBe('cold');
    expect(demandHazard('Air Quality Alert')).toBe('other');
  });

  it('ranks counties by storm reports in the last year and words the latest one', () => {
    const rows = stormSummaries([
      stormHistorySignal('34003', [{ date: '2026-09-26', kind: 'wind', event_type: 'NON-TSTM WND DMG', location: 'Ramsey' }]),
      stormHistorySignal('36047', [{ date: '2026-10-01', kind: 'wind' }, { date: '2026-09-01', kind: 'hail' }]),
    ]);
    expect(rows.map((r) => [r.countyFips, r.events12m])).toEqual([['36047', 2], ['34003', 1]]);
    expect(rows[1]!.lastEvent).toEqual({ date: '2026-09-26', label: 'Wind damage', location: 'Ramsey' });
  });
});

describe('county names', () => {
  it('names counties', () => {
    expect(countyName('36047')).toBe('Kings County, NY');
    expect(countyShort('36047')).toBe('Kings (Brooklyn)');
    expect(countyName('99999')).toBe('County 99999');
  });
});

describe('timing badges from the API', () => {
  const b = (key: string, severity: 'high' | 'medium' | 'low' | 'info') => ({ key, label: key, reason: key, source: 'nws', severity });

  it('takes the first badge that asks for action; the season badge never does', () => {
    expect(actionableBadge([b('season', 'info')])).toBeNull();
    expect(actionableBadge([b('season', 'info'), b('storm_response', 'high')])?.key).toBe('storm_response');
    expect(actionableBadge(undefined)).toBeNull();
  });
});
