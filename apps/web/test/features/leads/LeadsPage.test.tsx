import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadFilter, LeadSummary } from '@/api/types';
import { LeadsPage } from '@/features/leads';
import { prefsKey } from '@/features/leads/prefs';
import { lead, renderLeads, signIn, stubFetch, users, type FetchLog } from './testUtils';

// The tasks feature's dialog, as a marker: these tests are about what the list hands it.
vi.mock('@/features/tasks', () => ({
  LogActivityDialog: (p: { leadName: string; defaultType?: string; open: boolean }) =>
    (p.open ? <div role="dialog" aria-label="Log activity">{`Log ${p.defaultType} for ${p.leadName}`}</div> : null),
}));

const mineLead = lead({ businessName: 'Mine Roofing Co' });
const poolLead = lead({ businessName: 'Pool Roofing Co', assignedRep: null, canWrite: false });

function stubApi(items: LeadSummary[], extra: Record<string, unknown> = {}): FetchLog[] {
  return stubFetch({
    'GET /api/me': users.rep,
    'POST /api/leads/search': ({ body }: { body: unknown }) => {
      const f = (body as { filter: LeadFilter }).filter;
      // Probes for the last poll date ask for one lead.
      if (f.limit === 1) return { items: [], nextCursor: null, total: 0, totalCapped: false };
      return { items, nextCursor: null, total: items.length, totalCapped: false };
    },
    'GET /api/custom-tags': { items: [] },
    'GET /api/custom-fields/keys': { items: [] },
    'GET /api/signals': { alerts: [], stormHistory: [], news: [], counties: [] },
    ...extra,
  });
}

const searchBodies = (log: FetchLog[]) =>
  log.filter((r) => r.method === 'POST' && r.path === '/api/leads/search').map((r) => (r.body as { filter: LeadFilter }).filter);

afterEach(() => {
  vi.unstubAllGlobals();
  signIn(null);
});

/** Turns on optional columns (e.g. Checked / serviced) for the signed-in user before the list loads. */
const withColumns = (userId: string, extraColumns: string[]) =>
  localStorage.setItem(prefsKey(userId), JSON.stringify({ extraColumns }));

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

describe('LeadsPage', () => {
  it('disables the checked/serviced toggles on read-only leads, with the reason as a tooltip', async () => {
    const log = stubApi([mineLead, poolLead]);
    withColumns(users.rep.id, ['state']);
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />, '/leads?scope=all');

    const poolChecked = await screen.findByRole('button', { name: 'Checked: Pool Roofing Co' });
    expect(poolChecked).toHaveAttribute('aria-disabled', 'true');
    expect(poolChecked).toHaveAccessibleDescription(/Unallocated lead: view only/);
    expect(screen.getByRole('button', { name: 'Serviced: Pool Roofing Co' })).toHaveAttribute('aria-disabled', 'true');

    await user.click(poolChecked);
    expect(log.some((r) => r.path.endsWith('/state'))).toBe(false);
    expect(poolChecked).toHaveAttribute('aria-pressed', 'false');

    const mineChecked = screen.getByRole('button', { name: 'Checked: Mine Roofing Co' });
    expect(mineChecked).not.toHaveAttribute('aria-disabled');
  });

  it('toggles checked optimistically and posts the change', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const log = stubApi([mineLead], {
      // Held until release(), so the pressed state below can only come from the optimistic update.
      [`POST /api/leads/${mineLead.id}/state`]: () => gate.then(() => ({
        state: { checked: true, serviced: false, checkedAt: '2026-10-18T20:00:00Z', servicedAt: null },
        team: { checked: true, serviced: false, checkedAt: '2026-10-18T20:00:00Z', servicedAt: null },
      })),
    });
    withColumns(users.rep.id, ['state']);
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    const btn = await screen.findByRole('button', { name: 'Checked: Mine Roofing Co' });
    await user.click(btn);
    // Pressed before the server answers.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checked: Mine Roofing Co' })).toHaveAttribute('aria-pressed', 'true'));
    expect(log.find((r) => r.path === `/api/leads/${mineLead.id}/state`)?.body).toEqual({ checked: true });
    release();
  });

  it('sends the rep’s default view as scope "mine" and "All" as the default visibility', async () => {
    const log = stubApi([mineLead]);
    signIn(users.rep);
    const user = userEvent.setup();
    const { search } = renderLeads(<LeadsPage />);

    await screen.findByText('Mine Roofing Co');
    expect(searchBodies(log).at(-1)?.scope).toBe('mine');
    expect(screen.getByRole('radio', { name: /My leads/ })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: /All/ }));
    expect(new URLSearchParams(search()).get('scope')).toBe('all');
    await waitFor(() => expect(searchBodies(log).at(-1)).not.toHaveProperty('scope'));

    await user.click(screen.getByRole('radio', { name: /Unallocated/ }));
    await waitFor(() => expect(searchBodies(log).at(-1)?.scope).toBe('unallocated'));
  });

  it('opens a lead with the keyboard (arrow keys + Enter)', async () => {
    const other = lead({ businessName: 'Second Roofing' });
    stubApi([mineLead, other]);
    signIn(users.rep);
    const user = userEvent.setup();
    const { router } = renderLeads(<LeadsPage />);

    await screen.findByText('Second Roofing');
    const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-lead-id'));
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe(`/leads/${other.id}`);
  });

  it('tags the writable selected leads and reports the read-only ones it skipped', async () => {
    const log = stubApi([mineLead, poolLead], {
      'POST /api/custom-tags': { tag: { id: 'tag-1', name: 'Follow up' }, created: true },
      'POST /api/custom-tags/tag-1/leads': {
        tag: { id: 'tag-1', name: 'Follow up' }, attached: [{ companyId: mineLead.id, version: 2 }],
        alreadyTagged: [], skippedReadOnly: [], skippedInvisible: [],
      },
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />, '/leads?scope=all');

    await user.click(await screen.findByRole('checkbox', { name: 'Select Mine Roofing Co' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Pool Roofing Co' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 leads selected')).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /Allocate/ })).toBeNull(); // reps can't allocate

    await user.click(within(bar).getByRole('button', { name: 'Add tag' }));
    await user.type(screen.getByLabelText('Tag'), 'Follow up');
    await user.click(screen.getByRole('button', { name: 'Create & add' }));

    expect(await screen.findByText('Tagged 1 lead “Follow up”')).toBeInTheDocument();
    expect(screen.getByText('1 skipped (read-only)')).toBeInTheDocument();
    expect(log.find((r) => r.path === '/api/custom-tags' && r.method === 'POST')?.body).toEqual({ name: 'Follow up' });
    // One bulk call with the writable leads only.
    expect(log.filter((r) => r.path === '/api/custom-tags/tag-1/leads').map((r) => r.body)).toEqual([{ companyIds: [mineLead.id] }]);
  });

  it('selects a range with Shift-click and clears the selection with Esc', async () => {
    const a = lead({ businessName: 'Alpha Roofing' });
    const b = lead({ businessName: 'Bravo Roofing' });
    const c = lead({ businessName: 'Charlie Roofing' });
    stubApi([a, b, c]);
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Roofing' }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox', { name: 'Select Charlie Roofing' }));
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('checkbox', { name: 'Select Bravo Roofing' })).toBeChecked();
    expect(within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('3 leads selected')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('lets managers hand the selection to the allocation view', async () => {
    stubApi([mineLead, poolLead], { 'GET /api/me': users.manager, 'GET /api/users': { items: [] } });
    signIn(users.manager);
    const user = userEvent.setup();
    const { router } = renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('checkbox', { name: 'Select Pool Roofing Co' }));
    await user.click(screen.getByRole('button', { name: 'Allocate selected…' }));
    expect(router.state.location.pathname).toBe('/allocation');
    expect(router.state.location.state).toEqual({ companyIds: [poolLead.id] });
  });

  it('shows an empty state with a clear-filters action', async () => {
    stubApi([]);
    signIn(users.rep);
    const user = userEvent.setup();
    const { search } = renderLeads(<LeadsPage />, '/leads?segment=growth');

    expect(await screen.findByText('No leads match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search()).toBe('');
  });

  it('folds tags, owner and last contacted into other cells when the table is narrow', async () => {
    const width = 720;
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
        this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    stubApi([lead({ businessName: 'Narrow Roofing', lastContactedAt: day(-3) })], { 'GET /api/me': users.manager, 'GET /api/users': { items: [] } });
    signIn(users.manager);
    renderLeads(<LeadsPage />);
    const table = await screen.findByRole('table');
    await within(table).findByText('Narrow Roofing');
    expect(within(table).queryByRole('columnheader', { name: /Tags/ })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /Owner/ })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /Last contacted/ })).toBeNull();
    expect(within(table).getByText('Storm / emergency repair')).toBeInTheDocument();
    expect(within(table).getByText('Jordan Lee')).toBeInTheDocument();
    expect(within(table).getByText('3 days ago')).toBeInTheDocument();
  });

  it('shows the columns in sales order, the owner only in All', async () => {
    stubApi([lead({
      businessName: 'Sales Roofing', salesStage: 'quoting', lastContactedAt: day(-3),
      nextTask: { id: 't1', title: 'Send the TPO quote', type: 'email', dueAt: day(-2) },
      tags: [{ key: 'decision_maker', label: 'DM: Jane Roe (Owner)', value: 'identified', category: 'contactability' }],
    })]);
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);
    const table = await screen.findByRole('table');
    await within(table).findByText('Sales Roofing');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter(Boolean);
    // (Hint tooltips add their text after the label.)
    expect(headers).toEqual(['Company', 'Stage', 'Next follow-up', 'Last contacted', 'Priority', 'Why', 'Tags'].map((h) => expect.stringMatching(new RegExp(`^${h}`))));
    expect(within(table).getByText('Overdue 2d')).toHaveClass('text-roof', { exact: false });
    expect(within(table).getByText('Send the TPO quote')).toBeInTheDocument();
    expect(within(table).getByText('3 days ago')).toBeInTheDocument();
    expect(within(table).getByText('Jane Roe')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: /^Stage: Quoting/ })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /All/ }));
    await waitFor(() => expect(within(screen.getByRole('table')).getByRole('columnheader', { name: 'Owner' })).toBeInTheDocument());
  });

  it('changes the stage inline, optimistically, with the row’s version', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const log = stubApi([mineLead], {
      [`PUT /api/leads/${mineLead.id}/stage`]: () => gate.then(() => ({ stage: 'interested', version: 2, stageChangedAt: '2026-10-18T20:00:00Z' })),
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('button', { name: 'Stage: New. Change stage for Mine Roofing Co' }));
    const menu = screen.getByRole('menu', { name: 'Stage for Mine Roofing Co' });
    expect(within(menu).getByRole('menuitemradio', { name: /^New/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: /^Interested/ }));

    expect(await screen.findByRole('button', { name: /^Stage: Interested/ })).toBeInTheDocument();
    expect(log.find((r) => r.method === 'PUT')).toMatchObject({ path: `/api/leads/${mineLead.id}/stage`, body: { stage: 'interested', version: 1 } });
    release();
  });

  it('puts the stage back and says so when someone else changed the lead (409)', async () => {
    stubApi([mineLead], {
      [`PUT /api/leads/${mineLead.id}/stage`]: () => new Response(JSON.stringify({ error: 'version_conflict', current: { version: 3, stage: 'won' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('button', { name: /^Stage: New/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^Quoting/ }));
    expect(await screen.findByText('Mine Roofing Co was just updated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stage: New/ })).toBeInTheDocument();
  });

  it('offers call, log call, follow-up and stage on a row; read-only leads say why', async () => {
    const callable = lead({ businessName: 'Phone Roofing', phone: '(201) 555-0101' });
    const log = stubApi([callable, poolLead], {
      [`POST /api/leads/${callable.id}/tasks`]: ({ body }: { body: unknown }) => ({ task: { id: 'task-1', ...(body as object) } }),
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />, '/leads?scope=all');

    const actions = await screen.findByRole('group', { name: 'Quick actions for Phone Roofing' });
    expect(within(actions).getByRole('link', { name: 'Call Phone Roofing' })).toHaveAttribute('href', 'tel:2015550101');

    await user.click(within(actions).getByRole('button', { name: 'Log call: Phone Roofing' }));
    expect(screen.getByRole('dialog', { name: 'Log activity' })).toHaveTextContent('Log call for Phone Roofing');

    await user.click(within(actions).getByRole('button', { name: 'Add follow-up: Phone Roofing' }));
    const dialog = screen.getByRole('dialog', { name: 'Add follow-up' });
    await user.type(within(dialog).getByLabelText('What'), 'Send the shingle price sheet');
    await user.click(within(dialog).getByRole('radio', { name: 'Email' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    expect(await screen.findByText('Follow-up added for Phone Roofing')).toBeInTheDocument();
    const posted = log.find((r) => r.path === `/api/leads/${callable.id}/tasks`)?.body as Record<string, unknown>;
    expect(posted).toMatchObject({ title: 'Send the shingle price sheet', type: 'email' });
    expect(new Date(posted.dueAt as string).getHours()).toBe(9);

    const pool = screen.getByRole('group', { name: 'Quick actions for Pool Roofing Co' });
    const logPool = within(pool).getByRole('button', { name: 'Log call: Pool Roofing Co' });
    expect(logPool).toHaveAttribute('aria-disabled', 'true');
    expect(logPool).toHaveAccessibleDescription(/Unallocated lead: view only/);
    expect(within(pool).getByRole('button', { name: 'Call: Pool Roofing Co' })).toHaveAccessibleDescription('No phone number on file');
    expect(screen.queryByRole('button', { name: /^Stage: New. Change stage for Pool/ })).toBeNull();
  });

  it('moves the writable selection to a stage in bulk and reports what it skipped', async () => {
    const second = lead({ businessName: 'Second Roofing', version: 4 });
    const log = stubApi([mineLead, second, poolLead], {
      [`PUT /api/leads/${mineLead.id}/stage`]: { stage: 'won', version: 2, stageChangedAt: '2026-10-18T20:00:00Z' },
      [`PUT /api/leads/${second.id}/stage`]: () => new Response(JSON.stringify({ error: 'version_conflict' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />, '/leads?scope=all');

    for (const name of ['Mine Roofing Co', 'Second Roofing', 'Pool Roofing Co']) {
      await user.click(await screen.findByRole('checkbox', { name: `Select ${name}` }));
    }
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    await user.click(within(bar).getByRole('button', { name: /Change stage/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^Won/ }));

    expect(await screen.findByText('Moved to Won: 1 lead')).toBeInTheDocument();
    expect(screen.getByText('1 skipped (read-only) · 1 changed by someone else meanwhile')).toBeInTheDocument();
    expect(log.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body]).sort()).toEqual([
      [`/api/leads/${mineLead.id}/stage`, { stage: 'won', version: 1 }],
      [`/api/leads/${second.id}/stage`, { stage: 'won', version: 4 }],
    ].sort());
  });

  it('adds one follow-up per writable lead in bulk; managers give each to the lead’s rep', async () => {
    const theirs = lead({ businessName: 'Their Roofing', assignedRep: { id: 'f0000000-0000-4000-8000-000000000001', name: 'Sam Rivera' } });
    const unallocated = lead({ businessName: 'Pool Two', assignedRep: null });
    const log = stubApi([theirs, unallocated], { 'GET /api/me': users.manager, 'GET /api/users': { items: [] } });
    signIn(users.manager);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('checkbox', { name: 'Select Their Roofing' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Pool Two' }));
    await user.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: /Add follow-up/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Add follow-up' })).getByRole('button', { name: 'Add follow-ups' }));

    expect(await screen.findByText('Added a follow-up to 2 leads')).toBeInTheDocument();
    const bodies = Object.fromEntries(log.filter((r) => r.path.endsWith('/tasks')).map((r) => [r.path, r.body]));
    expect(bodies[`/api/leads/${theirs.id}/tasks`]).toMatchObject({ title: 'Call follow-up', type: 'call', assigneeId: 'f0000000-0000-4000-8000-000000000001' });
    expect(bodies[`/api/leads/${unallocated.id}/tasks`]).not.toHaveProperty('assigneeId');
  });

  it('applies the quick views, sales first and storm last, and sorts by the sales columns', async () => {
    const log = stubApi([mineLead]);
    signIn(users.rep);
    const user = userEvent.setup();
    const { search } = renderLeads(<LeadsPage />);
    await screen.findByText('Mine Roofing Co');

    const views = screen.getByRole('group', { name: 'Quick views' });
    expect(within(views).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Follow-ups due', 'Never contacted', 'Interested & quoting', 'Win-back', 'New in last poll', 'Storm-ready',
    ]);
    await user.click(within(views).getByRole('button', { name: 'Interested & quoting' }));
    let p = new URLSearchParams(search());
    expect(p.getAll('stage')).toEqual(['interested', 'quoting']);
    expect(p.get('sort')).toBe('next_follow_up:asc');
    await waitFor(() => expect(searchBodies(log).at(-1)).toMatchObject({ stages: ['interested', 'quoting'], sort: { by: 'next_follow_up', dir: 'asc' } }));
    expect(within(views).getByRole('button', { name: 'Interested & quoting' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(views).getByRole('button', { name: 'Follow-ups due' }));
    expect(new URLSearchParams(search()).get('followUp')).toBe('today');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Follow-ups due' })).getByRole('radio', { name: 'Overdue' }));
    expect(new URLSearchParams(search()).get('followUp')).toBe('overdue');
    expect(within(views).getByRole('button', { name: 'Follow-ups due' })).toHaveAttribute('aria-pressed', 'true');

    // Pressing the active view again goes back to the plain list.
    await user.click(within(views).getByRole('button', { name: 'Follow-ups due' }));
    expect(search()).toBe('');

    await user.click(screen.getByRole('button', { name: /Last contacted/ }));
    p = new URLSearchParams(search());
    expect(p.get('sort')).toBe('last_contacted:asc');
  });
});
