// Test helpers for the allocation feature: a routed fetch stub and a provider/router harness.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';
import type { LeadSummary, SessionUser } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { ToastProvider } from '@/components/ui';

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function jwt(): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (c: Call) => unknown;

/** Stubs global fetch with `METHOD /path` handlers (a trailing * matches a prefix); everything else is 404. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const c: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const key = `${c.method} ${c.path}`;
    const h = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!h) return json(404, { error: 'not_found' });
    const out = await h(c);
    return out instanceof Response ? out : json(200, out ?? {});
  });
  vi.stubGlobal('fetch', fn);
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET' && c.path !== '/api/leads/search'),
  };
}

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="location">{l.pathname}{l.search}</p>;
}

export function renderRoute(element: ReactElement, opts: { user: SessionUser; path: string; route?: string; state?: unknown }) {
  act(() => sessionStore.set({ token: jwt(), user: opts.user }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const route = opts.route ?? new URL(opts.path, 'http://x').pathname;
  const router = createMemoryRouter(
    [
      { path: route, element: <>{element}<LocationProbe /></> },
      { path: '*', element: <LocationProbe /> },
    ],
    { initialEntries: [{ pathname: new URL(opts.path, 'http://x').pathname, search: new URL(opts.path, 'http://x').search, state: opts.state }] },
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...view, qc, router };
}

export const manager: SessionUser = { id: 'm1', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' };
export const R1 = '11111111-1111-4111-8111-111111111111';
export const R2 = '22222222-2222-4222-8222-222222222222';
export const R3 = '33333333-3333-4333-8333-333333333333';
export const REPS = [
  { id: R1, name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const, allocatedCount: 50 },
  { id: R2, name: 'Priya Shah', email: 'rep2@demo.local', role: 'rep' as const, allocatedCount: 50 },
  { id: R3, name: 'Sam Rivera', email: 'rep3@demo.local', role: 'rep' as const, allocatedCount: 50 },
];

const flags = { checked: false, serviced: false, checkedAt: null, servicedAt: null };

export function lead(id: string, name: string, extra: Partial<LeadSummary> = {}): LeadSummary {
  return {
    id, businessName: name, city: 'Brooklyn', state: 'NY', postalCode: '11201', phone: null, websiteUrl: null,
    latitude: 40.7, longitude: -73.9, countyFips: '36047', rating: 4.8, reviewCount: 120, tier: 'master_elite',
    yearsInBusiness: 20, segment: 'strategic', priorityScore: 88, priorityDrivers: ['GAF tier', 'Review volume'],
    accountStatus: 'prospect', assignedRep: null, tags: [], customTags: [], updatedInLastPoll: true,
    lastChangeAt: '2026-10-18T12:00:00Z', mine: flags, team: flags, distanceMiles: null, canWrite: true, version: 1,
    salesStage: 'new', lastContactedAt: null, nextTask: null,
    ...extra,
  };
}

export const KPIS = {
  mine: { allocated: 0, unchecked: 0, unserviced: 0, updated_in_last_poll: 0 },
  team: {
    refreshedAt: new Date().toISOString(),
    totals: { allocated: 424, unchecked: 424, unserviced: 424, updated_in_last_poll: 239 },
    unallocated: { allocated: 274, unchecked: 274, unserviced: 274, updated_in_last_poll: 140 },
    reps: REPS.map((r) => ({
      repId: r.id, name: r.name, email: r.email, allocated: 50, unchecked: 40, unserviced: 45, updated_in_last_poll: 10,
      teamUnchecked: 40, teamUnserviced: 45,
    })),
  },
};
