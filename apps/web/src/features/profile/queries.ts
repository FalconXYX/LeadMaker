// Lead profile data: the activity feed (profile head + older pages) and every write, wired to the
// convention (ep.* + invalidateLead on success + toast on error). 409s are left to the caller's conflict flow.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { VersionConflictError } from '@/api/client';
import * as ep from '@/api/endpoints';
import { invalidateLead, qk, useLeadActivity } from '@/api/queries';
import type {
  ActivityEntry, ActivityKind, CompanyOverrideField, ContactInput, ContactOverrideField, LeadProfile,
  LeadStateFlags, OverrideResult, StageChanged,
} from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui';
import type { FeedFilter } from './lib';
import { isSalesStage } from '@/lib/labels';
import { markDone, salesOf, withSales, type SalesStage, type Task } from './sales';

/**
 * Activity for the timeline. "All": the profile's head entries, then older pages on demand. A filter: the server's
 * ?type= list, paged on its own from the newest entry, so older pages hold only matching entries and nothing is missed.
 */
export function useActivityFeed(profile: LeadProfile, filter: FeedFilter) {
  const type = filter.types?.length ? filter.types.join(',') : undefined;
  const [olderRequested, setOlderRequested] = useState(false);

  const typed = useLeadActivity(profile.id, { type, startCursor: null, enabled: !!type });
  const older = useLeadActivity(profile.id, {
    startCursor: profile.activityNextCursor,
    enabled: !type && olderRequested && !!profile.activityNextCursor,
  });

  if (type) {
    // Until the server's first page lands, the matching head entries the profile already has stand in.
    const head = profile.activity.filter((e) => (filter.types as readonly string[]).includes(e.type));
    const items = typed.data ? dedupe(typed.data.pages.flatMap((p) => p.items ?? [])) : head;
    return {
      items,
      isLoading: typed.isPending && head.length === 0,
      isError: typed.isError,
      hasMore: !!typed.hasNextPage,
      isLoadingMore: typed.isFetchingNextPage,
      loadMore: () => void typed.fetchNextPage(),
      retry: () => void typed.refetch(),
    };
  }
  const items = dedupe([...profile.activity, ...(older.data?.pages.flatMap((p) => p.items ?? []) ?? [])]);
  const lastPage = older.data?.pages.at(-1);
  const hasMore = olderRequested ? older.isPending || (!!lastPage && lastPage.nextCursor !== null) : !!profile.activityNextCursor;
  return {
    items,
    isLoading: false,
    isError: older.isError,
    hasMore: hasMore && !older.isError,
    isLoadingMore: olderRequested && (older.isPending || older.isFetchingNextPage) && !!profile.activityNextCursor,
    loadMore: () => {
      if (!olderRequested) setOlderRequested(true);
      else void older.fetchNextPage();
    },
    retry: () => void older.refetch(),
  };
}

/** Unique by id, newest first (pages are already ordered; this guards merges and live inserts). */
function dedupe(items: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  return items
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Every write on one lead. Each mutation refreshes the lead on success and toasts errors other than 409. */
const CONTACT_KEY: Record<ContactOverrideField, 'name' | 'title' | 'email' | 'phone' | 'doNotContact'> = {
  name: 'name', title: 'title', email: 'email', phone: 'phone', do_not_contact: 'doNotContact',
};

export function useLeadMutations(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  /** Show a write's result at once (no flash of the old value while the profile refetches). */
  const patch = (fn: (p: LeadProfile) => LeadProfile) =>
    qc.setQueryData<LeadProfile>(qk.leads.detail(leadId), (p) => (p ? fn(p) : p));
  const edited = (value: unknown, set: boolean) => ({
    value, overridden: set, sourceChangedSinceEdit: false,
    editedBy: set && user ? { id: user.id, name: user.name } : null, editedAt: set ? new Date().toISOString() : null,
  });
  const patchField = (field: CompanyOverrideField, res: OverrideResult, set: boolean) =>
    patch((p) => ({ ...p, version: res.companyVersion, fields: { ...p.fields, [field]: { ...p.fields[field], ...edited(res.value, set) } } }));
  const patchContact = (contactId: string, field: ContactOverrideField, res: OverrideResult, set: boolean) =>
    patch((p) => ({
      ...p,
      version: res.companyVersion,
      contacts: p.contacts.map((c) => (c.id !== contactId ? c : {
        ...c, version: res.contactVersion ?? res.version, [CONTACT_KEY[field]]: { ...c[CONTACT_KEY[field]], ...edited(res.value, set) },
      })),
    }));
  const onSuccess = () => invalidateLead(qc, leadId);
  const onError = (e: unknown) => {
    if (!(e instanceof VersionConflictError)) toast.error(e);
  };
  const base = { onSuccess, onError };

  const addNote = useMutation({ mutationFn: (text: string) => ep.addNote(leadId, text), ...base });

  const logActivity = useMutation({
    mutationFn: (body: { type: ActivityKind; outcome?: string; note?: string }) => ep.logActivity(leadId, body),
    // Logging also moves a new lead to Contacted and sets last contacted.
    onSuccess: (res) => {
      if (res?.salesStage) {
        patch((p) => ({
          ...withSales(p, { salesStage: res.salesStage, stageChangedAt: res.stageChangedAt, lastContactedAt: res.lastContactedAt }),
          version: res.version,
        }));
      }
      return onSuccess();
    },
    onError,
  });

  const setState = useMutation({
    mutationFn: (change: { checked?: boolean; serviced?: boolean }) => ep.setLeadState(leadId, change),
    // Optimistic: the toggle flips at once and rolls back if the write fails.
    onMutate: async (change) => {
      const key = qk.leads.detail(leadId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LeadProfile>(key);
      if (prev) {
        const now = new Date().toISOString();
        const mine: LeadStateFlags = { ...prev.state.mine };
        if (change.checked !== undefined) Object.assign(mine, { checked: change.checked, checkedAt: change.checked ? now : null });
        if (change.serviced !== undefined) Object.assign(mine, { serviced: change.serviced, servicedAt: change.serviced ? now : null });
        qc.setQueryData<LeadProfile>(key, { ...prev, state: { ...prev.state, mine } });
      }
      return { prev };
    },
    onError: (e, _change, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.leads.detail(leadId), ctx.prev);
      toast.error(e);
    },
    onSettled: onSuccess,
  });

  /** Optimistic; on a 409 (someone moved it meanwhile) shows the server's stage and says so. */
  const setStage = useMutation({
    mutationFn: (v: { stage: SalesStage; version: number }) => ep.setLeadStage(leadId, v.stage, v.version),
    onMutate: async (v) => {
      const key = qk.leads.detail(leadId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LeadProfile>(key);
      if (prev) qc.setQueryData<LeadProfile>(key, withSales(prev, { salesStage: v.stage, stageChangedAt: new Date().toISOString() }));
      return { prev };
    },
    onSuccess: (res) => patch((p) => ({ ...withSales(p, { salesStage: res.stage, stageChangedAt: res.stageChangedAt }), version: res.version })),
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.leads.detail(leadId), ctx.prev);
      if (!(e instanceof VersionConflictError)) return toast.error(e);
      const cur = e.current as Partial<StageChanged> | undefined;
      if (cur && isSalesStage(cur.stage) && typeof cur.version === 'number') {
        patch((p) => ({ ...withSales(p, { salesStage: cur.stage! }), version: cur.version! }));
      }
      toast.warning('Someone else just updated this lead', 'The stage shown is the latest. Pick again if you still want to change it.');
    },
    onSettled: () => onSuccess(),
  });

  const replaceTask = (task: Task) => patch((p) => withSales(p, { tasks: salesOf(p).tasks.map((t) => (t.id === task.id ? task : t)) }));
  const taskSettled = () => Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: qk.tasks })]);
  const onTaskError = (e: unknown, _v: unknown, ctx?: { prev?: LeadProfile }) => {
    if (ctx?.prev) qc.setQueryData(qk.leads.detail(leadId), ctx.prev);
    if (!(e instanceof VersionConflictError)) return toast.error(e);
    // current: the task as it is now.
    if (isTask(e.current)) replaceTask(e.current);
    toast.warning('That follow-up changed meanwhile', 'It now shows the latest version.');
  };
  const optimisticTasks = async (fn: (tasks: Task[]) => Task[]) => {
    const key = qk.leads.detail(leadId);
    await qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<LeadProfile>(key);
    if (prev) qc.setQueryData<LeadProfile>(key, withSales(prev, { tasks: fn(salesOf(prev).tasks) }));
    return { prev };
  };

  const setTaskDone = useMutation({
    mutationFn: (v: { task: Task; done: boolean }) => ep.updateTask(v.task.id, { done: v.done, version: v.task.version }),
    onMutate: (v) => optimisticTasks((ts) => markDone(ts, v.task.id, v.done)),
    onSuccess: (res) => replaceTask(res.task),
    onError: onTaskError,
    onSettled: taskSettled,
  });
  const rescheduleTask = useMutation({
    mutationFn: (v: { task: Task; dueAt: string }) => ep.updateTask(v.task.id, { dueAt: v.dueAt, version: v.task.version }),
    onMutate: (v) => optimisticTasks((ts) => ts.map((t) => (t.id === v.task.id ? { ...t, dueAt: v.dueAt } : t))),
    onSuccess: (res) => replaceTask(res.task),
    onError: onTaskError,
    onSettled: taskSettled,
  });
  const deleteTask = useMutation({
    mutationFn: (task: Task) => ep.deleteTask(task.id, task.version),
    onMutate: (task) => optimisticTasks((ts) => ts.filter((t) => t.id !== task.id)),
    onError: onTaskError,
    onSettled: taskSettled,
  });

  const setOverride = useMutation({
    mutationFn: (v: { field: CompanyOverrideField; value: unknown; version: number }) =>
      ep.setLeadOverride(leadId, v.field, v.value, v.version),
    onSuccess: (res, v) => {
      patchField(v.field, res, true);
      return onSuccess();
    },
    onError,
  });
  const clearOverride = useMutation({
    mutationFn: (v: { field: CompanyOverrideField; version: number }) => ep.clearLeadOverride(leadId, v.field, v.version),
    onSuccess: (res, v) => {
      patchField(v.field, res, false);
      return onSuccess();
    },
    onError,
  });
  const setContactOverride = useMutation({
    mutationFn: (v: { contactId: string; field: ContactOverrideField; value: unknown; version: number }) =>
      ep.setContactOverride(v.contactId, v.field, v.value, v.version),
    onSuccess: (res, v) => {
      patchContact(v.contactId, v.field, res, true);
      return onSuccess();
    },
    onError,
  });
  const clearContactOverride = useMutation({
    mutationFn: (v: { contactId: string; field: ContactOverrideField; version: number }) =>
      ep.clearContactOverride(v.contactId, v.field, v.version),
    onSuccess: (res, v) => {
      patchContact(v.contactId, v.field, res, false);
      return onSuccess();
    },
    onError,
  });

  const addContact = useMutation({ mutationFn: (body: ContactInput) => ep.addContact(leadId, body), ...base });
  const deleteContact = useMutation({
    mutationFn: (v: { contactId: string; version: number }) => ep.deleteContact(v.contactId, v.version),
    ...base,
  });

  const attachTag = useMutation({
    mutationFn: async (tag: { id?: string; name: string }) => {
      const id = tag.id ?? (await ep.createCustomTag(tag.name)).tag.id;
      return ep.addLeadCustomTag(leadId, id);
    },
    onSuccess: () => Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: qk.customTags })]),
    onError,
  });
  const removeTag = useMutation({
    mutationFn: (tagId: string) => ep.removeLeadCustomTag(leadId, tagId),
    onSuccess: () => Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: qk.customTags })]),
    onError,
  });

  const setCustomField = useMutation({
    mutationFn: (v: { key: string; value: string | number | boolean | null; version: number }) =>
      ep.setCustomField(leadId, v.key, v.value, v.version),
    onSuccess: () => Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: qk.customFieldKeys })]),
    onError,
  });

  return {
    addNote, logActivity, setState, setStage, setTaskDone, rescheduleTask, deleteTask, setOverride, clearOverride, setContactOverride, clearContactOverride,
    addContact, deleteContact, attachTag, removeTag, setCustomField,
  };
}

export type LeadMutations = ReturnType<typeof useLeadMutations>;

function isTask(v: unknown): v is Task {
  return typeof v === 'object' && v !== null && typeof (v as Task).id === 'string' && typeof (v as Task).version === 'number'
    && typeof (v as Task).dueAt === 'string';
}
