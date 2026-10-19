import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskList, TaskQuickAdd, TasksPage } from '@/features/tasks';
import { presetDay } from '@/features/tasks/dates';
import { LEAD_ID, MANAGER, PRIYA, REP, dueIn, json, renderWith, signOut, stubFetch, task, type Call } from './harness';

const profile = {
  id: LEAD_ID, salesStage: 'contacted', version: 4, tasks: [],
  fields: { phone: { value: '2019822718' } },
  contacts: [{ id: 'c1', name: { value: 'Mike Russo' }, phone: { value: '2015550111' }, doNotContact: { value: false }, isTarget: true }],
  targetContact: { contactId: 'c1' },
  allocation: { current: { rep: { id: REP.id, name: REP.name } }, history: [] },
};

/** GET /api/tasks answered from `all` with the server's filters (scope, due, status). */
function tasksRoute(all: ReturnType<typeof task>[], me = REP.id) {
  return (c: Call) => {
    const status = c.query.get('status') ?? 'open';
    const due = c.query.get('due') ?? 'all';
    const scope = c.query.get('scope') ?? 'mine';
    const day = (iso: string) => Math.round((Date.parse(iso) - Date.parse(dueIn(0))) / 86_400_000);
    const items = all.filter((t) => (status === 'done' ? t.doneAt : !t.doneAt)
      && (scope === 'team' || t.assignee.id === (scope.startsWith('rep:') ? scope.slice(4) : me))
      && (due === 'all' || (due === 'overdue' ? day(t.dueAt) < 0 : due === 'today' ? day(t.dueAt) === 0
        : due === 'week' ? day(t.dueAt) >= 0 && day(t.dueAt) < 7 : day(t.dueAt) >= 1)));
    const limit = Number(c.query.get('limit') ?? 50);
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? 'more' : null };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

describe('TaskList', () => {
  it('groups by due date, shows the phone to dial, and ticks a task off optimistically with undo', async () => {
    const user = userEvent.setup();
    const items = [
      task({ title: 'Call Mike about the TPO quote', dueAt: dueIn(-2) }),
      task({ title: 'Send price sheet', type: 'email', dueAt: dueIn(0) }),
      task({ title: 'Drop off samples', type: 'visit', dueAt: dueIn(1) }),
    ];
    let release: () => void = () => {};
    const calls = stubFetch({
      'GET /api/tasks': tasksRoute(items),
      [`GET /api/leads/${LEAD_ID}`]: profile,
      'PATCH /api/tasks/*': (c: Call) => new Promise((resolve) => {
        release = () => resolve(json({ task: { ...items[0]!, doneAt: new Date().toISOString(), version: c.body.version + 1 } }));
      }),
    });
    renderWith(<TaskList scope="mine" due="week" />);

    expect(await screen.findByRole('region', { name: 'Today, 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tomorrow, 1' })).toBeInTheDocument();
    expect((await screen.findAllByRole('link', { name: 'Call (201) 555-0111' })).length).toBeGreaterThan(0);

    const box = screen.getByRole('checkbox', { name: 'Mark “Send price sheet” done' });
    await user.click(box);
    // Ticked before the server answers.
    expect(await screen.findByRole('checkbox', { name: 'Mark “Send price sheet” not done' })).toBeChecked();
    release();
    expect(await screen.findByText('Follow-up done')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ done: true, version: 1 });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1]!.body).toEqual({ done: false, version: 2 });
  });

  it('reschedules from the due-date menu', async () => {
    const user = userEvent.setup();
    const items = [task({ title: 'Try calling again', dueAt: dueIn(0), version: 5 })];
    const calls = stubFetch({
      'GET /api/tasks': tasksRoute(items),
      [`GET /api/leads/${LEAD_ID}`]: profile,
      'PATCH /api/tasks/*': (c: Call) => ({ task: { ...items[0]!, dueAt: `${c.body.dueAt}T04:00:00.000Z`, version: 6 } }),
    });
    renderWith(<TaskList scope="mine" due="all" />);
    await user.click(await screen.findByRole('button', { name: 'Due Today. Reschedule' }));
    await user.click(screen.getByRole('menuitem', { name: /Tomorrow/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ dueAt: presetDay('tomorrow'), version: 5 }));
    expect(await screen.findByText('Follow-up moved')).toBeInTheDocument();
  });

  it('compact: a few rows, no phone lookups, and a link to the full list', async () => {
    const items = Array.from({ length: 4 }, (_, i) => task({ title: `Overdue ${i}`, dueAt: dueIn(-1 - i) }));
    const calls = stubFetch({ 'GET /api/tasks': tasksRoute(items) });
    renderWith(<TaskList scope="mine" due="overdue" compact limit={3} />);
    expect(await screen.findByText('Overdue 0')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /See all follow-ups/ })).toHaveAttribute('href', '/tasks?tab=overdue');
    expect(calls.some((c) => c.path.startsWith('/api/leads/'))).toBe(false);
    expect(calls.filter((c) => c.path === '/api/tasks').map((c) => c.query.get('limit'))).toEqual(['3']);
  });
});

describe('TasksPage', () => {
  it('opens on Overdue when anything is, with counts on every tab', async () => {
    const items = [
      task({ dueAt: dueIn(-1), title: 'Late one' }),
      task({ dueAt: dueIn(0) }), task({ dueAt: dueIn(0) }),
      task({ dueAt: dueIn(3) }),
      task({ dueAt: dueIn(-3), doneAt: dueIn(0) }),
    ];
    stubFetch({ 'GET /api/tasks': tasksRoute(items), [`GET /api/leads/${LEAD_ID}`]: profile });
    const { router } = renderWith(<TasksPage />);
    expect(await screen.findByRole('heading', { name: 'My follow-ups' })).toBeInTheDocument();
    expect(await screen.findByText('You have 1 overdue and 2 due today. Start with the overdue ones.')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe('?tab=overdue'));
    const tabs = screen.getByRole('tablist', { name: 'Follow-ups by due date' });
    expect(within(tabs).getByRole('tab', { name: 'Overdue 1' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'Today 2' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'This week 3' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Upcoming 1' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Done 1' })).toBeInTheDocument();
    expect(await screen.findByText('Late one')).toBeInTheDocument();
    // Reps get no scope switch.
    expect(screen.queryByRole('radiogroup', { name: 'Whose follow-ups' })).toBeNull();
  });

  it('shows a helpful empty state', async () => {
    stubFetch({ 'GET /api/tasks': tasksRoute([]) });
    renderWith(<TasksPage />, { route: '/tasks?tab=today' });
    expect(await screen.findByText('Nothing due today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Find leads with no next step/ })).toHaveAttribute(
      'href', '/leads?scope=mine&followUp=none&sort=priority_score%3Adesc',
    );
  });

  it('managers switch between their own, the team’s and one rep’s follow-ups', async () => {
    const user = userEvent.setup();
    const items = [
      task({ dueAt: dueIn(0), title: 'Mine today', assignee: { id: MANAGER.id, name: MANAGER.name } }),
      task({ dueAt: dueIn(0), title: 'Priya today', assignee: PRIYA }),
    ];
    const calls = stubFetch({
      'GET /api/tasks': tasksRoute(items, MANAGER.id),
      'GET /api/users': { items: [{ ...PRIYA, email: 'rep2@demo.local', role: 'rep', allocatedCount: 50 }] },
      [`GET /api/leads/${LEAD_ID}`]: profile,
    });
    const { router } = renderWith(<TasksPage />, { user: MANAGER, route: '/tasks?tab=today' });
    expect(await screen.findByText('Mine today')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Team' }));
    expect(await screen.findByRole('heading', { name: 'Team follow-ups' })).toBeInTheDocument();
    expect(await screen.findByText('Priya today')).toBeInTheDocument();
    expect(router.state.location.search).toContain('scope=team');

    await user.selectOptions(screen.getByRole('combobox', { name: "One rep's follow-ups" }), PRIYA.id);
    expect(await screen.findByRole('heading', { name: 'Priya’s follow-ups' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Mine today')).toBeNull());
    expect(calls.some((c) => c.query.get('scope') === `rep:${PRIYA.id}`)).toBe(true);
  });
});

describe('TaskQuickAdd', () => {
  it('adds a follow-up for a date (date only) and reports done', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const calls = stubFetch({ [`POST /api/leads/${LEAD_ID}/tasks`]: json({ task: task() }, 201) });
    renderWith(<TaskQuickAdd leadId={LEAD_ID} leadName="Jersey Roofing LLC" onDone={onDone} />, { path: '/x', route: '/x' });
    const title = screen.getByRole('textbox', { name: 'Follow-up title' });
    expect(title).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Email' }));
    await user.click(screen.getByRole('radio', { name: /Next week/ }));
    await user.type(title, 'Send the shingle promo{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 'Send the shingle promo', type: 'email', dueAt: presetDay('nextWeek') });
  });

  it('managers assign it to the lead’s rep by default', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users': { items: [{ id: REP.id, name: REP.name, email: REP.email, role: 'rep', allocatedCount: 50 }] },
      [`GET /api/leads/${LEAD_ID}`]: profile,
      [`POST /api/leads/${LEAD_ID}/tasks`]: json({ task: task() }, 201),
    });
    renderWith(<TaskQuickAdd leadId={LEAD_ID} />, { user: MANAGER, path: '/x', route: '/x' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Assign to' })).toHaveValue(REP.id));
    await user.click(screen.getByRole('button', { name: 'Add follow-up' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'Follow-up call', assigneeId: REP.id }));
  });

  it('explains a rep writing to someone else’s lead', async () => {
    const user = userEvent.setup();
    stubFetch({ [`POST /api/leads/${LEAD_ID}/tasks`]: json({ error: 'forbidden' }, 403) });
    renderWith(<TaskQuickAdd leadId={LEAD_ID} />, { path: '/x', route: '/x' });
    await user.click(screen.getByRole('button', { name: 'Add follow-up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can only add follow-ups on your own leads.');
  });
});
