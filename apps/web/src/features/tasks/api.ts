// The task list read, normalised so a missing or partial body reads as an empty page. Writes are the shared
// endpoints (@/api/endpoints); the types are the shared contract.
import * as ep from '@/api/endpoints';
import type { ActivityKind, SalesStage, Task, TaskDue, TaskScope, TasksPage, TaskStatus, TaskType } from '@/api/types';

export type { ActivityKind, SalesStage, Task, TaskDue, TaskScope, TaskStatus, TaskType };

type Opts = { signal?: AbortSignal };

export interface TaskQuery {
  scope: TaskScope;
  due: TaskDue;
  status?: TaskStatus;
  limit?: number;
  cursor?: string | null;
}

export async function getTasks(q: TaskQuery, o?: Opts): Promise<TasksPage> {
  const res = (await ep.getTasks({ ...q, status: q.status ?? 'open' }, o)) as Partial<TasksPage> | undefined;
  return { items: Array.isArray(res?.items) ? res.items : [], nextCursor: res?.nextCursor ?? null };
}
