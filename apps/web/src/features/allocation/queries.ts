// Allocation reads (team load) and writes (assign, assign by filter, return to pool, undo), with the
// success toasts and their Undo actions in one place so every entry point behaves the same.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { ApiError, isRecord } from '@/api/errors';
import * as ep from '@/api/endpoints';
import { invalidateAllocation, useAllocationSuggestions, useKpis, useUsers } from '@/api/queries';
import type { LeadFilter, UserListItem } from '@/api/types';
import { useToast } from '@/components/ui';
import { configKey, ensureAllocationLimits, unallocateLeads } from './api';
import {
  chunk, mergeOutcomes, normalizeOutcome, normalizeRelease, plural, repsOf, undoPlan,
  type AllocationOutcome, type MovedLead, type RepLoad,
} from './lib';

// ---- reads ---------------------------------------------------------------------------------

export interface TeamLoad {
  reps: RepLoad[];
  /** Every user (managers too), for names in live updates. */
  users: UserListItem[];
  pool: { size: number | null; updatedInLastPoll: number | null };
  maxAllocated: number;
  kpiRefreshedAt: string | null;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/** Per-rep load: allocated is live (GET /api/users); unchecked/unserviced come from the team KPI view. */
export function useTeamLoad(enabled = true): TeamLoad {
  const users = useUsers(undefined, { enabled });
  const kpis = useKpis();
  const suggestions = useAllocationSuggestions(undefined, { enabled });

  return useMemo(() => {
    const team = kpis.data?.team;
    const kpiReps = team?.reps ?? [];
    const userReps = repsOf(users.data?.items);
    const base = userReps.length
      ? userReps.map((u) => ({ id: u.id, name: u.name, email: u.email, allocated: u.allocatedCount }))
      : kpiReps.map((r) => ({ id: r.repId, name: r.name, email: r.email, allocated: r.allocated }));
    const reps: RepLoad[] = base.map((r) => {
      const k = kpiReps.find((x) => x.repId === r.id);
      // The KPI view refreshes every few minutes while allocated is live: never show more unchecked than owned.
      const cap = (n: number | undefined) => (typeof n === 'number' ? Math.min(n, r.allocated) : null);
      return {
        ...r,
        unchecked: cap(k?.unchecked),
        unserviced: cap(k?.unserviced),
        updatedInLastPoll: cap(k?.updated_in_last_poll),
      };
    });
    const size = suggestions.data?.unallocatedTotal ?? team?.unallocated?.allocated ?? null;
    return {
      reps,
      users: users.data?.items ?? [],
      pool: { size: typeof size === 'number' ? size : null, updatedInLastPoll: team?.unallocated?.updated_in_last_poll ?? null },
      maxAllocated: Math.max(1, ...reps.map((r) => r.allocated)),
      kpiRefreshedAt: team?.refreshedAt ?? null,
      isLoading: !reps.length && (users.isLoading || kpis.isLoading),
      error: users.error && kpis.error ? users.error : null,
      refetch: () => {
        void users.refetch();
        void kpis.refetch();
        void suggestions.refetch();
      },
    };
  }, [users.data, users.isLoading, users.error, kpis.data, kpis.isLoading, kpis.error, suggestions.data]); // refetch fns are stable
}

// ---- writes ---------------------------------------------------------------------------------

/** A readable message for the server's refusal of an oversized bulk allocation, else null. */
export function tooManyMessage(err: unknown, fallbackMax?: number): { title: string; description: string } | null {
  if (!(err instanceof ApiError) || err.code !== 'too_many_leads') return null;
  const d = isRecord(err.details) ? err.details : {};
  const max = typeof d.max === 'number' ? d.max : fallbackMax;
  const matched = typeof d.matched === 'number' ? d.matched : null;
  return {
    title: matched ? `That filter matches ${d.matchedAtLeast ? 'over ' : ''}${matched.toLocaleString('en-US')} leads` : 'That filter matches too many leads',
    description: max
      ? `You can assign up to ${max.toLocaleString('en-US')} at a time. Narrow the filter and try again.`
      : 'Narrow the filter and try again.',
  };
}

/** The ids a 404 from DELETE /api/allocations names as unknown (details.missing), else []. */
function missingIds(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.status !== 404 || !isRecord(err.details)) return [];
  const m = err.details.missing;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

export interface ReleaseOutcome {
  moved: MovedLead[];
  /** Already in the pool: left alone. */
  unchanged: number;
  /** Deleted meanwhile (the server's 404 named them). */
  missing: number;
  /** In a batch that failed for another reason. */
  failed: number;
  /** The first such failure, to report when nothing moved. */
  error: unknown;
}

/**
 * Returns leads to the pool with the bulk DELETE, `max` per request (null: one request). A batch the server
 * refuses for unknown ids is retried once without them, so one deleted lead never blocks the rest.
 */
export async function releaseToPool(companyIds: string[], max: number | null): Promise<ReleaseOutcome> {
  const out: ReleaseOutcome = { moved: [], unchanged: 0, missing: 0, failed: 0, error: null };
  const fail = (n: number, e: unknown) => {
    out.failed += n;
    out.error ??= e;
  };
  for (const part of chunk([...new Set(companyIds)], max)) {
    let ids = part;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = normalizeRelease(await unallocateLeads(ids));
        out.moved.push(...r.moved);
        out.unchanged += r.unchanged.length;
        break;
      } catch (e) {
        const gone = attempt === 0 ? new Set(missingIds(e)) : new Set<string>();
        if (!gone.size) {
          fail(ids.length, e);
          break;
        }
        out.missing += ids.filter((id) => gone.has(id)).length;
        ids = ids.filter((id) => !gone.has(id));
        if (!ids.length) break;
      }
    }
  }
  return out;
}

interface AssignVars {
  companyIds: string[];
  repId: string;
}

export interface RestoreResult {
  restored: number;
  failed: number;
}

/**
 * const alloc = useAllocationActions();
 * await alloc.assign(ids, repId);   // toast with Undo, invalidates lists/KPIs/suggestions
 */
export function useAllocationActions(users: UserListItem[] = []) {
  const qc = useQueryClient();
  const toast = useToast();
  const nameOf = useCallback((id: string | null) => users.find((u) => u.id === id)?.name ?? 'the rep', [users]);

  const assignM = useMutation({
    mutationFn: async ({ companyIds, repId }: AssignVars) => {
      const limits = await ensureAllocationLimits(qc);
      const outcomes: AllocationOutcome[] = [];
      for (const ids of chunk(companyIds, limits?.maxBulkAllocation ?? null)) {
        outcomes.push(normalizeOutcome(await ep.allocateLeads(ids, repId), repId));
      }
      return mergeOutcomes(outcomes, repId);
    },
    onSuccess: (_out, v) => invalidateAllocation(qc, v.companyIds),
    onError: (e) => toast.error(e),
  });

  const byFilterM = useMutation({
    mutationFn: async ({ filter, repId }: { filter: LeadFilter; repId: string }) => {
      const { cursor: _c, limit: _l, ...rest } = filter;
      return normalizeOutcome(await ep.allocateByFilter(rest, repId), repId);
    },
    onSuccess: (out) => invalidateAllocation(qc, out.moved.map((m) => m.companyId)),
    onError: (e) => {
      const tm = tooManyMessage(e, qc.getQueryData<{ maxBulkAllocation?: number }>(configKey)?.maxBulkAllocation);
      if (tm) toast.error(tm.title, tm.description);
      else toast.error(e);
    },
  });

  const unassignM = useMutation({
    mutationFn: async ({ companyIds }: { companyIds: string[] }) => {
      const limits = await ensureAllocationLimits(qc);
      const out = await releaseToPool(companyIds, limits?.maxBulkUnallocate ?? null);
      if (!out.moved.length && out.failed) throw out.error;
      return out;
    },
    onSuccess: (_r, v) => invalidateAllocation(qc, v.companyIds),
    onError: (e) => toast.error(e),
  });

  const restoreM = useMutation({
    mutationFn: async (moved: MovedLead[]): Promise<RestoreResult> => {
      const { toPool, toReps } = undoPlan(moved);
      const limits = await ensureAllocationLimits(qc);
      let restored = 0;
      let failed = 0;
      for (const [repId, ids] of toReps) {
        for (const part of chunk(ids, limits?.maxBulkAllocation ?? null)) {
          try {
            await ep.allocateLeads(part, repId);
            restored += part.length;
          } catch {
            failed += part.length;
          }
        }
      }
      if (toPool.length) {
        // Already in the pool (someone else put it back) is where Undo wanted it.
        const r = await releaseToPool(toPool, limits?.maxBulkUnallocate ?? null);
        restored += r.moved.length + r.unchanged;
        failed += r.missing + r.failed;
      }
      return { restored, failed };
    },
    onSuccess: (_r, moved) => invalidateAllocation(qc, moved.map((m) => m.companyId)),
    onError: (e) => toast.error(e),
  });

  const undo = useCallback(async (moved: MovedLead[], what = 'allocation') => {
    try {
      const r = await restoreM.mutateAsync(moved);
      if (r.failed) toast.warning(`Undid ${plural(r.restored, 'lead')}; ${r.failed} could not be restored`, 'They may have been changed by someone else.');
      else toast.success(`Undid the ${what}`, `${plural(r.restored, 'lead')} back where ${r.restored === 1 ? 'it was' : 'they were'}.`);
    } catch {
      /* toasted in onError */
    }
  }, [restoreM, toast]);

  const announce = useCallback((out: AllocationOutcome, title: string) => {
    const notes: string[] = [];
    if (out.unchanged) notes.push(`${plural(out.unchanged, 'lead')} already with ${nameOf(out.repId)}`);
    if (out.missing) notes.push(`${plural(out.missing, 'lead')} no longer exist${out.missing === 1 ? 's' : ''}`);
    if (!out.moved.length) {
      toast.info('Nothing changed', notes.join(' · ') || undefined);
      return;
    }
    toast({
      variant: 'success',
      title,
      description: notes.join(' · ') || undefined,
      duration: 10_000,
      action: { label: 'Undo', onClick: () => void undo(out.moved, 'assignment') },
    });
  }, [nameOf, toast, undo]);

  /** Assign (or reassign) explicit leads to a rep. Resolves null when it failed (already toasted). */
  const assign = useCallback(async (companyIds: string[], repId: string, opts: { title?: string } = {}) => {
    try {
      const out = await assignM.mutateAsync({ companyIds, repId });
      const reassigned = out.moved.some((m) => m.previousRepId);
      announce(out, opts.title ?? `${reassigned ? 'Reassigned' : 'Assigned'} ${plural(out.moved.length, 'lead')} to ${nameOf(repId)}`);
      return out;
    } catch {
      return null;
    }
  }, [assignM, announce, nameOf]);

  /** Assign everything a LeadFilter matches (POST /api/allocations/by-filter). */
  const assignByFilter = useCallback(async (filter: LeadFilter, repId: string) => {
    try {
      const out = await byFilterM.mutateAsync({ filter, repId });
      const reassigned = out.moved.some((m) => m.previousRepId);
      announce(out, `${reassigned ? 'Reassigned' : 'Assigned'} ${plural(out.moved.length, 'lead')} to ${nameOf(repId)}`);
      return out;
    } catch {
      return null;
    }
  }, [byFilterM, announce, nameOf]);

  /** Return leads to the unallocated pool (DELETE /api/allocations, batched by config.maxBulkUnallocate). */
  const returnToPool = useCallback(async (companyIds: string[]) => {
    try {
      const out = await unassignM.mutateAsync({ companyIds });
      const notes: string[] = [];
      if (out.unchanged) notes.push(`${plural(out.unchanged, 'lead')} already in the pool`);
      if (out.missing) notes.push(`${plural(out.missing, 'lead')} no longer exist${out.missing === 1 ? 's' : ''}`);
      if (out.failed) notes.push(`${plural(out.failed, 'lead')} could not be moved`);
      if (!out.moved.length) {
        toast.info('Nothing changed', notes.join(' · ') || undefined);
        return out.moved;
      }
      const from = new Set(out.moved.map((m) => m.previousRepId));
      toast({
        variant: out.failed ? 'warning' : 'success',
        title: `Returned ${plural(out.moved.length, 'lead')} to the pool`,
        description: notes.join(' · ') || (from.size === 1 ? `From ${nameOf([...from][0] ?? null)}.` : undefined),
        duration: 10_000,
        action: { label: 'Undo', onClick: () => void undo(out.moved, 'move to the pool') },
      });
      return out.moved;
    } catch {
      return null;
    }
  }, [unassignM, toast, nameOf, undo]);

  /** Approve suggestion groups: one POST per rep, one toast (with a single Undo) for the lot. */
  const approve = useCallback(async (groups: { companyIds: string[]; repId: string }[], label: string) => {
    const byRep = new Map<string, string[]>();
    for (const g of groups) byRep.set(g.repId, [...(byRep.get(g.repId) ?? []), ...g.companyIds]);
    const outcomes: AllocationOutcome[] = [];
    let failure: unknown = null;
    for (const [repId, ids] of byRep) {
      try {
        outcomes.push(await assignM.mutateAsync({ companyIds: ids, repId }));
      } catch (e) {
        failure = e;
      }
    }
    if (!outcomes.length) return null;
    const merged = mergeOutcomes(outcomes, outcomes[0]!.repId);
    const reps = [...new Set(outcomes.filter((o) => o.moved.length).map((o) => nameOf(o.repId)))];
    toast({
      variant: failure ? 'warning' : 'success',
      title: `${label}: ${plural(merged.moved.length, 'lead')} assigned`,
      description: failure ? 'Some groups failed; the rest went through.' : reps.length ? `To ${reps.join(', ')}.` : undefined,
      duration: 10_000,
      action: merged.moved.length ? { label: 'Undo', onClick: () => void undo(merged.moved, 'approval') } : undefined,
    });
    return merged;
  }, [assignM, nameOf, toast, undo]);

  return {
    assign,
    assignByFilter,
    returnToPool,
    approve,
    undo,
    isPending: assignM.isPending || byFilterM.isPending || unassignM.isPending || restoreM.isPending,
    isAssigning: assignM.isPending,
    isAssigningByFilter: byFilterM.isPending,
    isReturning: unassignM.isPending,
  };
}
