import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCalendar, TaskQuickAdd } from '@/features/tasks';
import { PickDateDialog } from '@/features/tasks/parts';
import {
  HEAVY_DAY, addMonths, monthWeeks, repLoad, repsOf, timeOf, weekDays, weekLabel, weekStart,
} from '@/features/tasks/calendar';
import { addDays, formatDay, today } from '@/features/tasks/dates';
import { LEAD_ID, MANAGER, PRIYA, REP, dueIn, renderWith, signOut, stubFetch, task, type Call } from './harness';

/** GET /api/tasks answered from `all` by status and scope (the calendar reads due=all and filters days itself). */
function tasksRoute(all: ReturnType<typeof task>[], me = REP.id) {
  return (c: Call) => {
    const status = c.query.get('status') ?? 'open';
    const scope = c.query.get('scope') ?? 'mine';
    const items = all.filter((t) => (status === 'done' ? t.doneAt : !t.doneAt)
      && (scope === 'team' || t.assignee.id === (scope.startsWith('rep:') ? scope.slice(4) : me)));
    return { items, nextCursor: null };
  };
}

/** Midnight in New York on `day`: how a follow-up saved as a plain day is stored (no time). */
const midnightNY = (day: string) => ['04', '05'].map((h) => `${day}T${h}:00:00.000Z`).find((iso) => timeOf(iso) === null)!;
const dayCell = (container: HTMLElement, day: string) => {
  const el = container.querySelector<HTMLElement>(`li[data-day="${day}"]`);
  if (!el) throw new Error(`no cell for ${day}`);
  return el;
};

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

describe('calendar maths', () => {
  it('runs weeks Monday to Sunday and months in whole weeks', () => {
    expect(weekStart('2026-10-19')).toBe('2026-10-19'); // a Monday
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // Sunday belongs to the week before
    expect(weekDays('2026-10-22')).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    const oct = monthWeeks('2026-10-19');
    expect(oct[0]![0]).toBe('2026-09-28');
    expect(oct.at(-1)!.at(-1)).toBe('2026-11-01');
    expect(oct.every((w) => w.length === 7)).toBe(true);
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(weekLabel('2026-10-22')).toBe('Oct 19 – 25, 2026');
    expect(weekLabel('2026-10-29')).toBe('Oct 26 – Nov 1, 2026');
  });

  it('shows a time only when one was set', () => {
    expect(timeOf(midnightNY('2026-10-20'))).toBeNull();
    expect(timeOf('2026-10-20T18:30:00.000Z')).toBe('2:30 PM');
  });

  it('colours reps in name order and counts each one’s day, busiest first', () => {
    const reps = repsOf([{ id: REP.id, name: REP.name }], [task({ assignee: PRIYA })]);
    expect(reps.map((r) => r.name)).toEqual(['Jordan Lee', 'Priya Shah']);
    expect(reps[0]!.color).not.toEqual(reps[1]!.color);
    const load = repLoad([task(), task({ assignee: PRIYA }), task({ assignee: PRIYA })], reps);
    expect(load.map((l) => [l.rep.name, l.count])).toEqual([['Priya Shah', 2], ['Jordan Lee', 1]]);
  });
});

describe('TaskCalendar', () => {
  it('shows this week Monday to Sunday with today highlighted, and chips that open the lead', async () => {
    const t0 = today();
    const items = [
      task({ companyName: 'Bergen Roofing', type: 'call', dueAt: `${t0}T18:30:00.000Z` }),
      task({ companyName: 'Garden State Roofing', type: 'visit', dueAt: midnightNY(t0) }),
      task({ companyName: 'Done Roofing', type: 'email', dueAt: midnightNY(t0), doneAt: new Date().toISOString() }),
    ];
    const overdueDay = addDays(t0, -1);
    if (weekStart(overdueDay) === weekStart(t0)) items.push(task({ companyName: 'Late Roofing', dueAt: dueIn(-1) }));
    stubFetch({ 'GET /api/tasks': tasksRoute(items) });
    const { container } = renderWith(<TaskCalendar scope="mine" />);

    const cal = screen.getByRole('region', { name: 'Follow-up calendar' });
    expect(within(cal).getByRole('heading', { name: weekLabel(t0) })).toBeInTheDocument();
    const days = [...container.querySelectorAll('li[data-day]')].map((el) => el.getAttribute('data-day'));
    expect(days).toEqual(weekDays(t0));

    const todayCell = dayCell(container, t0);
    expect(todayCell).toHaveAttribute('aria-label', expect.stringContaining('(today)'));
    const timed = await within(todayCell).findByRole('link', { name: /^Call: Bergen Roofing, at 2:30 PM/ });
    expect(timed).toHaveAttribute('href', `/leads/${LEAD_ID}`);
    expect(timed).toHaveTextContent('2:30 PM');
    // A plain day has no time; a done one is struck through.
    expect(within(todayCell).getByRole('link', { name: /^Visit: Garden State Roofing, Follow-up/ })).not.toHaveTextContent('PM');
    expect(within(todayCell).getByRole('link', { name: /Done Roofing.*done$/ })).toHaveClass('line-through');
    if (weekStart(overdueDay) === weekStart(t0)) {
      expect(within(dayCell(container, overdueDay)).getByRole('link', { name: /Late Roofing.*overdue$/ })).toHaveClass('text-roof');
    }
  });

  it('moves by week, jumps back to today, switches to a month and folds busy days into "+N more"', async () => {
    const user = userEvent.setup();
    const t0 = today();
    const nextWeek = addDays(t0, 7);
    const crowded = Array.from({ length: 8 }, (_, i) => task({ companyName: `Crowded ${i}`, dueAt: `${nextWeek}T1${i}:00:00.000Z` }));
    stubFetch({ 'GET /api/tasks': tasksRoute(crowded) });
    const { container } = renderWith(<TaskCalendar scope="mine" />);
    const cal = screen.getByRole('region', { name: 'Follow-up calendar' });

    await user.click(within(cal).getByRole('button', { name: 'Next week' }));
    expect(within(cal).getByRole('heading', { name: weekLabel(nextWeek) })).toBeInTheDocument();
    const cell = dayCell(container, nextWeek);
    expect(await within(cell).findAllByRole('link')).toHaveLength(6);
    await user.click(within(cell).getByRole('button', { name: '+2 more' }));
    expect(within(cell).getAllByRole('link')).toHaveLength(8);

    await user.click(within(cal).getByRole('button', { name: 'Previous week' }));
    await user.click(within(cal).getByRole('button', { name: 'Previous week' }));
    expect(within(cal).getByRole('heading', { name: weekLabel(addDays(t0, -7)) })).toBeInTheDocument();
    await user.click(within(cal).getByRole('button', { name: 'Today' }));
    expect(within(cal).getByRole('heading', { name: weekLabel(t0) })).toBeInTheDocument();

    await user.click(within(cal).getByRole('radio', { name: 'Month' }));
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${t0}T12:00:00Z`));
    expect(within(cal).getByRole('heading', { name: monthName })).toBeInTheDocument();
    expect(container.querySelectorAll('li[data-day]').length % 7).toBe(0);
    await user.click(within(cal).getByRole('button', { name: 'Next month' }));
    expect(within(cal).getByRole('heading', { name: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${addMonths(t0, 1)}T12:00:00Z`)) })).toBeInTheDocument();
    await user.click(within(cal).getByRole('button', { name: 'Previous month' }));

    // The crowded day shows three chips and "+5 more", which opens its week with every chip.
    const monthCell = dayCell(container, nextWeek);
    await user.click(within(monthCell).getByRole('button', { name: '+5 more' }));
    expect(within(cal).getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dayCell(container, nextWeek)).getAllByRole('link')).toHaveLength(8);
  });

  it('manager: colour-codes each rep with a legend, counts each rep’s day and filters to one rep', async () => {
    const user = userEvent.setup();
    const t0 = today();
    const items = [
      task({ companyName: 'Jordan One', dueAt: dueIn(0) }),
      task({ companyName: 'Jordan Two', dueAt: dueIn(0) }),
      task({ companyName: 'Priya One', dueAt: dueIn(0), assignee: PRIYA }),
    ];
    const calls = stubFetch({ 'GET /api/tasks': tasksRoute(items, MANAGER.id) });
    const { container } = renderWith(<TaskCalendar scope="team" reps={[{ id: REP.id, name: REP.name }, PRIYA]} />, { user: MANAGER });
    const cal = screen.getByRole('region', { name: 'Follow-up calendar' });
    const cell = dayCell(container, t0);
    expect(await within(cell).findAllByRole('link')).toHaveLength(3);
    expect(calls.filter((c) => c.path === '/api/tasks').every((c) => c.query.get('scope') === 'team')).toBe(true);

    const legend = within(cal).getByRole('list', { name: 'Rep colours' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Jordan Lee', 'Priya Shah']);
    expect(within(cell).getByTestId('rep-load')).toHaveTextContent('Jordan 2 · Priya 1');
    expect(within(cell).getByRole('link', { name: /Priya One.*for Priya Shah/ }).className).toMatch(/border-l-stage-/);

    await user.selectOptions(within(cal).getByRole('combobox', { name: 'Show follow-ups for' }), PRIYA.id);
    await waitFor(() => expect(within(cell).getAllByRole('link')).toHaveLength(1));
    expect(within(cell).getByRole('link')).toHaveAccessibleName(/Priya One/);
    expect(within(cell).queryByTestId('rep-load')).not.toBeInTheDocument();
  });
});

describe('busy-aware follow-up picker', () => {
  const pickDay = (offset: number) => addDays(today(), offset);

  it('shows each day’s load, stronger from four, and what is already on the chosen day', async () => {
    const user = userEvent.setup();
    const busy = pickDay(2);
    const heavy = pickDay(3);
    const items = [
      task({ companyName: 'Bergen Roofing', dueAt: dueIn(2) }),
      task({ companyName: 'Clifton Roofing', type: 'visit', dueAt: dueIn(2) }),
      ...Array.from({ length: HEAVY_DAY }, (_, i) => task({ companyName: `Heavy ${i}`, dueAt: dueIn(3) })),
    ];
    stubFetch({ 'GET /api/tasks': tasksRoute(items), [`GET /api/leads/${LEAD_ID}`]: { id: LEAD_ID, version: 1, contacts: [], fields: {} } });
    const { container } = renderWith(<TaskQuickAdd leadId={LEAD_ID} leadName="Jersey Roofing LLC" />);

    // A preset day already lists what's on it.
    await user.click(screen.getByRole('radio', { name: /In 3 days/ }));
    expect(await screen.findByTestId('busy-line')).toHaveTextContent(`Busy day. Already on ${formatDay(heavy)}: Call · Heavy 0`);

    await user.click(screen.getByRole('radio', { name: 'Pick a date' }));
    expect(screen.getByLabelText('Follow-up date')).toHaveAttribute('type', 'date'); // the native fallback stays
    const grid = screen.getByRole('grid');
    // The grid shows the month of the date in the box; make sure the busy days' month is in view.
    if (!container.querySelector(`button[data-day="${busy}"]`)) await user.click(screen.getByRole('button', { name: 'Next month' }));
    const busyBtn = container.querySelector<HTMLButtonElement>(`button[data-day="${busy}"]`)!;
    await waitFor(() => expect(busyBtn).toHaveAttribute('data-load', '2'));
    expect(busyBtn).toHaveAccessibleName(/2 follow-ups already$/);
    expect(within(busyBtn).getByTestId('day-load')).toHaveTextContent('2');
    expect(within(busyBtn).getByTestId('day-load')).not.toHaveClass('font-bold');
    const heavyBtn = container.querySelector<HTMLButtonElement>(`button[data-day="${heavy}"]`);
    if (heavyBtn) {
      expect(heavyBtn).toHaveAccessibleName(/4 follow-ups already, a busy day$/);
      expect(within(heavyBtn).getByTestId('day-load')).toHaveClass('font-bold', 'text-roof');
    }
    expect(grid).toBeInTheDocument();

    await user.click(busyBtn);
    expect(screen.getByLabelText('Follow-up date')).toHaveValue(busy);
    expect(screen.getByTestId('busy-line')).toHaveTextContent(`Already on ${formatDay(busy)}: Call · Bergen Roofing, Visit · Clifton Roofing`);
  });

  it('is keyboard-driven: arrows move a day or a week, Enter picks, past days stay unpickable', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    stubFetch({ 'GET /api/tasks': { items: [], nextCursor: null } });
    renderWith(<PickDateDialog open title="Reschedule follow-up" onClose={() => {}} onPick={onPick} />);
    const dialog = await screen.findByRole('dialog', { name: 'Reschedule follow-up' });
    const tomorrow = pickDay(1);
    const selected = within(dialog).getByRole('button', { name: new RegExp(`^${new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${tomorrow}T12:00:00Z`))}`) });
    expect(selected).toHaveAttribute('tabindex', '0');
    selected.focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-day', pickDay(2));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveAttribute('data-day', pickDay(9));
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(document.activeElement).toHaveAttribute('data-day', pickDay(1));
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(within(dialog).getByLabelText('New due date')).toHaveValue(pickDay(3));
    expect(within(dialog).getByText(`Nothing else on ${formatDay(pickDay(3))} yet.`)).toBeInTheDocument();

    // Yesterday can be reached but not picked.
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{Enter}');
    expect(document.activeElement).toHaveAttribute('data-day', pickDay(-1));
    expect(document.activeElement).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByLabelText('New due date')).toHaveValue(pickDay(3));

    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(onPick).toHaveBeenCalledWith(pickDay(3));
  });
});
