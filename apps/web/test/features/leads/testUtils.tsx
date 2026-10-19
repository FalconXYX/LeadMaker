// Test harness for the lead list: memory router at /leads, fresh QueryClient, auth + toasts, and a
// fetch stub that routes by method + path (vi.stubGlobal).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';
import type { LeadSummary, SessionUser } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';

export const token = (() => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();

export const users = {
  rep: { id: 'ab3ee7d1-f903-4b52-a89d-20d26eac84d6', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' } satisfies SessionUser,
  manager: { id: 'f4d9577f-3a16-464b-a232-8ec8ea71e6bf', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' } satisfies SessionUser,
};

export type Handler = (req: { method: string; path: string; query: URLSearchParams; body: unknown }) => unknown;

export interface FetchLog {
  method: string;
  path: string;
  body: unknown;
}

/** Stubs fetch: `routes` keys are "METHOD /path" (exact path). Unknown routes answer {}. */
export function stubFetch(routes: Record<string, Handler | unknown>): FetchLog[] {
  const log: FetchLog[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    log.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    const value = await (typeof route === 'function' ? (route as Handler)({ method, path: url.pathname, query: url.searchParams, body }) : route ?? {});
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return log;
}

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

export function signIn(user: SessionUser | null): void {
  act(() => sessionStore.set(user ? { token, user } : null));
}

/** Renders `ui` at `route` (path /leads) with every provider the list needs. */
export function renderLeads(ui: ReactNode, route = '/leads') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/leads', element: <>{ui}<LocationProbe /></> },
      { path: '/leads/:id', element: <><p>Lead profile</p><LocationProbe /></> },
      { path: '/allocation', element: <><p>Allocation</p><LocationProbe /></> },
    ],
    { initialEntries: [route] },
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
  return { ...utils, qc, router, search: () => router.state.location.search };
}

let seq = 0;
export function lead(over: Partial<LeadSummary> = {}): LeadSummary {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    businessName: `Roofer ${seq}`,
    city: 'Garfield',
    state: 'NJ',
    postalCode: '07026',
    phone: null,
    websiteUrl: null,
    latitude: 40.87,
    longitude: -74.11,
    countyFips: '34003',
    rating: 4.8,
    reviewCount: 120,
    tier: 'master_elite',
    yearsInBusiness: 20,
    segment: 'strategic',
    priorityScore: 80,
    priorityDrivers: ['GAF tier', 'Review volume'],
    accountStatus: 'prospect',
    assignedRep: { id: users.rep.id, name: users.rep.name },
    tags: [
      { key: 'gaf_tier', label: 'GAF Master Elite', value: 'master_elite', category: 'certification' },
      { key: 'review_volume', label: '50-199 reviews', value: 'high', category: 'size' },
      { key: 'work_type:storm_emergency', label: 'Storm / emergency repair', value: true, category: 'work_type' },
    ],
    customTags: [],
    updatedInLastPoll: false,
    lastChangeAt: '2026-10-18T06:03:25.719Z',
    mine: { checked: false, serviced: false, checkedAt: null, servicedAt: null },
    team: { checked: false, serviced: false, checkedAt: null, servicedAt: null },
    distanceMiles: null,
    canWrite: true,
    version: 1,
    salesStage: 'new',
    lastContactedAt: null,
    nextTask: null,
    ...over,
  };
}
