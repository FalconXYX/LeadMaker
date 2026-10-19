import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/api/queries';
import type { LeadProfile } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';
import { liveEvents } from '@/live/liveEvents';
import { displayCustomValue } from '@/features/profile/CustomFields';
import { LEAD_ID, MANAGER, REP, contact, entry, field, makeProfile, task } from './fixtures';
import { LeadProfilePage } from '@/features/profile/index';

vi.mock('@/features/profile/LocationMap', () => ({ default: () => <div data-testid="map" /> }));
// The shared follow-up components belong to the tasks feature; here they only need to open, close and report done.
vi.mock('@/features/tasks', () => ({
  LogActivityDialog: (p: { open: boolean; defaultType?: string; leadName: string; onOpenChange: (o: boolean) => void; onDone?: () => void }) =>
    p.open ? (
      <div role="dialog" aria-label={`Log ${p.defaultType} with ${p.leadName}`}>
        <button type="button" onClick={() => { p.onDone?.(); p.onOpenChange(false); }}>Save log</button>
      </div>
    ) : null,
  TaskQuickAdd: (p: { leadId: string; onDone?: () => void }) => (
    <div data-testid="quick-add" data-lead={p.leadId}><button type="button" onClick={p.onDone}>Save follow-up</button></div>
  ),
}));

const token = (() => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Handler = (c: Call) => Response | undefined;

function setup(profile: LeadProfile | null, opts: { user?: typeof REP | typeof MANAGER; handler?: Handler; search?: string } = {}) {
  const user = opts.user ?? REP;
  const calls: Call[] = [];
  let current = profile;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const c: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const custom = opts.handler?.(c);
    if (custom) return custom;
    if (c.path === '/api/me') return json(user);
    if (c.path === '/api/config') return json({ weeklyActivityGoal: 25 });
    if (c.path === `/api/leads/${LEAD_ID}` && c.method === 'GET') return current ? json(current) : json({ error: 'not_found' }, 404);
    if (c.path === '/api/signals') return json({ scope: 'all', counties: [], alerts: [], stormHistory: [], news: [], generatedAt: new Date().toISOString() });
    if (c.path === '/api/custom-tags') return json({ items: [] });
    if (c.path.endsWith('/activity')) return json({ items: [], nextCursor: null });
    if (c.path === '/api/custom-fields/keys') return json({ items: [] });
    return json({}, 200);
  });
  vi.stubGlobal('fetch', fetchMock);
  act(() => sessionStore.set({ token, user }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/leads/${LEAD_ID}${opts.search ?? ''}`]}>
            <Routes><Route path="/leads/:id" element={<LeadProfilePage />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return {
    ...utils, qc, calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    setProfile: (p: LeadProfile) => {
      current = p;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

const companyInfo = async () => within(await screen.findByRole('region', { name: 'Company info' }));

const INSIGHT = {
  businessSummary: 'Homestead Roofing is a GAF Master Elite residential roofer in Ridgewood, NJ.',
  salesRecommendation: 'Lead with bulk architectural shingle pricing for a high-volume Master Elite shop.',
  talkingPoints: ['Ask how the 4.7 rating is holding up as they add crews.', 'Follow up on late deliveries from the current supplier.'],
  targetContact: { name: 'Eileen Cawley', title: 'Buyer', why: 'signs off on supplier changes' },
  productFocus: ['architectural_shingles'],
  citedFacts: [
    { id: 'F1', text: 'business_name: Homestead Roofing Company' },
    { id: 'F3', text: 'gaf_tier: GAF Master Elite' },
    { id: 'F5', text: 'rating: 4.7 stars from 213 reviews' },
    { id: 'F12', text: 'note (Jordan L., 2026-10-07): Unhappy with late deliveries from their current supplier.' },
    { id: 'F14', text: 'activity (call, connected, 2026-10-12): Asked for a shingle quote.' },
    { id: 'F9', text: 'custom_field: annual_volume_squares = 2400' },
    { id: 'F10', text: 'custom_tag: Bulk buyer' },
    { id: 'F11', text: 'website_summary: Family-run roofer serving Bergen County since 1930.' },
  ],
  model: 'gemini:gemini-3.8-flash',
  promptVersion: 'insights/v1',
  generatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
} satisfies NonNullable<LeadProfile['insights']>;

describe('LeadProfilePage', () => {
  it('shows effective values with Edited and Source changed badges, and Use source reverts', async () => {
    const editedAt = new Date(Date.now() - 3600_000).toISOString();
    const profile = makeProfile();
    profile.fields.phone = field<string | null>('(718) 555-0199', {
      scraped: '(212) 555-0100', overridden: true, sourceChangedSinceEdit: true,
      editedBy: { id: MANAGER.id, name: MANAGER.name }, editedAt,
    });
    const { writes } = setup(profile, { handler: (c) => (c.method === 'DELETE' ? json({ field: 'phone', value: '(212) 555-0100', version: 8, companyVersion: 8 }) : undefined) });

    const info = await companyInfo();
    expect(await info.findByText('(718) 555-0199')).toBeInTheDocument();
    expect(info.queryByText('(212) 555-0100')).toBeNull(); // the scraped value only appears in the source note
    const edited = info.getByText('Edited').parentElement!;
    expect(edited).toHaveAccessibleDescription(/Edited by Alex Morgan/);
    expect(info.getByText(/by Alex Morgan · 1 hour ago/)).toBeInTheDocument();
    expect(info.getByText('Source changed')).toBeInTheDocument();
    const note = info.getByRole('note');
    expect(note).toHaveTextContent('Source changed since your edit: GAF now says “(212) 555-0100”.');

    // Untouched fields show the scraped value with no badge.
    expect(info.getByText('Ridgewood')).toBeInTheDocument();
    expect(info.getAllByText('Edited')).toHaveLength(1);

    await userEvent.click(within(note).getByRole('button', { name: 'Use source' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const del = writes()[0]!;
    expect(del.method).toBe('DELETE');
    expect(del.path).toBe(`/api/leads/${LEAD_ID}/overrides/phone`);
    expect(del.query.get('version')).toBe('7');
  });

  it('on a 409 shows their value, who and when, and Overwrite retries with the new version', async () => {
    let puts = 0;
    const { writes } = setup(makeProfile(), {
      handler: (c) => {
        if (c.method !== 'PUT') return undefined;
        puts++;
        if (puts === 1) {
          return json({
            error: 'version_conflict',
            current: { version: 9, field: 'phone', value: '(646) 555-3333', overridden: true },
            changedBy: { id: MANAGER.id, name: MANAGER.name }, changedByType: 'user',
            changedAt: new Date(Date.now() - 120_000).toISOString(),
          }, 409);
        }
        return json({ field: 'phone', value: '(917) 555-2222', version: 10, companyVersion: 10 });
      },
    });

    const info = await companyInfo();
    await userEvent.click(await info.findByRole('button', { name: 'Edit phone' }));
    const input = info.getByRole('textbox', { name: 'Phone' });
    await userEvent.clear(input);
    await userEvent.type(input, '(917) 555-2222');
    await userEvent.click(info.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Phone changed while you were editing' });
    expect(dialog).toHaveTextContent('Alex Morgan changed this lead 2 minutes ago');
    expect(within(dialog).getByTestId('conflict-theirs')).toHaveTextContent('(646) 555-3333');
    expect(within(dialog).getByTestId('conflict-mine')).toHaveTextContent('(917) 555-2222');
    expect(writes()[0]!.body).toEqual({ value: '(917) 555-2222', version: 7 });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Overwrite with mine' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toHaveLength(2);
    expect(writes()[1]!.body).toEqual({ value: '(917) 555-2222', version: 9 });
    expect(info.queryByRole('textbox', { name: 'Phone' })).toBeNull();
  });

  it('retries silently when only other fields moved, and Use theirs drops the draft', async () => {
    let puts = 0;
    const { writes } = setup(makeProfile(), {
      handler: (c) => {
        if (c.method !== 'PUT') return undefined;
        puts++;
        // City is unchanged on the server (someone edited another field): no dialog, just retry.
        if (puts === 1) return json({ current: { version: 8, field: 'city', value: 'Ridgewood' }, changedBy: null, changedAt: null }, 409);
        if (puts === 2) return json({ field: 'city', value: 'Glen Rock', version: 9, companyVersion: 9 });
        return json({ current: { version: 12, field: 'state', value: 'NY' }, changedBy: null, changedByType: 'pipeline', changedAt: null }, 409);
      },
    });
    const info = await companyInfo();
    await userEvent.click(await info.findByRole('button', { name: 'Edit city' }));
    await userEvent.clear(info.getByRole('textbox', { name: 'City' }));
    await userEvent.type(info.getByRole('textbox', { name: 'City' }), 'Glen Rock{Enter}');
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map((w) => (w.body as { version: number }).version)).toEqual([7, 8]);
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(info.getByRole('button', { name: 'Edit state' }));
    await userEvent.clear(info.getByRole('textbox', { name: 'State' }));
    await userEvent.type(info.getByRole('textbox', { name: 'State' }), 'PA{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The data pipeline changed this lead');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use theirs' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(info.queryByRole('textbox', { name: 'State' })).toBeNull();
    expect(writes()).toHaveLength(3);
  });

  it('validates before saving', async () => {
    const { writes } = setup(makeProfile());
    const info = await companyInfo();
    await userEvent.click(await info.findByRole('button', { name: 'Edit website' }));
    const input = info.getByRole('textbox', { name: 'Website' });
    await userEvent.clear(input);
    await userEvent.type(input, 'not a url{Enter}');
    expect(info.getByText('Enter a web address like https://example.com.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(writes()).toHaveLength(0);
  });

  it('is read-only for a rep on an unallocated lead', async () => {
    const profile = makeProfile({
      allocation: { current: null, history: [] },
      permissions: { canWrite: false, canAllocate: false },
    });
    setup(profile);
    expect(await screen.findByText('Unallocated: ask a manager to assign it to you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Checked/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Serviced/ })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Call/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Log call' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Add follow-up' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(within(screen.getByRole('radiogroup', { name: 'Sales stage' })).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect((await companyInfo()).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.getByRole('button', { name: /Checked/ }).parentElement)
      .toHaveAccessibleDescription('Unallocated lead: view only until a manager assigns it to you.');
  });

  it('renders a pipeline scraped_change row with its field diff', async () => {
    const profile = makeProfile({
      activity: [
        entry({
          id: 'a2', type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline',
          fieldDiff: { fields: ['phone', 'rating'], from: { phone: '(212) 555-0100', rating: 4.5 }, to: { phone: '(718) 555-0199', rating: 4.7 }, run_id: 42 },
        }),
        entry({ id: 'a1', type: 'note', text: 'UI test: asked about shingle pricing' }),
      ],
    });
    setup(profile);
    const feed = within(await screen.findByRole('complementary', { name: 'Activity and notes' }));
    const row = (await feed.findAllByTestId('activity-item')).find((el) => el.dataset.type === 'scraped_change')!;
    expect(row).toHaveTextContent('Data pipeline');
    expect(row).toHaveTextContent('updated phone and rating from the source');
    expect(row).toHaveTextContent('Phone:(212) 555-0100→ changed to (718) 555-0199');
    expect(row).toHaveTextContent('Rating:4.5→ changed to 4.7');
    expect(feed.getByText('UI test: asked about shingle pricing')).toBeInTheDocument();

    await userEvent.click(feed.getByRole('button', { name: 'Notes' }));
    expect(feed.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('posts a note and logs a call with an outcome', async () => {
    const { writes } = setup(makeProfile(), {
      handler: (c) => (c.method === 'POST' ? json({}, 201) : undefined),
    });
    const note = await screen.findByRole('textbox', { name: 'Note' });
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByText('Write something first.')).toBeInTheDocument();
    await userEvent.type(note, 'UI test note');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'POST', path: `/api/leads/${LEAD_ID}/notes`, body: { text: 'UI test note' } });

    const panel = within(screen.getByRole('complementary', { name: 'Activity and notes' }));
    await userEvent.click(panel.getByRole('radio', { name: /Call/ }));
    await userEvent.selectOptions(panel.getByRole('combobox', { name: 'Outcome' }), 'Left voicemail');
    await userEvent.click(panel.getByRole('button', { name: 'Log call' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: `/api/leads/${LEAD_ID}/activities`, body: { type: 'call', outcome: 'Left voicemail' } });
  });

  it('shows the 404 page for a lead outside the territory', async () => {
    setup(null);
    expect(await screen.findByText('This lead isn’t in your territory')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to leads' })).toHaveAttribute('href', '/leads');
  });

  it('toasts "Updated by <name>" and highlights the field when someone else changes the lead', async () => {
    const { qc, setProfile } = setup(makeProfile());
    const info = await companyInfo();
    await info.findByText('(201) 444-2233');

    const next = makeProfile({ version: 8 });
    next.fields.phone = field<string | null>('(201) 444-9999', {
      scraped: '(201) 444-2233', overridden: true, editedBy: { id: MANAGER.id, name: MANAGER.name }, editedAt: new Date().toISOString(),
    });
    setProfile(next);
    act(() => liveEvents.emit({
      id: '1-0', type: 'override.set', companyIds: [LEAD_ID],
      payload: { actor_type: 'user', actor_id: MANAGER.id, field: 'phone', cleared: false }, data: {},
    }));
    // The app-wide stream invalidates the lead; do the same here.
    await act(() => qc.invalidateQueries({ queryKey: qk.leads.detail(LEAD_ID) }));

    expect(await screen.findByText('Updated by Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('Edited Phone')).toBeInTheDocument();
    const value = await info.findByText('(201) 444-9999');
    expect(value.closest('[data-highlighted]')).not.toBeNull();
  });

  it('names the writer from payload.actor_name, even one the profile does not mention', async () => {
    const { qc, setProfile } = setup(makeProfile());
    await (await companyInfo()).findByText('(201) 444-2233');
    setProfile(makeProfile({ version: 8, customFields: { crew_size: 9 } }));
    act(() => liveEvents.emit({
      id: '1-1', type: 'lead.updated', companyIds: [LEAD_ID], actorName: 'Priya Shah',
      payload: { actor_type: 'user', actor_id: 'u-not-on-this-lead', actor_name: 'Priya Shah', fields: ['custom_fields.crew_size'] }, data: {},
    }));
    await act(() => qc.invalidateQueries({ queryKey: qk.leads.detail(LEAD_ID) }));
    expect(await screen.findByText('Updated by Priya Shah')).toBeInTheDocument();
    expect(screen.queryByText('Updated by a teammate')).toBeNull();
  });

  it('falls back to "a teammate" only without actor_name or a known user', async () => {
    const { qc, setProfile } = setup(makeProfile());
    await (await companyInfo()).findByText('(201) 444-2233');
    setProfile(makeProfile({ version: 8, customFields: { crew_size: 9 } }));
    act(() => liveEvents.emit({
      id: '1-2', type: 'lead.updated', companyIds: [LEAD_ID],
      payload: { actor_type: 'user', actor_id: 'u-not-on-this-lead', fields: ['custom_fields.crew_size'] }, data: {},
    }));
    await act(() => qc.invalidateQueries({ queryKey: qk.leads.detail(LEAD_ID) }));
    expect(await screen.findByText('Updated by a teammate')).toBeInTheDocument();
  });

  it('pages "Calls & visits" and "Changes" through the server’s multi-type filter', async () => {
    const call = entry({ id: 'c1', type: 'call', outcome: 'Connected', text: 'Talked to the owner' });
    const olderVisit = entry({ id: 'v0', type: 'visit', text: 'Dropped off samples', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    const { calls } = setup(makeProfile({ activity: [entry({ id: 'n1', type: 'note', text: 'Head note' }), call], activityNextCursor: 'head-cursor' }), {
      handler: (c) => {
        if (!c.path.endsWith('/activity')) return undefined;
        const type = c.query.get('type');
        if (type === 'call,email,visit') {
          return c.query.get('before') === 'p2' ? json({ items: [olderVisit], nextCursor: null }) : json({ items: [call], nextCursor: 'p2' });
        }
        if (type) return json({ items: [entry({ id: 'o1', type: 'override', fieldDiff: { phone: ['a', 'b'] } })], nextCursor: null });
        return json({ items: [], nextCursor: null });
      },
    });
    const feed = within(await screen.findByRole('complementary', { name: 'Activity and notes' }));
    await userEvent.click(feed.getByRole('button', { name: 'Calls & visits' }));
    expect(await feed.findByText('Talked to the owner')).toBeInTheDocument();
    expect(feed.queryByText('Head note')).toBeNull();
    await userEvent.click(await feed.findByRole('button', { name: 'Load older activity' }));
    expect(await feed.findByText('Dropped off samples')).toBeInTheDocument();
    const activityCalls = calls.filter((c) => c.path.endsWith('/activity'));
    expect(activityCalls.map((c) => [c.query.get('type'), c.query.get('before')])).toEqual([
      ['call,email,visit', null], ['call,email,visit', 'p2'],
    ]);

    await userEvent.click(feed.getByRole('button', { name: 'Changes' }));
    expect(await feed.findByText(/edited Phone/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/activity')).at(-1)!.query.get('type'))
      .toBe('stage_changed,override,contact,custom_field,custom_tag,allocation,checked,serviced,scraped_change');
  });

  it('renames and removes custom tag chips live when a tag is renamed or deleted', async () => {
    const addedAt = new Date().toISOString();
    setup(makeProfile({
      customTags: [
        { id: 't1', name: 'Hot', addedBy: { id: REP.id, name: REP.name }, addedAt },
        { id: 't2', name: 'Storm follow-up', addedBy: { id: REP.id, name: REP.name }, addedAt },
      ],
    }), { search: '?tab=tags' });
    const tags = within(await screen.findByRole('region', { name: 'Custom tags' }));
    expect(tags.getByText('Hot')).toBeInTheDocument();

    act(() => liveEvents.emit({
      id: '5-0', type: 'tags.changed', companyIds: [LEAD_ID], actorName: MANAGER.name,
      payload: { actor_type: 'user', actor_id: MANAGER.id, actor_name: MANAGER.name, company_id: LEAD_ID, tag_id: 't1', tag_name: 'Hot lead', previous_name: 'Hot', renamed: true, version: 8 },
      data: {},
    }));
    expect(await tags.findByText('Hot lead')).toBeInTheDocument();
    expect(tags.queryByText('Hot')).toBeNull();
    expect(await screen.findByText('Renamed tag “Hot” to “Hot lead”')).toBeInTheDocument();

    // The tag-level event (no lead) for a delete removes the chip too.
    act(() => liveEvents.emit({
      id: '5-1', type: 'tags.changed', companyIds: [],
      payload: { actor_type: 'user', actor_id: MANAGER.id, actor_name: MANAGER.name, tag_id: 't2', tag_name: 'Storm follow-up', deleted: true },
      data: {},
    }));
    await waitFor(() => expect(tags.queryByText('Storm follow-up')).toBeNull());
    expect(tags.getByText('Hot lead')).toBeInTheDocument();
  });

  it('ignores live events caused by the signed-in user', async () => {
    const { qc } = setup(makeProfile());
    await (await companyInfo()).findByText('(201) 444-2233');
    act(() => liveEvents.emit({
      id: '2-0', type: 'note.added', companyIds: [LEAD_ID], payload: { actor_type: 'user', actor_id: REP.id }, data: {},
    }));
    await act(() => qc.invalidateQueries({ queryKey: qk.leads.detail(LEAD_ID) }));
    expect(screen.queryByText(/Updated by/)).toBeNull();
  });

  it('a new AI insight appears quietly: no toast, no highlight', async () => {
    const { qc, setProfile } = setup(makeProfile());
    await screen.findByRole('region', { name: 'Next steps' });
    // No insight yet: the card offers Generate and nothing else.
    const empty = await screen.findByRole('region', { name: 'AI insights' });
    expect(within(empty).getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    expect(within(empty).queryByText(INSIGHT.businessSummary)).toBeNull();

    setProfile(makeProfile({ insights: INSIGHT }));
    act(() => liveEvents.emit({
      id: '9-0', type: 'lead.updated', companyIds: [LEAD_ID],
      payload: { actor_type: 'pipeline', actor_id: null, fields: ['insights'], material: false, version: 7 }, data: {},
    }));
    // The app-wide stream invalidates the lead; do the same here.
    await act(() => qc.invalidateQueries({ queryKey: qk.leads.detail(LEAD_ID) }));
    const region = await screen.findByRole('region', { name: 'AI insights' });
    expect(within(region).getByText(INSIGHT.businessSummary)).toBeInTheDocument();
    expect(region.querySelector('[data-highlighted]')).toBeNull();
    // Past the fallback window too: still no "Updated by the data pipeline".
    await new Promise((r) => setTimeout(r, 4200));
    expect(screen.queryByText(/^Updated by/)).toBeNull();
  }, 10_000);

  it('attaches an existing tag, creates one inline, removes one, and shows custom fields', async () => {
    const addedAt = new Date().toISOString();
    const profile = makeProfile({
      customTags: [{ id: 't1', name: 'Hot', addedBy: { id: REP.id, name: REP.name }, addedAt }],
      customFields: { next_visit: '2026-10-24', crew_size: 12, buys_metal: true },
    });
    const catalog = [
      { id: 't1', name: 'Hot', createdBy: { id: REP.id, name: REP.name }, createdAt: addedAt, leadCount: 4 },
      { id: 't2', name: 'Storm follow-up', createdBy: { id: MANAGER.id, name: MANAGER.name }, createdAt: addedAt, leadCount: 3 },
    ];
    const { writes } = setup(profile, {
      search: '?tab=tags',
      handler: (c) => {
        if (c.path === '/api/custom-tags' && c.method === 'GET') return json({ items: catalog });
        if (c.path === '/api/custom-tags' && c.method === 'POST') return json({ tag: { id: 't3', name: 'Brand new' }, created: true }, 201);
        if (c.method === 'POST') return json({ tag: { id: 'x', name: 'x' }, added: true, version: 8 }, 201);
        if (c.method === 'DELETE') return json({ removed: true, tagId: 't1', version: 8 });
        return undefined;
      },
    });

    const fields = within(await screen.findByRole('region', { name: 'Custom fields' }));
    expect(fields.getByText('Oct 24, 2026')).toBeInTheDocument();
    expect(fields.getByText('Crew size')).toBeInTheDocument();
    expect(fields.getByText('Yes')).toBeInTheDocument();

    const tags = within(screen.getByRole('region', { name: 'Custom tags' }));
    await userEvent.click(tags.getByRole('button', { name: 'Remove tag Hot' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: `/api/leads/${LEAD_ID}/custom-tags/t1` });

    await userEvent.click(tags.getByRole('button', { name: 'Add tag' }));
    const box = tags.getByRole('combobox', { name: 'Add a custom tag' });
    await userEvent.type(box, 'sto');
    expect(await tags.findByRole('option', { name: /Storm follow-up/ })).toHaveAttribute('aria-selected', 'true');
    expect(tags.queryByRole('option', { name: /Hot/ })).toBeNull(); // already on the lead
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ method: 'POST', path: `/api/leads/${LEAD_ID}/custom-tags`, body: { tagId: 't2' } });

    await userEvent.type(box, 'Brand new');
    await userEvent.click(await tags.findByRole('option', { name: /Create “Brand new”/ }));
    await waitFor(() => expect(writes()).toHaveLength(4));
    expect(writes()[2]).toMatchObject({ method: 'POST', path: '/api/custom-tags', body: { name: 'Brand new' } });
    expect(writes()[3]).toMatchObject({ method: 'POST', path: `/api/leads/${LEAD_ID}/custom-tags`, body: { tagId: 't3' } });
  });
});

describe('LeadProfilePage sales', () => {
  const day = 86_400_000;
  const header = () => screen.getByRole('heading', { level: 1 }).closest('.overflow-hidden') as HTMLElement;

  it('leads with the stage, last contact and the next follow-up, and drops the weather banner for one line', async () => {
    setup(makeProfile({
      salesStage: 'interested',
      stageChangedAt: new Date(Date.now() - 5 * day).toISOString(),
      lastContactedAt: new Date(Date.now() - 3 * day).toISOString(),
      tasks: [
        task({ id: 't2', title: 'Send the TPO price sheet', dueAt: new Date(Date.now() + 5 * day).toISOString() }),
        task({ id: 't1', title: 'Call Mike about underlayment quote', dueAt: new Date(Date.now() + day).toISOString() }),
      ],
    }));
    await screen.findByRole('heading', { level: 1, name: 'Homestead Roofing Company' });
    const h = within(header());
    expect(h.getByRole('radio', { name: 'Interested' })).toHaveAttribute('aria-checked', 'true');
    expect(h.getAllByRole('radio').map((r) => r.textContent)).toEqual(['New', 'Contacted', 'Interested', 'Quoting', 'Won', 'Not a fit']);
    expect(header()).toHaveTextContent('Last contacted 3 days ago');
    expect(header()).toHaveTextContent('Next follow-up Tomorrow: Call Mike about underlayment quote');
    expect(h.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:2014442233');
    // Who to ask for, one click away.
    expect(h.getByText('Eileen Cawley')).toBeInTheDocument();
    expect(h.getByRole('link', { name: /\(201\) 444-2233/ })).toHaveAttribute('href', 'tel:2014442233');
    // Weather: one line in the strip, the rest on the last tab.
    expect(screen.queryByText(/Why now/)).toBeNull();
    expect(h.getByText('Recent storm activity')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.at(-1)).toBe('Weather');
    await userEvent.click(h.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('tab', { name: 'Weather' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says when nothing is scheduled and the lead was never contacted', async () => {
    setup(makeProfile());
    await screen.findByRole('heading', { level: 1 });
    expect(header()).toHaveTextContent('Not contacted yet');
    expect(header()).toHaveTextContent('No follow-up scheduled');
    expect(within(header()).getByRole('radio', { name: 'New' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves the stage with the profile version, and shows the server’s stage on a 409', async () => {
    let puts = 0;
    const { writes, setProfile } = setup(makeProfile({ salesStage: 'contacted' }), {
      handler: (c) => {
        if (c.method !== 'PUT' || !c.path.endsWith('/stage')) return undefined;
        puts++;
        if (puts === 1) return json({ stage: 'quoting', version: 8, stageChangedAt: new Date().toISOString() });
        return json({ error: 'version_conflict', current: { version: 11, stage: 'won' } }, 409);
      },
    });
    const group = within(await screen.findByRole('radiogroup', { name: 'Sales stage' }));
    setProfile(makeProfile({ salesStage: 'quoting', version: 8 }));
    await userEvent.click(group.getByRole('radio', { name: 'Quoting' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PUT', path: `/api/leads/${LEAD_ID}/stage`, body: { stage: 'quoting', version: 7 } });
    expect(group.getByRole('radio', { name: 'Quoting' })).toHaveAttribute('aria-checked', 'true');

    setProfile(makeProfile({ salesStage: 'won', version: 11 }));
    await userEvent.click(group.getByRole('radio', { name: 'Not a fit' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]!.body).toEqual({ stage: 'lost', version: 8 });
    expect(await screen.findByText('Someone else just updated this lead')).toBeInTheDocument();
    expect(group.getByRole('radio', { name: 'Won' })).toHaveAttribute('aria-checked', 'true');
  });

  it('lists next steps with overdue ones flagged, completes one with undo, and folds away done ones', async () => {
    const overdue = task({ id: 't1', title: 'Call Mike about underlayment quote', dueAt: new Date(Date.now() - 2 * day).toISOString(), version: 3 });
    const later = task({ id: 't2', title: 'Drop off TPO samples', type: 'visit', dueAt: new Date(Date.now() + 9 * day).toISOString() });
    const done = task({ id: 't0', title: 'Intro call', doneAt: new Date(Date.now() - day).toISOString() });
    const { writes } = setup(makeProfile({ tasks: [overdue, later, done] }), {
      handler: (c) => (c.method === 'PATCH' ? json({ task: { ...overdue, doneAt: new Date().toISOString(), version: 4 } }) : undefined),
    });
    const card = within(await screen.findByRole('region', { name: 'Next steps' }));
    const rows = card.getAllByTestId('task-row');
    expect(rows.map((r) => within(r).getByText(/Mike|samples/).textContent)).toEqual(['Call Mike about underlayment quote', 'Drop off TPO samples']);
    expect(within(rows[0]!).getByText(/^Overdue · due/)).toHaveClass('text-roof');
    expect(card.getByText('2 open, 1 overdue')).toBeInTheDocument();
    expect(card.getByText('Done (1)').closest('details')).not.toHaveAttribute('open');

    await userEvent.click(card.getByRole('checkbox', { name: 'Mark “Call Mike about underlayment quote” done' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: '/api/tasks/t1', body: { done: true, version: 3 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: '/api/tasks/t1', body: { done: false, version: 4 } });
  });

  it('reschedules from the row menu and removes a follow-up', async () => {
    const t = task({ id: 't1', title: 'Call Mike', dueAt: new Date(Date.now() - day).toISOString(), version: 2 });
    let setServed: (p: ReturnType<typeof makeProfile>) => void = () => {};
    const { writes, setProfile } = setup(makeProfile({ tasks: [t] }), {
      handler: (c) => {
        if (c.method === 'PATCH') {
          const moved = { ...t, dueAt: (c.body as { dueAt: string }).dueAt, version: 3 };
          setServed(makeProfile({ tasks: [moved] }));
          return json({ task: moved });
        }
        if (c.method === 'DELETE') return json({ deleted: true, id: 't1' });
        return undefined;
      },
    });
    setServed = setProfile;
    const card = within(await screen.findByRole('region', { name: 'Next steps' }));
    await userEvent.click(card.getByRole('button', { name: 'Reschedule or remove “Call Mike”' }));
    await userEvent.click(card.getByRole('menuitem', { name: 'Tomorrow' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const body = writes()[0]!.body as { dueAt: string; version: number };
    expect(body.version).toBe(2);
    const tomorrow = new Date(Date.now() + day);
    expect(new Date(body.dueAt).toDateString()).toBe(tomorrow.toDateString());
    expect(new Date(body.dueAt).getHours()).toBe(new Date(t.dueAt).getHours());
    expect(await card.findByText(/^Tomorrow/)).toBeInTheDocument();

    await userEvent.click(card.getByRole('button', { name: 'Reschedule or remove “Call Mike”' }));
    await userEvent.click(card.getByRole('menuitem', { name: 'Remove follow-up' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ method: 'DELETE', path: '/api/tasks/t1' });
    expect(writes()[1]!.query.get('version')).toBe('3');
  });

  it('opens the shared log-call dialog and the quick add from the header', async () => {
    setup(makeProfile());
    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(within(header()).getByRole('button', { name: 'Log call' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log call with Homestead Roofing Company' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save log' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(within(header()).getByRole('button', { name: 'Add follow-up' }));
    const card = within(screen.getByRole('region', { name: 'Next steps' }));
    expect(card.getByTestId('quick-add')).toHaveAttribute('data-lead', LEAD_ID);
    await userEvent.click(card.getByRole('button', { name: 'Save follow-up' }));
    expect(card.queryByTestId('quick-add')).toBeNull();
  });

  it('shows stage changes and follow-ups in the timeline, with a Follow-ups filter', async () => {
    const { calls } = setup(makeProfile({
      activity: [
        entry({ id: 'a1', type: 'stage_changed', fieldDiff: { sales_stage: ['contacted', 'interested'] } }),
        entry({ id: 'a2', type: 'task_created', fieldDiff: { task_id: 't1', title: 'Call Mike', type: 'call', due_at: new Date(Date.now() + day).toISOString(), assignee_id: REP.id } }),
      ],
    }), {
      handler: (c) => (c.path.endsWith('/activity') && c.query.get('type')?.startsWith('task_')
        ? json({ items: [entry({ id: 'a3', type: 'task_completed', fieldDiff: { task_id: 't0', title: 'Intro call', type: 'call', due_at: new Date().toISOString(), assignee_id: REP.id } })], nextCursor: null })
        : undefined),
    });
    const feed = within(await screen.findByRole('complementary', { name: 'Activity and notes' }));
    expect(await feed.findByText(/moved this lead from Contacted to Interested/)).toBeInTheDocument();
    expect(feed.getByText(/added a call follow-up for Tomorrow/)).toBeInTheDocument();
    expect(feed.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((b) => b.textContent))
      .toEqual(['All', 'Calls & visits', 'Notes', 'Follow-ups', 'Changes']);
    await userEvent.click(feed.getByRole('button', { name: 'Follow-ups' }));
    expect(await feed.findByText('Intro call')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/activity')).at(-1)!.query.get('type')).toBe('task_created,task_completed,task_updated,task_deleted');
  });

  it('shows a teammate’s follow-up with their name for a manager', async () => {
    setup(makeProfile({ tasks: [task({ id: 't1', title: 'Visit the yard', assignee: { id: REP.id, name: REP.name } })], contacts: [contact({ id: 'c1', isTarget: true })] }), { user: MANAGER });
    const row = (await screen.findAllByTestId('task-row'))[0]!;
    expect(row).toHaveTextContent(REP.name);
  });

  it('shows AI insights as one card: summary, how to approach, talking points, and it collapses as a whole', async () => {
    const user = userEvent.setup();
    const { unmount } = setup(makeProfile({ insights: INSIGHT }));
    const region = await screen.findByRole('region', { name: 'AI insights' });
    const ins = within(region);
    // With nothing scheduled the card comes before the empty Next steps card, so the pitch is above the fold on a
    // phone (Section 4 product review L6).
    const next = screen.getByRole('region', { name: 'Next steps' });
    expect(next.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(ins.getByRole('heading', { name: 'AI insights', level: 2 })).toHaveClass('text-sm', 'font-semibold');

    // Expanded by default, everything together in reading order; no More row.
    const toggle = ins.getByRole('button', { name: 'AI insights' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body).toBeVisible();
    expect(ins.queryByRole('button', { name: /More/ })).toBeNull();
    const order = [INSIGHT.businessSummary, 'How to approach', INSIGHT.salesRecommendation, 'Talking points', INSIGHT.talkingPoints[0]!];
    const at = order.map((t) => body.textContent!.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(ins.getByRole('heading', { name: 'How to approach', level: 3 })).not.toHaveClass('uppercase');
    expect(ins.getByRole('heading', { name: 'Talking points', level: 3 })).not.toHaveClass('uppercase');
    expect(ins.getAllByRole('listitem').map((li) => li.textContent)).toEqual(INSIGHT.talkingPoints);
    expect(ins.getByText(/^Ask for/).closest('p')).toHaveTextContent('Ask for Eileen Cawley, Buyer · signs off on supplier changes');

    // The provenance lines are gone: no model, prompt, facts, product focus or "Generated".
    for (const gone of [/gemini/, /Prompt/, /Based on/, /Focus:/, /Generated/, /architectural shingles/]) {
      expect(region).not.toHaveTextContent(gone);
    }

    // Keyboard toggles the whole body, and the choice is remembered on the next visit.
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).not.toBeVisible();
    expect(localStorage.getItem('leadmaker.profile.insights.open')).toBe('0');
    unmount();
    setup(makeProfile({ insights: INSIGHT }));
    const again = within(await screen.findByRole('region', { name: 'AI insights' }));
    const toggle2 = again.getByRole('button', { name: 'AI insights' });
    expect(toggle2).toHaveAttribute('aria-expanded', 'false');
    expect(again.getByText(INSIGHT.businessSummary)).not.toBeVisible();
    await user.click(toggle2);
    expect(toggle2).toHaveAttribute('aria-expanded', 'true');
    expect(again.getByText(INSIGHT.businessSummary)).toBeVisible();
    expect(localStorage.getItem('leadmaker.profile.insights.open')).toBe('1');
  });

  it('still renders when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      setup(makeProfile({ insights: INSIGHT }));
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      const toggle = ins.getByRole('button', { name: 'AI insights' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('puts AI insights under Next steps when something is scheduled', async () => {
    setup(makeProfile({
      insights: INSIGHT,
      tasks: [task({ id: 't1', title: 'Call Mike about underlayment quote', dueAt: new Date(Date.now() + day).toISOString() })],
    }));
    const region = await screen.findByRole('region', { name: 'AI insights' });
    const next = screen.getByRole('region', { name: 'Next steps' });
    expect(next.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers Generate when there is no insight, or one with no summary or pitch', async () => {
    const { unmount } = setup(makeProfile({ insights: { ...INSIGHT, businessSummary: ' ', salesRecommendation: '' } }));
    const region = await screen.findByRole('region', { name: 'AI insights' });
    const ins = within(region);
    expect(ins.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    expect(ins.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(ins.queryByRole('button', { name: 'AI insights' })).toBeNull(); // nothing to collapse
    expect(region).toHaveTextContent('No AI insights for this lead yet.');
    expect(ins.queryByText('Talking points')).toBeNull();
    unmount();
    setup(makeProfile({ insights: null }));
    expect(within(await screen.findByRole('region', { name: 'AI insights' })).getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });

  describe('Refresh', () => {
    const REFRESH = `/api/leads/${LEAD_ID}/insights/refresh`;
    const accepted = (requestedAt = new Date().toISOString()) => json({ jobId: 41, requestedAt, merged: false }, 202);
    const fresh = (over: Partial<NonNullable<LeadProfile['insights']>> = {}) => ({
      ...INSIGHT,
      businessSummary: 'Homestead Roofing is adding a second crew and is tagged Bulk buyer.',
      generatedAt: new Date(Date.now() + 1000).toISOString(),
      ...over,
    });

    it('regenerates in place: Updating… with the text dimmed, then the new text and Updated; the card stays open', async () => {
      const user = userEvent.setup();
      const { calls, setProfile } = setup(makeProfile({ insights: INSIGHT }), {
        handler: (c) => (c.method === 'POST' && c.path === REFRESH ? accepted() : undefined),
      });
      const region = await screen.findByRole('region', { name: 'AI insights' });
      const ins = within(region);
      const toggle = ins.getByRole('button', { name: 'AI insights' });
      const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      const button = ins.getByRole('button', { name: 'Refresh' });
      expect(button).toHaveAttribute('data-phase', 'idle');

      await user.click(button);
      // Its own click target: the card does not collapse.
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(body).toBeVisible();
      expect(button).toHaveTextContent('Updating…');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button.querySelector('svg')).toHaveClass('animate-spin');
      // The old text stays, dimmed, until the new insight is in.
      expect(ins.getByText(INSIGHT.businessSummary)).toBeVisible();
      expect(body).toHaveClass('opacity-60');
      expect(region).toHaveAttribute('aria-busy', 'true');
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1));
      await user.click(button); // ignored while waiting
      expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1);
      expect(calls.find((c) => c.path === REFRESH)!.method).toBe('POST');

      // The job writes a newer insight; the 3 s poll (or the live event) brings it in.
      const before = calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length;
      setProfile(makeProfile({ insights: fresh() }));
      expect(await ins.findByText(fresh().businessSummary, {}, { timeout: 4500 })).toBeVisible();
      expect(calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length).toBeGreaterThan(before);
      expect(button).toHaveTextContent('Updated');
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(body).not.toHaveClass('opacity-60');
      expect(region).not.toHaveAttribute('aria-busy');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByText(/^Updated by/)).toBeNull(); // no toast for it
      // Then it reads Refresh again.
      await waitFor(() => expect(button).toHaveTextContent('Refresh'), { timeout: 3500 });
      expect(button).toHaveAttribute('data-phase', 'idle');
    }, 15_000);

    it('a refused request (429) shows one neutral line, even on a collapsed card, and Refresh can be tried again', async () => {
      const user = userEvent.setup();
      let n = 0;
      const { calls } = setup(makeProfile({ insights: INSIGHT }), {
        handler: (c) => {
          if (c.method !== 'POST' || c.path !== REFRESH) return undefined;
          return ++n === 1
            ? new Response(JSON.stringify({ error: 'rate_limited', retryAfterMs: 60_000 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } })
            : json({ error: 'internal_error' }, 500);
        },
      });
      const region = await screen.findByRole('region', { name: 'AI insights' });
      const ins = within(region);
      const toggle = ins.getByRole('button', { name: 'AI insights' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(ins.getByRole('button', { name: 'Refresh' }));
      expect(await ins.findByRole('alert')).toHaveTextContent('Couldn’t refresh right now. Try again in a moment.');
      expect(toggle).toHaveAttribute('aria-expanded', 'false'); // still collapsed
      expect(region).not.toHaveTextContent(/quota|limit|3:00|resets|too many/i);
      expect(screen.queryByText(/Too many requests/)).toBeNull(); // no toast either
      const again = ins.getByRole('button', { name: 'Refresh' });
      expect(again).toHaveAttribute('data-phase', 'error');

      await user.click(again);
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(2));
      expect(await ins.findByRole('alert')).toHaveTextContent('Couldn’t refresh right now. Try again in a moment.');
    });

    it('gives up after 100 s without a newer insight, with the same line', async () => {
      const { calls } = setup(makeProfile({ insights: INSIGHT }), {
        handler: (c) => (c.method === 'POST' && c.path === REFRESH ? accepted() : undefined),
      });
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(ins.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1));
        await act(() => vi.advanceTimersByTimeAsync(95_000));
        expect(ins.getByRole('button', { name: 'Updating…' })).toBeInTheDocument();
        expect(ins.queryByRole('alert')).toBeNull();
        await act(() => vi.advanceTimersByTimeAsync(6_000));
        expect(ins.getByRole('alert')).toHaveTextContent('Couldn’t refresh right now. Try again in a moment.');
        expect(ins.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
        expect(ins.getByText(INSIGHT.businessSummary)).toBeVisible(); // the old text stays
        // Polling stopped with it.
        const polls = calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length;
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        expect(calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length).toBe(polls);
      } finally {
        vi.useRealTimers();
      }
    }, 15_000);

    const withAttempt = (p: LeadProfile, attempt: LeadProfile['insightAttempt']): LeadProfile =>
      Object.assign(p, { insightAttempt: attempt });

    it('a run that ends in error (insightAttempt after requestedAt) shows the neutral line within seconds', async () => {
      const user = userEvent.setup();
      const requestedAt = new Date().toISOString();
      // An earlier run's error, before this request: it must not end the wait.
      const stale = { status: 'error' as const, at: new Date(Date.now() - 60_000).toISOString() };
      // The retry is queued after this run's error, so that error must not end the retry's wait.
      const retryAt = new Date(Date.parse(requestedAt) + 5000).toISOString();
      let posts = 0;
      const { calls, setProfile } = setup(withAttempt(makeProfile({ insights: INSIGHT }), stale), {
        handler: (c) => (c.method === 'POST' && c.path === REFRESH ? accepted(++posts === 1 ? requestedAt : retryAt) : undefined),
      });
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      await user.click(ins.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1));
      // The poll's refetch still carries the stale error: still waiting.
      setProfile(withAttempt(makeProfile({ insights: INSIGHT }), stale));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(ins.getByRole('button', { name: 'Updating…' })).toBeInTheDocument();
      expect(ins.queryByRole('alert')).toBeNull();

      // The worker writes this run's error row; the live event or the 3 s poll refetches the profile.
      const t0 = Date.now();
      setProfile(withAttempt(makeProfile({ insights: INSIGHT }), {
        status: 'error', at: new Date(Date.parse(requestedAt) + 4000).toISOString(),
      }));
      expect(await ins.findByRole('alert', {}, { timeout: 4500 })).toHaveTextContent(
        'Couldn’t update the insights this time. Try again.',
      );
      expect(Date.now() - t0).toBeLessThan(5000); // seconds, not the 100 s timeout
      expect(ins.getByRole('alert')).not.toHaveTextContent(/quota|limit|3:00|resets/i);
      const again = ins.getByRole('button', { name: 'Refresh' });
      expect(again).toHaveAttribute('data-phase', 'error');
      expect(again).not.toHaveAttribute('aria-disabled');
      expect(ins.getByText(INSIGHT.businessSummary)).toBeVisible(); // the old text stays

      // Polling stopped, and Refresh works again: this time the insight lands.
      const polls = calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length;
      await act(() => new Promise((r) => setTimeout(r, 3500)));
      expect(calls.filter((c) => c.method === 'GET' && c.path === `/api/leads/${LEAD_ID}`).length).toBe(polls);
      await user.click(again);
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(2));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(ins.queryByRole('alert')).toBeNull();
      expect(ins.getByRole('button', { name: 'Updating…' })).toBeInTheDocument();
      const landed = fresh({ generatedAt: new Date(Date.parse(retryAt) + 3000).toISOString() });
      setProfile(withAttempt(makeProfile({ insights: landed }), { status: 'ok', at: landed.generatedAt }));
      expect(await ins.findByText(landed.businessSummary, {}, { timeout: 4500 })).toBeVisible();
      expect(ins.getByRole('button', { name: 'Updated' })).toBeInTheDocument();
    }, 20_000);

    it('an error already on the profile when the request answers ends the wait at once', async () => {
      const user = userEvent.setup();
      const requestedAt = new Date(Date.now() - 2000).toISOString();
      // The run failed before the POST's answer was read (e.g. a merged job): the next refetch already says so.
      const { setProfile } = setup(makeProfile({ insights: INSIGHT }), {
        handler: (c) => {
          if (c.method !== 'POST' || c.path !== REFRESH) return undefined;
          setProfile(withAttempt(makeProfile({ insights: INSIGHT }), { status: 'error', at: new Date().toISOString() }));
          return accepted(requestedAt);
        },
      });
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      await user.click(ins.getByRole('button', { name: 'Refresh' }));
      expect(await ins.findByRole('alert', {}, { timeout: 4500 })).toHaveTextContent(
        'Couldn’t update the insights this time. Try again.',
      );
    }, 10_000);

    it('an ok attempt without a newer insight keeps waiting (only an error or the insight ends it)', async () => {
      const user = userEvent.setup();
      const requestedAt = new Date().toISOString();
      const { calls, setProfile } = setup(makeProfile({ insights: INSIGHT }), {
        handler: (c) => (c.method === 'POST' && c.path === REFRESH ? accepted(requestedAt) : undefined),
      });
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      await user.click(ins.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1));
      setProfile(withAttempt(makeProfile({ insights: INSIGHT }), { status: 'ok', at: INSIGHT.generatedAt }));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(ins.getByRole('button', { name: 'Updating…' })).toBeInTheDocument();
      expect(ins.queryByRole('alert')).toBeNull();
    });

    it('a do-not-contact lead gets no Refresh or Generate (the worker never sends it to the model)', async () => {
      const dnc = (insights: LeadProfile['insights']) => {
        const p = makeProfile({ insights });
        return { ...p, details: { ...p.details, accountStatus: 'do_not_contact' as const } };
      };
      const { unmount } = setup(dnc(INSIGHT));
      const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
      expect(ins.getByText(INSIGHT.businessSummary)).toBeVisible();
      expect(ins.queryByRole('button', { name: 'Refresh' })).toBeNull();
      unmount();
      setup(dnc(null));
      await screen.findByRole('region', { name: 'Next steps' });
      expect(screen.queryByRole('region', { name: 'AI insights' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
    });

    it('Generate on a lead without an insight: Generating…, then the card fills in and offers Refresh', async () => {
      const user = userEvent.setup();
      const { calls, setProfile } = setup(makeProfile(), {
        handler: (c) => (c.method === 'POST' && c.path === REFRESH ? accepted() : undefined),
      });
      const region = await screen.findByRole('region', { name: 'AI insights' });
      const ins = within(region);
      await user.click(ins.getByRole('button', { name: 'Generate' }));
      expect(ins.getByRole('button', { name: 'Generating…' })).toHaveAttribute('aria-disabled', 'true');
      await waitFor(() => expect(calls.filter((c) => c.path === REFRESH)).toHaveLength(1));
      setProfile(makeProfile({ insights: fresh() }));
      const filled = within(await screen.findByRole('region', { name: 'AI insights' }));
      expect(await filled.findByText(fresh().businessSummary, {}, { timeout: 4500 })).toBeVisible();
      expect(filled.getByRole('button', { name: 'AI insights' })).toHaveAttribute('aria-expanded', 'true');
      expect(filled.getByRole('heading', { name: 'Talking points' })).toBeInTheDocument();
    }, 10_000);
  });

  it('renders an older insight body (one-sentence pitch, no talking points or facts) without crashing', async () => {
    setup(makeProfile({
      insights: {
        businessSummary: 'Family-run residential roofer.', salesRecommendation: 'Lead with the shingle promo.',
        generatedAt: new Date().toISOString(), model: 'claude', promptVersion: 'v2',
      } as LeadProfile['insights'],
    }));
    const region = await screen.findByRole('region', { name: 'AI insights' });
    const ins = within(region);
    expect(ins.getByText('Lead with the shingle promo.')).toBeVisible();
    expect(ins.getByText('Family-run residential roofer.')).toBeVisible();
    expect(ins.getByRole('heading', { name: 'How to approach' })).toBeInTheDocument();
    expect(ins.queryByText('Talking points')).toBeNull();
    expect(ins.queryByText(/Ask for/)).toBeNull();
    expect(region).not.toHaveTextContent(/Generated|claude|Prompt/);
  });

  it('shows a multi-sentence pitch whole, as one paragraph', async () => {
    const pitch = 'They run storm crews out of Garfield, so stock-outs after a hailstorm cost them jobs. Open with how fast we can drop tarps and ice & water shield on site. Then ask who handles their reorders.';
    setup(makeProfile({ insights: { ...INSIGHT, salesRecommendation: pitch } }));
    const ins = within(await screen.findByRole('region', { name: 'AI insights' }));
    expect(ins.getByText(pitch).tagName).toBe('P');
  });
});

describe('displayCustomValue', () => {
  it('formats calendar dates without a timezone shift', () => {
    expect(displayCustomValue('2026-10-24')).toBe('Oct 24, 2026');
    expect(displayCustomValue(1200)).toBe('1,200');
    expect(displayCustomValue(false)).toBe('No');
  });
});
