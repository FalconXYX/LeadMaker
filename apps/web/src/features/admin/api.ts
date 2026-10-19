// Admin reads and writes (managers only; the gateway answers 403 to reps).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useToast } from '@/components/ui';
import { areaText, isActive, normalizeRuns, normalizeTerritories, normalizeTerritory, territoryName } from './lib';
import type { Run, RunStarted, Territory, TerritoryInput } from './types';

export const RUNS_LIMIT = 20;
/** While anything is queued or running the page checks every 5 s; otherwise every 30 s. */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;

export const adminKeys = {
  all: ['admin'] as const,
  territories: ['admin', 'territories'] as const,
  runs: (limit: number) => ['admin', 'runs', limit] as const,
};

type Opts = { signal?: AbortSignal };

export const getTerritories = async (o?: Opts) => normalizeTerritories(await api.get<unknown>('/api/admin/territories', o));
export const getRuns = async (limit = RUNS_LIMIT, o?: Opts) => normalizeRuns(await api.get<unknown>('/api/admin/runs', { ...o, query: { limit } }));

async function saved(p: Promise<unknown>): Promise<Territory> {
  const t = normalizeTerritory(await p);
  if (!t) throw new Error('LeadMaker saved the area but sent back something unexpected. Reload to see it.');
  return t;
}

export const createTerritory = (body: TerritoryInput) => saved(api.post('/api/admin/territories', body));
export const updateTerritory = (id: string, patch: Partial<TerritoryInput>) => saved(api.patch(`/api/admin/territories/${encodeURIComponent(id)}`, patch));
export const deleteTerritory = (id: string) => api.delete<void>(`/api/admin/territories/${encodeURIComponent(id)}`);
export const runTerritory = (id: string) => api.post<RunStarted>(`/api/admin/territories/${encodeURIComponent(id)}/run`);

// ---- reads ---------------------------------------------------------------------------------

/** `fast`: something is running, so last/next run times are refreshed with the runs list. */
export function useTerritories(fast = false) {
  return useQuery({
    queryKey: adminKeys.territories,
    queryFn: ({ signal }) => getTerritories({ signal }),
    refetchInterval: fast ? FAST_POLL_MS : false,
  });
}

/** `waiting`: a run was just started here and may not be listed yet, so keep checking quickly. */
export function useRuns(waiting = false, limit = RUNS_LIMIT) {
  return useQuery({
    queryKey: adminKeys.runs(limit),
    queryFn: ({ signal }) => getRuns(limit, { signal }),
    refetchInterval: (q) => (waiting || (q.state.data ?? []).some((r: Run) => isActive(r.status)) ? FAST_POLL_MS : SLOW_POLL_MS),
  });
}

// ---- writes --------------------------------------------------------------------------------

export function useTerritoryActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const setList = (fn: (xs: Territory[]) => Territory[]) => qc.setQueryData<Territory[]>(adminKeys.territories, (xs) => (xs ? fn(xs) : xs));
  const upsert = (t: Territory) => setList((xs) => (xs.some((x) => x.id === t.id) ? xs.map((x) => (x.id === t.id ? t : x)) : [...xs, t]));
  const refresh = () => qc.invalidateQueries({ queryKey: adminKeys.territories });

  const create = useMutation({
    mutationFn: createTerritory,
    onSuccess: (t) => {
      upsert(t);
      void refresh();
      toast.success('Area added', `LeadMaker will look for contractors within ${t.radiusMiles} mi of ${t.zip}.`);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TerritoryInput> }) => updateTerritory(id, patch),
    onSuccess: (t) => {
      upsert(t);
      void refresh();
    },
  });

  /** The on/off switch: flips at once, puts it back if the save fails. */
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateTerritory(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: adminKeys.territories });
      const before = qc.getQueryData<Territory[]>(adminKeys.territories);
      setList((xs) => xs.map((x) => (x.id === id ? { ...x, enabled } : x)));
      return { before };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(adminKeys.territories, ctx.before);
      toast.error(e);
    },
    onSuccess: (t) => {
      upsert(t);
      toast.success(t.enabled ? `${territoryName(t)} is on` : `${territoryName(t)} is paused`, t.enabled
        ? (t.everyHours == null ? 'It runs when you press Run now.' : 'Scheduled runs will pick it up again.')
        : 'No scheduled runs until you turn it back on. Run now still works.');
    },
    onSettled: () => void refresh(),
  });

  const remove = useMutation({
    mutationFn: (t: Territory) => deleteTerritory(t.id),
    onSuccess: (_r, t) => {
      setList((xs) => xs.filter((x) => x.id !== t.id));
      void refresh();
      toast.success('Area deleted', `LeadMaker stopped looking around ${areaText(t.zip, t.radiusMiles)}. Leads it already found stay.`);
    },
    onError: (e) => toast.error(e),
  });

  const run = useMutation({
    mutationFn: (t: Territory) => runTerritory(t.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.all }),
    onError: (e) => toast.error(e),
  });

  return { create, update, setEnabled, remove, run };
}
