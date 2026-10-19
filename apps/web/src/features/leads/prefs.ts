// Per-user list preferences (density, columns, tag chips, filter panel). The server copy (GET/PUT
// /api/preferences, under the 'leads' key, optimistic locking) is the source of truth; localStorage
// (leadmaker.leads.<userId>) is the offline cache, so the list renders with the user's settings before the
// server answers and edits made offline are pushed on the next load. Malformed values fall back to defaults.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { VersionConflictError } from '@/api/errors';
import type { UserPreferences } from '@/api/types';
import { safeStorage } from '@/lib/storage';
import { getPreferences, putPreferences } from '@/api/endpoints';
import { qk } from '@/api/queries';
import { TAG_GROUPS, type TagGroup } from './tags';

/** In sales order: the core columns first, then the optional ones (off unless chosen in Display). */
export const COLUMN_IDS = [
  'stage', 'followUp', 'lastContacted', 'priority', 'reasons', 'tags', 'owner', 'segment', 'gaf', 'rating', 'state', 'updated',
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];
export const EXTRA_COLUMNS: readonly ColumnId[] = ['segment', 'gaf', 'rating', 'state', 'updated'];
export const isExtraColumn = (c: ColumnId) => EXTRA_COLUMNS.includes(c);

export const COLUMN_LABELS: Record<ColumnId, string> = {
  stage: 'Stage',
  followUp: 'Next follow-up',
  lastContacted: 'Last contacted',
  priority: 'Priority',
  reasons: 'Why',
  tags: 'Tags',
  owner: 'Owner',
  segment: 'Segment',
  gaf: 'GAF tier',
  rating: 'Rating',
  state: 'Checked / serviced',
  updated: 'Updated',
};

/** The columns the prefs show, in order. */
export function visibleColumns(p: Pick<LeadsPrefs, 'hiddenColumns' | 'extraColumns'>): ColumnId[] {
  return COLUMN_IDS.filter((c) => (isExtraColumn(c) ? p.extraColumns.includes(c) : !p.hiddenColumns.includes(c)));
}

export type Density = 'comfortable' | 'compact';

/** A view saved in this browser before views moved to the server (migrated once by useSavedViews). */
export interface LocalSavedView {
  id: string;
  name: string;
  /** URL query string (LeadFilter params + the alert flag). */
  query: string;
  createdAt: string;
}

export interface LeadsPrefs {
  density: Density;
  /** Core columns turned off. */
  hiddenColumns: ColumnId[];
  /** Optional columns turned on. */
  extraColumns: ColumnId[];
  tagGroups: Record<TagGroup | 'custom', boolean>;
  /** Custom tag names hidden from the chips. */
  hiddenCustomTags: string[];
  filtersOpen: boolean;
  /** Saved view ids that also apply the storm-alert flag, which a LeadFilter (and so a server view) cannot hold. */
  alertViews: string[];
}

export const PREFS_KEYS = ['density', 'hiddenColumns', 'extraColumns', 'tagGroups', 'hiddenCustomTags', 'filtersOpen', 'alertViews'] as const satisfies readonly (keyof LeadsPrefs)[];

/** The key this list's preferences live under in the user's server preferences. */
export const SERVER_PREFS_KEY = 'leads';

export const DEFAULT_PREFS: LeadsPrefs = {
  density: 'comfortable',
  hiddenColumns: [],
  extraColumns: [],
  tagGroups: { custom: true, work_type: true, size: false, certification: false, services: false, other: false },
  hiddenCustomTags: [],
  filtersOpen: false,
  alertViews: [],
};

export const prefsKey = (userId: string) => `leadmaker.leads.${userId}`;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Sanitises a stored or server value; anything missing or malformed takes the default. */
export function parsePrefs(raw: unknown): LeadsPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS;
  const r = raw as Partial<Record<keyof LeadsPrefs, unknown>>;
  const groups = { ...DEFAULT_PREFS.tagGroups };
  if (r.tagGroups && typeof r.tagGroups === 'object') {
    const g = r.tagGroups as Record<string, unknown>;
    for (const k of [...TAG_GROUPS, 'custom'] as const) {
      if (typeof g[k] === 'boolean') groups[k] = g[k];
    }
  }
  const columnsIn = (v: unknown, extra: boolean) => strings(v)
    .filter((c): c is ColumnId => (COLUMN_IDS as readonly string[]).includes(c) && isExtraColumn(c as ColumnId) === extra);
  return {
    density: r.density === 'compact' ? 'compact' : 'comfortable',
    hiddenColumns: columnsIn(r.hiddenColumns, false),
    extraColumns: columnsIn(r.extraColumns, true),
    tagGroups: groups,
    hiddenCustomTags: strings(r.hiddenCustomTags),
    filtersOpen: typeof r.filtersOpen === 'boolean' ? r.filtersOpen : DEFAULT_PREFS.filtersOpen,
    alertViews: strings(r.alertViews),
  };
}

/** Only the synced fields (drops cache bookkeeping and legacy keys). */
export function pickPrefs(p: LeadsPrefs): LeadsPrefs {
  return Object.fromEntries(PREFS_KEYS.map((k) => [k, p[k]])) as unknown as LeadsPrefs;
}

// ---- local cache -------------------------------------------------------------------------------------------

interface CacheMeta {
  /** Server version the cache was last in step with (0: never synced). */
  _version?: number;
  /** Local edits the server has not accepted yet. */
  _pending?: boolean;
  /** The last value the server accepted, the base for a three-way merge of offline edits. */
  _base?: unknown;
  /** Views saved in this browser by older versions; migrated to the server, then removed. */
  savedViews?: unknown;
}

function readCache(userId: string): (Partial<LeadsPrefs> & CacheMeta) | null {
  const raw = safeStorage.getJson<Partial<LeadsPrefs> & CacheMeta>(prefsKey(userId));
  return raw && typeof raw === 'object' ? raw : null;
}

function writeCache(userId: string, prefs: LeadsPrefs, meta: CacheMeta): void {
  const legacy = readCache(userId)?.savedViews;
  safeStorage.setJson(prefsKey(userId), { ...pickPrefs(prefs), ...meta, ...(legacy !== undefined ? { savedViews: legacy } : {}) });
}

export function loadPrefs(userId: string): LeadsPrefs {
  return parsePrefs(readCache(userId));
}

/** Views saved in this browser before saved views moved to the server. */
export function loadLocalViews(userId: string): LocalSavedView[] {
  const raw = readCache(userId)?.savedViews;
  return Array.isArray(raw)
    ? raw.filter((v): v is LocalSavedView => !!v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.query === 'string')
    : [];
}

/** Keeps only the local views still to migrate (all migrated: the key goes). */
export function setLocalViews(userId: string, views: LocalSavedView[]): void {
  const raw = readCache(userId);
  if (!raw) return;
  const { savedViews: _drop, ...rest } = raw;
  safeStorage.setJson(prefsKey(userId), views.length ? { ...rest, savedViews: views } : rest);
}

// ---- merge -------------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge after a 409: fields (and single tag groups) this tab changed since `base` win; everything
 * else takes the server's value, so another device's edits to other settings survive.
 */
export function mergePrefs(base: LeadsPrefs, local: LeadsPrefs, server: LeadsPrefs): LeadsPrefs {
  const out = { ...server, tagGroups: { ...server.tagGroups } };
  for (const k of PREFS_KEYS) {
    if (k === 'tagGroups') {
      for (const g of Object.keys(local.tagGroups) as (TagGroup | 'custom')[]) {
        if (local.tagGroups[g] !== base.tagGroups[g]) out.tagGroups[g] = local.tagGroups[g];
      }
    } else if (!same(local[k], base[k])) {
      (out as Record<string, unknown>)[k] = local[k];
    }
  }
  return out;
}

// ---- hook --------------------------------------------------------------------------------------------------

export type PrefsUpdate = Partial<LeadsPrefs> | ((prev: LeadsPrefs) => LeadsPrefs);

const SAVE_DELAY_MS = 600;
const MAX_CONFLICT_RETRIES = 3;

export const prefsQueryKey = (userId: string | undefined) => [...qk.preferences, userId ?? 'anon'] as const;

/**
 * [prefs, update]: update applies at once (and to the offline cache), then saves to the server after a short
 * pause. A stale version (409) refetches, merges and saves again.
 */
export function useLeadsPrefs(userId: string | undefined): [LeadsPrefs, (update: PrefsUpdate) => void] {
  const qc = useQueryClient();
  const [prefs, setPrefsState] = useState<LeadsPrefs>(() => (userId ? loadPrefs(userId) : DEFAULT_PREFS));
  const latest = useRef(prefs);
  const sync = useRef(initialSync(userId));
  const loadedFor = useRef(userId);

  const apply = useCallback((next: LeadsPrefs) => {
    latest.current = next;
    setPrefsState(next);
  }, []);

  // A different signed-in user gets their own preferences.
  useEffect(() => {
    if (loadedFor.current !== userId) {
      loadedFor.current = userId;
      clearTimeout(sync.current.timer);
      sync.current = initialSync(userId);
      apply(userId ? loadPrefs(userId) : DEFAULT_PREFS);
    }
  }, [userId, apply]);

  const server = useQuery({
    queryKey: prefsQueryKey(userId),
    queryFn: ({ signal }) => getPreferences({ signal }),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const persistLocal = useCallback(() => {
    if (!userId) return;
    const s = sync.current;
    writeCache(userId, latest.current, { _version: s.version, _pending: s.pending, _base: s.base });
  }, [userId]);

  const push = useCallback(async (): Promise<void> => {
    const s = sync.current;
    if (!userId || s.user !== userId) return;
    if (s.inflight) {
      s.again = true;
      return;
    }
    s.inflight = true;
    try {
      for (let attempt = 0; ; attempt++) {
        const sent = latest.current;
        try {
          const res = await putPreferences({ ...s.others, [SERVER_PREFS_KEY]: pickPrefs(sent) }, s.version);
          if (sync.current !== s) return;
          s.version = typeof res?.version === 'number' ? res.version : s.version + 1;
          s.others = withoutLeads(res?.prefs) ?? s.others;
          s.base = sent;
          s.pending = latest.current !== sent;
          qc.setQueryData<UserPreferences>(prefsQueryKey(userId), res);
          persistLocal();
          return;
        } catch (err) {
          if (!(err instanceof VersionConflictError) || attempt >= MAX_CONFLICT_RETRIES || sync.current !== s) throw err;
          // Someone (another tab or device) saved first: refetch, merge our changes onto theirs, retry.
          const fresh = await qc.fetchQuery({ queryKey: prefsQueryKey(userId), queryFn: () => getPreferences(), staleTime: 0 });
          if (sync.current !== s) return;
          const theirs = parsePrefs(fresh?.prefs?.[SERVER_PREFS_KEY]);
          const merged = mergePrefs(s.base, latest.current, theirs);
          s.version = fresh?.version ?? s.version;
          s.others = withoutLeads(fresh?.prefs) ?? {};
          s.base = theirs;
          apply(merged);
          persistLocal();
        }
      }
    } catch {
      // Offline or the server refused: the edit stays in the local cache (pending) and is pushed next load.
    } finally {
      s.inflight = false;
      if (s.again) {
        s.again = false;
        void push();
      }
    }
  }, [userId, qc, apply, persistLocal]);

  // The server copy arrived (or changed): adopt it, or push local edits it has not seen.
  useEffect(() => {
    const data = server.data;
    const s = sync.current;
    if (!data || !userId || s.user !== userId || s.inflight) return;
    if (typeof data.version === 'number' && data.version < s.version) return;
    s.others = withoutLeads(data.prefs) ?? {};
    const stored = data.prefs?.[SERVER_PREFS_KEY];
    if (stored === undefined && !s.pending && same(pickPrefs(latest.current), pickPrefs(DEFAULT_PREFS))) {
      s.version = data.version ?? 0;
      return;
    }
    if (s.pending || (stored === undefined && s.version === 0)) {
      // Offline edits (or first sync of a browser-only setup): merge onto the server's copy and save.
      const theirs = stored === undefined ? latest.current : parsePrefs(stored);
      const merged = stored === undefined ? latest.current : mergePrefs(s.base, latest.current, theirs);
      s.version = data.version ?? 0;
      s.base = theirs;
      s.pending = true;
      apply(merged);
      persistLocal();
      void push();
      return;
    }
    if (data.version === s.version && same(pickPrefs(latest.current), pickPrefs(parsePrefs(stored)))) return;
    const next = parsePrefs(stored);
    s.version = data.version ?? s.version;
    s.base = next;
    apply(next);
    persistLocal();
  }, [server.data, userId, apply, persistLocal, push]);

  useEffect(() => () => clearTimeout(sync.current.timer), []);

  const update = useCallback((u: PrefsUpdate) => {
    const prev = latest.current;
    const next = typeof u === 'function' ? u(prev) : { ...prev, ...u };
    if (next === prev) return;
    apply(next);
    const s = sync.current;
    s.pending = true;
    persistLocal();
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void push(), SAVE_DELAY_MS);
  }, [apply, persistLocal, push]);

  return [prefs, update];
}

interface SyncState {
  user: string | undefined;
  version: number;
  base: LeadsPrefs;
  pending: boolean;
  /** The user's other preference keys (other pages'), sent back untouched since PUT replaces them all. */
  others: Record<string, unknown>;
  inflight: boolean;
  again: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function initialSync(userId: string | undefined): SyncState {
  const cache = userId ? readCache(userId) : null;
  return {
    user: userId,
    version: typeof cache?._version === 'number' ? cache._version : 0,
    base: cache?._base ? parsePrefs(cache._base) : userId ? loadPrefs(userId) : DEFAULT_PREFS,
    pending: !!cache?._pending,
    others: {},
    inflight: false,
    again: false,
  };
}

function withoutLeads(prefs: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!prefs || typeof prefs !== 'object') return null;
  const { [SERVER_PREFS_KEY]: _leads, ...rest } = prefs;
  return rest;
}
