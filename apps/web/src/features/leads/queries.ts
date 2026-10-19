// Lead-list hooks: optimistic checked/serviced toggles and stage changes, bulk tagging, stage changes and
// follow-ups, tag rename/delete.
import { useMutation, useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import * as ep from '@/api/endpoints';
import { VersionConflictError } from '@/api/errors';
import { invalidateLead, qk } from '@/api/queries';
import type { CustomTagsResponse, LeadSearchResult, LeadSummary, StateChanged, TagLeadVersion } from '@/api/types';
import { useToast } from '@/components/ui';
import { createTask, setLeadStage } from '@/api/endpoints';
import { DEFAULT_LIMITS, type TaskCreate } from './api';
import { STAGE_LABELS, type SalesStage } from './sales';

export const leadsKeys = {
  stateMutation: ['leads', 'state'] as const,
};

type ListData = InfiniteData<LeadSearchResult> | LeadSearchResult | undefined;

/** Applies `fn` to every cached copy of a lead in the list queries (paged and single-page). */
export function patchLeadInLists(qc: QueryClient, leadId: string, fn: (lead: LeadSummary) => LeadSummary): void {
  const patchItems = (items: LeadSummary[] | undefined) => items?.map((l) => (l.id === leadId ? fn(l) : l));
  qc.setQueriesData<ListData>({ queryKey: qk.leads.lists }, (old) => {
    if (!old || typeof old !== 'object') return old;
    if ('pages' in old && Array.isArray(old.pages)) {
      return { ...old, pages: old.pages.map((p) => (p && Array.isArray(p.items) ? { ...p, items: patchItems(p.items)! } : p)) };
    }
    if ('items' in old && Array.isArray(old.items)) return { ...old, items: patchItems(old.items)! };
    return old;
  });
}

export interface StateChange {
  checked?: boolean;
  serviced?: boolean;
}

function applyChange(lead: LeadSummary, change: StateChange): LeadSummary {
  const now = new Date().toISOString();
  const mine = { ...lead.mine };
  const team = { ...lead.team };
  if (change.checked !== undefined) {
    mine.checked = change.checked;
    mine.checkedAt = change.checked ? now : null;
    if (change.checked) team.checked = true;
  }
  if (change.serviced !== undefined) {
    mine.serviced = change.serviced;
    mine.servicedAt = change.serviced ? now : null;
    if (change.serviced) team.serviced = true;
  }
  return { ...lead, mine, team };
}

/**
 * The team flags after a state write. The response carries the team's latest times only: nobody's time means
 * nobody (checked / serviced); otherwise keep the optimistic flag, which the list refetch then confirms.
 */
export function teamAfter(lead: LeadSummary, res: StateChanged): LeadSummary['team'] {
  const t = res.team;
  if (!t) return lead.team;
  return {
    checked: t.lastCheckedAt ? lead.team.checked || res.state.checked : false,
    serviced: t.lastServicedAt ? lead.team.serviced || res.state.serviced : false,
    checkedAt: t.lastCheckedAt,
    servicedAt: t.lastServicedAt,
  };
}

/**
 * Optimistic checked/serviced toggle (POST /api/leads/:id/state). Lists refetch only after the last
 * in-flight toggle settles, so quick successive clicks never flash back to stale server state.
 */
export function useLeadStateToggle(opts: { onLocalEdit?: (leadId: string) => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationKey: leadsKeys.stateMutation,
    mutationFn: ({ lead, change }: { lead: LeadSummary; change: StateChange }) => ep.setLeadState(lead.id, change),
    onMutate: async ({ lead, change }) => {
      opts.onLocalEdit?.(lead.id);
      await qc.cancelQueries({ queryKey: qk.leads.lists });
      const snapshot = qc.getQueriesData<ListData>({ queryKey: qk.leads.lists });
      patchLeadInLists(qc, lead.id, (l) => applyChange(l, change));
      return { snapshot };
    },
    onSuccess: (res: StateChanged | undefined, { lead }) => {
      if (res?.state) patchLeadInLists(qc, lead.id, (l) => ({ ...l, mine: res.state, team: teamAfter(l, res) }));
    },
    onError: (e, _vars, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key as QueryKey, data));
      toast.error(e);
    },
    onSettled: (_res, _err, { lead }) => {
      if (qc.isMutating({ mutationKey: leadsKeys.stateMutation }) <= 1) return invalidateLead(qc, lead.id);
      return qc.invalidateQueries({ queryKey: qk.leads.detail(lead.id) });
    },
  });
}

export interface BulkTagInput {
  /** An existing tag, or a name to create (POST /api/custom-tags returns the existing one on a name match). */
  tag: { id: string; name: string } | { name: string };
  leadIds: string[];
}

export interface BulkTagResult {
  tag: { id: string; name: string };
  tagged: string[];
  alreadyHad: string[];
  /** Visible but not the user's to write (a rep: unallocated or another rep's). */
  readOnly: string[];
  /** Gone or no longer visible. */
  missing: string[];
}

/**
 * Creates the tag if needed, then attaches it to the leads in batches of `maxBulkTag` (GET /api/config) per
 * POST /api/custom-tags/:id/leads.
 */
export function useBulkAddTag(opts: { maxBulkTag?: number } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const cap = Math.max(1, opts.maxBulkTag ?? DEFAULT_LIMITS.maxBulkTag);
  return useMutation({
    mutationFn: async ({ tag, leadIds }: BulkTagInput): Promise<BulkTagResult> => {
      const resolved = 'id' in tag ? tag : (await ep.createCustomTag(tag.name.trim())).tag;
      const out: BulkTagResult = { tag: { id: resolved.id, name: resolved.name }, tagged: [], alreadyHad: [], readOnly: [], missing: [] };
      for (let i = 0; i < leadIds.length; i += cap) {
        const r = await ep.attachCustomTagToLeads(resolved.id, leadIds.slice(i, i + cap));
        out.tagged.push(...(r.attached ?? []).map((a) => a.companyId));
        out.alreadyHad.push(...(r.alreadyTagged ?? []));
        out.readOnly.push(...(r.skippedReadOnly ?? []));
        out.missing.push(...(r.skippedInvisible ?? []));
      }
      return out;
    },
    onSuccess: (res) => Promise.all([
      qc.invalidateQueries({ queryKey: qk.leads.lists }),
      qc.invalidateQueries({ queryKey: qk.customTags }),
      ...res.tagged.map((id) => qc.invalidateQueries({ queryKey: qk.leads.detail(id) })),
    ]),
    onError: (e) => toast.error(e),
  });
}

function invalidateTagged(qc: QueryClient, leads: TagLeadVersion[] | undefined) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.customTags }),
    qc.invalidateQueries({ queryKey: qk.leads.lists }),
    ...(leads ?? []).map((l) => qc.invalidateQueries({ queryKey: qk.leads.detail(l.companyId) })),
  ]);
}

/** PATCH /api/custom-tags/:id {name}; the error (409 name_taken, 403) is left to the caller to show inline. */
export function useRenameTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => ep.renameCustomTag(id, name),
    onSuccess: (res, { id, name }) => {
      qc.setQueryData<CustomTagsResponse>(qk.customTags, (old) => old && ({
        ...old,
        items: old.items.map((t) => (t.id === id ? { ...t, name: res?.tag?.name ?? name } : t)),
      }));
      return invalidateTagged(qc, res?.leads);
    },
  });
}

/** DELETE /api/custom-tags/:id: unlinks it from every lead, then deletes it. */
export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => ep.deleteCustomTag(id),
    onSuccess: (res, { id }) => {
      qc.setQueryData<CustomTagsResponse>(qk.customTags, (old) => old && ({ ...old, items: old.items.filter((t) => t.id !== id) }));
      return invalidateTagged(qc, res?.leads);
    },
  });
}

// ---- sales stage and follow-ups ---------------------------------------------------------------------------------

const withStage = (lead: LeadSummary, stage: SalesStage, version?: number): LeadSummary =>
  ({ ...lead, salesStage: stage, ...(version !== undefined ? { version } : {}) }) as LeadSummary;

/** Optimistic stage change (PUT /api/leads/:id/stage with the row's version); a stale row refreshes and says so. */
export function useSetStage(opts: { onLocalEdit?: (leadId: string) => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ lead, stage }: { lead: LeadSummary; stage: SalesStage }) => setLeadStage(lead.id, stage, lead.version),
    onMutate: async ({ lead, stage }) => {
      opts.onLocalEdit?.(lead.id);
      await qc.cancelQueries({ queryKey: qk.leads.lists });
      const snapshot = qc.getQueriesData<ListData>({ queryKey: qk.leads.lists });
      patchLeadInLists(qc, lead.id, (l) => withStage(l, stage));
      return { snapshot };
    },
    onSuccess: (res, { lead, stage }) => {
      patchLeadInLists(qc, lead.id, (l) => withStage(l, res?.stage ?? stage, typeof res?.version === 'number' ? res.version : undefined));
    },
    onError: (e, { lead }, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key as QueryKey, data));
      if (e instanceof VersionConflictError) {
        toast({ variant: 'warning', title: `${lead.businessName} was just updated`, description: 'The list is refreshed; pick the stage again.' });
      } else toast.error(e);
    },
    onSettled: (_res, _err, { lead }) => invalidateLead(qc, lead.id),
  });
}

export interface BulkWriteResult {
  done: string[];
  /** Changed by someone else meanwhile (409). */
  conflicts: string[];
  failed: string[];
}

/** Runs `fn` over the items, a few at a time. */
async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function collect(leads: readonly LeadSummary[], write: (lead: LeadSummary) => Promise<unknown>): Promise<BulkWriteResult> {
  const out: BulkWriteResult = { done: [], conflicts: [], failed: [] };
  await inBatches(leads, 4, async (lead) => {
    try {
      await write(lead);
      out.done.push(lead.id);
    } catch (err) {
      (err instanceof VersionConflictError ? out.conflicts : out.failed).push(lead.id);
    }
  });
  return out;
}

function invalidateMany(qc: QueryClient, ids: readonly string[]) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.leads.lists }),
    qc.invalidateQueries({ queryKey: qk.kpis }),
    qc.invalidateQueries({ queryKey: qk.tasks }),
    ...ids.map((id) => qc.invalidateQueries({ queryKey: qk.leads.detail(id) })),
  ]);
}

/** Moves the (writable) leads to one stage, each with its own version. */
export function useBulkStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leads, stage }: { leads: readonly LeadSummary[]; stage: SalesStage }) =>
      collect(leads, (lead) => setLeadStage(lead.id, stage, lead.version)),
    onSettled: (_res, _err, { leads }) => invalidateMany(qc, leads.map((l) => l.id)),
  });
}

/** One follow-up per lead (POST /api/leads/:id/tasks). */
export function useBulkFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leads, task }: { leads: readonly LeadSummary[]; task: (lead: LeadSummary) => TaskCreate }) =>
      collect(leads, (lead) => createTask(lead.id, task(lead))),
    onSettled: (_res, _err, { leads }) => invalidateMany(qc, leads.map((l) => l.id)),
  });
}

/** "Moved 3 leads to Quoting · 1 changed meanwhile". */
export function bulkSummary(res: BulkWriteResult, verb: string, skipped = 0): { title: string; description?: string; variant: 'success' | 'warning' | 'error' } {
  const notes = [
    skipped ? `${skipped} skipped (read-only)` : '',
    res.conflicts.length ? `${res.conflicts.length} changed by someone else meanwhile` : '',
    res.failed.length ? `${res.failed.length} failed` : '',
  ].filter(Boolean).join(' · ');
  const n = res.done.length;
  return {
    variant: !n ? 'error' : res.conflicts.length || res.failed.length ? 'warning' : 'success',
    title: n ? `${verb} ${n} ${n === 1 ? 'lead' : 'leads'}` : 'Nothing changed',
    description: notes || undefined,
  };
}

export const stageVerb = (stage: SalesStage) => `Moved to ${STAGE_LABELS[stage]}:`;
