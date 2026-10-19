import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomTagListItem } from '@/api/types';
import { DisplayMenu } from '@/features/leads/components/toolbar';
import { DEFAULT_PREFS, loadPrefs, mergePrefs, prefsKey, useLeadsPrefs, visibleColumns, type LeadsPrefs } from '@/features/leads/prefs';
import { visibleChips } from '@/features/leads/tags';
import { lead, stubFetch, type FetchLog } from './testUtils';

const stored = (userId: string) => JSON.parse(localStorage.getItem(prefsKey(userId)) ?? 'null');

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function DisplayHarness({ userId, tags = [] }: { userId: string; tags?: CustomTagListItem[] }) {
  const [prefs, setPrefs] = useLeadsPrefs(userId);
  return <DisplayMenu prefs={prefs} onPrefs={setPrefs} customTags={tags} />;
}

const followUp: CustomTagListItem = { id: 't1', name: 'Follow up', createdBy: { id: 'u', name: 'Jordan' }, createdAt: '2026-10-18T00:00:00Z', leadCount: 4 };

/** Server preferences that answer GET and PUT (with optimistic locking), like the real route. */
function prefsServer(initial: { prefs: Record<string, unknown>; version: number }) {
  const state = { ...initial };
  const log = stubFetch({
    'GET /api/preferences': () => ({ ...state, updatedAt: null }),
    'PUT /api/preferences': ({ body }: { body: unknown }) => {
      const b = body as { prefs: Record<string, unknown>; version: number };
      if (b.version !== state.version) {
        return new Response(JSON.stringify({ error: 'version_conflict', current: state }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      state.prefs = b.prefs;
      state.version += 1;
      return { ...state, updatedAt: '2026-10-18T12:00:00Z' };
    },
  });
  return { state, log };
}

const puts = (log: FetchLog[]) => log.filter((r) => r.method === 'PUT' && r.path === '/api/preferences');

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('tag visibility preferences', () => {
  beforeEach(() => {
    // Offline: the local cache alone.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  });

  it('persist per user under leadmaker.leads.<userId>', () => {
    const { result } = renderHook(() => useLeadsPrefs('u1'), { wrapper: wrapper() });
    expect(result.current[0].tagGroups).toEqual(DEFAULT_PREFS.tagGroups);

    act(() => result.current[1]((p) => ({ ...p, tagGroups: { ...p.tagGroups, other: true, work_type: false } })));
    expect(stored('u1').tagGroups).toMatchObject({ other: true, work_type: false });

    // A fresh mount (reload) restores them; another user keeps the defaults.
    const again = renderHook(() => useLeadsPrefs('u1'), { wrapper: wrapper() });
    expect(again.result.current[0].tagGroups).toMatchObject({ other: true, work_type: false, custom: true });
    const other = renderHook(() => useLeadsPrefs('u2'), { wrapper: wrapper() });
    expect(other.result.current[0].tagGroups).toEqual(DEFAULT_PREFS.tagGroups);
  });

  it('are toggled from the Display menu, including single custom tags', async () => {
    const user = userEvent.setup();
    render(<DisplayHarness userId="u3" tags={[followUp]} />, { wrapper: wrapper() });
    await user.click(screen.getByRole('button', { name: 'Display settings' }));

    await user.click(screen.getByRole('switch', { name: /Certification/ }));
    expect(stored('u3').tagGroups.certification).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /Follow up/ }));
    expect(stored('u3').hiddenCustomTags).toEqual(['Follow up']);

    // Core columns are on until turned off; the optional ones are off until turned on.
    await user.click(screen.getByRole('checkbox', { name: 'Last contacted' }));
    expect(stored('u3').hiddenColumns).toEqual(['lastContacted']);
    expect(screen.getByRole('checkbox', { name: 'GAF tier' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'GAF tier' }));
    expect(stored('u3').extraColumns).toEqual(['gaf']);
    expect(visibleColumns(loadPrefs('u3'))).toEqual(['stage', 'followUp', 'priority', 'reasons', 'tags', 'owner', 'gaf']);

    expect(loadPrefs('u3')).toMatchObject({ tagGroups: { certification: true }, hiddenCustomTags: ['Follow up'] });
  });

  it('decide which chips a row shows', () => {
    const l = lead({ customTags: [{ id: 't1', name: 'Follow up' }, { id: 't2', name: 'Hot' }] });
    const groups = { ...DEFAULT_PREFS.tagGroups };
    expect(visibleChips(l, { groups, hiddenCustomTags: [] }).map((c) => c.label)).toEqual(['Follow up', 'Hot', 'Storm / emergency repair']);
    expect(visibleChips(l, { groups, hiddenCustomTags: ['hot'] }).map((c) => c.label)).toEqual(['Follow up', 'Storm / emergency repair']);
    expect(visibleChips(l, { groups: { ...groups, custom: false, work_type: false, certification: true }, hiddenCustomTags: [] }).map((c) => c.label))
      .toEqual(['GAF Master Elite']);
  });

  it('ignore malformed stored values, and older column settings', () => {
    localStorage.setItem(prefsKey('u4'), JSON.stringify({
      density: 'huge', hiddenColumns: ['nope', 'priority', 'updated', 'timing'], extraColumns: ['rating', 'stage'], tagGroups: { other: 'yes' }, alertViews: [1, 'v1'],
    }));
    expect(loadPrefs('u4')).toMatchObject({
      density: 'comfortable', hiddenColumns: ['priority'], extraColumns: ['rating'], tagGroups: DEFAULT_PREFS.tagGroups, alertViews: ['v1'],
    });
    localStorage.setItem(prefsKey('u5'), '{not json');
    expect(loadPrefs('u5')).toEqual(DEFAULT_PREFS);
  });
});

describe('server sync (/api/preferences, key "leads")', () => {
  it('adopts the server copy over the local cache, and caches it', async () => {
    localStorage.setItem(prefsKey('s1'), JSON.stringify({ ...DEFAULT_PREFS, density: 'compact', _version: 3 }));
    prefsServer({ prefs: { leads: { ...DEFAULT_PREFS, density: 'comfortable', hiddenCustomTags: ['Hot'] } }, version: 4 });
    const { result } = renderHook(() => useLeadsPrefs('s1'), { wrapper: wrapper() });
    // The cache renders first...
    expect(result.current[0].density).toBe('compact');
    // ...then the server wins.
    await waitFor(() => expect(result.current[0].hiddenCustomTags).toEqual(['Hot']));
    expect(result.current[0].density).toBe('comfortable');
    expect(stored('s1')).toMatchObject({ hiddenCustomTags: ['Hot'], _version: 4, _pending: false });
  });

  it('saves edits under "leads" with the version it read, keeping other pages’ keys', async () => {
    const { state, log } = prefsServer({ prefs: { dashboard: { range: '30d' }, leads: DEFAULT_PREFS }, version: 2 });
    const { result } = renderHook(() => useLeadsPrefs('s2'), { wrapper: wrapper() });
    await waitFor(() => expect(log.some((r) => r.method === 'GET' && r.path === '/api/preferences')).toBe(true));
    await act(async () => {});

    act(() => result.current[1]({ density: 'compact' }));
    await waitFor(() => expect(puts(log)).toHaveLength(1), { timeout: 2000 });
    expect(puts(log)[0]!.body).toMatchObject({ version: 2, prefs: { dashboard: { range: '30d' }, leads: { density: 'compact' } } });
    expect(state.version).toBe(3);
    await waitFor(() => expect(stored('s2')).toMatchObject({ density: 'compact', _version: 3, _pending: false }));
  });

  it('on 409 refetches, merges both sides’ changes and saves again', async () => {
    const { state, log } = prefsServer({ prefs: { leads: DEFAULT_PREFS }, version: 1 });
    const { result } = renderHook(() => useLeadsPrefs('s3'), { wrapper: wrapper() });
    await waitFor(() => expect(log.some((r) => r.method === 'GET')).toBe(true));
    await act(async () => {});

    // Another device saves first: hides a custom tag and turns on the Size chips.
    state.prefs = { leads: { ...DEFAULT_PREFS, hiddenCustomTags: ['Hot'], tagGroups: { ...DEFAULT_PREFS.tagGroups, size: true } } };
    state.version = 2;

    // This tab, still on version 1, switches to compact rows and turns on Certification chips.
    act(() => result.current[1]((p) => ({ ...p, density: 'compact', tagGroups: { ...p.tagGroups, certification: true } })));

    await waitFor(() => expect(puts(log)).toHaveLength(2), { timeout: 3000 });
    expect(puts(log)[0]!.body).toMatchObject({ version: 1 });
    // The retry carries the server's version and both sets of changes.
    expect(puts(log)[1]!.body).toMatchObject({
      version: 2,
      prefs: { leads: { density: 'compact', hiddenCustomTags: ['Hot'], tagGroups: { size: true, certification: true } } },
    });
    expect(log.filter((r) => r.method === 'GET' && r.path === '/api/preferences').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(result.current[0]).toMatchObject({ density: 'compact', hiddenCustomTags: ['Hot'] }));
    expect(state.version).toBe(3);
  });

  it('mergePrefs: this tab’s changed fields win, the rest come from the server', () => {
    const base: LeadsPrefs = DEFAULT_PREFS;
    const local: LeadsPrefs = { ...base, density: 'compact', tagGroups: { ...base.tagGroups, other: true } };
    const server: LeadsPrefs = { ...base, hiddenColumns: [], tagGroups: { ...base.tagGroups, work_type: false }, filtersOpen: true };
    expect(mergePrefs(base, local, server)).toEqual({
      ...base,
      density: 'compact',
      hiddenColumns: [],
      filtersOpen: true,
      tagGroups: { ...base.tagGroups, other: true, work_type: false },
    });
  });
});
