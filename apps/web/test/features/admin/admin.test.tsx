import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '@/auth/session';
import { RequireManager } from '@/auth/guards';
import { AdminPage, liveRuns } from '@/features/admin/AdminPage';
import { FAST_POLL_MS, SLOW_POLL_MS, adminKeys } from '@/features/admin/api';
import { changedFields, formFrom, formatDuration, parseZips, scheduleLabel, toInput, validateArea } from '@/features/admin/lib';
import type { Run, Territory } from '@/features/admin/types';
import { json, manager, mockApi, renderRoute, type Call } from '../allocation/testkit';

const rep = { id: 'r1', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const };

const SOHO: Territory = {
  id: 't1', name: 'Manhattan', zip: '10013', radiusMiles: 25, alsoZips: ['07030', '11201'], everyHours: 24, enabled: true,
  lastRun: { jobId: 'j1', status: 'succeeded', finishedAt: '2026-10-19T08:00:00Z' }, nextRunAt: '2099-01-01T08:00:00Z',
};
const JERSEY: Territory = {
  id: 't2', name: '', zip: '07601', radiusMiles: 10, alsoZips: [], everyHours: null, enabled: false, lastRun: null, nextRunAt: null,
};

const RUN_OK: Run = {
  jobId: 'j1', kind: 'pipeline', territory: { zip: '10013', radiusMiles: 25 }, status: 'succeeded', requestedBy: null,
  createdAt: '2026-10-19T07:58:00Z', startedAt: '2026-10-19T07:58:05Z', finishedAt: '2026-10-19T08:00:00Z', durationMs: 115_000,
  stats: { found: 212, new: 14, updated: 37 }, error: null,
};
const RUN_FAILED: Run = {
  jobId: 'j0', kind: 'pipeline', territory: { zip: '07601', radiusMiles: 10 }, status: 'failed', requestedBy: { name: 'Alex Morgan' },
  createdAt: '2026-10-18T07:58:00Z', startedAt: '2026-10-18T07:58:05Z', finishedAt: '2026-10-18T07:59:00Z', durationMs: 55_000,
  stats: null, error: 'Directory search timed out after 3 retries',
};

/** A small in-memory admin API: writes change what the next GET returns, like the real one. */
function api(over: Record<string, (c: Call) => unknown> = {}, data: { territories?: Territory[]; runs?: Run[]; refusePatch?: () => boolean } = {}) {
  let list = [...(data.territories ?? [SOHO, JERSEY])];
  const idOf = (c: Call) => c.path.split('/')[4]!;
  return mockApi({
    'GET /api/me': () => manager,
    'GET /api/admin/territories': () => list,
    'GET /api/admin/runs': () => data.runs ?? [RUN_OK, RUN_FAILED],
    'POST /api/admin/territories': (c) => {
      const b = c.body as Partial<Territory>;
      const t: Territory = { ...JERSEY, name: '', alsoZips: [], ...b, id: `t${list.length + 1}` } as Territory;
      list = [...list, t];
      return json(201, t);
    },
    'PATCH /api/admin/territories/*': (c) => {
      if (data.refusePatch?.()) return json(400, { error: 'invalid_request', message: 'ZIP not found' });
      const id = idOf(c);
      list = list.map((t) => (t.id === id ? { ...t, ...(c.body as object) } : t));
      return list.find((t) => t.id === id);
    },
    'DELETE /api/admin/territories/*': (c) => {
      list = list.filter((t) => t.id !== idOf(c));
      return new Response(null, { status: 204 });
    },
    ...over,
  });
}

const renderPage = (user = manager) => renderRoute(
  <RequireManager title="Admin is for managers" description="Your manager sets where LeadMaker finds leads."><AdminPage /></RequireManager>,
  { user, path: '/admin' },
);

const areas = () => within(screen.getByRole('table', { name: 'Lead sourcing areas' }));
const runsTable = () => within(screen.getByRole('table', { name: 'Recent runs' }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

describe('AdminPage', () => {
  it('lists the areas and the recent runs', async () => {
    const m = api();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Lead sourcing' })).toBeInTheDocument();
    expect(screen.getByText('Where LeadMaker looks for contractors')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent runs' })).toBeInTheDocument();

    const soho = within((await screen.findByRole('cell', { name: 'Manhattan' })).closest('tr')!);
    expect(soho.getByText('10013 · 25 mi')).toBeInTheDocument();
    expect(soho.getByText('07030, 11201')).toBeInTheDocument();
    expect(soho.getByText('Daily')).toBeInTheDocument();
    expect(soho.getByRole('switch', { name: 'Manhattan turned on' })).toHaveAttribute('aria-checked', 'true');
    expect(soho.getByText('Done')).toBeInTheDocument();

    const jersey = within(areas().getByRole('cell', { name: 'ZIP 07601' }).closest('tr')!);
    expect(jersey.getAllByText('Manual only')).toHaveLength(2); // schedule + next run
    expect(jersey.getByText('Never run')).toBeInTheDocument();
    expect(jersey.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    const ok = within((await runsTable().findByText('212')).closest('tr')!);
    expect(ok.getByText('Manhattan')).toBeInTheDocument();
    expect(ok.getByText('Automatic')).toBeInTheDocument();
    expect(ok.getByText('1m 55s')).toBeInTheDocument();
    expect(ok.getByText('14')).toBeInTheDocument();
    expect(ok.getByText('37')).toBeInTheDocument();

    const failed = within(runsTable().getByText('Alex Morgan').closest('tr')!);
    expect(failed.getByText('Failed')).toBeInTheDocument();
    expect(failed.getAllByText('—')).toHaveLength(3); // no counts recorded for older runs
    expect(screen.queryByText(/Directory search timed out/)).toBeNull();
    const show = failed.getByRole('button', { name: /Show error/ });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(show).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Directory search timed out after 3 retries')).toBeInTheDocument();

    expect(m.calls.find((c) => c.path === '/api/admin/runs')?.query.get('limit')).toBe('20');
  });

  it('shows empty states with a way to add the first area', async () => {
    api({}, { territories: [], runs: [] });
    renderPage();
    expect(await screen.findByText('No areas yet')).toBeInTheDocument();
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add area' })[1]!);
    expect(screen.getByRole('dialog', { name: 'Add area' })).toBeInTheDocument();
  });

  it('shows an error with a retry when the areas cannot be loaded', async () => {
    let fail = true;
    api({ 'GET /api/admin/territories': () => (fail ? json(500, { error: 'boom' }) : [SOHO]) });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load this')).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('cell', { name: 'Manhattan' })).toBeInTheDocument();
  });

  it('validates the Add area form and posts a clean body', async () => {
    const m = api();
    renderPage();
    await screen.findByRole('cell', { name: 'Manhattan' });
    await userEvent.click(screen.getByRole('button', { name: 'Add area' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add area' }));

    const zip = dialog.getByLabelText('ZIP code');
    expect(zip).toHaveFocus();
    await userEvent.click(dialog.getByRole('button', { name: 'Add area' }));
    expect(dialog.getByText('Enter a ZIP code.')).toBeInTheDocument();

    await userEvent.type(zip, '0703');
    expect(dialog.getByText('Use a 5-digit US ZIP code, like 10013.')).toBeInTheDocument();
    await userEvent.type(zip, '0');
    expect(dialog.queryByText(/5-digit US ZIP/)).toBeNull();

    const miles = dialog.getByRole('spinbutton', { name: 'Search radius in miles' });
    await userEvent.clear(miles);
    await userEvent.type(miles, '75');
    expect(dialog.getByText('Pick a whole number of miles from 1 to 50.')).toBeInTheDocument();
    await userEvent.clear(miles);
    await userEvent.type(miles, '15');
    expect(dialog.getByRole('slider', { name: 'Search radius' })).toHaveValue('15');

    const extra = dialog.getByLabelText('Extra ZIP codes (optional)');
    await userEvent.type(extra, '07302, 123');
    expect(dialog.getByText('Not a 5-digit ZIP: 123')).toBeInTheDocument();
    await userEvent.type(extra, '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace} 07030');
    expect(dialog.queryByText(/Not a 5-digit ZIP/)).toBeNull();

    await userEvent.type(dialog.getByLabelText('Name (optional)'), 'Hoboken');
    await userEvent.click(dialog.getByRole('radio', { name: 'Weekly' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Add area' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = m.writes().find((c) => c.method === 'POST' && c.path === '/api/admin/territories');
    expect(post?.body).toEqual({ name: 'Hoboken', zip: '07030', radiusMiles: 15, alsoZips: ['07302'], everyHours: 168, enabled: true });
    expect(await screen.findByText('Area added')).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Hoboken' })).toBeInTheDocument();
  });

  it('edits an area, sending only what changed, and keeps the dialog open on a server refusal', async () => {
    let refuse = true;
    const m = api({}, { territories: [SOHO], refusePatch: () => refuse });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Manhattan' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit area' }));
    expect(dialog.getByLabelText('ZIP code')).toHaveValue('10013');
    expect(dialog.getByLabelText('Extra ZIP codes (optional)')).toHaveValue('07030, 11201');
    expect(dialog.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');

    const miles = dialog.getByRole('spinbutton', { name: 'Search radius in miles' });
    await userEvent.clear(miles);
    await userEvent.type(miles, '30');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    expect(await dialog.findByRole('alert')).toBeInTheDocument();

    refuse = false;
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const patches = m.writes().filter((c) => c.method === 'PATCH');
    expect(patches.at(-1)?.body).toEqual({ radiusMiles: 30 });
    expect(await screen.findByText('Area saved')).toBeInTheDocument();
    expect(areas().getByText('10013 · 30 mi')).toBeInTheDocument();
  });

  it('Run now shows Queued, then the live status of that run', async () => {
    let runs: Run[] = [RUN_OK];
    const m = api({
      'GET /api/admin/runs': () => runs,
      'POST /api/admin/territories/t1/run': () => json(202, { jobId: 'j9' }),
    });
    const { qc } = renderPage();
    const row = () => within(areas().getByRole('cell', { name: 'Manhattan' }).closest('tr')!);
    await screen.findByRole('cell', { name: 'Manhattan' });

    await userEvent.click(row().getByRole('button', { name: 'Run now: Manhattan' }));
    const queued = await row().findByRole('button', { name: 'Manhattan: Queued' });
    expect(queued).toHaveAttribute('aria-disabled', 'true');
    expect(m.writes().filter((c) => c.path === '/api/admin/territories/t1/run')).toHaveLength(1);
    await userEvent.click(queued); // no second run while one is open
    expect(m.writes().filter((c) => c.path === '/api/admin/territories/t1/run')).toHaveLength(1);

    runs = [{ ...RUN_OK, jobId: 'j9', status: 'running', requestedBy: { name: 'Alex Morgan' }, finishedAt: null, durationMs: null, stats: null }, RUN_OK];
    await act(() => qc.invalidateQueries({ queryKey: adminKeys.all }));
    expect(await row().findByRole('button', { name: 'Manhattan: Running' })).toBeInTheDocument();
    expect(within(row().getAllByRole('cell')[5]!).getByText('Running')).toBeInTheDocument(); // the last-run chip

    runs = [{ ...runs[0]!, status: 'succeeded', finishedAt: new Date().toISOString(), durationMs: 90_000, stats: { found: 220, new: 8, updated: 3 } }, RUN_OK];
    await act(() => qc.invalidateQueries({ queryKey: adminKeys.all }));
    expect(await row().findByRole('button', { name: 'Run now: Manhattan' })).toBeInTheDocument();
    expect(row().getByText('Done')).toBeInTheDocument();
    expect(runsTable().getByText('220')).toBeInTheDocument();
  });

  it('turns an area off and on with the switch', async () => {
    const m = api();
    renderPage();
    const sw = await screen.findByRole('switch', { name: 'Manhattan turned on' });
    await userEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    await waitFor(() => expect(m.writes().at(-1)?.body).toEqual({ enabled: false }));
    expect(await screen.findByText('Manhattan is paused')).toBeInTheDocument();
  });

  it('deletes an area only after confirming', async () => {
    const m = api();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete ZIP 07601' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Delete this area?' }));
    expect(confirm.getByText('07601 · 10 mi')).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(m.writes()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Delete ZIP 07601' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete area' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(m.writes().map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/admin/territories/t2']);
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'ZIP 07601' })).toBeNull());
  });

  it('polls every 5 s while a run is open and every 30 s otherwise', async () => {
    api({}, { runs: [{ ...RUN_OK, jobId: 'j5', status: 'queued', startedAt: null, finishedAt: null, durationMs: null, stats: null }] });
    const { qc } = renderPage();
    await screen.findByText('Waiting', { exact: false });
    const interval = () => {
      const q = qc.getQueryCache().find({ queryKey: adminKeys.runs(20) });
      const opt = (q?.options as { refetchInterval?: number | ((query: unknown) => number) } | undefined)?.refetchInterval;
      return typeof opt === 'function' ? opt(q) : opt;
    };
    expect(interval()).toBe(FAST_POLL_MS);
    qc.setQueryData(adminKeys.runs(20), [RUN_OK]);
    await waitFor(() => expect(interval()).toBe(SLOW_POLL_MS));
  });

  it('sends reps back to the dashboard', async () => {
    const m = api();
    renderPage(rep);
    expect(await screen.findByText('Admin is for managers')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(m.calls.some((c) => c.path.startsWith('/api/admin'))).toBe(false);
  });

  it('shows cards instead of tables on a phone', async () => {
    const mm = vi.fn((q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    vi.stubGlobal('matchMedia', mm);
    api();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Lead sourcing areas' });
    expect(within(list).getByText('Manhattan')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Run now: Manhattan' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('admin helpers', () => {
  it('validates ZIPs, radius and extra ZIPs', () => {
    const ok = { ...formFrom(null), zip: '10013' };
    expect(validateArea(ok)).toEqual({});
    expect(validateArea({ ...ok, zip: '1001' }).zip).toBeTruthy();
    expect(validateArea({ ...ok, zip: 'abcde' }).zip).toBeTruthy();
    expect(validateArea({ ...ok, radius: '0' }).radius).toBeTruthy();
    expect(validateArea({ ...ok, radius: '51' }).radius).toBeTruthy();
    expect(validateArea({ ...ok, radius: '2.5' }).radius).toBeTruthy();
    expect(validateArea({ ...ok, radius: '' }).radius).toBeTruthy();
    expect(validateArea({ ...ok, radius: '50' })).toEqual({});
    expect(validateArea({ ...ok, alsoZips: '07030 x1' }).alsoZips).toContain('x1');
    expect(parseZips('07030, 07030;11201  ')).toEqual({ zips: ['07030', '11201'], invalid: [] });
    expect(toInput({ ...ok, alsoZips: '10013, 07030' }).alsoZips).toEqual(['07030']);
    expect(toInput(ok)).not.toHaveProperty('name');
  });

  it('labels schedules and durations', () => {
    expect(scheduleLabel(24)).toBe('Daily');
    expect(scheduleLabel(168)).toBe('Weekly');
    expect(scheduleLabel(null)).toBe('Manual only');
    expect(scheduleLabel(6)).toBe('Every 6 hours');
    expect(scheduleLabel(72)).toBe('Every 3 days');
    expect(formatDuration(400)).toBe('<1s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(null)).toBe('—');
  });

  it('patches only changed fields', () => {
    expect(changedFields(SOHO, toInput(formFrom(SOHO)))).toEqual({});
    expect(changedFields(SOHO, { ...toInput(formFrom(SOHO)), enabled: false, alsoZips: [] })).toEqual({ enabled: false, alsoZips: [] });
  });

  it('follows the run started from the page, else the last run', () => {
    expect(liveRuns([SOHO, JERSEY], [], {})).toEqual({ t1: { status: 'succeeded', at: SOHO.lastRun!.finishedAt }, t2: null });
    expect(liveRuns([SOHO], [], { t1: '' }).t1?.status).toBe('queued');
    expect(liveRuns([SOHO], [], { t1: 'j9' }).t1?.status).toBe('queued');
    expect(liveRuns([SOHO], [{ ...RUN_OK, jobId: 'j9', status: 'running' }], { t1: 'j9' }).t1?.status).toBe('running');
  });
});
