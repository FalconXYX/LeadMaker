// Saved views on the server (GET/POST/PATCH/DELETE /api/views). A view stores a LeadFilter and its sort; the
// list's URL state maps to and from it through the lib/filterUrl helpers (useLeadsUrl). Views saved in this
// browser by older versions are moved to the server once, then removed from localStorage.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { ApiError } from '@/api/errors';
import type { LeadFilter, SavedView, SavedViewCreate, SavedViewsResponse, SavedViewWritten } from '@/api/types';
import { createView, deleteView, getViews, updateView } from '@/api/endpoints';
import { qk } from '@/api/queries';
import { loadLocalViews, setLocalViews, type LocalSavedView } from './prefs';
import { ALERT_PARAM, normalizeQuery, searchParamsToFilter, viewQuery } from './useLeadsUrl';

/** 409 name_taken: the owner already has a view (or the team a tag) with that name. */
export function isNameTaken(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'name_taken';
}

/** A list URL query -> what a server view stores (cursor and limit dropped; sort apart) + the alert flag. */
export function queryToView(query: string): { filter: LeadFilter; sort: LeadFilter['sort'] | null; alert: boolean } {
  const p = new URLSearchParams(query);
  const { sort, cursor: _c, limit: _l, ...filter } = searchParamsToFilter(p);
  return { filter, sort: sort ?? null, alert: p.get(ALERT_PARAM) === '1' };
}

/** A server view -> the list URL query that shows it. */
export function viewToQuery(view: Pick<SavedView, 'filter' | 'sort'>, alert = false): string {
  const { cursor: _c, limit: _l, sort: inner, ...rest } = view.filter ?? {};
  const sort = view.sort ?? inner;
  return viewQuery({ ...rest, ...(sort ? { sort } : {}) }, alert);
}

export interface MigrationResult {
  /** Local view -> the server view now holding it (created, or an identical one already there). */
  moved: { local: LocalSavedView; view: SavedView; alert: boolean }[];
  /** Not moved (offline, server error): they stay in localStorage for the next attempt. */
  failed: LocalSavedView[];
}

/**
 * Moves browser-saved views to the server. An own server view with the same name and filter counts as moved
 * (a previous, interrupted run); a different view with the same name gets the next free "Name (2)".
 */
export async function migrateLocalViews(
  local: readonly LocalSavedView[],
  existing: readonly SavedView[],
  create: (body: SavedViewCreate) => Promise<SavedViewWritten>,
): Promise<MigrationResult> {
  const out: MigrationResult = { moved: [], failed: [] };
  const own = existing.filter((v) => v.mine);
  for (const lv of local) {
    const { filter, sort, alert } = queryToView(lv.query);
    const target = normalizeQuery(viewToQuery({ filter, sort }));
    const twin = own.find((v) => v.name.toLowerCase() === lv.name.toLowerCase() && normalizeQuery(viewToQuery(v)) === target);
    if (twin) {
      out.moved.push({ local: lv, view: twin, alert });
      continue;
    }
    let done = false;
    for (let n = 1; n <= 5 && !done; n++) {
      const name = n === 1 ? lv.name : `${lv.name.slice(0, 55)} (${n})`;
      try {
        const res = await create({ name, filter, ...(sort ? { sort } : {}) });
        out.moved.push({ local: lv, view: res.view, alert });
        own.push(res.view);
        done = true;
      } catch (err) {
        if (!isNameTaken(err)) break;
      }
    }
    if (!done) out.failed.push(lv);
  }
  return out;
}

const migrations = new Map<string, Promise<unknown>>();

export interface SavedViewsApi {
  /** The caller's own views. */
  mine: SavedView[];
  /** Other people's views shared with the team. */
  shared: SavedView[];
  loading: boolean;
  error: unknown;
}

/** GET /api/views, split into own and team views, with the one-time move of browser-saved views. */
export function useSavedViews(
  userId: string | undefined,
  onMigrated?: (res: MigrationResult) => void,
): SavedViewsApi {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.views,
    queryFn: ({ signal }) => getViews({ signal }),
    enabled: !!userId,
    staleTime: 60_000,
  });
  const items = useMemo(() => (Array.isArray(q.data?.items) ? q.data.items : []), [q.data]);

  useEffect(() => {
    if (!userId || !q.isSuccess || migrations.has(userId)) return;
    const local = loadLocalViews(userId);
    if (!local.length) return;
    const run = migrateLocalViews(local, items, createView).then((res) => {
      setLocalViews(userId, res.failed);
      if (res.moved.length) {
        qc.setQueryData<SavedViewsResponse>(qk.views, (old) => {
          const have = new Set((old?.items ?? []).map((v) => v.id));
          return { items: [...(old?.items ?? []), ...res.moved.map((m) => m.view).filter((v) => !have.has(v.id))] };
        });
        void qc.invalidateQueries({ queryKey: qk.views });
      }
      onMigrated?.(res);
    }).finally(() => {
      // A failed run may try again on a later mount; a finished one has nothing left to move.
      setTimeout(() => migrations.delete(userId), 0);
    });
    migrations.set(userId, run);
  }, [userId, q.isSuccess, items, qc, onMigrated]);

  return useMemo(() => ({
    mine: items.filter((v) => v.mine),
    shared: items.filter((v) => !v.mine && v.isShared),
    loading: q.isPending && !!userId,
    error: q.error,
  }), [items, q.isPending, q.error, userId]);
}

/** Create / rename / share / delete, each patching the cached list so the menu updates at once. */
export function useViewMutations() {
  const qc = useQueryClient();
  const upsert = (view: SavedView) =>
    qc.setQueryData<SavedViewsResponse>(qk.views, (old) => {
      const items = old?.items ?? [];
      return { items: items.some((v) => v.id === view.id) ? items.map((v) => (v.id === view.id ? view : v)) : [...items, view] };
    });
  const drop = (viewId: string) =>
    qc.setQueryData<SavedViewsResponse>(qk.views, (old) => ({ items: (old?.items ?? []).filter((v) => v.id !== viewId) }));
  const settle = () => qc.invalidateQueries({ queryKey: qk.views });

  const create = useMutation({
    mutationFn: (body: SavedViewCreate) => createView(body),
    onSuccess: (res) => upsert(res.view),
    onSettled: settle,
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateView>[1] }) => updateView(id, patch),
    onSuccess: (res) => upsert(res.view),
    onSettled: settle,
  });
  const remove = useMutation({
    mutationFn: (view: SavedView) => deleteView(view.id),
    onMutate: (view) => drop(view.id),
    onError: (_e, view) => upsert(view),
    onSettled: settle,
  });
  return { create, update, remove };
}

/** The saved view the current URL shows, if any (own views first). */
export function matchingView(query: string, views: readonly SavedView[], alertViews: readonly string[]): SavedView | null {
  const cur = normalizeQuery(query);
  return views.find((v) => normalizeQuery(viewToQuery(v, alertViews.includes(v.id))) === cur) ?? null;
}
