import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import type { SessionUser } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';
import { liveEvents } from '@/live/liveEvents';
import { hrefFor } from '@/features/notifications/meta';
import { NotificationBell, badgeText } from '@/features/notifications/NotificationBell';
import { toItem } from '@/features/notifications/types';

const rep: SessionUser = { id: '33333333-3333-4333-8333-333333333333', name: 'Sam Rivera', email: 'rep3@demo.local', role: 'rep' };
const LEAD = 'c0ffee00-0000-4000-8000-000000000001';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const jwt = () => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
};

const n = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'allocated', title: 'New lead allocated to you', body: 'Acme Roofing is now yours', companyId: LEAD, countyFips: null,
  data: { latest: 'Acme Roofing' }, count: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readAt: null, ...extra,
});

interface Call { method: string; path: string; body: unknown }

function setup(opts: { items?: unknown[]; unreadCount?: number; prefs?: unknown } = {}) {
  const calls: Call[] = [];
  let items = opts.items ?? [
    n('11111111-0000-4000-8000-000000000001'),
    n('11111111-0000-4000-8000-000000000002', {
      type: 'storm_alert', title: 'Severe Thunderstorm Warning: Kings', body: '4 of your leads are in the alert area', companyId: null,
      countyFips: '36047', readAt: new Date().toISOString(),
    }),
  ];
  let unread = opts.unreadCount ?? 1;
  let prefs = opts.prefs ?? {
    items: ['allocated', 'reassigned_away', 'storm_alert', 'source_changed', 'refresh_done', 'manager_note', 'pool_grew'].map((type) => ({ type, enabled: true })),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const c = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (c.path === '/api/me') return json(rep);
    if (c.path === '/api/notifications' && c.method === 'GET') {
      const only = url.searchParams.get('unread') === '1';
      return json({ items: only ? (items as { readAt: unknown }[]).filter((x) => !x.readAt) : items, nextCursor: null, unreadCount: unread });
    }
    if (c.path === '/api/notifications/read') {
      unread = 0;
      items = (items as Record<string, unknown>[]).map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }));
      return json({ updated: 1, unreadCount: 0 });
    }
    if (c.path === '/api/notifications/preferences') {
      if (c.method === 'PUT') {
        const changed = (c.body as { items: { type: string; enabled: boolean }[] }).items;
        prefs = { items: (prefs as { items: { type: string; enabled: boolean }[] }).items.map((p) => changed.find((x) => x.type === p.type) ?? p) };
      }
      return json(prefs);
    }
    return json({ error: 'not_found' }, 404);
  }));

  act(() => sessionStore.set({ token: jwt(), user: rep }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Where() {
    const l = useLocation();
    return <p data-testid="location">{l.pathname}{l.search}</p>;
  }
  const router = createMemoryRouter([{ path: '*', element: <><NotificationBell /><Where /></> }], { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider><RouterProvider router={router} /></ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => sessionStore.set(null));
});

describe('NotificationBell', () => {
  it('shows the unread count, capped at 99+', async () => {
    setup({ unreadCount: 3 });
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toHaveTextContent('3');
    expect(badgeText(120)).toBe('99+');
    expect(badgeText(99)).toBe('99');
  });

  it('caps a large badge at 99+', async () => {
    setup({ unreadCount: 240 });
    expect(await screen.findByRole('button', { name: 'Notifications, 240 unread' })).toHaveTextContent('99+');
  });

  it('opens a focus-trapped list; clicking an item marks it read and opens the lead', async () => {
    const api = setup({ unreadCount: 1 });
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await userEvent.click(bell);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    // Focus moves into the popover (jsdom has no layout, so Tab cycling is checked in the browser instead).
    expect(panel).toHaveFocus();
    const item = await within(panel).findByRole('button', { name: /^Unread: New lead allocated to you/ });
    expect(within(panel).getByRole('button', { name: /^Severe Thunderstorm Warning: Kings/ })).toBeInTheDocument();

    await userEvent.click(item);
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/api/notifications/read', body: { ids: ['11111111-0000-4000-8000-000000000001'] } }]));
    expect(screen.getByTestId('location')).toHaveTextContent(`/leads/${LEAD}`);
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Notifications' })).not.toHaveTextContent(/\d/);
  });

  it('marks everything read, closes on Escape, and shows an empty unread view', async () => {
    const api = setup({ unreadCount: 1 });
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(panel).findByRole('button', { name: /^Unread: New lead allocated to you/ });
    await userEvent.click(within(panel).getByRole('button', { name: /Mark all read/ }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/api/notifications/read', body: { all: true } }]));
    expect(await within(panel).findByRole('button', { name: /^New lead allocated to you/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Mark all read/ })).toBeDisabled();

    await userEvent.click(within(panel).getByRole('button', { name: /^Unread/ }));
    expect(await within(panel).findByText('You’re all caught up')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
  });

  it('saves a preference toggle with PUT', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /^Notifications/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Notification settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notification settings' });
    const storm = await within(dialog).findByRole('switch', { name: 'Storm alerts' });
    expect(storm).toHaveAttribute('aria-checked', 'true');
    // Reps never get pool notifications, so the switch is not offered.
    expect(within(dialog).queryByRole('switch', { name: 'New leads in the pool' })).toBeNull();

    await userEvent.click(storm);
    expect(storm).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(api.writes()).toEqual([
      { method: 'PUT', path: '/api/notifications/preferences', body: { items: [{ type: 'storm_alert', enabled: false }] } },
    ]));
    expect(await within(dialog).findByText(/1 turned off/)).toBeInTheDocument();
  });

  it('on notification.created toasts the payload title and body without fetching, and View opens the full row', async () => {
    const api = setup({ unreadCount: 0, items: [] });
    await screen.findByRole('button', { name: 'Notifications' });
    const fresh = n('22222222-0000-4000-8000-000000000008', { title: 'Homestead Roofing is now yours', body: 'Ridgewood, NJ · priority 78' });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      api.calls.push({ method: 'GET', path: url.pathname, body: undefined });
      if (url.pathname === '/api/notifications') return json({ items: [fresh], nextCursor: null, unreadCount: 1 });
      return json(rep);
    });
    const before = api.calls.length;
    act(() => liveEvents.emit({
      id: '9-2', type: 'notification.created', companyIds: [], data: {}, actorName: 'system',
      payload: {
        user_id: rep.id, notification_id: fresh.id, type: 'allocated', count: 1, title: fresh.title, body: fresh.body,
        actor_type: 'system', actor_id: null, actor_name: 'system',
      },
    }));
    // Shown at once, from the event alone.
    expect(screen.getByText('Homestead Roofing is now yours')).toBeInTheDocument();
    expect(screen.getByText('Ridgewood, NJ · priority 78')).toBeInTheDocument();
    // The only request is the list refetch (badge), not a lookup for the toast.
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    const lookups = api.calls.slice(before).filter((c) => c.path === '/api/notifications');
    expect(lookups.length).toBeLessThanOrEqual(1);
    // View resolves the cached row, which has the lead id the event lacks.
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/leads/${LEAD}`);
  });

  it('falls back to fetching the row for older events without a title', async () => {
    setup({ unreadCount: 0, items: [] });
    await screen.findByRole('button', { name: 'Notifications' });
    const fresh = n('22222222-0000-4000-8000-000000000009', { title: '3 new leads allocated to you', body: 'Latest: Acme Roofing', count: 3 });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/notifications') return json({ items: [fresh], nextCursor: null, unreadCount: 1 });
      return json(rep);
    });
    act(() => liveEvents.emit({
      id: '9-0', type: 'notification.created', companyIds: [], data: {},
      payload: { user_id: rep.id, notification_id: fresh.id, type: 'allocated', count: 3, actor_type: 'system', actor_id: null },
    }));
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    expect(await screen.findByText('3 new leads allocated to you')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/leads?scope=mine&sort=last_change%3Adesc');
  });

  it('ignores events addressed to someone else', async () => {
    setup({ unreadCount: 0, items: [] });
    await screen.findByRole('button', { name: 'Notifications' });
    act(() => liveEvents.emit({
      id: '9-1', type: 'notification.created', companyIds: [], data: {},
      payload: { user_id: 'someone-else', notification_id: 'x', type: 'allocated', count: 1, actor_type: 'system', actor_id: null },
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
  });
});

describe('notification targets', () => {
  it('routes each type somewhere useful', () => {
    const at = (x: Record<string, unknown>, role: 'rep' | 'manager' = 'rep') => hrefFor(toItem(n('1', x) as never), role);
    expect(at({})).toBe(`/leads/${LEAD}`);
    expect(at({ type: 'pool_grew', companyId: null, count: 12 }, 'manager')).toBe('/allocation?new=1');
    expect(at({ type: 'storm_alert', companyId: null, countyFips: '36047' })).toBe('/');
    expect(at({ type: 'refresh_done', companyId: null, data: { postal_code: '11201', radius_miles: 5 } })).toBe('/leads?zip=11201&radius=5&sort=last_change%3Adesc');
    expect(at({ type: 'reassigned_away', count: 4 })).toBe('/leads?scope=mine');
  });
});
