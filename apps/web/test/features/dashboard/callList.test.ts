import { describe, expect, it } from 'vitest';
import {
  bestContact, buildBriefing, countKinds, formatPhone, prioritiesSentence, weatherChip,
} from '@/features/dashboard/callList';
import { daysAgo, makeContact, makeLead, makeProfile, makeTask } from './fixtures';

const now = Date.parse('2026-10-18T14:00:00');
const today = (h: number) => new Date(new Date(now).setHours(h, 0, 0, 0)).toISOString();

describe('buildBriefing', () => {
  const quote = makeLead({ businessName: 'Quote Co', salesStage: 'quoting', lastContactedAt: daysAgo(9, now), priorityScore: 40 });
  const warm = makeLead({ businessName: 'Warm Co', salesStage: 'interested', lastContactedAt: daysAgo(20, now), priorityScore: 90 });
  const recent = makeLead({ businessName: 'Called Tuesday', salesStage: 'interested', lastContactedAt: daysAgo(2, now) });
  const fresh = makeLead({ businessName: 'Fresh Co', updatedInLastPoll: true, priorityScore: 70, certifications: ['gaf:master_elite'] });
  const planned = makeLead({ businessName: 'Planned Co', salesStage: 'quoting', lastContactedAt: daysAgo(12, now), nextTask: { id: 'x', title: 'Call', type: 'call', dueAt: daysAgo(-3, now) } });
  const strategic = makeLead({ businessName: 'Big Co', segment: 'strategic', priorityScore: 95 });
  const dnc = makeLead({ businessName: 'Do Not Call', segment: 'strategic', accountStatus: 'do_not_contact' });

  const overdueOld = makeTask({ companyId: 'l-a', companyName: 'Oldest overdue', dueAt: daysAgo(4, now) });
  const overdueNew = makeTask({ companyId: 'l-b', companyName: 'Newer overdue', dueAt: daysAgo(1, now) });
  const dueLater = makeTask({ companyId: 'l-c', companyName: 'Due at 3', dueAt: today(15) });
  const dueEarly = makeTask({ companyId: 'l-d', companyName: 'Due at 10', dueAt: today(10) });
  const sameLeadToday = makeTask({ companyId: quote.id, companyName: 'Quote Co', dueAt: today(11) });

  const rows = buildBriefing({
    overdue: [overdueNew, overdueOld],
    today: [dueLater, dueEarly, sameLeadToday],
    quiet: [warm, recent, planned, quote],
    fresh: [fresh],
    strategic: [dnc, strategic],
    now,
  });

  it('puts follow-ups first (oldest overdue, then today by time), then quotes, warm leads, new and strategic ones', () => {
    expect(rows.map((r) => r.leadName)).toEqual([
      'Oldest overdue', 'Newer overdue', 'Due at 10', 'Quote Co', 'Due at 3', 'Warm Co', 'Fresh Co', 'Big Co',
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['overdue', 'overdue', 'today', 'today', 'today', 'interested', 'new', 'strategic']);
  });

  it('lists each lead once, skips leads with a follow-up planned, recent contact or do-not-contact', () => {
    expect(rows.filter((r) => r.leadId === quote.id)).toHaveLength(1);
    const names = rows.map((r) => r.leadName);
    expect(names).not.toContain('Planned Co');
    expect(names).not.toContain('Called Tuesday');
    expect(names).not.toContain('Do Not Call');
  });

  it('says why in sales language', () => {
    expect(rows[0]).toMatchObject({ why: 'Follow-up 4 days overdue', detail: 'Call about the underlayment quote' });
    expect(rows[2]!.why).toBe('Follow-up due today at 10:00 AM');
    expect(rows.find((r) => r.leadName === 'Warm Co')!.why).toBe('Interested, no contact in 20 days');
    expect(rows.find((r) => r.leadName === 'Fresh Co')).toMatchObject({ why: 'New in the latest data: make the first call', detail: 'GAF Master Elite · Rated 4.8 (40 reviews)' });
    expect(rows.find((r) => r.leadName === 'Big Co')!.detail).toBe('Rated 4.8 (40 reviews) · 10 years in business');
  });

  it('is deterministic: same input, same order, whatever order the sources came in', () => {
    const again = buildBriefing({ overdue: [overdueOld, overdueNew], today: [sameLeadToday, dueEarly, dueLater], quiet: [quote, planned, recent, warm], fresh: [fresh], strategic: [strategic, dnc], now });
    expect(again.map((r) => r.key)).toEqual(rows.map((r) => r.key));
  });

  it('ranks quotes before interested leads, the longest-quiet first', () => {
    const a = makeLead({ salesStage: 'interested', lastContactedAt: daysAgo(30, now) });
    const b = makeLead({ salesStage: 'quoting', lastContactedAt: daysAgo(8, now) });
    const c = makeLead({ salesStage: 'quoting', lastContactedAt: daysAgo(15, now) });
    const r = buildBriefing({ overdue: [], today: [], quiet: [a, b, c], fresh: [], strategic: [], now });
    expect(r.map((x) => x.leadId)).toEqual([c.id, b.id, a.id]);
    expect(r[0]!.why).toBe('Quote out, no contact in 15 days');
    expect(countKinds(r)).toMatchObject({ quote: 2, interested: 1, overdue: 0 });
  });
});

describe('bestContact', () => {
  const lead = makeLead({ phone: '2015550100' });

  it('asks for the target contact, else a reachable contact with a phone, else the main line', () => {
    const owner = makeContact({ id: 'c1', name: 'Mike Russo', title: 'Owner', phone: '(201) 555-0111' });
    const office = makeContact({ id: 'c2', name: 'Dana Office', phone: null, isTarget: false });
    const blocked = makeContact({ id: 'c3', name: 'Blocked', phone: '1', doNotContact: true });
    const target = { role: 'owner', label: 'Ask for: the Owner (name unknown)', reason: null, contactId: 'c2' };
    expect(bestContact(makeProfile(lead, { contacts: [owner, office, blocked], targetContact: target }), lead))
      .toMatchObject({ name: 'Dana Office', phone: '2015550100' });
    expect(bestContact(makeProfile(lead, { contacts: [office, owner, blocked] }), lead)).toMatchObject({ name: 'Mike Russo', title: 'Owner', phone: '(201) 555-0111' });
    expect(bestContact(makeProfile(lead, { contacts: [blocked], targetContact: { ...target, contactId: null } }), lead))
      .toEqual({ name: null, title: null, phone: '2015550100', email: null, askFor: 'Ask for: the Owner' });
    expect(bestContact(undefined, lead).phone).toBe('2015550100');
  });

  it('formats ten-digit numbers', () => {
    expect(formatPhone('2015550100')).toBe('(201) 555-0100');
    expect(formatPhone('+1 201 555 0100')).toBe('(201) 555-0100');
    expect(formatPhone('555-0100 ext 4')).toBe('555-0100 ext 4');
  });
});

describe('weatherChip', () => {
  const badge = (key: string, severity: 'high' | 'medium' | 'low' | 'info') => ({ key, label: key, reason: key, source: 'nws', severity });
  it('shows only an alert that asks for action soon, never county-wide storm history', () => {
    expect(weatherChip(undefined, makeLead({ timing: [badge('recent_storm', 'medium')] }))).toBeNull();
    expect(weatherChip(undefined, makeLead({ timing: [badge('recent_storm', 'medium'), badge('storm_response', 'high')] }))?.key).toBe('storm_response');
    expect(weatherChip(undefined, makeLead({ timing: [badge('cold_snap', 'low')] }))).toBeNull();
  });
});

describe('prioritiesSentence', () => {
  const none = { overdue: 0, today: 0, quote: 0, interested: 0, new: 0, strategic: 0 };
  it('says where to start today', () => {
    expect(prioritiesSentence({ subject: null, overdue: 2, today: 3, kinds: { ...none, quote: 1, interested: 1 } }))
      .toBe('Start with 2 overdue follow-ups, 3 due today and 2 warm deals gone quiet.');
    expect(prioritiesSentence({ subject: null, overdue: 0, today: 0, kinds: { ...none, new: 4 } }))
      .toBe('Nothing due today: 4 new leads from the latest data are ready for a first call.');
    expect(prioritiesSentence({ subject: 'The team', overdue: 1, today: 0, kinds: none, behind: { count: 2, of: 3 } }))
      .toBe('The team has 1 overdue follow-up; 2 of 3 reps are behind their weekly activity pace.');
    expect(prioritiesSentence({ subject: 'Priya', overdue: 0, today: 0, kinds: none })).toBe('Priya has nothing overdue or due today.');
  });
});
