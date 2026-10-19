import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadFilter, TimingBadge } from '@/api/types';
import { apiScope, scopeForView, viewLabel, viewOf } from '@/features/leads/scope';
import { rankingReasons, tagRefLabel } from '@/features/leads/tags';
import { lead, users } from './testUtils';
import { hasAlertBadge, leadTiming } from '@/features/leads/timing';
import { activePreset, activeViewName, applyPreset, PRESETS } from '@/features/leads/views';
import {
  daysAgoDate, decisionMaker, followUpText, lastContactedOf, lastContactedText, nextTaskOf, notContactedDays, stageOf,
} from '@/features/leads/sales';
import { filterToSearchParams, searchParamsToFilter } from '@/features/leads/useLeadsUrl';

afterEach(() => vi.unstubAllGlobals());

describe('scope', () => {
  it('defaults reps to their own leads and managers to everything', () => {
    expect(viewOf({}, false).view).toBe('mine');
    expect(viewOf({}, true).view).toBe('all');
    expect(viewOf({ scope: { repId: 'r' } }, true)).toEqual({ view: 'rep', repId: 'r' });
    expect(scopeForView('mine', false)).toBeUndefined();
    expect(scopeForView('all', false)).toBe('all');
    expect(scopeForView('all', true)).toBeUndefined();
  });

  it('never sends a rep a manager-only scope', () => {
    expect(apiScope({}, users.rep)).toBe('mine');
    expect(apiScope({ scope: 'all' }, users.rep)).toBeUndefined();
    expect(apiScope({ scope: { repId: 'someone-else' } }, users.rep)).toBeUndefined();
    expect(apiScope({ scope: { repId: users.rep.id } }, users.rep)).toBe('mine');
    expect(apiScope({ scope: 'all' }, users.manager)).toBe('all');
    expect(apiScope({}, users.manager)).toBeUndefined();
  });

  it('labels the view', () => {
    expect(viewLabel({ scope: 'all' }, false)).toBe('Mine + unallocated');
    expect(viewLabel({ scope: { repId: 'p' } }, true, [{ id: 'p', name: 'Priya Shah' }])).toBe('Priya Shah’s leads');
  });
});

describe('timing (from LeadSummary.timing)', () => {
  const badge = (key: string, label: string, severity: TimingBadge['severity']): TimingBadge => ({ key, label, reason: `${label} reason`, source: 'nws', severity });

  it('shortens the labels, drops the season badge and puts the most severe first', () => {
    const t = leadTiming(lead({
      timing: [
        badge('season', 'In season: service & storm response', 'info'),
        badge('recent_storm', 'Recent storm activity', 'low'),
        badge('storm_response', 'Storm response: Severe Thunderstorm Warning (recent)', 'medium'),
      ],
    }));
    expect(t.map((b) => [b.key, b.short])).toEqual([['storm_response', 'Storm response'], ['recent_storm', 'Recent storms']]);
    expect(hasAlertBadge(t)).toBe(true);
  });

  it('tells nearby alerts apart and handles leads without badges', () => {
    expect(leadTiming(lead({ timing: [badge('storm_response', 'Storm nearby: High Wind Warning', 'low')] }))[0]?.short).toBe('Storm nearby');
    expect(leadTiming(lead({ timing: [badge('weather_alert', 'Severe weather nearby: Wind Advisory', 'low')] }))[0]?.short).toBe('Severe weather nearby');
    expect(leadTiming(lead({ timing: [badge('weather_delays', 'Weather delays likely', 'medium')] }))[0]?.short).toBe('Weather delays');
    expect(leadTiming(lead({ timing: undefined }))).toEqual([]);
    expect(hasAlertBadge(leadTiming(lead({ timing: [badge('recent_storm', 'Recent storm activity', 'low')] })))).toBe(false);
  });
});

describe('ranking reasons and tag labels', () => {
  it('phrases drivers with the lead’s own values', () => {
    const l = lead({
      priorityDrivers: ['Proximity', 'Decision-maker', 'Size'],
      tags: [
        { key: 'distance_band', label: '0-5 mi', value: '0-5', category: 'geography' },
        { key: 'decision_maker', label: 'DM: Jane (Owner)', value: 'identified', category: 'contactability' },
      ],
    });
    expect(rankingReasons(l, 3).map((r) => r.label)).toEqual(['0-5 mi away', 'Decision-maker found', 'Size']);
    expect(tagRefLabel('work_type:new_construction')).toBe('New-build work');
    expect(tagRefLabel('gaf_tier=certified_plus')).toBe('GAF Certified Plus');
  });
});

describe('presets', () => {
  it('slice the open view, sales views first and storm last', () => {
    expect(PRESETS.map((p) => p.name)).toEqual([
      'Follow-ups due', 'Never contacted', 'Interested & quoting', 'Lapsed customers (win-back)', 'New in last poll', 'Storm-ready',
    ]);
    const current: LeadFilter = { scope: 'unallocated', segment: ['growth'] };
    expect(applyPreset(current, 'interested-quoting').filter).toEqual({
      stages: ['interested', 'quoting'], sort: { by: 'next_follow_up', dir: 'asc' }, scope: 'unallocated',
    });
    expect(applyPreset(current, 'never-contacted').filter).toEqual({ unserviced: 'team', scope: 'unallocated' });
    expect(applyPreset({}, 'win-back').filter).toEqual({ accountStatus: ['lapsed_customer'], sort: { by: 'last_contacted', dir: 'asc' }, scope: undefined });
    expect(applyPreset({}, 'storm-ready')).toEqual({
      filter: { tagsAny: ['work_type:storm_emergency', 'service:emergency_service'], scope: undefined }, alert: true,
    });
  });

  it('name the matching view, order-insensitively; follow-ups due in any of its windows', () => {
    expect(activeViewName({ tagsAny: ['service:emergency_service', 'work_type:storm_emergency'] }, true, [])).toBe('Storm-ready');
    expect(activeViewName({ tagsAny: ['service:emergency_service', 'work_type:storm_emergency'] }, false, [])).toBeNull();
    expect(activeViewName({ updatedInLastPoll: true, sort: { by: 'last_change', dir: 'desc' } }, false, [])).toBe('New in last poll');
    expect(activeViewName({ segment: ['growth', 'strategic'] }, false, [{ name: 'Mine', query: 'segment=strategic&segment=growth' }]))
      .toBe('Mine');
    const due = (followUp: LeadFilter['followUp']) => activePreset({ scope: 'mine', followUp, sort: { by: 'next_follow_up', dir: 'asc' } }, false)?.id ?? null;
    expect([due('overdue'), due('today'), due('week'), due('none')]).toEqual(['follow-ups-due', 'follow-ups-due', 'follow-ups-due', null]);
  });
});

describe('sales cells', () => {
  const now = new Date(2026, 9, 18, 15, 0).getTime(); // Sunday Oct 18, 3pm
  const at = (days: number, hour = 9) => new Date(2026, 9, 18 + days, hour).toISOString();

  it('words the next follow-up: overdue in days, today, tomorrow, a weekday, then a date', () => {
    expect(followUpText(at(-2), now)).toEqual({ label: 'Overdue 2d', tone: 'overdue' });
    expect(followUpText(at(0, 8), now)).toEqual({ label: 'Today', tone: 'today' });
    expect(followUpText(at(1), now)?.label).toBe('Tomorrow');
    expect(followUpText(at(4), now)?.label).toBe('Thu');
    expect(followUpText(at(12), now)).toEqual({ label: 'Oct 30', tone: 'later' });
    expect(followUpText('nope', now)).toBeNull();
  });

  it('words the last contact, "Never" being null', () => {
    expect(lastContactedText(null, now)).toBeNull();
    expect(lastContactedText(at(0), now)).toBe('Today');
    expect(lastContactedText(at(-1), now)).toBe('Yesterday');
    expect(lastContactedText(at(-3), now)).toBe('3 days ago');
    expect(lastContactedText(at(-21), now)).toBe('3 weeks ago');
    expect(lastContactedText(at(-95), now)).toBe('3 months ago');
  });

  it('reads the sales fields defensively and finds the decision-maker', () => {
    const old = { ...lead(), salesStage: undefined, nextTask: undefined, lastContactedAt: undefined } as unknown as Parameters<typeof stageOf>[0];
    expect([stageOf(old), nextTaskOf(old), lastContactedOf(old)]).toEqual(['new', null, null]);
    expect(stageOf(lead({ salesStage: 'quoting' }))).toBe('quoting');
    const dm = (label: string) => decisionMaker({ tags: [{ key: 'decision_maker', label, value: 'identified', category: 'contactability' }] });
    expect(dm('DM: Lawrence Ferrari (President)')).toMatchObject({ name: 'Lawrence Ferrari', role: 'President' });
    expect(dm('DM: Dean A Logan (Company officer (FMCSA MCS-150))')).toMatchObject({ name: 'Dean A Logan', role: 'Company officer (FMCSA MCS-150)' });
    expect(dm('Possible contact: Erand Molla')).toMatchObject({ name: 'Erand Molla', role: null });
    expect(dm('No decision-maker yet — ask for the Owner')).toBeNull();
  });

  it('knows 7 and 30 days back', () => {
    expect(notContactedDays(daysAgoDate(7, now), now)).toBe(7);
    expect(notContactedDays(daysAgoDate(30, now), now)).toBe(30);
    expect(notContactedDays('2026-01-01', now)).toBeNull();
    expect(notContactedDays(undefined, now)).toBeNull();
  });
});

describe('URL state', () => {
  it('round-trips the sales facets and sorts', () => {
    const f: LeadFilter = { stages: ['won', 'new'], followUp: 'week', notContactedSince: '2026-10-11', sort: { by: 'last_contacted', dir: 'asc' } };
    const p = filterToSearchParams(f);
    expect(p.getAll('stage')).toEqual(['won', 'new']);
    expect(searchParamsToFilter(p)).toEqual(f);
    expect(searchParamsToFilter(new URLSearchParams('stage=bogus&followUp=later&sort=next_follow_up:up'))).toEqual({});
  });
});

describe('state writes', () => {
  it('derives the team flags from the response’s latest team times', async () => {
    const { teamAfter } = await import('@/features/leads/queries');
    const l = lead({ team: { checked: true, serviced: false, checkedAt: '2026-10-18T10:00:00Z', servicedAt: null } });
    const mine = { checked: false, serviced: false, checkedAt: null, servicedAt: null };
    // Nobody checked any more (I cleared the only check): the team flag clears too.
    expect(teamAfter(l, { state: mine, team: { lastCheckedAt: null, lastServicedAt: null } })).toEqual({
      checked: false, serviced: false, checkedAt: null, servicedAt: null,
    });
    // A teammate's check still stands.
    expect(teamAfter(l, { state: mine, team: { lastCheckedAt: '2026-10-18T09:00:00Z', lastServicedAt: null } }).checked).toBe(true);
  });
});
