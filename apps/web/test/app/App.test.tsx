import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as client } from '@/api/client';
import { App } from '@/app/App';
import { sessionStore } from '@/auth/session';

const jwt = (n = 1) => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ n, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
};
const users = {
  'rep1@demo.local': { id: 'r1', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const },
  'rep2@demo.local': { id: 'r2', name: 'Priya Shah', email: 'rep2@demo.local', role: 'rep' as const },
  'manager@demo.local': { id: 'm1', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' as const },
};
type Email = keyof typeof users;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The API: dev-login issues numbered tokens for the seeded users; /api/me echoes the token's user; the rest is empty. */
function mockApi(extra?: (path: string, init?: RequestInit) => Response | undefined) {
  let issued = 0;
  const tokens = new Map<string, Email>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/auth/dev-login') {
      const email = JSON.parse(String(init?.body)).email as Email;
      if (!users[email]) return json({ error: 'unknown_user' }, 401);
      const token = jwt(++issued);
      tokens.set(token, email);
      return json({ token, user: users[email] });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.slice(7);
    if (path === '/api/me') return auth && tokens.has(auth) ? json(users[tokens.get(auth)!]) : json({ error: 'invalid_token' }, 401);
    return extra?.(path, init) ?? json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const devLogins = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/auth/dev-login').map(([, i]) => JSON.parse(String(i?.body)).email);
  return { fetchMock, devLogins, signIn: (email: Email) => { const token = jwt(++issued); tokens.set(token, email); act(() => sessionStore.set({ token, user: users[email] })); } };
}

beforeEach(() => {
  sessionStore.resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
  sessionStore.resetForTests();
  window.history.pushState({}, '', '/');
});

const nav = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!);

describe('App shell', () => {
  it('signs in silently as the default demo user: no login page', async () => {
    const { devLogins } = mockApi();
    window.history.pushState({}, '', '/leads');
    render(<App />);
    expect(await screen.findByRole('button', { name: /Account menu for Jordan Lee, Sales rep/ })).toBeInTheDocument();
    expect(devLogins()).toEqual(['rep1@demo.local']);
    expect(window.location.pathname).toBe('/leads');
    expect(screen.queryByRole('heading', { name: /Sign in/ })).toBeNull();
  });

  it('sends old /login links to the dashboard', async () => {
    mockApi();
    window.history.pushState({}, '', '/login');
    render(<App />);
    await screen.findByRole('button', { name: /Account menu for Jordan Lee/ });
    expect(window.location.pathname).toBe('/');
  });

  it('shows reps Dashboard, Leads and Tasks in the top bar but not Allocation, and guards /allocation', async () => {
    const server = mockApi();
    server.signIn('rep1@demo.local');
    window.history.pushState({}, '', '/allocation');
    render(<App />);
    expect(await screen.findByText('Allocation is for managers')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(nav().getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page'));
    expect(nav().getByRole('link', { name: 'Leads' })).toBeInTheDocument();
    expect(nav().getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(nav().queryByRole('link', { name: 'Allocation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open AI assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByText(/^Live$/)).toBeNull();
  });

  it('keeps Admin out of a rep’s top bar and sends reps away from /admin', async () => {
    const server = mockApi();
    server.signIn('rep1@demo.local');
    window.history.pushState({}, '', '/admin');
    render(<App />);
    expect(await screen.findByText('Admin is for managers')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(nav().queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(server.fetchMock.mock.calls.some(([u]) => String(u).includes('/api/admin'))).toBe(false);
  });

  it('shows managers Admin in the top bar and opens it', async () => {
    const server = mockApi((path) => (path.startsWith('/api/admin/') ? json([]) : undefined));
    server.signIn('manager@demo.local');
    render(<App />);
    await userEvent.click(await screen.findByRole('link', { name: 'Admin' }));
    expect(window.location.pathname).toBe('/admin');
    await waitFor(() => expect(nav().getByRole('link', { name: 'Admin' })).toHaveAttribute('aria-current', 'page'));
    expect(await screen.findByRole('heading', { name: 'Lead sourcing' })).toBeInTheDocument();
    expect(await screen.findByText('No areas yet')).toBeInTheDocument();
  });

  it('opens the Tasks page from the top bar', async () => {
    const server = mockApi();
    server.signIn('rep1@demo.local');
    render(<App />);
    await userEvent.click(await screen.findByRole('link', { name: 'Tasks' }));
    expect(window.location.pathname).toBe('/tasks');
    await waitFor(() => expect(nav().getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page'));
  });

  it('lets managers reach Allocation and searches leads from the top bar', async () => {
    const server = mockApi();
    server.signIn('manager@demo.local');
    window.history.pushState({}, '', '/allocation');
    render(<App />);
    await waitFor(() => expect(nav().getByRole('link', { name: 'Allocation' })).toHaveAttribute('aria-current', 'page'));

    await userEvent.type(screen.getByRole('combobox', { name: /Search leads/ }), 'jersey{Enter}');
    expect(window.location.pathname).toBe('/leads');
    expect(window.location.search).toBe('?q=jersey');
  });

  it('suggests matching leads as you type and opens one with the keyboard', async () => {
    const acme = { id: '11111111-0000-4000-8000-000000000001', businessName: 'Acme Roofing', city: 'Garfield', state: 'NJ', segment: 'growth', assignedRep: null };
    const server = mockApi((path, init) => (path === '/api/leads/search' && JSON.parse(String(init?.body)).filter.text === 'acme'
      ? json({ items: [acme], total: 1, totalCapped: false, nextCursor: null })
      : undefined));
    server.signIn('rep1@demo.local');
    window.history.pushState({}, '', '/leads');
    render(<App />);
    const box = await screen.findByRole('combobox', { name: /Search leads/ });
    await userEvent.type(box, 'acme');
    expect(await screen.findByRole('option', { name: /Acme Roofing/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /See all 1 results for “acme”/ })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(window.location.pathname).toBe(`/leads/${acme.id}`);
  });
});

describe('Switch user', () => {
  it('lists the demo team with roles and switches, saying who you are now', async () => {
    const server = mockApi();
    server.signIn('rep1@demo.local');
    window.history.pushState({}, '', '/leads?q=acme');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Account menu for Jordan Lee, Sales rep/ }));
    const group = screen.getByRole('group', { name: 'Switch user' });
    const options = within(group).getAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual(['AMAlex MorganManager', 'JLJordan LeeSales rep', 'PSPriya ShahSales rep', 'SRSam RiveraSales rep']);
    expect(within(group).getByRole('menuitemradio', { name: /Jordan Lee/ })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(within(group).getByRole('menuitemradio', { name: /Alex Morgan/ }));
    expect(await screen.findByText('Now viewing as Alex Morgan')).toBeInTheDocument();
    expect(server.devLogins()).toEqual(['manager@demo.local']);
    expect(sessionStore.get()?.user.name).toBe('Alex Morgan');
    expect(window.location.pathname + window.location.search).toBe('/leads?q=acme');
    expect(await screen.findByRole('link', { name: 'Allocation' })).toBeInTheDocument();
  });

  it('a rep switched in on a managers-only page lands on the dashboard without a warning', async () => {
    const server = mockApi();
    server.signIn('manager@demo.local');
    window.history.pushState({}, '', '/allocation');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Account menu for Alex Morgan, Manager/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Priya Shah/ }));
    expect(await screen.findByText('Now viewing as Priya Shah')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByText('Allocation is for managers')).toBeNull();
  });

  it('remembers the chosen account when the session has to start again', async () => {
    const server = mockApi();
    server.signIn('rep2@demo.local');
    act(() => sessionStore.set(null, 'user'));
    render(<App />);
    expect(await screen.findByRole('button', { name: /Account menu for Priya Shah/ })).toBeInTheDocument();
    expect(server.devLogins()).toEqual(['rep2@demo.local']);
  });
});

describe('Expired sessions', () => {
  it('a 401 signs the same user in again without leaving the page', async () => {
    const server = mockApi();
    server.signIn('rep2@demo.local');
    window.history.pushState({}, '', '/leads?q=acme');
    render(<App />);
    await screen.findByRole('button', { name: /Account menu for Priya Shah/ });
    const before = sessionStore.get()!.token;

    server.fetchMock.mockImplementationOnce(async () => json({ error: 'invalid_token' }, 401));
    await act(async () => {
      await client.get('/api/kpis').catch(() => {});
    });
    await waitFor(() => expect(sessionStore.get()?.token).not.toBe(before));
    expect(sessionStore.get()?.user.name).toBe('Priya Shah');
    expect(server.devLogins()).toEqual(['rep2@demo.local']);
    expect(screen.getByRole('button', { name: /Account menu for Priya Shah/ })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/leads?q=acme');
  });

  it('stops and offers a retry when the API rejects every new token, instead of signing in over and over', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === '/auth/dev-login'
      ? json({ token: jwt(++n), user: users['rep1@demo.local'] })
      : json({ error: 'invalid_token' }, 401)));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Couldn’t open LeadMaker' })).toBeInTheDocument();
    expect(n).toBe(2);
  });

  it('shows a retry when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Couldn’t open LeadMaker' })).toBeInTheDocument();
    const { devLogins } = mockApi();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Account menu for Jordan Lee/ })).toBeInTheDocument();
    expect(devLogins()).toEqual(['rep1@demo.local']);
  });
});
