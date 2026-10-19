import { describe, expect, it } from 'vitest';
import { normalizeDashboard } from '@/features/dashboard/api';
import { daysAgoDate, salesLeadsHref, weekPace } from '@/features/dashboard/sales';
import { dashboardBody } from './fixtures';

describe('normalizeDashboard', () => {
  it('shapes the contract body for rendering: stage counts by stage, one total per day', () => {
    const d = normalizeDashboard(dashboardBody({
      reps: [{ rep: { id: 'r1', name: 'Jordan Lee' }, assigned: 50, pipeline: [{ stage: 'won', count: 2 }], activityThisWeek: 16, overdue: 2, wonThisMonth: 1 }],
    }), 'mine');
    expect(d.pipeline).toEqual({ new: 20, contacted: 12, interested: 8, quoting: 4, won: 3, lost: 3 });
    expect(d.activity.daily[1]).toEqual({ date: '2026-10-06', total: 2 });
    expect(d.reps![0]!.pipeline).toEqual({ new: 0, contacted: 0, interested: 0, quoting: 0, won: 2, lost: 0 });
  });

  it('renders a partial or empty body as zeros instead of failing', () => {
    const d = normalizeDashboard({ pipeline: [{ stage: 'bogus', count: 9 }], activity: { thisWeek: { calls: 'x' } } }, 'team');
    expect(d.scope).toBe('team');
    expect(d.pipeline.new).toBe(0);
    expect(d.activity).toMatchObject({ thisWeek: { calls: 0, emails: 0, visits: 0, notes: 0 }, goalPerWeek: 25, daily: [] });
    expect(d.reps).toBeUndefined();
    expect(normalizeDashboard(undefined, 'mine').topTags).toEqual([]);
  });
});

describe('salesLeadsHref', () => {
  it('links a number to the leads behind it, in the rep, team or one-rep scope', () => {
    expect(salesLeadsHref('mine', { accountStatus: ['lapsed_customer'] })).toBe('/leads?scope=mine&status=lapsed_customer');
    expect(salesLeadsHref('team', { stages: ['quoting'] })).toMatch(/^\/leads\?scope=all&.*stage=quoting/);
    const rep = '50302c37-aeb7-4cef-b8c7-cc14004df3bb';
    const href = salesLeadsHref(`rep:${rep}`, { followUp: 'overdue', sort: { by: 'next_follow_up', dir: 'asc' } });
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('scope')).toBe(`rep:${rep}`);
    expect(q.get('sort')).toBe('next_follow_up:asc');
    expect(q.get('followUp') ?? q.get('followup') ?? q.get('due')).toBe('overdue');
  });

  it('puts each filter in once', () => {
    const q = new URLSearchParams(salesLeadsHref('mine', { stages: ['interested', 'quoting'] }).split('?')[1]);
    expect(q.getAll('stage').length + q.getAll('stages').length).toBe(2);
  });
});

describe('dates', () => {
  it('expects a fifth of the weekly goal per work day, all of it at the weekend', () => {
    expect(weekPace(25, Date.parse('2026-10-14T12:00:00'))).toBe(15); // Wednesday
    expect(weekPace(25, Date.parse('2026-10-18T12:00:00'))).toBe(25); // Sunday
    expect(daysAgoDate(30, Date.parse('2026-10-18T12:00:00'))).toBe('2026-09-18');
  });
});
