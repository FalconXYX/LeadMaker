import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/api/errors';
import type { CustomTagListItem, LeadFilter, SavedView, SavedViewCreate } from '@/api/types';
import { ManageTagsDialog, canManageTag } from '@/features/leads/components/ManageTagsDialog';
import { LeadsPage } from '@/features/leads';
import { loadLocalViews, prefsKey, type LocalSavedView } from '@/features/leads/prefs';
import { migrateLocalViews, queryToView, viewToQuery } from '@/features/leads/savedViews';
import { lead, renderLeads, signIn, stubFetch, users, type FetchLog } from './testUtils';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const nameTaken = () => json(409, { error: 'name_taken' });

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: `v-${Math.random().toString(36).slice(2, 8)}`,
    name: 'View',
    filter: {},
    sort: null,
    isShared: false,
    owner: { id: users.rep.id, name: users.rep.name },
    mine: true,
    canEdit: true,
    createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z',
    ...over,
  };
}

const local = (name: string, query: string): LocalSavedView => ({ id: `l-${name}`, name, query, createdAt: '2026-10-01T00:00:00Z' });

function stubList(extra: Record<string, unknown> = {}): FetchLog[] {
  return stubFetch({
    'GET /api/me': users.rep,
    'POST /api/leads/search': { items: [lead({ businessName: 'Mine Roofing Co' })], nextCursor: null, total: 1, totalCapped: false },
    'GET /api/custom-tags': { items: [] },
    'GET /api/custom-fields/keys': { items: [] },
    'GET /api/signals': { alerts: [], stormHistory: [], news: [], counties: [] },
    'GET /api/preferences': { prefs: {}, version: 0, updatedAt: null },
    'GET /api/config': { maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500, refreshPerHour: 20, userRoleTtlSeconds: 30 },
    ...extra,
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  signIn(null);
});

describe('view <-> URL mapping', () => {
  it('round-trips a list query through a server view (sort apart, alert flag kept)', () => {
    const q = 'segment=strategic&county=36047&minPriority=70&sort=rating:desc&alert=1';
    const v = queryToView(q);
    expect(v).toEqual({ filter: { segment: ['strategic'], counties: ['36047'], minPriority: 70 }, sort: { by: 'rating', dir: 'desc' }, alert: true });
    expect(new URLSearchParams(viewToQuery(v, true)).getAll('county')).toEqual(['36047']);
    expect(queryToView(viewToQuery(v, true))).toEqual(v);
  });
});

describe('migrating browser-saved views', () => {
  it('creates each on the server, skips one already there, and renames on a name clash', async () => {
    const existing = [view({ name: 'Storm', filter: { tagsAny: ['work_type:storm_emergency'] } }), view({ name: 'Growth', filter: { segment: ['strategic'] } })];
    const bodies: SavedViewCreate[] = [];
    const create = vi.fn(async (body: SavedViewCreate) => {
      bodies.push(body);
      if (existing.some((v) => v.name.toLowerCase() === body.name.toLowerCase())) throw new ApiError(409, 'name_taken');
      return { view: view({ name: body.name, filter: body.filter, sort: body.sort ?? null }) };
    });
    const res = await migrateLocalViews([
      local('Storm', 'anyTag=work_type%3Astorm_emergency'), // identical: already migrated
      local('Growth', 'segment=growth&sort=rating:desc'), // same name, different filter
      local('Brooklyn', 'county=36047&alert=1'),
    ], existing, create);

    expect(bodies.map((b) => b.name)).toEqual(['Growth', 'Growth (2)', 'Brooklyn']);
    expect(bodies[1]).toEqual({ name: 'Growth (2)', filter: { segment: ['growth'] }, sort: { by: 'rating', dir: 'desc' } });
    expect(res.moved.map((m) => [m.local.name, m.view.name, m.alert])).toEqual([
      ['Storm', 'Storm', false], ['Growth', 'Growth (2)', false], ['Brooklyn', 'Brooklyn', true],
    ]);
    expect(res.failed).toEqual([]);
  });

  it('keeps views it could not move (offline) for the next attempt', async () => {
    const res = await migrateLocalViews([local('A', 'size=small')], [], async () => { throw new NetworkError(); });
    expect(res.failed.map((v) => v.name)).toEqual(['A']);
  });

  it('runs once on the list, then clears them from localStorage', async () => {
    localStorage.setItem(prefsKey(users.rep.id), JSON.stringify({
      density: 'compact',
      savedViews: [local('My strategic', 'segment=strategic'), local('Storm Brooklyn', 'county=36047&alert=1')],
    }));
    const created: SavedView[] = [];
    const log = stubList({
      'GET /api/views': () => ({ items: created }),
      'POST /api/views': ({ body }: { body: unknown }) => {
        const b = body as SavedViewCreate;
        const v = view({ name: b.name, filter: b.filter });
        created.push(v);
        return json(201, { view: v });
      },
    });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await waitFor(() => expect(log.filter((r) => r.method === 'POST' && r.path === '/api/views')).toHaveLength(2));
    expect(log.filter((r) => r.method === 'POST' && r.path === '/api/views').map((r) => r.body)).toEqual([
      { name: 'My strategic', filter: { segment: ['strategic'] } },
      { name: 'Storm Brooklyn', filter: { counties: ['36047'] } },
    ]);
    await waitFor(() => expect(loadLocalViews(users.rep.id)).toEqual([]));
    expect(JSON.parse(localStorage.getItem(prefsKey(users.rep.id))!)).not.toHaveProperty('savedViews');
    expect(await screen.findByText(/Moved 2 saved views to your account/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Saved views/ }));
    const mine = screen.getByRole('list', { name: 'My views' });
    expect(within(mine).getByText('My strategic')).toBeInTheDocument();
    expect(within(mine).getByText('Storm Brooklyn')).toBeInTheDocument();
  });
});

describe('saving and renaming views', () => {
  it('shows a server name clash inline and keeps the dialog open', async () => {
    const log = stubList({ 'GET /api/views': { items: [] }, 'POST /api/views': nameTaken });
    signIn(users.rep);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />, '/leads?segment=strategic');

    await user.click(await screen.findByRole('button', { name: /Saved views/ }));
    await user.click(screen.getByRole('button', { name: /Save current view/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    await user.type(within(dialog).getByLabelText('Name'), 'Strategic');
    // Reps cannot share.
    expect(within(dialog).queryByRole('switch', { name: /Shared with team/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You already have a view named “Strategic”.');
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(log.find((r) => r.method === 'POST' && r.path === '/api/views')?.body).toEqual({ name: 'Strategic', filter: { segment: ['strategic'] } });
  });

  it('managers can share; renames show name_taken inline; reps see the team’s views in their own section', async () => {
    const own = view({ id: 'v1', name: 'Hot list', owner: { id: users.manager.id, name: users.manager.name } });
    const teamView = view({ id: 'v2', name: 'Team storm', isShared: true, mine: false, canEdit: true, owner: { id: 'x', name: 'Sam Rivera' } });
    const log = stubList({
      'GET /api/me': users.manager,
      'GET /api/users': { items: [] },
      'GET /api/views': { items: [own, teamView] },
      'PATCH /api/views/v1': ({ body }: { body: unknown }) => ((body as { name?: string }).name ? nameTaken() : { view: { ...own, isShared: true } }),
    });
    signIn(users.manager);
    const user = userEvent.setup();
    renderLeads(<LeadsPage />);

    await user.click(await screen.findByRole('button', { name: /Saved views/ }));
    const shared = await screen.findByRole('list', { name: 'Shared with team' });
    expect(within(shared).getByText('Team storm')).toBeInTheDocument();
    expect(within(shared).getByText('by Sam Rivera')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Share Hot list with team' }));
    await waitFor(() => expect(log.find((r) => r.method === 'PATCH')?.body).toEqual({ isShared: true }));

    await user.click(screen.getByRole('button', { name: 'Rename view Hot list' }));
    const field = screen.getByRole('textbox', { name: 'Rename view Hot list' });
    await user.clear(field);
    await user.type(field, 'Taken name{Enter}');
    expect(await screen.findByText('You already have a view named “Taken name”.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Manage tags', () => {
  const mineTag: CustomTagListItem = { id: 't1', name: 'Follow up', createdBy: { id: users.rep.id, name: users.rep.name }, createdAt: '2026-10-18T00:00:00Z', leadCount: 12 };
  const theirs: CustomTagListItem = { id: 't2', name: 'Hot', createdBy: { id: 'other', name: 'Sam Rivera' }, createdAt: '2026-10-18T00:00:00Z', leadCount: 3 };

  it('canManageTag: the creator or a manager', () => {
    expect(canManageTag(users.rep, mineTag)).toBe(true);
    expect(canManageTag(users.rep, theirs)).toBe(false);
    expect(canManageTag(users.manager, theirs)).toBe(true);
    expect(canManageTag(null, mineTag)).toBe(false);
  });

  it('disables rename/delete on others’ tags for a rep, with the reason', async () => {
    stubList({ 'GET /api/custom-tags': { items: [mineTag, theirs] } });
    signIn(users.rep);
    renderLeads(<ManageTagsDialog open onClose={() => {}} user={users.rep} />);

    const rename = await screen.findByRole('button', { name: 'Rename tag Hot' });
    expect(rename).toHaveAttribute('aria-disabled', 'true');
    expect(rename).toHaveAccessibleDescription('Only Sam Rivera (who created it) or a manager can change this tag');
    expect(screen.getByRole('button', { name: 'Delete tag Hot' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Rename tag Follow up' })).not.toHaveAttribute('aria-disabled');
  });

  it('renames after a confirm that names the affected leads; a clash shows inline', async () => {
    let taken = true;
    const log = stubList({
      'GET /api/custom-tags': { items: [mineTag, theirs] },
      'PATCH /api/custom-tags/t1': ({ body }: { body: unknown }) => (taken
        ? nameTaken()
        : { tag: { id: 't1', name: (body as { name: string }).name, createdBy: users.rep.id, createdAt: '' }, previousName: 'Follow up', leads: [] }),
    });
    signIn(users.rep);
    const onRenamed = vi.fn();
    const user = userEvent.setup();
    renderLeads(<ManageTagsDialog open onClose={() => {}} user={users.rep} onRenamed={onRenamed} />);

    await user.click(await screen.findByRole('button', { name: 'Rename tag Follow up' }));
    const field = screen.getByRole('textbox', { name: 'New name for Follow up' });
    // A clash with a tag in the list is caught before sending.
    await user.clear(field);
    await user.type(field, 'hot');
    expect(screen.getByRole('alert')).toHaveTextContent('Another tag is already called “hot”.');
    expect(screen.getByRole('button', { name: 'Rename…' })).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'Call back{Enter}');
    expect(screen.getByText(/on 12 leads\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rename tag' }));
    // The server knows a tag this list does not show yet.
    expect(await screen.findByRole('alert')).toHaveTextContent('Another tag is already called “Call back”.');
    expect(log.filter((r) => r.method === 'PATCH')).toHaveLength(1);

    taken = false;
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    await user.click(screen.getByRole('button', { name: 'Rename tag' }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('Follow up', 'Call back'));
    expect(log.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({ name: 'Call back' });
  });

  it('deletes after a confirm with the lead count', async () => {
    const log = stubList({
      'GET /api/custom-tags': { items: [mineTag] },
      'DELETE /api/custom-tags/t1': { deleted: true, tagId: 't1', name: 'Follow up', leads: [] },
    });
    signIn(users.rep);
    const onDeleted = vi.fn();
    const user = userEvent.setup();
    renderLeads(<ManageTagsDialog open onClose={() => {}} user={users.rep} onDeleted={onDeleted} />);

    await user.click(await screen.findByRole('button', { name: 'Delete tag Follow up' }));
    expect(screen.getByText(/comes off 12 leads/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete from 12 leads' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('Follow up'));
    expect(log.some((r) => r.method === 'DELETE' && r.path === '/api/custom-tags/t1')).toBe(true);
  });
});

// Keeps the LeadFilter import used for the type-level check above.
export type _F = LeadFilter;
