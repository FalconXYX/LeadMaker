import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { sessionStore } from '@/auth/session';
import { liveEvents } from '@/live/liveEvents';
import { AllocationPage } from '@/features/allocation/AllocationPage';
import { countyPlace, humanizeCountyRefs } from '@/lib/counties';
import { normalizeOutcome, normalizeRelease, undoPlan } from '@/features/allocation/lib';
import { parseQueue, queueFilter, serializeQueue } from '@/features/allocation/params';
import { releaseToPool } from '@/features/allocation/queries';
import { suggestionKey } from '@/features/allocation/SuggestionsPanel';
import { KPIS, R1, R2, R3, REPS, json, lead, manager, mockApi, renderRoute, type Call } from './testkit';

const A = lead('a0000000-0000-4000-8000-000000000001', 'Acme Roofing', { priorityScore: 91 });
const B = lead('b0000000-0000-4000-8000-000000000002', 'Brooklyn Roof Pros', { segment: 'growth', priorityScore: 72 });
const C = lead('c0000000-0000-4000-8000-000000000003', 'Coastal Exteriors', { countyFips: '34003', postalCode: '07601', priorityScore: 55 });

const SUGGESTIONS = {
  considered: 274,
  unallocatedTotal: 274,
  suggestions: [
    {
      repId: R3, repName: 'Sam Rivera', basis: 'postal_code', key: '11201',
      reason: 'Sam Rivera already works 4 leads in ZIP 11201',
      companyIds: [A.id, B.id],
      leads: [A, B].map((l) => ({ id: l.id, businessName: l.businessName, postalCode: l.postalCode, countyFips: l.countyFips, priorityScore: l.priorityScore })),
    },
    {
      repId: R1, repName: 'Jordan Lee', basis: 'county', key: '34003',
      reason: 'Jordan Lee already works 50 leads in county 34003',
      companyIds: [C.id],
      leads: [{ id: C.id, businessName: C.businessName, postalCode: C.postalCode, countyFips: C.countyFips, priorityScore: C.priorityScore }],
    },
  ],
};

const CONFIG = { maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500, refreshPerHour: 20, userRoleTtlSeconds: 30 };

/** DELETE /api/allocations {companyIds}: every id back to the pool from Sam (R3). */
const release = (c: Call) => ({
  unallocated: (c.body as { companyIds: string[] }).companyIds.map((id) => ({ companyId: id, previousRepId: R3, version: 3 })),
  unchanged: [],
});

const bulkDeletes = (m: { writes: () => Call[] }) =>
  m.writes().filter((c) => c.method === 'DELETE').map((c) => (c.body as { companyIds: string[] }).companyIds);

function api(overrides: Record<string, (c: Call) => unknown> = {}, search: { total?: number; capped?: boolean } = {}) {
  return mockApi({
    'GET /api/me': () => manager,
    'GET /api/config': () => CONFIG,
    'GET /api/users': () => ({ items: [...REPS, { id: 'm1', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager', allocatedCount: 0 }] }),
    'GET /api/kpis': () => KPIS,
    'GET /api/signals': () => ({ counties: [{ countyFips: '36047', leadCount: 2 }, { countyFips: '34003', leadCount: 1 }], alerts: [], stormHistory: [], news: [] }),
    'GET /api/allocations/suggestions': () => SUGGESTIONS,
    'POST /api/leads/search': () => ({ items: [A, B, C], nextCursor: null, total: search.total ?? 274, totalCapped: search.capped ?? false }),
    'POST /api/allocations': (c) => {
      const b = c.body as { companyIds: string[]; repId: string };
      return { repId: b.repId, allocated: b.companyIds.map((id) => ({ companyId: id, previousRepId: null, version: 2 })), unchanged: [] };
    },
    'POST /api/allocations/by-filter': (c) => ({ repId: (c.body as { repId: string }).repId, allocated: [{ companyId: A.id, previousRepId: null, version: 2 }], unchanged: [], missing: [], matched: 1 }),
    'DELETE /api/allocations': release,
    ...overrides,
  });
}

const renderPage = (path = '/allocation', state?: unknown) => renderRoute(<AllocationPage />, { user: manager, path, route: '/allocation', state });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

describe('AllocationPage', () => {
  it('shows team load per rep and the pool, and scopes the queue to a rep on click', async () => {
    const m = api();
    renderPage();
    const pool = await screen.findByRole('button', { name: /^Unallocated pool: 274 leads, 140 updated in the last poll/ });
    expect(pool).toHaveAttribute('aria-pressed', 'true');
    const sam = screen.getByRole('button', { name: /^Sam Rivera: 50 leads, 40 unchecked, 45 unserviced/ });
    await userEvent.click(sam);
    expect(sam).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('heading', { name: "Sam Rivera's leads" })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/allocation?scope=rep%3A${R3}`);
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/leads/search'
      && JSON.stringify((c.body as { filter: { scope: unknown } }).filter.scope) === JSON.stringify({ repId: R3 }))).toBe(true));
  });

  it('bulk assigns selected rows after a confirm with before/after load, then undoes to the pool', async () => {
    const m = api();
    renderPage();
    const table = await screen.findByRole('table');
    await userEvent.click(await within(table).findByRole('checkbox', { name: 'Select Acme Roofing' }));
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select Brooklyn Roof Pros' }));

    const bar = screen.getByRole('region', { name: 'Selected leads' });
    expect(bar).toHaveTextContent('2 selected');
    await userEvent.click(within(bar).getByRole('button', { name: /Assign to…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Sam Rivera/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Assign 2 leads to Sam?' });
    const load = within(dialog).getByRole('region', { name: 'Load before and after' });
    expect(load).toHaveTextContent(/Sam Rivera\s*50 → 52\s*\+2/);
    expect(load).toHaveTextContent(/Unallocated pool\s*274 → 272/);
    expect(dialog).toHaveTextContent('1 Strategic');
    expect(dialog).toHaveTextContent('1 Growth');
    expect(m.writes()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign 2 leads' }));
    await waitFor(() => expect(m.writes()).toHaveLength(1));
    expect(m.writes()[0]).toMatchObject({ method: 'POST', path: '/api/allocations', body: { companyIds: [A.id, B.id], repId: R3 } });

    expect(await screen.findByText('Assigned 2 leads to Sam Rivera')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Selected leads' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // One bulk DELETE for both, not one request per lead.
    await waitFor(() => expect(bulkDeletes(m)).toEqual([[A.id, B.id]]));
    expect(m.writes().filter((c) => c.method === 'DELETE').every((c) => c.path === '/api/allocations')).toBe(true);
    expect(await screen.findByText('Undid the assignment')).toBeInTheDocument();
  });

  it('assigns everything a filter matches via by-filter after confirming the count', async () => {
    const m = api();
    renderPage('/allocation?segment=strategic');
    await userEvent.click(await screen.findByRole('button', { name: /^Assign all 274 matching to…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Priya Shah/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign all 274 leads to Priya?' });
    expect(within(dialog).getByText('Matching')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Strategic');
    expect(dialog).toHaveTextContent(/Priya Shah\s*50 → 324/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign 274 leads' }));
    await waitFor(() => expect(m.writes()).toHaveLength(1));
    expect(m.writes()[0]).toMatchObject({
      method: 'POST', path: '/api/allocations/by-filter',
      body: { filter: { scope: 'unallocated', segment: ['strategic'] }, repId: R2 },
    });
    expect(await screen.findByText('Assigned 1 lead to Priya Shah')).toBeInTheDocument();
  });

  it('flags a capped count and explains the server refusing an oversized batch', async () => {
    const m = api({
      'POST /api/allocations/by-filter': () => new Response(JSON.stringify({ error: 'too_many_leads', details: { matched: 6200, max: 5000 } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    }, { total: 1000, capped: true });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Assign all 1,000\+ to…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Jordan Lee/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign all 1,000+ leads to Jordan?' });
    expect(dialog).toHaveTextContent('More than 1,000 leads match');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign 1,000+ leads' }));
    expect(await screen.findByText('That filter matches 6,200 leads')).toBeInTheDocument();
    expect(screen.getByText(/You can assign up to 5,000 at a time/)).toBeInTheDocument();
    expect(m.writes()).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: /Assign all 1,000\+ leads/ })).toBeInTheDocument();
  });

  it('approves a suggestion as one allocation, and remembers dismissals per user', async () => {
    const m = api();
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Suggestions' });
    expect(await within(panel).findByText('ZIP 11201')).toBeInTheDocument();
    expect(within(panel).getByText('Jordan Lee already works 50 leads in Bergen County')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /^Dismiss suggestion for Bergen County/ }));
    expect(within(panel).queryByText('Bergen County, NJ')).toBeNull();
    expect(JSON.parse(localStorage.getItem('leadmaker.allocation.dismissed.m1') ?? '[]')).toEqual([
      suggestionKey(SUGGESTIONS.suggestions[1] as never),
    ]);

    await userEvent.click(within(panel).getByRole('button', { name: 'Approve: assign ZIP 11201 (2 leads) to Sam Rivera' }));
    await waitFor(() => expect(m.writes()).toHaveLength(1));
    expect(m.writes()[0]).toMatchObject({ method: 'POST', path: '/api/allocations', body: { companyIds: [A.id, B.id], repId: R3 } });
    expect(await screen.findByText('Approved ZIP 11201: 2 leads assigned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('can approve a suggestion for a different rep', async () => {
    const m = api();
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Suggestions' });
    await userEvent.selectOptions(await within(panel).findByRole('combobox', { name: 'Rep for ZIP 11201' }), R2);
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve: assign ZIP 11201 (2 leads) to Priya Shah' }));
    await waitFor(() => expect(m.writes()[0]).toMatchObject({ body: { companyIds: [A.id, B.id], repId: R2 } }));
  });

  it('preselects leads handed over from the Leads list', async () => {
    api();
    renderPage('/allocation', { companyIds: [A.id, C.id] });
    expect(await screen.findByText('2 leads from your Leads list are selected.')).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(await within(table).findByRole('checkbox', { name: 'Select Acme Roofing' })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: 'Select Coastal Exteriors' })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: 'Select Brooklyn Roof Pros' })).not.toBeChecked();
  });

  it('sends county and priority filters to the server and assigns all matching by filter', async () => {
    const m = api({
      'POST /api/leads/search': () => ({ items: [A], nextCursor: null, total: 1, totalCapped: false }),
      'POST /api/leads/facets': () => ({ total: 1, segment: [{ value: 'strategic', count: 1 }], size: [], certifications: [], services: [], materials: [], customTags: [], accountStatus: [] }),
    });
    renderPage('/allocation?county=36047&minPriority=80');
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Acme Roofing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Segment/ }));
    await userEvent.keyboard('{Escape}');
    const search = m.calls.find((c) => c.path === '/api/leads/search')!;
    expect(search.body).toMatchObject({ filter: { scope: 'unallocated', counties: ['36047'], minPriority: 80, limit: 50 } });
    // Facet counts cover the same filter (they are no longer hidden while a county or floor is on).
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/leads/facets'
      && JSON.stringify(c.body).includes('"counties":["36047"]') && JSON.stringify(c.body).includes('"minPriority":80'))).toBe(true));

    await userEvent.click(await screen.findByRole('button', { name: /^Assign all 1 matching to…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Sam Rivera/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Assign 1 lead' }));
    const allocations = () => m.writes().filter((c) => c.path.startsWith('/api/allocations'));
    await waitFor(() => expect(allocations()).toHaveLength(1));
    expect(allocations()[0]).toMatchObject({
      method: 'POST', path: '/api/allocations/by-filter',
      body: { filter: { scope: 'unallocated', counties: ['36047'], minPriority: 80 }, repId: R3 },
    });
    expect((allocations()[0]!.body as { filter: object }).filter).not.toHaveProperty('limit');
  });

  it('returns a rep\'s selected leads in bulk DELETEs of at most config.maxBulkUnallocate, with one Undo', async () => {
    const m = api({
      'GET /api/config': () => ({ ...CONFIG, maxBulkUnallocate: 2 }),
      'POST /api/leads/search': () => ({ items: [A, B, C].map((l) => ({ ...l, assignedRep: { id: R3, name: 'Sam Rivera' } })), nextCursor: null, total: 3, totalCapped: false }),
    });
    renderPage(`/allocation?scope=rep%3A${R3}`);
    const table = await screen.findByRole('table');
    await userEvent.click(await within(table).findByRole('checkbox', { name: /Select all/ }));
    const bar = screen.getByRole('region', { name: 'Selected leads' });
    expect(bar).toHaveTextContent('3 selected');
    await userEvent.click(within(bar).getByRole('button', { name: 'Return to pool' }));
    const dialog = await screen.findByRole('dialog', { name: 'Return 3 leads to the pool?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return to pool' }));
    await waitFor(() => expect(bulkDeletes(m)).toEqual([[A.id, B.id], [C.id]]));
    expect(await screen.findByText('Returned 3 leads to the pool')).toBeInTheDocument();
    expect(screen.getByText('From Sam Rivera.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(m.writes().filter((c) => c.path === '/api/allocations' && c.method === 'POST')).toHaveLength(1));
    expect(m.writes().at(-1)).toMatchObject({ body: { companyIds: [A.id, B.id, C.id], repId: R3 } });
    expect(await screen.findByText('Undid the move to the pool')).toBeInTheDocument();
  });

  it('uses the configured cap for "assign all matching"', async () => {
    api({ 'GET /api/config': () => ({ ...CONFIG, maxBulkAllocation: 200 }) });
    renderPage('/allocation?segment=strategic');
    await userEvent.click(await screen.findByRole('button', { name: /^Assign all 274 matching to…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Priya Shah/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign all 274 leads to Priya?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('274 leads match, but up to 200 can be assigned at a time');
    expect(within(dialog).getByRole('button', { name: 'Assign 274 leads' })).toBeDisabled();
  });

  it('names the manager from payload.actor_name when another manager moves leads', async () => {
    api();
    renderPage();
    await screen.findByRole('table');
    act(() => liveEvents.emit({
      id: '1-0', type: 'lead.allocated', companyIds: [A.id, B.id], data: {},
      payload: { actor_type: 'user', actor_id: 'm2', actor_name: 'Casey Park', assigned_rep_id: R3, previous_rep_id: null },
    }));
    expect(await screen.findByText('Casey Park moved 2 leads to Sam Rivera', undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('allocation helpers', () => {
  it('reads the allocation response and plans the undo', () => {
    const arr = normalizeOutcome({
      repId: 'r3',
      allocated: [{ companyId: 'a', previousRepId: null, version: 2 }, { companyId: 'b', previousRepId: 'r1', version: 5 }],
      unchanged: ['c'],
    }, 'r3');
    expect(arr.moved).toEqual([{ companyId: 'a', previousRepId: null }, { companyId: 'b', previousRepId: 'r1' }]);
    expect(arr.unchanged).toBe(1);
    const byFilter = normalizeOutcome({ repId: 'r3', allocated: [], unchanged: ['c', 'd'], missing: [], matched: 2 }, 'r3');
    expect(byFilter).toMatchObject({ moved: [], unchanged: 2, missing: 0, matched: 2 });
    const plan = undoPlan(arr.moved);
    expect(plan.toPool).toEqual(['a']);
    expect([...plan.toReps]).toEqual([['r1', ['b']]]);
  });

  it('reads the bulk release response', () => {
    expect(normalizeRelease({ unallocated: [{ companyId: 'a', previousRepId: 'r1', version: 3 }], unchanged: ['b'] })).toEqual({
      moved: [{ companyId: 'a', previousRepId: 'r1' }], unchanged: ['b'],
    });
    expect(normalizeRelease(undefined)).toEqual({ moved: [], unchanged: [] });
  });

  it('retries a release batch without the ids the server no longer knows', async () => {
    const m = mockApi({
      'DELETE /api/allocations': (c) => {
        const ids = (c.body as { companyIds: string[] }).companyIds;
        if (ids.includes('gone')) return json(404, { error: 'not_found', details: { missing: ['gone'] } });
        return { unallocated: ids.filter((id) => id !== 'pooled').map((id) => ({ companyId: id, previousRepId: R1, version: 2 })), unchanged: ids.filter((id) => id === 'pooled') };
      },
    });
    const out = await releaseToPool(['a', 'gone', 'pooled', 'b'], 3);
    expect(m.calls.map((c) => (c.body as { companyIds: string[] }).companyIds)).toEqual([['a', 'gone', 'pooled'], ['a', 'pooled'], ['b']]);
    expect(out).toMatchObject({ moved: [{ companyId: 'a', previousRepId: R1 }, { companyId: 'b', previousRepId: R1 }], unchanged: 1, missing: 1, failed: 0 });
  });

  it('round-trips queue params next to the shared LeadFilter ones', () => {
    const qs = 'scope=rep%3A0b8f2a8e-5d1c-4a8e-9a3b-2f6c1d9e7a10&segment=growth&new=1&county=36047&minPriority=60';
    const s = parseQueue(new URLSearchParams(qs));
    expect(s).toMatchObject({ scope: { repId: '0b8f2a8e-5d1c-4a8e-9a3b-2f6c1d9e7a10' }, counties: ['36047'], minPriority: 60, filter: { segment: ['growth'], updatedInLastPoll: true } });
    expect(serializeQueue(s).toString()).toBe(qs);
    expect(queueFilter(s)).toEqual({ scope: { repId: '0b8f2a8e-5d1c-4a8e-9a3b-2f6c1d9e7a10' }, segment: ['growth'], updatedInLastPoll: true, counties: ['36047'], minPriority: 60 });
    expect(queueFilter(parseQueue(new URLSearchParams('')))).toEqual({ scope: 'unallocated' });
    expect(parseQueue(new URLSearchParams('scope=all&minPriority=500')).scope).toBe('unallocated');
  });

  it('names counties in server-written reasons', () => {
    expect(countyPlace('36047')).toBe('Brooklyn');
    expect(humanizeCountyRefs('works 3 leads in county 34003')).toBe('works 3 leads in Bergen County');
    expect(countyPlace('99999')).toBe('County 99999');
  });
});

describe('queue search box', () => {
  it('keeps the space between words while the debounced search echoes back through the URL', async () => {
    api();
    renderPage();
    const box = await screen.findByRole('searchbox', { name: 'Search by business name' });
    await userEvent.type(box, 'acme ');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/allocation?q=acme'), { timeout: 2000 });
    await userEvent.type(box, 'roofing');
    expect(box).toHaveValue('acme roofing');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/allocation?q=acme+roofing'), { timeout: 2000 });
  });
});
