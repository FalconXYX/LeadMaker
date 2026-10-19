import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadFilter, SessionUser } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';
import { DashboardPage } from '@/features/dashboard';
import {
  MANAGER, REP, REP2, dashboardBody, daysAgo, json, makeBrief, makeContact, makeLead, makeProfile, makeTask, signalsResponse, testToken,
} from './fixtures';

// Leaflet needs a real layout engine; the map itself is covered by screenshots, not jsdom.
vi.mock('@/components/map/BaseMap', () => ({
  BaseMap: ({ label }: { label: string }) => <div role="region" aria-label={label} />,
}));
// The tasks feature owns the dialog; here it only has to open for the right lead.
vi.mock('@/features/tasks', () => ({
  LogActivityDialog: ({ leadName, open }: { leadName: string; open: boolean }) =>
    (open ? <div role="dialog" aria-label={`Log activity for ${leadName}`} /> : null),
}));

const overdueLead = makeLead({ businessName: 'Bergen Roofing', city: 'Paramus', salesStage: 'interested', lastContactedAt: daysAgo(3) });
const todayLead = makeLead({ businessName: 'Garden State Roofing', city: 'Clifton', salesStage: 'contacted' });
const quote = makeLead({ businessName: 'Quote Pending Roofing', salesStage: 'quoting', lastContactedAt: daysAgo(10), priorityScore: 60 });
const fresh = makeLead({ businessName: 'Fresh Roofing Co', updatedInLastPoll: true, priorityScore: 80 });
const overdue = makeTask({ companyId: overdueLead.id, companyName: overdueLead.businessName, dueAt: daysAgo(2), title: 'Call Mike about the TPO quote' });
const dueToday = makeTask({ companyId: todayLead.id, companyName: todayLead.businessName, dueAt: new Date(new Date().setHours(23, 0, 0, 0)).toISOString() });
const profiles = new Map([
  [overdueLead.id, makeProfile(overdueLead, { contacts: [makeContact({ id: 'c1', name: 'Mike Russo', title: 'Owner', phone: '2015550111', isTarget: true })] })],
  [todayLead.id, makeProfile(todayLead)],
  [quote.id, makeProfile(quote)],
  [fresh.id, makeProfile(fresh)],
]);

let fetchMock: ReturnType<typeof vi.fn>;
let searches: LeadFilter[];

interface Options {
  /** GET /api/territory-brief; the default is no brief yet ({brief: null}). */
  brief?: (scope: string | null) => Response | Promise<Response>;
}

function install(user: SessionUser, opts: Options = {}) {
  searches = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname;
    if (p === '/api/me') return json(user);
    if (p === '/api/config') return json({ weeklyActivityGoal: 25 });
    if (p === '/api/dashboard') {
      const scope = u.searchParams.get('scope');
      return json(dashboardBody({
        scope: scope as 'mine',
        ...(scope === 'team' ? {
          activity: { ...dashboardBody().activity, goalPerWeek: 50 },
          reps: [
            { rep: { id: REP.id, name: REP.name }, assigned: 50, pipeline: dashboardBody().pipeline, activityThisWeek: 16, overdue: 2, wonThisMonth: 1 },
            { rep: { id: REP2.id, name: REP2.name }, assigned: 48, pipeline: dashboardBody().pipeline, activityThisWeek: 27, overdue: 0, wonThisMonth: 3 },
          ],
        } : {}),
      }));
    }
    if (p === '/api/tasks') {
      const due = u.searchParams.get('due');
      return json({ items: due === 'overdue' ? [overdue] : due === 'today' ? [dueToday] : [], nextCursor: null });
    }
    if (p.startsWith('/api/tasks/') && init?.method === 'PATCH') return json({ task: { ...overdue, ...JSON.parse(String(init.body)), version: 2 } });
    if (p === '/api/leads/search') {
      const { filter } = JSON.parse(String(init?.body)) as { filter: LeadFilter };
      searches.push(filter);
      const items = filter.sort?.by === 'last_contacted' ? [overdueLead, quote]
        : filter.stages?.includes('quoting') ? [quote]
        : filter.updatedInLastPoll ? [fresh]
        : [];
      return json({ items, nextCursor: null, total: items.length, totalCapped: false });
    }
    const lead = p.match(/^\/api\/leads\/([^/]+)$/);
    if (lead) return profiles.has(lead[1]!) ? json(profiles.get(lead[1]!)) : json({ error: 'not_found' }, 404);
    if (p.endsWith('/activity')) {
      return json({ items: [{ id: 'a1', type: 'call', actorType: 'user', user: { id: REP.id, name: REP.name }, actorLabel: REP.name, outcome: 'connected', text: 'Wants TPO samples', fieldDiff: null, createdAt: daysAgo(1) }], nextCursor: null });
    }
    if (p === '/api/signals') return json(signalsResponse());
    if (p === '/api/territory-brief') return opts.brief ? opts.brief(u.searchParams.get('scope')) : json({ brief: null });
    if (p === '/api/leads/map') return json({ items: [] });
    if (p === '/api/users') return json({ items: [{ ...REP, allocatedCount: 50 }, { ...REP2, allocatedCount: 48 }, { ...MANAGER, allocatedCount: 0 }] });
    if (p === '/api/kpis') {
      const k = { allocated: 0, unchecked: 0, unserviced: 0, updated_in_last_poll: 0 };
      return json({ mine: k, team: { refreshedAt: null, totals: k, unallocated: { ...k, allocated: 274 }, reps: [] } });
    }
    return json({ error: 'not_found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  act(() => sessionStore.set({ token: testToken(), user }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

function renderPage(path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}><DashboardPage /></MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const calls = (pred: (url: URL, init?: RequestInit) => boolean) =>
  fetchMock.mock.calls.filter(([url, init]) => pred(new URL(String(url), 'http://localhost'), init as RequestInit | undefined));

describe('DashboardPage (rep)', () => {
  beforeEach(() => install(REP));

  it('greets the rep, says where to start and ranks today’s call list', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening), Jordan$/);
    expect(await screen.findByText('Start with 2 overdue follow-ups, 3 due today and 1 warm deal gone quiet.')).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Today’s call list' });
    // Three leads at first; the fourth is one click away.
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const toggle = await screen.findByRole('button', { name: 'Show 1 more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4));
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getAllByRole('link')[0]!.textContent)).toEqual([
      'Bergen Roofing', 'Garden State Roofing', 'Quote Pending Roofing', 'Fresh Roofing Co',
    ]);
    expect(rows[0]).toHaveTextContent('Follow-up 2 days overdue');
    expect(rows[0]).toHaveTextContent('Call Mike about the TPO quote');
    expect(await within(rows[0]!).findByText('Mike Russo')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'Call Bergen Roofing' })).toHaveAttribute('href', 'tel:2015550111');
    expect(rows[2]).toHaveTextContent('Quote out, no contact in 10 days');
    expect(within(rows[2]!).getByRole('button', { name: /Follow up/ })).toBeInTheDocument();

    // No live/updated pill and no icon tiles: plain sales numbers that link to their leads.
    expect(screen.queryByText(/^Live\b/)).toBeNull();
    expect(screen.queryByText(/updated .* ago/i)).toBeNull();
    const overdueLink = await screen.findByRole('link', { name: /^2\s*Overdue/ });
    expect(overdueLink.getAttribute('href')).toMatch(/^\/leads\?scope=mine&.*overdue/);
    expect(screen.getByRole('link', { name: 'Quoting: 4 leads' }).getAttribute('href')).toMatch(/stage=quoting|stages=quoting/);
    expect(screen.getByRole('link', { name: /Win back 3 lapsed accounts/ })).toHaveAttribute('href', '/leads?scope=mine&status=lapsed_customer&sort=priority_score%3Adesc');
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('of 25 goal')).toBeInTheDocument();
    expect(screen.getByText('Decision-maker found')).toBeInTheDocument();
    expect(await screen.findAllByText('Wants TPO samples', { exact: false })).toHaveLength(2);
    expect(screen.getByText('No weather alerts in your counties right now.')).toBeInTheDocument();

    // Bounded reads only.
    expect(searches.every((f) => !f.cursor && (f.limit ?? 0) <= 50)).toBe(true);
    expect(searches).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'mine', stages: ['interested', 'quoting'], notContactedSince: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
      expect.objectContaining({ scope: 'mine', stages: ['new'], updatedInLastPoll: true }),
      expect.objectContaining({ scope: 'mine', stages: ['new'], segment: ['strategic'] }),
    ]));
    expect(calls((u) => u.pathname === '/api/users' || u.pathname === '/api/kpis')).toHaveLength(0);
  });

  it('puts Follow-ups beside the briefing, once, ahead of the scorecard', async () => {
    renderPage();
    const briefing = await screen.findByRole('region', { name: 'Today’s briefing' });
    const followUps = screen.getAllByRole('heading', { level: 2, name: 'Follow-ups' });
    expect(followUps).toHaveLength(1);
    const card = followUps[0]!.closest('.lg\\:col-span-2')!;
    // One row: the briefing takes 3 of 5 columns on desktop, Follow-ups the other 2; phones stack them in this order.
    expect(card.parentElement).toBe(briefing.parentElement);
    expect(briefing.parentElement).toHaveClass('grid', 'items-start', 'lg:grid-cols-5');
    expect(briefing).toHaveClass('lg:col-span-3');
    expect(briefing.nextElementSibling).toBe(card);
    expect(await within(card as HTMLElement).findByRole('link', { name: /^2\s*Overdue/ })).toBeInTheDocument();
    const activity = screen.getByRole('heading', { level: 2, name: 'Activity this week' });
    expect(card.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.contains(activity)).toBe(false);
  });

  it('reschedules a follow-up and opens the log-a-call dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Today’s call list' });
    const first = (await within(list).findAllByRole('listitem'))[0]!;
    await user.click(within(first).getByRole('button', { name: 'Log call' }));
    expect(screen.getByRole('dialog', { name: 'Log activity for Bergen Roofing' })).toBeInTheDocument();

    await user.click(within(first).getByRole('button', { name: /Reschedule/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Tomorrow' }));
    await waitFor(() => expect(calls((_u, init) => init?.method === 'PATCH')).toHaveLength(1));
    const [[url, init]] = calls((_u, i) => i?.method === 'PATCH') as [[string, RequestInit]];
    expect(url).toBe(`/api/tasks/${overdue.id}`);
    const body = JSON.parse(String(init.body)) as { dueAt: string; version: number };
    expect(body.version).toBe(1);
    expect(new Date(body.dueAt).getHours()).toBe(9);
    expect(await screen.findByText('Follow-up moved')).toBeInTheDocument();
  });
});

describe('DashboardPage (manager)', () => {
  beforeEach(() => install(MANAGER));

  it('shows the team, the pool and lets the manager open one rep’s book', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/^The team has 2 overdue follow-ups, 3 due today/)).toBeInTheDocument();
    const team = await screen.findByRole('region', { name: 'Team' });
    expect(within(team).getByText('Weekly goal: 25 calls, emails and visits per rep')).toBeInTheDocument();
    expect(within(team).getAllByText('Priya Shah').length).toBeGreaterThan(0);
    expect(within(team).getByRole('link', { name: /Allocate/ })).toHaveAttribute('href', '/allocation');
    expect(within(team).getByText('274')).toBeInTheDocument();
    // Follow-ups sits beside the briefing, above the Team table.
    const followUps = screen.getByRole('heading', { level: 2, name: 'Follow-ups' }).closest('.lg\\:col-span-2')!;
    expect(followUps.parentElement).toBe(screen.getByRole('region', { name: 'Today’s briefing' }).parentElement);
    expect(followUps.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls((u) => u.pathname === '/api/dashboard' && u.searchParams.get('scope') === 'team')).not.toHaveLength(0);
    expect(calls((u) => u.pathname === '/api/tasks' && u.searchParams.get('scope') === 'team')).not.toHaveLength(0);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Whose dashboard' }), REP2.id);
    await waitFor(() => expect(calls((u) => u.pathname === '/api/dashboard' && u.searchParams.get('scope') === `rep:${REP2.id}`)).not.toHaveLength(0));
    expect(await screen.findByText(/Viewing Priya Shah’s book/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Team' })).toBeNull();
    expect(searches).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { repId: REP2.id }, stages: ['interested', 'quoting'] })]));
  });
});

describe('DashboardPage territory brief', () => {
  const brief = () => screen.queryByTestId('territory-brief');
  const briefing = () => screen.getByRole('region', { name: 'Today’s briefing' });
  const sentence = 'Start with 2 overdue follow-ups, 3 due today and 1 warm deal gone quiet.';

  it('opens the briefing card with one short muted paragraph and an ⓘ, above the call list', async () => {
    const text = 'Severe Thunderstorm Warning in Bergen County until 8 PM: 4 storm-restoration roofers there may need tarps and repair stock. Since Saturday’s poll: 3 new leads in this territory.';
    install(REP, { brief: () => json({ brief: makeBrief({ text }) }) });
    renderPage();
    await screen.findByText(sentence);
    const p = await screen.findByText(text);
    expect(p.tagName).toBe('P');
    expect(p).toHaveClass('text-sm', 'text-muted', 'max-sm:line-clamp-3');
    expect(p.closest('header')).toBeNull();
    expect(briefing()).toContainElement(p);
    const list = await screen.findByRole('list', { name: 'Today’s call list' });
    expect(p.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p.compareDocumentPosition(screen.getByText('No weather alerts in your counties right now.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Plain text: no links or icons in it, just the ⓘ beside it.
    expect(within(brief()!).queryAllByRole('link')).toHaveLength(0);
    // Phones clamp it to 3 lines; "Read more" (sm:hidden) shows the rest (product review L1).
    expect(within(brief()!).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Read more', 'About this summary']);
    expect(calls((u) => u.pathname === '/api/territory-brief').map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('scope'))).toEqual(['mine']);
  });

  it.each([
    ['no brief yet', () => json({ brief: null })],
    ['a quiet brief', () => json({ brief: makeBrief({ quiet: true, text: '' }) })],
    ['a stale brief', () => json({ brief: makeBrief({ stale: true }) })],
    ['an empty text', () => json({ brief: makeBrief({ text: '  ' }) })],
    ['an error', () => json({ error: 'internal' }, 500)],
    ['a missing endpoint', () => json({ error: 'not_found' }, 404)],
  ])('renders nothing for %s', async (_what, res) => {
    install(REP, { brief: res });
    renderPage();
    await screen.findByText(sentence);
    await waitFor(() => expect(calls((u) => u.pathname === '/api/territory-brief')).not.toHaveLength(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(brief()).toBeNull();
    expect(screen.queryByRole('button', { name: 'About this summary' })).toBeNull();
    expect(briefing()).toBeInTheDocument();
  });

  it('renders nothing while loading (no skeleton)', async () => {
    install(REP, { brief: () => new Promise<Response>(() => {}) });
    renderPage();
    await screen.findByText(sentence);
    await screen.findByRole('list', { name: 'Today’s call list' });
    expect(brief()).toBeNull();
    expect(screen.queryByRole('button', { name: 'About this summary' })).toBeNull();
  });

  it('a manager reads the team brief, then one rep’s', async () => {
    install(MANAGER, { brief: (scope) => json({ brief: makeBrief({ scope: scope === 'team' ? 'team' : scope as `rep:${string}`, text: `Brief for ${scope}.` }) }) });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Brief for team.')).toBeInTheDocument();
    expect(briefing()).toContainElement(screen.getByText('Brief for team.'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Whose dashboard' }), REP2.id);
    expect(await screen.findByText(`Brief for rep:${REP2.id}.`)).toBeInTheDocument();
  });
});
