// Sales stages and follow-up tasks: what "today" and "this week" mean, who may assign and change tasks (crm-write),
// and the task SQL crm-write, query and the LeadFilter compiler share.
import { isUuid } from './internal-auth.ts';
import { raw, sql, type Sql } from './sql.ts';
import type { FollowUp, SalesScope, Task, TaskDue, TaskType } from './types.ts';
import { canView, visibilitySql, type Viewer } from './visibility.ts';

/** The reps' time zone: follow-up days, the dashboard's weeks (Monday first) and its daily activity. */
export const SALES_TIME_ZONE = 'America/New_York';

/** Midnight in SALES_TIME_ZONE `days` days from today (negative: earlier), as a timestamptz. */
export function dayStartSql(days = 0): Sql {
  return sql`((date_trunc('day', now() AT TIME ZONE ${SALES_TIME_ZONE}::text) + make_interval(days => ${days}::int))
    AT TIME ZONE ${SALES_TIME_ZONE}::text)`;
}

/** Monday 00:00 in SALES_TIME_ZONE of this week (0) or an earlier one (-1: last week). */
export function weekStartSql(weeks = 0): Sql {
  return sql`((date_trunc('week', now() AT TIME ZONE ${SALES_TIME_ZONE}::text) + make_interval(weeks => ${weeks}::int))
    AT TIME ZONE ${SALES_TIME_ZONE}::text)`;
}

/** The 1st of this month, 00:00 in SALES_TIME_ZONE. */
export function monthStartSql(): Sql {
  return sql`(date_trunc('month', now() AT TIME ZONE ${SALES_TIME_ZONE}::text) AT TIME ZONE ${SALES_TIME_ZONE}::text)`;
}

/** A due-date window (TaskDue) over `col`; open or done is a separate condition. */
export function taskDueCondition(due: TaskDue, col: Sql = raw('t.due_at')): Sql {
  switch (due) {
    case 'overdue':
      return sql`${col} < ${dayStartSql(0)}`;
    case 'today':
      return sql`(${col} >= ${dayStartSql(0)} AND ${col} < ${dayStartSql(1)})`;
    case 'week':
      return sql`(${col} >= ${dayStartSql(0)} AND ${col} < ${dayStartSql(7)})`;
    case 'upcoming':
      return sql`${col} >= ${dayStartSql(1)}`;
    case 'all':
      return raw('TRUE');
  }
}

/** LeadFilter.followUp over companies c: an open task due in the window, or ('none') no open task at all. */
export function followUpCondition(followUp: FollowUp): Sql {
  if (followUp === 'none') return raw('NOT EXISTS (SELECT 1 FROM tasks t WHERE t.company_id = c.id AND t.done_at IS NULL)');
  return sql`EXISTS (SELECT 1 FROM tasks t WHERE t.company_id = c.id AND t.done_at IS NULL AND ${taskDueCondition(followUp)})`;
}

/** The earliest due date of the lead's (c) open tasks, NULL without one: sort 'next_follow_up'. */
export const NEXT_FOLLOW_UP = raw('(SELECT min(t.due_at) FROM tasks t WHERE t.company_id = c.id AND t.done_at IS NULL)');

/** LeadFilter.notContactedSince over companies c (never contacted included). */
export function notContactedSinceCondition(since: string): Sql {
  return sql`(c.last_contacted_at IS NULL OR c.last_contacted_at < ${since}::timestamptz)`;
}

export type ParsedSalesScope = { kind: 'mine' } | { kind: 'team' } | { kind: 'rep'; repId: string };

/** ?scope= of /api/tasks and /api/dashboard; null unless mine, team or rep:<uuid>. */
export function parseSalesScope(value: unknown): ParsedSalesScope | null {
  if (value === 'mine' || value === 'team') return { kind: value };
  if (typeof value === 'string' && value.startsWith('rep:') && isUuid(value.slice(4))) {
    return { kind: 'rep', repId: value.slice(4).toLowerCase() };
  }
  return null;
}

export function salesScopeString(scope: ParsedSalesScope): SalesScope {
  return scope.kind === 'rep' ? `rep:${scope.repId}` : scope.kind;
}

/** team is for managers; rep:<id> for managers and that rep. */
export function canUseSalesScope(viewer: Viewer, scope: ParsedSalesScope): boolean {
  if (viewer.role === 'manager') return true;
  return scope.kind === 'mine' || (scope.kind === 'rep' && scope.repId === viewer.id);
}

/**
 * GET /api/tasks scope over tasks t joined to companies c: tasks on leads the viewer may open, either every task
 * (team) or, for mine and rep:<id>, those assigned to that user plus every task on that user's leads. The scope must
 * pass canUseSalesScope first. (services/query tasks.ts applies the same rule as two index-driven branches.)
 */
export function taskScopeConditions(viewer: Viewer, scope: ParsedSalesScope): Sql[] {
  const visible = visibilitySql(viewer, 'view', 'c');
  if (scope.kind === 'team') return [visible];
  const user = scope.kind === 'rep' ? scope.repId : viewer.id;
  return [visible, sql`(t.assignee_id = ${user}::uuid OR c.assigned_rep_id = ${user}::uuid)`];
}

/** Who may get a task on a lead (leadRepId: its assigned rep): a rep only themselves, on their own lead; a manager anyone who can open it. */
export function canAssignTask(viewer: Viewer, assignee: Viewer, leadRepId: string | null): boolean {
  if (viewer.role === 'manager') return canView(assignee, leadRepId);
  return viewer.role === 'rep' && assignee.id === viewer.id && leadRepId === viewer.id;
}

/** Who may change, complete or delete a task: managers; a rep on their own lead, or while it is assigned to them and they can open the lead. */
export function canEditTask(viewer: Viewer, task: { assigneeId: string }, leadRepId: string | null): boolean {
  if (viewer.role === 'manager') return true;
  if (viewer.role !== 'rep' || !canView(viewer, leadRepId)) return false;
  return leadRepId === viewer.id || task.assigneeId === viewer.id;
}

/** A tasks row with the names TASK_SELECT joins in. */
export interface TaskRow {
  id: string;
  company_id: string;
  company_name: string;
  title: string;
  type: TaskType;
  due_at: Date | string;
  done_at: Date | string | null;
  note: string | null;
  assignee_id: string;
  assignee_name: string;
  created_by: string;
  created_by_name: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

/** Selects TaskRow columns from tasks t (with companies c, assignee a, creator b); append WHERE / ORDER BY. */
export const TASK_SELECT = raw(`SELECT t.id, t.company_id,
    COALESCE((SELECT o.value #>> '{}' FROM field_overrides o
              WHERE o.company_id = t.company_id AND o.contact_id IS NULL AND o.field = 'business_name'
                AND o.superseded_at IS NULL), c.business_name) AS company_name,
    t.title, t.type, t.due_at, t.done_at, t.note, t.assignee_id, a.name AS assignee_name, t.created_by,
    b.name AS created_by_name, t.created_at, t.updated_at, t.version
  FROM tasks t JOIN companies c ON c.id = t.company_id JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.created_by`);

const isoOf = (d: Date | string) => new Date(d).toISOString();

export function taskOut(r: TaskRow): Task {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    title: r.title,
    type: r.type,
    dueAt: isoOf(r.due_at),
    doneAt: r.done_at === null ? null : isoOf(r.done_at),
    note: r.note,
    assignee: { id: r.assignee_id, name: r.assignee_name },
    createdBy: { id: r.created_by, name: r.created_by_name },
    createdAt: isoOf(r.created_at),
    updatedAt: isoOf(r.updated_at),
    version: r.version,
  };
}

export type TaskAction = 'created' | 'updated' | 'completed' | 'deleted';

/** Payload fields of the lead.updated event a task write emits (fields ['tasks']), besides the usual lead and actor ones. */
export interface TaskEventFields {
  fields: ['tasks'];
  task_id: string;
  task_action: TaskAction;
  task_title: string;
  task_type: TaskType;
  due_at: string;
  done: boolean;
  assignee_id: string;
  /** The assignee before, when this write moved the task to someone else; else null. */
  previous_assignee_id: string | null;
}
