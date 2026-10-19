import { describe, expect, it } from 'vitest';
import {
  defaultTerritoryName, runStatus, sql, territoryFromRow, territorySql, US_ZIP, type TerritoryRow,
} from '../src/index.ts';

const row = (over: Partial<TerritoryRow> = {}): TerritoryRow => ({
  id: 7, name: 'North Jersey', params: { postal_code: '07030', radius_miles: 12.5, also_zips: ['07302'] },
  every_hours: 24, enabled: true, next_run_at: new Date('2026-10-20T06:00:00Z'),
  last_job_id: null, last_status: null, last_finished_at: null, ...over,
});

describe('admin contract helpers', () => {
  it('maps job states to run states; retries used up read as failed', () => {
    expect(['queued', 'running', 'succeeded', 'failed', 'dead'].map(runStatus))
      .toEqual(['queued', 'running', 'succeeded', 'failed', 'failed']);
  });

  it('maps a schedules row to a Territory', () => {
    expect(territoryFromRow(row({ last_job_id: 42, last_status: 'dead', last_finished_at: new Date('2026-10-19T11:00:00Z') })))
      .toEqual({
        id: '7', name: 'North Jersey', zip: '07030', radiusMiles: 12.5, alsoZips: ['07302'], everyHours: 24, enabled: true,
        lastRun: { jobId: '42', status: 'failed', finishedAt: '2026-10-19T11:00:00.000Z' },
        nextRunAt: '2026-10-20T06:00:00.000Z',
      });
  });

  it('has no next run when manual only or paused, and defaults missing params', () => {
    expect(territoryFromRow(row({ every_hours: null, next_run_at: null })).nextRunAt).toBeNull();
    expect(territoryFromRow(row({ enabled: false })).nextRunAt).toBeNull();
    expect(territoryFromRow(row({ params: { postal_code: '10013' } }))).toMatchObject({ radiusMiles: 25, alsoZips: [] });
  });

  it('selects only pipeline schedules, with the where clause as parameters', () => {
    const q = territorySql(sql`AND s.id = ${7}::int`).compile();
    expect(q.values).toEqual(['pipeline', 7]);
    expect(q.text).toMatch(/WHERE s\.kind = \$1 AND s\.id = \$2::int/);
  });

  it('validates ZIPs and names territories after their area', () => {
    expect(['10013', '07030'].every((z) => US_ZIP.test(z))).toBe(true);
    expect(['1001', '100131', '10013-1234', 'abcde'].some((z) => US_ZIP.test(z))).toBe(false);
    expect(defaultTerritoryName('10013', 25)).toBe('10013 (25 mi)');
  });
});
