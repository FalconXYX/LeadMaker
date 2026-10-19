// Task reads and writes. Every key starts with ['tasks'] (the dashboard's task lists too), so one prefix
// invalidation reaches all of them; a task write also changes its lead (nextTask, activity) and the lead lists.
import {
  useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient, type QueryKey,
} from '@tanstack/react-query';
import { VersionConflictError, isRecord } from '@/api/errors';
import { invalidateLead, qk } from '@/api/queries';
import * as ep from '@/api/endpoints';
import type { LeadProfile, TasksPage, TaskUpdate } from '@/api/types';
import { getTasks, type Task, type TaskDue, type TaskScope, type TaskStatus, type TaskType } from './api';
import { bucketOf, daysBetween, salesDay, today } from './dates';

export interface TaskListParams {
  scope: TaskScope;
  due: TaskDue;
  status?: TaskStatus;
  limit?: number;
}

const norm = (p: TaskListParams) => ({ scope: p.scope, due: p.due, status: p.status ?? 'open', limit: p.limit ?? 50 });

export const taskKeys = {
  all: qk.tasks,
  /** Everything this feature caches (patched optimistically); the dashboard's task keys sit beside it. */
  mine: ['tasks', 'list'] as const,
  page: (p: TaskListParams) => ['tasks', 'list', 'page', norm(p)] as const,
  infinite: (p: TaskListParams) => ['tasks', 'list', 'infinite', norm(p)] as const,
  summary: (scope: TaskScope) => ['tasks', 'list', 'summary', scope] as const,
};

/** One page of GET /api/tasks (contract hook; TaskList pages through useInfiniteTasks). */
export function useTasks(params: TaskListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: taskKeys.page(params),
    queryFn: ({ signal }) => getTasks(norm(params), { signal }),
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

export function useInfiniteTasks(params: TaskListParams, opts: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: taskKeys.infinite(params),
    queryFn: ({ pageParam, signal }) => getTasks({ ...norm(params), cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

export const SUMMARY_LIMIT = 200;

export interface TaskCounts {
  overdue: number;
  today: number;
  week: number;
  upcoming: number;
  /** Completed in the last 7 days. */
  done: number;
  /** More open tasks than one read returns: the later counts are lower bounds. */
  capped: boolean;
  doneCapped: boolean;
}

export function countTasks(open: readonly Task[], done: readonly Task[], now = new Date()): Omit<TaskCounts, 'capped' | 'doneCapped'> {
  const c = { overdue: 0, today: 0, week: 0, upcoming: 0, done: 0 };
  for (const t of open) {
    const b = bucketOf(t.dueAt, now);
    if (b === 'overdue') c.overdue++;
    if (b === 'today') c.today++;
    if (b === 'today' || b === 'tomorrow' || b === 'week') c.week++;
    if (b !== 'overdue' && b !== 'today') c.upcoming++;
  }
  const day = today(now);
  for (const t of done) if (t.doneAt && daysBetween(salesDay(t.doneAt), day) < 7) c.done++;
  return c;
}

/** The tab counts: every open task (earliest due first) and the latest completed ones, two reads. */
export function useTaskCounts(scope: TaskScope) {
  const open = useQuery({
    queryKey: [...taskKeys.summary(scope), 'open'],
    queryFn: ({ signal }) => getTasks({ scope, due: 'all', status: 'open', limit: SUMMARY_LIMIT }, { signal }),
    staleTime: 30_000,
  });
  const done = useQuery({
    queryKey: [...taskKeys.summary(scope), 'done'],
    queryFn: ({ signal }) => getTasks({ scope, due: 'all', status: 'done', limit: 100 }, { signal }),
    staleTime: 30_000,
  });
  const counts: TaskCounts | undefined = open.data && {
    ...countTasks(open.data.items, done.data?.items ?? []),
    capped: !!open.data.nextCursor,
    doneCapped: !!done.data?.nextCursor,
  };
  return { counts, isLoading: open.isLoading, error: open.error, refetch: () => void open.refetch() };
}

// ---- optimistic cache edits ------------------------------------------------------------------------

type Edit = (t: Task) => Task | null;

function editPage(page: TasksPage, edit: Edit): TasksPage {
  return { ...page, items: page.items.flatMap((t) => edit(t) ?? []) };
}

/** Applies `edit` to the task in every list this feature caches (null drops it); returns the rollback. */
export function editCachedTasks(qc: QueryClient, edit: Edit): () => void {
  const snapshot = qc.getQueriesData<unknown>({ queryKey: taskKeys.mine });
  qc.setQueriesData<unknown>({ queryKey: taskKeys.mine }, (data: unknown) => {
    if (!isRecord(data)) return data;
    if (Array.isArray(data.pages)) {
      const inf = data as unknown as InfiniteData<TasksPage>;
      return { ...inf, pages: inf.pages.map((p) => editPage(p, edit)) };
    }
    if (Array.isArray(data.items)) return editPage(data as unknown as TasksPage, edit);
    return data;
  });
  return () => snapshot.forEach(([key, data]) => qc.setQueryData(key as QueryKey, data));
}

/** After a task write: every task list, then its lead's profile, activity and lists. */
export function invalidateAfterTaskWrite(qc: QueryClient, leadId: string): Promise<void> {
  return Promise.all([qc.invalidateQueries({ queryKey: taskKeys.all }), invalidateLead(qc, leadId)]).then(() => undefined);
}

/** A stale write retried once on the server's version, unless the task already ended up as wanted. */
async function patchWithRetry(task: Task, patch: Omit<TaskUpdate, 'version'>, settled?: (current: Task) => boolean) {
  try {
    return await ep.updateTask(task.id, { ...patch, version: task.version });
  } catch (err) {
    const current = err instanceof VersionConflictError && isRecord(err.current) ? (err.current as unknown as Task) : null;
    if (!current || typeof current.version !== 'number') throw err;
    if (settled?.(current)) return { task: current };
    return ep.updateTask(task.id, { ...patch, version: current.version });
  }
}

export function useCompleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, done }: { task: Task; done: boolean }) =>
      patchWithRetry(task, { done }, (cur) => !!cur.doneAt === done),
    onMutate: async ({ task, done }) => {
      await qc.cancelQueries({ queryKey: taskKeys.mine });
      const doneAt = done ? new Date().toISOString() : null;
      return { rollback: editCachedTasks(qc, (t) => (t.id === task.id ? { ...t, doneAt } : t)) };
    },
    onSuccess: (res) => {
      editCachedTasks(qc, (t) => (t.id === res.task.id ? res.task : t));
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: (_d, _e, { task }) => {
      // A beat so the tick and strike-through show before the row leaves the open list.
      setTimeout(() => void invalidateAfterTaskWrite(qc, task.companyId), 450);
    },
  });
}

export function useRescheduleTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, day }: { task: Task; day: string }) =>
      patchWithRetry(task, { dueAt: day }, (cur) => salesDay(cur.dueAt) === day),
    onMutate: async ({ task, day }) => {
      await qc.cancelQueries({ queryKey: taskKeys.mine });
      // 16:00 UTC is midday in New York, so the row lands on the right day until the server answers.
      const dueAt = `${day}T16:00:00.000Z`;
      return { rollback: editCachedTasks(qc, (t) => (t.id === task.id ? { ...t, dueAt } : t)) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: (_d, _e, { task }) => invalidateAfterTaskWrite(qc, task.companyId),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ task }: { task: Task }) => {
      try {
        return await ep.deleteTask(task.id, task.version);
      } catch (err) {
        const current = err instanceof VersionConflictError && isRecord(err.current) ? (err.current as unknown as Task) : null;
        if (!current || typeof current.version !== 'number') throw err;
        return ep.deleteTask(task.id, current.version);
      }
    },
    onMutate: async ({ task }) => {
      await qc.cancelQueries({ queryKey: taskKeys.mine });
      return { rollback: editCachedTasks(qc, (t) => (t.id === task.id ? null : t)) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: (_d, _e, { task }) => invalidateAfterTaskWrite(qc, task.companyId),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { leadId: string; title: string; type: TaskType; day: string; note?: string; assigneeId?: string }) =>
      ep.createTask(v.leadId, {
        title: v.title, type: v.type, dueAt: v.day,
        ...(v.note ? { note: v.note } : {}),
        ...(v.assigneeId ? { assigneeId: v.assigneeId } : {}),
      }),
    onSuccess: (_d, v) => invalidateAfterTaskWrite(qc, v.leadId),
  });
}

// ---- the contractor's phone ------------------------------------------------------------------------

/** The number to dial for a lead: its target contact's, else any reachable contact's, else the company's. */
export function phoneOf(profile: LeadProfile | undefined): { phone: string; contact: string | null } | null {
  if (!profile) return null;
  const reachable = (profile.contacts ?? []).filter((c) => !c.doNotContact?.value && c.phone?.value);
  const pick = reachable.find((c) => c.id === profile.targetContact?.contactId) ?? reachable.find((c) => c.isTarget) ?? reachable[0];
  if (pick?.phone.value) return { phone: pick.phone.value, contact: pick.name.value };
  const company = profile.fields?.phone?.value;
  return company ? { phone: company, contact: null } : null;
}

/** The lead's profile (the profile page's cache entry, so opening the lead afterwards is instant). */
export function useLeadPhone(leadId: string, enabled = true) {
  const q = useQuery({
    queryKey: qk.leads.detail(leadId),
    queryFn: ({ signal }) => ep.getLead(leadId, { signal }),
    staleTime: 5 * 60_000,
    enabled,
  });
  return { data: phoneOf(q.data), isLoading: q.isLoading && enabled };
}
