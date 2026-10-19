// Tasks test harness: memory router, fresh QueryClient, auth + toasts, and a fetch stub routed by "METHOD /path".
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { SessionUser, Task } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';
import { addDays, today } from '@/features/tasks/dates';

const token = (() => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();

export const REP: SessionUser = { id: 'ab3ee7d1-f903-4b52-a89d-20d26eac84d6', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' };
export const MANAGER: SessionUser = { id: 'f4d9577f-3a16-464b-a232-8ec8ea71e6bf', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' };
export const PRIYA = { id: '50302c37-aeb7-4cef-b8c7-cc14004df3bb', name: 'Priya Shah' };
export const LEAD_ID = '585751d0-8791-4c9f-a0cb-1fc42ae76f65';

/** Midday in New York `offset` days from today, so the day is the same in any test runner's zone. */
export const dueIn = (offset: number) => `${addDays(today(), offset)}T16:00:00.000Z`;

let seq = 0;
export function task(over: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    companyId: LEAD_ID,
    companyName: 'Jersey Roofing LLC',
    title: `Follow-up ${seq}`,
    type: 'call',
    dueAt: dueIn(0),
    doneAt: null,
    note: null,
    assignee: { id: REP.id, name: REP.name },
    createdBy: { id: REP.id, name: REP.name },
    createdAt: dueIn(-5),
    updatedAt: dueIn(-1),
    version: 1,
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}
export type Handler = (c: Call) => unknown;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Stubs fetch; `routes` keys are "METHOD /path" or "METHOD /path*" (prefix). Unknown routes answer {}. */
export function stubFetch(routes: Record<string, Handler | unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const c: Call = { method, path: url.pathname, query: url.searchParams, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const key = `${method} ${url.pathname}`;
    const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    const value = await (typeof route === 'function' ? (route as Handler)(c) : route ?? {});
    return value instanceof Response ? value : json(value);
  }));
  return calls;
}

export function renderWith(ui: ReactNode, opts: { user?: SessionUser; route?: string; path?: string } = {}) {
  act(() => sessionStore.set({ token, user: opts.user ?? REP }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: opts.path ?? '/tasks', element: ui },
      { path: '/leads/:id', element: <p>Lead profile</p> },
      { path: '/leads', element: <p>Leads list</p> },
    ],
    { initialEntries: [opts.route ?? '/tasks'] },
  );
  const utils = render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, qc, router };
}

export function signOut() {
  act(() => sessionStore.set(null));
}
