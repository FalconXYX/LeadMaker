import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import {
  canAssignTask, canEditTask, canView, SALES_TIME_ZONE, TASK_SELECT, TASK_TYPES, taskOut, type Role, type Task,
  type TaskAction, type TaskDeleted, type TaskEventFields, type TaskRow, type TaskType, type TaskWritten, type UserRef,
} from '@leadmaker/shared';
import { actorOf, type Actor } from '../auth.ts';
import { badRequest, forbidden, HttpError, notFound, parse, uuid } from '../http.ts';
import { emit, lockLead, logActivity, type Json, type Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

export const MAX_OPEN_TASKS_PER_LEAD = 100;

const title = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}]+$/u, 'must not contain control characters');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A date alone means that day in the reps' time zone (00:00), so the task is due all of that day.
const dueAt = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const note = z.string().trim().max(10_000).transform((s) => s || null);
const createBody = z.object({
  title, type: z.enum(TASK_TYPES), dueAt, note: note.optional(), assigneeId: uuid.optional(),
}).strict();
const updateBody = z.object({
  title: title.optional(),
  type: z.enum(TASK_TYPES).optional(),
  dueAt: dueAt.optional(),
  note: note.nullable().optional(),
  done: z.boolean().optional(),
  assigneeId: uuid.optional(),
  version: z.int().positive(),
}).strict().refine(({ version: _v, ...rest }) => Object.values(rest).some((v) => v !== undefined), 'nothing to change');
const versionParam = z.coerce.number().pipe(z.int().positive());

type TaskState = {
  id: string; company_id: string; title: string; type: TaskType; due_at: Date; done_at: Date | null; note: string | null;
  assignee_id: string; version: number; updated_at: Date;
};
type LeadRef = { id: string; assigned_rep_id: string | null; version: number };

const prismaSql = (q: { strings: readonly string[]; values: readonly unknown[] }) => new Prisma.Sql(q.strings, q.values);
const dueSql = (v: string) => (DATE_ONLY.test(v)
  ? Prisma.sql`(${v}::date::timestamp AT TIME ZONE ${SALES_TIME_ZONE}::text)`
  : Prisma.sql`${v}::timestamptz`);

async function readTask(tx: Tx, id: string): Promise<Task> {
  const [row] = await tx.$queryRaw<TaskRow[]>(Prisma.sql`${prismaSql(TASK_SELECT)} WHERE t.id = ${id}::uuid`);
  return taskOut(row);
}

/** The assignee a write names: a user the actor may give a task on this lead. */
async function assignee(tx: Tx, actor: Actor, id: string, leadRepId: string | null): Promise<{ id: string; role: Role }> {
  const [user] = await tx.$queryRaw<{ id: string; role: Role }[]>(Prisma.sql`SELECT id, role FROM users WHERE id = ${id}::uuid`);
  if (!user) throw badRequest('invalid_assignee', 'no such user');
  if (!canAssignTask(actor, user, leadRepId)) {
    if (actor.role !== 'manager') throw forbidden('reps can only assign tasks to themselves, on their own leads');
    throw badRequest('invalid_assignee', 'the assignee cannot open this lead');
  }
  return user;
}

/**
 * Locks a task's lead (share, so a reassignment waits) and then the task. A task on a lead the actor cannot see is
 * 404; one they may not change (canEditTask) is 403.
 */
async function lockTask(tx: Tx, actor: Actor, id: string): Promise<{ lead: LeadRef; task: TaskState }> {
  const [ref] = await tx.$queryRaw<{ company_id: string }[]>(Prisma.sql`SELECT company_id FROM tasks WHERE id = ${id}::uuid`);
  if (!ref) throw notFound('task_not_found');
  const [lead] = await tx.$queryRaw<LeadRef[]>(Prisma.sql`
    SELECT id, assigned_rep_id, version FROM companies WHERE id = ${ref.company_id}::uuid FOR SHARE`);
  if (!lead || !canView(actor, lead.assigned_rep_id)) throw notFound('task_not_found');
  const [task] = await tx.$queryRaw<TaskState[]>(Prisma.sql`
    SELECT id, company_id, title, type, due_at, done_at, note, assignee_id, version, updated_at
    FROM tasks WHERE id = ${id}::uuid FOR UPDATE`);
  if (!task) throw notFound('task_not_found');
  if (!canEditTask(actor, { assigneeId: task.assignee_id }, lead.assigned_rep_id)) {
    throw forbidden('only a manager, the lead\'s rep or the task\'s assignee may change it');
  }
  return { lead, task };
}

/** 409 for a stale task version: the task as it is, and who last wrote it (its latest task_* activity row). */
async function taskConflict(tx: Tx, task: TaskState): Promise<HttpError> {
  const [by] = await tx.$queryRaw<UserRef[]>(Prisma.sql`
    SELECT u.id, u.name FROM activity_logs a JOIN users u ON u.id = a.user_id
    WHERE a.company_id = ${task.company_id}::uuid AND a.field_diff->>'task_id' = ${task.id}
      AND a.action_type IN ('task_created', 'task_completed', 'task_updated', 'task_deleted')
    ORDER BY a.created_at DESC LIMIT 1`);
  return new HttpError(409, {
    error: 'version_conflict', current: await readTask(tx, task.id), changedBy: by ?? null, changedAt: task.updated_at.toISOString(),
  });
}

/** The task_* activity row and the lead.updated event (fields ['tasks']) of one task write. */
async function record(
  tx: Tx, actor: Actor, lead: LeadRef, action: TaskAction, task: Task, extra: { changes?: Record<string, Json>; previousAssignee?: string } = {},
): Promise<void> {
  const diff = {
    task_id: task.id, title: task.title, type: task.type, due_at: task.dueAt, assignee_id: task.assignee.id,
    ...(extra.changes ? { changes: extra.changes } : {}),
  };
  await logActivity(tx, actor, lead.id, `task_${action}`, { fieldDiff: diff });
  const event: TaskEventFields = {
    fields: ['tasks'], task_id: task.id, task_action: action, task_title: task.title, task_type: task.type, due_at: task.dueAt,
    done: task.doneAt !== null, assignee_id: task.assignee.id, previous_assignee_id: extra.previousAssignee ?? null,
  };
  await emit(tx, actor, 'lead.updated', lead.id, { ...event, assigned_rep_id: lead.assigned_rep_id, version: lead.version });
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function taskRoutes({ write }: Deps): Router {
  const r = Router();

  // Tasks do not move the lead version (the profile reads them uncached, like notes); each has its own version.
  r.post('/leads/:id/tasks', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(createBody, req.body);
    const task = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'share');
      const to = await assignee(tx, actor, body.assigneeId ?? actor.id, lead.assigned_rep_id);
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n FROM tasks WHERE company_id = ${lead.id}::uuid AND done_at IS NULL`);
      if (n >= MAX_OPEN_TASKS_PER_LEAD) throw badRequest('too_many_tasks', { max: MAX_OPEN_TASKS_PER_LEAD });
      const [{ id }] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO tasks (company_id, title, type, due_at, note, assignee_id, created_by)
        VALUES (${lead.id}::uuid, ${body.title}, ${body.type}, ${dueSql(body.dueAt)}, ${body.note ?? null}, ${to.id}::uuid,
                ${actor.id}::uuid)
        RETURNING id`);
      const created = await readTask(tx, id);
      await record(tx, actor, lead, 'created', created);
      return created;
    });
    res.status(201).json({ task } satisfies TaskWritten);
  });

  // Changes the given fields; done completes (done_at now) or reopens the task. Unchanged values write nothing.
  r.patch('/tasks/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    const body = parse(updateBody, req.body);
    const task = await write(actor, async (tx) => {
      const { lead, task: cur } = await lockTask(tx, actor, id);
      if (cur.version !== body.version) throw await taskConflict(tx, cur);
      if (body.assigneeId !== undefined && body.assigneeId !== cur.assignee_id) {
        await assignee(tx, actor, body.assigneeId, lead.assigned_rep_id);
      }
      const changes: Record<string, Json> = {};
      const set: Prisma.Sql[] = [];
      const change = (field: string, before: Json, after: Json, sqlValue: Prisma.Sql) => {
        if (before === after) return;
        changes[field] = [before, after];
        set.push(sqlValue);
      };
      if (body.title !== undefined) change('title', cur.title, body.title, Prisma.sql`title = ${body.title}`);
      if (body.type !== undefined) change('type', cur.type, body.type, Prisma.sql`type = ${body.type}`);
      if (body.dueAt !== undefined) {
        const [next] = await tx.$queryRaw<{ due_at: Date }[]>(Prisma.sql`SELECT ${dueSql(body.dueAt)} AS due_at`);
        change('due_at', iso(cur.due_at), iso(next.due_at), Prisma.sql`due_at = ${next.due_at}::timestamptz`);
      }
      if (body.note !== undefined) change('note', cur.note, body.note, Prisma.sql`note = ${body.note}`);
      if (body.assigneeId !== undefined) {
        change('assignee_id', cur.assignee_id, body.assigneeId, Prisma.sql`assignee_id = ${body.assigneeId}::uuid`);
      }
      const completed = body.done === true && cur.done_at === null;
      const reopened = body.done === false && cur.done_at !== null;
      if (completed) set.push(Prisma.sql`done_at = clock_timestamp()`);
      if (reopened) set.push(Prisma.sql`done_at = NULL`);
      if (!set.length) return readTask(tx, id);
      await tx.$executeRaw(Prisma.sql`
        UPDATE tasks SET ${Prisma.join(set)}, version = version + 1, updated_at = clock_timestamp() WHERE id = ${id}::uuid`);
      const updated = await readTask(tx, id);
      if (completed || reopened) changes.done_at = [iso(cur.done_at), updated.doneAt];
      const reassigned = 'assignee_id' in changes;
      await record(tx, actor, lead, completed ? 'completed' : 'updated', updated, {
        changes, ...(reassigned ? { previousAssignee: cur.assignee_id } : {}),
      });
      return updated;
    });
    res.json({ task } satisfies TaskWritten);
  });

  r.delete('/tasks/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    const version = parse(versionParam, req.query.version ?? (req.body as { version?: unknown } | undefined)?.version);
    await write(actor, async (tx) => {
      const { lead, task: cur } = await lockTask(tx, actor, id);
      if (cur.version !== version) throw await taskConflict(tx, cur);
      const gone = await readTask(tx, id);
      await tx.$executeRaw(Prisma.sql`DELETE FROM tasks WHERE id = ${id}::uuid`);
      await record(tx, actor, lead, 'deleted', gone);
    });
    res.json({ deleted: true, id } satisfies TaskDeleted);
  });

  return r;
}
