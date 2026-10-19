import { describe, expect, it } from 'vitest';
import { addDays, bucketOf, dayOfChoice, daysBetween, doneText, dueError, dueText, presetDay, salesDay } from '@/features/tasks/dates';
import { countTasks } from '@/features/tasks/queries';
import { suggestFollowUp } from '@/features/tasks/model';
import { task } from './harness';

// Wed Oct 21 2026, 10:00 in New York (14:00 UTC).
const now = new Date('2026-10-21T14:00:00Z');
const at = (day: string) => `${day}T16:00:00.000Z`;

describe('follow-up days', () => {
  it('reads days in New York, whatever the instant', () => {
    expect(salesDay('2026-10-22T03:30:00Z')).toBe('2026-10-21'); // 11:30 pm the evening before
    expect(salesDay('2026-10-22T04:00:00Z')).toBe('2026-10-22'); // midnight: a date-only due day
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(daysBetween('2026-10-21', '2026-10-18')).toBe(-3);
  });

  it('buckets open tasks like the server: overdue, today, tomorrow, the rest of 7 days, later', () => {
    expect(bucketOf(at('2026-10-20'), now)).toBe('overdue');
    expect(bucketOf('2026-10-21T04:00:00.000Z', now)).toBe('today');
    expect(bucketOf(at('2026-10-22'), now)).toBe('tomorrow');
    expect(bucketOf(at('2026-10-27'), now)).toBe('week');
    expect(bucketOf(at('2026-10-28'), now)).toBe('later');
  });

  it('says due dates the way a rep would', () => {
    expect(dueText(at('2026-10-18'), now)).toBe('3 days overdue');
    expect(dueText(at('2026-10-20'), now)).toBe('Yesterday');
    expect(dueText(at('2026-10-21'), now)).toBe('Today');
    expect(dueText(at('2026-10-22'), now)).toBe('Tomorrow');
    expect(dueText(at('2026-10-24'), now)).toBe('Sat');
    expect(dueText(at('2026-11-12'), now)).toBe('Nov 12');
    expect(dueText(at('2027-01-04'), now)).toBe('Jan 4, 2027');
    expect(doneText(at('2026-10-21'), now)).toBe('Done today');
    expect(doneText(at('2026-10-20'), now)).toBe('Done yesterday');
  });

  it('resolves presets and validates picked dates', () => {
    expect(presetDay('tomorrow', now)).toBe('2026-10-22');
    expect(presetDay('in3', now)).toBe('2026-10-24');
    expect(presetDay('nextWeek', now)).toBe('2026-10-28');
    expect(dayOfChoice({ preset: 'date', day: '' }, now)).toBeNull();
    expect(dueError({ preset: 'date', day: '' }, now)).toBe('Pick a date.');
    expect(dueError({ preset: 'date', day: '2026-10-20' }, now)).toBe('Pick today or a later date.');
    expect(dueError({ preset: 'date', day: '2026-10-21' }, now)).toBeNull();
  });

  it('counts the tabs from one list of open tasks', () => {
    const open = [at('2026-10-19'), at('2026-10-21'), at('2026-10-21'), at('2026-10-23'), at('2026-11-20')].map((dueAt) => task({ dueAt }));
    const done = [task({ doneAt: at('2026-10-21') }), task({ doneAt: at('2026-10-10') })];
    expect(countTasks(open, done, now)).toEqual({ overdue: 1, today: 2, week: 3, upcoming: 2, done: 1 });
  });

  it('suggests the next step from the outcome', () => {
    expect(suggestFollowUp('call', 'No answer')).toEqual({ title: 'Try calling again', type: 'call', when: 'tomorrow' });
    expect(suggestFollowUp('call', 'Wrong number').type).toBe('todo');
    expect(suggestFollowUp('email', null).title).toBe('Follow up on my email');
  });
});
