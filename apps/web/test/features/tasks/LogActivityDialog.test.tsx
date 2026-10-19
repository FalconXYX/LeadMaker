import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogActivityDialog } from '@/features/tasks';
import { presetDay } from '@/features/tasks/dates';
import { LEAD_ID, json, renderWith, signOut, stubFetch, task } from './harness';

const logged = (over: Record<string, unknown> = {}) => ({
  activity: { id: 'a1', companyId: LEAD_ID, type: 'call', outcome: null, note: null, userId: 'u', userName: 'Jordan Lee', createdAt: new Date().toISOString() },
  state: {}, team: {}, salesStage: 'contacted', stageChangedAt: null, lastContactedAt: new Date().toISOString(), version: 8, ...over,
});

function setup(routes: Record<string, unknown> = {}, props: Partial<Parameters<typeof LogActivityDialog>[0]> = {}) {
  const onDone = vi.fn();
  const onOpenChange = vi.fn();
  const calls = stubFetch({
    'GET /api/me': {},
    [`GET /api/leads/${LEAD_ID}`]: { id: LEAD_ID, salesStage: 'new', version: 7, contacts: [], fields: {}, tasks: [] },
    [`POST /api/leads/${LEAD_ID}/activities`]: logged(),
    [`PUT /api/leads/${LEAD_ID}/stage`]: { stage: 'interested', version: 9, stageChangedAt: new Date().toISOString() },
    [`POST /api/leads/${LEAD_ID}/tasks`]: (c: { body: Record<string, unknown> }) => json({ task: task({ title: String(c.body.title) }) }, 201),
    'PATCH /api/tasks/*': (c: { body: Record<string, unknown> }) => ({ task: task({ doneAt: new Date().toISOString(), version: Number(c.body.version) + 1 }) }),
    ...routes,
  });
  renderWith(
    <LogActivityDialog leadId={LEAD_ID} leadName="Jersey Roofing LLC" defaultType="call" open onOpenChange={onOpenChange} onDone={onDone} {...props} />,
  );
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { calls, writes, onDone, onOpenChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

describe('LogActivityDialog', () => {
  it('posts the activity, then the stage, then the follow-up, and closes with a toast', async () => {
    const user = userEvent.setup();
    const { writes, onDone, onOpenChange } = setup();
    const dialog = await screen.findByRole('dialog', { name: 'Log a call' });
    // The first outcome chip has focus, so the rep can pick with the keyboard straight away.
    expect(within(dialog).getByRole('radio', { name: 'Connected' })).toHaveFocus();
    await user.click(within(dialog).getByRole('radio', { name: 'Left voicemail' }));
    expect(within(dialog).getByRole('textbox', { name: 'Follow-up title' })).toHaveValue('Call back (left a voicemail)');
    expect(within(dialog).getByRole('radio', { name: /In 3 days/ })).toHaveAttribute('aria-checked', 'true');
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'Spoke to the office manager');
    await user.click(within(dialog).getByRole('radio', { name: 'Interested' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save call' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /api/leads/${LEAD_ID}/activities`,
      `PUT /api/leads/${LEAD_ID}/stage`,
      `POST /api/leads/${LEAD_ID}/tasks`,
    ]);
    expect(writes()[0]!.body).toEqual({ type: 'call', outcome: 'Left voicemail', note: 'Spoke to the office manager' });
    // The stage write uses the version the activity returned (it moved when the lead went new -> contacted).
    expect(writes()[1]!.body).toEqual({ stage: 'interested', version: 8 });
    expect(writes()[2]!.body).toEqual({ title: 'Call back (left a voicemail)', type: 'call', dueAt: presetDay('in3') });
    expect(await screen.findByText('Call logged with Jersey Roofing LLC')).toBeInTheDocument();
  });

  it('keeps what saved after a partial failure and retries only the rest', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { writes, onDone } = setup({
      [`POST /api/leads/${LEAD_ID}/tasks`]: () => (fail ? json({ error: 'boom' }, 500) : json({ task: task() }, 201)),
    });
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'No answer' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save call' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Call logged, but the follow-up wasn’t scheduled');
    expect(within(dialog).getByText(/Call logged\./)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const paths = writes().map((c) => c.path);
    expect(paths.filter((p) => p.endsWith('/activities'))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith('/tasks'))).toHaveLength(2);
  });

  it('marks the follow-up it was opened from done, and skips scheduling when switched off', async () => {
    const user = userEvent.setup();
    const t = task({ title: 'Call Mike about the TPO quote', version: 3 });
    const { writes } = setup({}, { task: t });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'Mark “Call Mike about the TPO quote” done' })).toBeChecked();
    await user.click(within(dialog).getByRole('switch', { name: /Schedule next follow-up/ }));
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ method: 'PATCH', path: `/api/tasks/${t.id}`, body: { done: true, version: 3 } });
  });

  it('does not save a follow-up without a valid date', async () => {
    const user = userEvent.setup();
    const { writes } = setup();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Pick a date' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save call' }));
    expect(await within(dialog).findByText('Pick a date.')).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });
});
