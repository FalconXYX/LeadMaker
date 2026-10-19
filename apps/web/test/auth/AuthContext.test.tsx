import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';

const KEY = 'leadmaker.session';
const rep = { id: 'r1', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const };
const manager = { id: 'm1', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' as const };

function jwt(expSecondsFromNow: number, n = 0): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'r1', n, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="user">{auth.user?.name ?? 'anonymous'}</span>
      <span data-testid="manager">{String(auth.isManager)}</span>
      <span data-testid="reason">{auth.logoutReason ?? ''}</span>
      <span data-testid="canWriteMine">{String(auth.canWrite({ assignedRep: { id: 'r1', name: 'Jordan Lee' } }))}</span>
      <span data-testid="canWritePool">{String(auth.canWrite({ assignedRep: null }))}</span>
      <button onClick={() => void auth.login('Rep1@demo.local ')}>login rep</button>
      <button onClick={() => void auth.switchUser('manager@demo.local')}>switch to manager</button>
      <button onClick={() => auth.logout()}>logout</button>
    </div>
  );
}

function renderAuth() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider><Probe /></AuthProvider>
    </QueryClientProvider>,
  );
  return qc;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  act(() => sessionStore.set(null));
  sessionStore.resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStore.resetForTests();
});

describe('AuthProvider', () => {
  it('logs in with dev-login, persists the session, and logs out', async () => {
    const token = jwt(3600);
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/auth/dev-login') {
        expect(JSON.parse(String(init.body))).toEqual({ email: 'rep1@demo.local' });
        return json(200, { token, user: rep });
      }
      return json(200, rep);
    });
    renderAuth();
    expect(screen.getByTestId('user')).toHaveTextContent('anonymous');

    await userEvent.click(screen.getByText('login rep'));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee'));
    expect(screen.getByTestId('manager')).toHaveTextContent('false');
    expect(screen.getByTestId('canWriteMine')).toHaveTextContent('true');
    expect(screen.getByTestId('canWritePool')).toHaveTextContent('false');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ token, user: rep });
    expect(sessionStore.demoUser()).toBe('rep1@demo.local');

    await userEvent.click(screen.getByText('logout'));
    expect(screen.getByTestId('user')).toHaveTextContent('anonymous');
    expect(screen.getByTestId('reason')).toHaveTextContent('user');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('switching user drops the previous user’s cached data before the new user renders', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/auth/dev-login') {
        const email = JSON.parse(String(init.body)).email;
        return json(200, { token: jwt(3600, email === rep.email ? 1 : 2), user: email === rep.email ? rep : manager });
      }
      return json(200, {});
    });
    const qc = renderAuth();
    await userEvent.click(screen.getByText('login rep'));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee'));
    qc.setQueryData(['leads', 'mine'], ['rep lead']);

    await userEvent.click(screen.getByText('switch to manager'));
    await waitFor(() => expect(screen.getByTestId('manager')).toHaveTextContent('true'));
    expect(qc.getQueryData(['leads', 'mine'])).toBeUndefined();
    expect(screen.getByTestId('canWritePool')).toHaveTextContent('true');
  });

  it('a restored session that /api/me rejects is renewed for the same user', async () => {
    const stale = jwt(3600, 1);
    const fresh = jwt(3600, 2);
    localStorage.setItem(KEY, JSON.stringify({ token: stale, user: rep }));
    act(() => sessionStore.reload());
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/auth/dev-login') return json(200, { token: fresh, user: rep });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${fresh}` ? json(200, rep) : json(401, { error: 'invalid_token' });
    });
    renderAuth();
    expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/me');

    await waitFor(() => expect(sessionStore.get()?.token).toBe(fresh));
    expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee');
    const login = fetchMock.mock.calls.find(([u]) => u === '/auth/dev-login')!;
    expect(JSON.parse(String(login[1].body))).toEqual({ email: 'rep1@demo.local' });
  });

  it('ends the session when renewing fails too', async () => {
    localStorage.setItem(KEY, JSON.stringify({ token: jwt(3600), user: rep }));
    act(() => sessionStore.reload());
    fetchMock.mockResolvedValue(json(401, { error: 'unknown_user' }));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('anonymous'));
    expect(screen.getByTestId('reason')).toHaveTextContent('expired');
  });

  it('does not loop when a freshly renewed token is rejected again', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/auth/dev-login' ? json(200, { token: jwt(3600, Math.random()), user: rep }) : json(200, rep));
    renderAuth();
    await userEvent.click(screen.getByText('login rep'));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee'));

    fetchMock.mockImplementation(async (url: string) =>
      url === '/auth/dev-login' ? json(200, { token: jwt(3600, Math.random()), user: rep }) : json(401, { error: 'invalid_token' }));
    await act(async () => {
      await api.get('/api/kpis').catch(() => {});
    });
    await waitFor(() => expect(sessionStore.isRenewing()).toBe(false));
    await act(async () => {
      await api.get('/api/kpis').catch(() => {});
    });
    expect(screen.getByTestId('user')).toHaveTextContent('anonymous');
    expect(fetchMock.mock.calls.filter(([u]) => u === '/auth/dev-login')).toHaveLength(2);
  });

  it('discards an expired stored token without calling the API', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: jwt(-60), user: rep }));
    act(() => sessionStore.reload());
    renderAuth();
    expect(screen.getByTestId('user')).toHaveTextContent('anonymous');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps working when localStorage throws', async () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    vi.spyOn(proto, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    fetchMock.mockImplementation(async (url: string) =>
      url === '/auth/dev-login' ? json(200, { token: jwt(3600), user: rep }) : json(200, rep));
    act(() => sessionStore.reload());
    renderAuth();
    await userEvent.click(screen.getByText('login rep'));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('Jordan Lee'));
    expect(sessionStore.demoUser()).toBe('rep1@demo.local');
  });
});
