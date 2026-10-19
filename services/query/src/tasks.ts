// GET /tasks: follow-up tasks in a sales scope. A scope's tasks are those assigned to its user plus every task on
// that user's leads, limited to leads the caller may open; team is every task (managers). Open tasks come earliest
// due first, done ones most recently completed first, in keyset pages on (due_at, id) or (done_at, id).
import {
  and, canUseSalesScope, isUuid, parseSalesScope, raw, sql, TASK_SELECT, taskDueCondition, taskOut, visibilitySql,
  type ParsedSalesScope, type Sql, type TaskDue, type TaskRow, type TasksPage, type TaskStatus, type Viewer,
} from '@leadmaker/shared';
import { pgCode, pick, rows, type Db } from './db.ts';
import { badRequest, forbidden } from './errors.ts';

export const DEFAULT_TASK_LIMIT = 50;
export const MAX_TASK_LIMIT = 200;

export interface TaskListOptions {
  scope: ParsedSalesScope;
  due: TaskDue;
  status: TaskStatus;
  limit: number;
  cursor?: string;
}

interface TaskCursor {
  s: TaskStatus;
  k: string;
  id: string;
}

/** ?scope= of /tasks and /dashboard: 400 when malformed, 403 when the caller may not use it. */
export function salesScope(viewer: Viewer, value: string): ParsedSalesScope {
  const scope = parseSalesScope(value);
  if (!scope) throw badRequest('invalid scope', 'mine, team or rep:{uuid}');
  if (!canUseSalesScope(viewer, scope)) throw forbidden(scope.kind === 'team' ? 'scope team is for managers' : 'scope rep:{id} is for managers and that rep');
  return scope;
}

const order = (status: TaskStatus) => status === 'open'
  ? { col: raw('due_at'), dir: raw('ASC'), op: raw('>') }
  : { col: raw('done_at'), dir: raw('DESC'), op: raw('<') };

function decodeCursor(value: string | undefined, status: TaskStatus): TaskCursor | undefined {
  if (!value) return undefined;
  let c: Partial<TaskCursor>;
  try {
    c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  if (!c || typeof c !== 'object' || typeof c.k !== 'string' || !isUuid(c.id)) throw badRequest('invalid cursor');
  if (c.s !== status) throw badRequest('cursor belongs to a different status');
  return c as TaskCursor;
}

export function tasksQuery(viewer: Viewer, opts: TaskListOptions): Sql {
  const { col, dir, op } = order(opts.status);
  const cursor = decodeCursor(opts.cursor, opts.status);
  const conditions = and([
    raw(opts.status === 'open' ? 't.done_at IS NULL' : 't.done_at IS NOT NULL'),
    taskDueCondition(opts.due),
    cursor ? sql`(t.${col}, t.id) ${op} (${cursor.k}::timestamptz, ${cursor.id}::uuid)` : raw('TRUE'),
  ]);
  const limit = sql`${opts.limit + 1}::int`;
  const sort = sql`ORDER BY t.${col} ${dir}, t.id ${dir} LIMIT ${limit}`;
  let where: Sql;
  if (opts.scope.kind === 'team') {
    where = and([visibilitySql(viewer, 'view', 'c'), conditions]);
  } else {
    // Each half walks its own index (tasks by assignee; the user's leads, then their tasks) up to a page.
    const user = sql`${opts.scope.kind === 'rep' ? opts.scope.repId : viewer.id}::uuid`;
    where = sql`t.id IN (
      (SELECT t.id FROM tasks t JOIN companies c ON c.id = t.company_id
       WHERE t.assignee_id = ${user} AND ${visibilitySql(viewer, 'view', 'c')} AND ${conditions} ${sort})
      UNION
      (SELECT t.id FROM companies c JOIN tasks t ON t.company_id = c.id
       WHERE c.assigned_rep_id = ${user} AND ${visibilitySql(viewer, 'view', 'c')} AND ${conditions} ${sort}))`;
  }
  // The sort key goes out as text: a JS Date would drop the microseconds the keyset compares.
  return sql`SELECT r.*, r.${col}::text AS sort_key FROM (${TASK_SELECT} WHERE ${where} ${sort}) r
    ORDER BY r.${col} ${dir}, r.id ${dir}`;
}

export async function listTasks(db: Db, viewer: Viewer, opts: TaskListOptions, primary: boolean): Promise<TasksPage> {
  const found = await rows<TaskRow & { sort_key: string }>(pick(db, primary), tasksQuery(viewer, opts)).catch((err: unknown) => {
    // A cursor's sort key that is not a timestamp fails its cast (SQLSTATE class 22).
    if (opts.cursor && pgCode(err)?.startsWith('22')) throw badRequest('invalid cursor');
    throw err;
  });
  const page = found.slice(0, opts.limit);
  const last = page.at(-1);
  const next: TaskCursor | undefined = found.length > opts.limit && last ? { s: opts.status, k: last.sort_key, id: last.id } : undefined;
  return {
    items: page.map(taskOut),
    nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
  };
}
