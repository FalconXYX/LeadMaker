import { describe, expect, it } from 'vitest';
import { makeProfile, task } from './fixtures';
import {
  dayWord, doneTasks, dueState, dueText, markDone, nextTask, onDay, openTasks, rescheduleDate, salesOf, stageLabel, toDayInput,
} from '@/features/profile/sales';

// Sunday, Oct 18 2026, noon local time.
const NOW = new Date(2026, 9, 18, 12, 0).getTime();
const local = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).toISOString();

describe('due dates', () => {
  it('names days relative to today', () => {
    expect(dayWord(local(18, 9), NOW)).toBe('Today');
    expect(dayWord(local(19), NOW)).toBe('Tomorrow');
    expect(dayWord(local(17, 23), NOW)).toBe('Yesterday');
    expect(dayWord(local(22), NOW)).toBe('Thu');
    expect(dayWord(local(13), NOW)).toBe('Tue');
    expect(dayWord(local(30), NOW)).toBe('Oct 30');
    expect(dayWord(new Date(2027, 0, 4).toISOString(), NOW)).toBe('Jan 4, 2027');
  });

  it('is overdue from the day after it was due, in calendar days', () => {
    expect(dueState({ dueAt: local(18, 9), doneAt: null }, NOW)).toBe('today');
    expect(dueState({ dueAt: local(17, 23), doneAt: null }, NOW)).toBe('overdue');
    expect(dueState({ dueAt: local(20), doneAt: null }, NOW)).toBe('soon');
    expect(dueState({ dueAt: local(30), doneAt: null }, NOW)).toBe('later');
    expect(dueState({ dueAt: local(1), doneAt: local(2) }, NOW)).toBe('done');
  });

  it('shows the clock time today and tomorrow only, and says how late an overdue one is', () => {
    expect(dueText({ dueAt: local(18, 15), doneAt: null }, NOW)).toBe('Today 3:00 PM');
    expect(dueText({ dueAt: local(19), doneAt: null }, NOW)).toBe('Tomorrow');
    expect(dueText({ dueAt: local(22, 9), doneAt: null }, NOW)).toBe('Thu');
    expect(dueText({ dueAt: local(17, 9), doneAt: null }, NOW)).toBe('Overdue · due yesterday');
    expect(dueText({ dueAt: local(13, 9), doneAt: null }, NOW)).toBe('Overdue · due Tue');
  });

  it('reschedules to presets and picked days, keeping the time of day', () => {
    const due = local(16, 14, 30);
    const at = (iso: string) => [new Date(iso).getDate(), new Date(iso).getHours(), new Date(iso).getMinutes()];
    expect(at(rescheduleDate('tomorrow', due, NOW))).toEqual([19, 14, 30]);
    expect(at(rescheduleDate('in3', due, NOW))).toEqual([21, 14, 30]);
    expect(at(rescheduleDate('nextMonday', due, NOW))).toEqual([19, 14, 30]);
    expect(at(rescheduleDate('nextMonday', due, new Date(2026, 9, 19, 8).getTime()))).toEqual([26, 14, 30]);
    expect(at(rescheduleDate('in2weeks', due, NOW))).toEqual([1, 14, 30]);
    expect(at(onDay('2026-10-23', due)!)).toEqual([23, 14, 30]);
    expect(onDay('', due)).toBeNull();
    expect(toDayInput(local(5, 9))).toBe('2026-10-05');
  });
});

describe('tasks', () => {
  const a = task({ id: 'a', dueAt: local(20) });
  const b = task({ id: 'b', dueAt: local(15) });
  const c = task({ id: 'c', dueAt: local(10), doneAt: local(12) });
  const d = task({ id: 'd', dueAt: local(11), doneAt: local(16) });

  it('orders open ones by due date and done ones by completion, newest first', () => {
    expect(openTasks([a, b, c, d]).map((t) => t.id)).toEqual(['b', 'a']);
    expect(doneTasks([a, b, c, d]).map((t) => t.id)).toEqual(['d', 'c']);
    expect(nextTask([a, b, c])?.id).toBe('b');
    expect(nextTask([c])).toBeNull();
  });

  it('marks one done or open again', () => {
    expect(markDone([a, b], 'a', true, 'T').map((t) => t.doneAt)).toEqual(['T', null]);
    expect(markDone([c], 'c', false)[0]!.doneAt).toBeNull();
  });
});

describe('salesOf', () => {
  it('defaults the sales fields for a service that does not send them yet', () => {
    const old = makeProfile() as Partial<ReturnType<typeof makeProfile>>;
    delete old.salesStage;
    delete old.tasks;
    expect(salesOf(old as ReturnType<typeof makeProfile>)).toEqual({ salesStage: 'new', stageChangedAt: null, lastContactedAt: null, tasks: [] });
    expect(salesOf(makeProfile({ salesStage: 'quoting' })).salesStage).toBe('quoting');
    expect(stageLabel('lost')).toBe('Not a fit');
  });
});
