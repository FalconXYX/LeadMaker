// Sales stages (PUT /leads/:id/stage, the auto-advance on logged activity) and follow-up tasks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness, url, type Fixture } from './harness.ts';

const h = new Harness();

describe.skipIf(!url)('sales stages and tasks', () => {
  let f: Fixture;

  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(async () => {
    f = await h.reset();
  });

  const lead = (id: string) => h.one<{ sales_stage: string; stage_changed_at: Date | null; last_contacted_at: Date | null; version: number }>(
    'SELECT sales_stage, stage_changed_at, last_contacted_at, version FROM companies WHERE id = $1::uuid', id);
  const activity = () => h.all<{ action_type: string; field_diff: Record<string, unknown> | null; user_id: string }>(
    'SELECT action_type, field_diff, user_id FROM activity_logs ORDER BY created_at');

  describe('stage', () => {
    it('moves the stage with the lead version, an activity row and a lead.updated event', async () => {
      const res = await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, { stage: 'interested', version: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stage: 'interested', version: 2, stageChangedAt: expect.any(String) });
      const row = await lead(f.leads.own);
      expect(row).toMatchObject({ sales_stage: 'interested', version: 2 });
      expect(row.stage_changed_at?.toISOString()).toBe(res.body.stageChangedAt);
      expect(await activity()).toEqual([
        { action_type: 'stage_changed', field_diff: { sales_stage: ['new', 'interested'] }, user_id: f.rep1.id },
      ]);
      expect(await h.outbox()).toEqual([{
        event_type: 'lead.updated', company_id: f.leads.own,
        payload: {
          company_id: f.leads.own, fields: ['sales_stage'], sales_stage: 'interested', previous_stage: 'new',
          assigned_rep_id: f.rep1.id, version: 2, actor_type: 'user', actor_id: f.rep1.id, actor_name: 'Jordan Rep',
        },
      }]);
    });

    it('rejects a stale version with the current stage and who moved it', async () => {
      await h.as(f.manager).put(`/api/leads/${f.leads.own}/stage`, { stage: 'quoting', version: 1 });
      const stale = await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, { stage: 'lost', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        error: 'version_conflict', current: { version: 2, stage: 'quoting' }, changedBy: { id: f.manager.id, name: 'Alex Manager' },
      });
      expect((await h.counts()).outbox).toBe(1);
    });

    it('treats the same stage as a no-op and validates the body', async () => {
      const same = await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, { stage: 'new', version: 1 });
      expect(same.body).toEqual({ stage: 'new', version: 1, stageChangedAt: null });
      for (const body of [{ stage: 'closed', version: 1 }, { stage: 'won' }, { stage: 'won', version: 1, extra: true }]) {
        expect((await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, body)).status).toBe(400);
      }
      expect((await h.as(f.rep1).put(`/api/leads/${f.leads.pool}/stage`, { stage: 'won', version: 1 })).status).toBe(403);
      expect((await h.as(f.rep1).put(`/api/leads/${f.leads.other}/stage`, { stage: 'won', version: 1 })).status).toBe(404);
      expect(await h.counts()).toMatchObject({ outbox: 0, activity: 0 });
    });

    it('moves a new lead to contacted on its first call, email or visit; later ones only set last contacted', async () => {
      const first = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/activities`, { type: 'email' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ salesStage: 'contacted', version: 2, lastContactedAt: first.body.activity.createdAt });
      expect(first.body.stageChangedAt).toEqual(expect.any(String));
      const rows = await activity();
      expect(rows.map((r) => r.action_type)).toEqual(['email', 'stage_changed']);
      expect(rows[1].field_diff).toEqual({ sales_stage: ['new', 'contacted'], auto: true, activity_id: first.body.activity.id });
      const events = await h.outbox();
      expect(events.map((e) => [e.event_type, e.payload.version])).toEqual([['state.changed', 2], ['lead.updated', 2]]);
      expect(events[1].payload).toMatchObject({ fields: ['sales_stage'], sales_stage: 'contacted', previous_stage: 'new' });

      const second = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/activities`, { type: 'call', outcome: 'voicemail' });
      expect(second.body).toMatchObject({ salesStage: 'contacted', version: 2, lastContactedAt: second.body.activity.createdAt });
      expect(second.body.stageChangedAt).toBe(first.body.stageChangedAt);
      expect((await lead(f.leads.own)).last_contacted_at?.toISOString()).toBe(second.body.activity.createdAt);
      expect((await h.outbox()).slice(2).map((e) => e.event_type)).toEqual(['state.changed']);

      await h.as(f.rep1).put(`/api/leads/${f.leads.own}/stage`, { stage: 'quoting', version: 2 });
      const third = await h.as(f.rep1).post(`/api/leads/${f.leads.own}/activities`, { type: 'visit' });
      expect(third.body).toMatchObject({ salesStage: 'quoting', version: 3 });
      await h.as(f.rep1).post(`/api/leads/${f.leads.own}/notes`, { text: 'Owner wants a sample bundle' });
      expect((await lead(f.leads.own)).last_contacted_at?.toISOString()).toBe(third.body.activity.createdAt);
    });
  });

  describe('tasks', () => {
    const create = (who: keyof Pick<Fixture, 'rep1' | 'rep2' | 'manager'>, leadId: string, body: object = {}) =>
      h.as(f[who]).post(`/api/leads/${leadId}/tasks`, { title: 'Call back about the shingle order', type: 'call', dueAt: '2026-10-20T14:00:00Z', ...body });

    it('creates a task for the rep on their own lead, with its activity row and event; the lead version stays', async () => {
      const res = await create('rep1', f.leads.own, { note: '  Ask for the foreman  ' });
      expect(res.status).toBe(201);
      expect(res.body.task).toEqual({
        id: expect.any(String), companyId: f.leads.own, companyName: 'Own Roofing', title: 'Call back about the shingle order',
        type: 'call', dueAt: '2026-10-20T14:00:00.000Z', doneAt: null, note: 'Ask for the foreman',
        assignee: { id: f.rep1.id, name: 'Jordan Rep' }, createdBy: { id: f.rep1.id, name: 'Jordan Rep' },
        createdAt: expect.any(String), updatedAt: expect.any(String), version: 1,
      });
      const { id } = res.body.task;
      expect(await h.version(f.leads.own)).toBe(1);
      expect(await activity()).toEqual([{
        action_type: 'task_created', user_id: f.rep1.id,
        field_diff: { task_id: id, title: 'Call back about the shingle order', type: 'call', due_at: '2026-10-20T14:00:00.000Z', assignee_id: f.rep1.id },
      }]);
      expect((await h.outbox())[0]).toEqual({
        event_type: 'lead.updated', company_id: f.leads.own,
        payload: {
          company_id: f.leads.own, fields: ['tasks'], task_id: id, task_action: 'created', task_title: 'Call back about the shingle order',
          task_type: 'call', due_at: '2026-10-20T14:00:00.000Z', done: false, assignee_id: f.rep1.id, previous_assignee_id: null,
          assigned_rep_id: f.rep1.id, version: 1, actor_type: 'user', actor_id: f.rep1.id, actor_name: 'Jordan Rep',
        },
      });
    });

    it('reads a date alone as that day in New York, and validates the body', async () => {
      const winter = await create('rep1', f.leads.own, { dueAt: '2026-12-01' });
      expect(winter.body.task.dueAt).toBe('2026-12-01T05:00:00.000Z');
      const summer = await create('rep1', f.leads.own, { dueAt: '2026-07-01', type: 'todo' });
      expect(summer.body.task.dueAt).toBe('2026-07-01T04:00:00.000Z');
      for (const body of [{ title: '   ' }, { type: 'meeting' }, { dueAt: 'tomorrow' }, { dueAt: undefined }, { title: 'a\u0007b' }, { extra: 1 }]) {
        expect((await create('rep1', f.leads.own, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('lets reps assign only themselves on their own leads and managers anyone who can open the lead', async () => {
      expect((await create('rep1', f.leads.own, { assigneeId: f.rep2.id })).status).toBe(403);
      expect((await create('rep1', f.leads.own, { assigneeId: f.manager.id })).status).toBe(403);
      expect((await create('rep1', f.leads.pool)).status).toBe(403);
      expect((await create('rep1', f.leads.other)).status).toBe(404);
      const cannotOpen = await create('manager', f.leads.other, { assigneeId: f.rep1.id });
      expect(cannotOpen.status).toBe(400);
      expect(cannotOpen.body.error).toBe('invalid_assignee');
      expect((await create('manager', f.leads.own, { assigneeId: '7a1c4c8e-0000-4000-8000-000000000000' })).body.error).toBe('invalid_assignee');
      expect(await h.counts()).toMatchObject({ outbox: 0, activity: 0 });
      const forRep = await create('manager', f.leads.pool, { assigneeId: f.rep1.id });
      expect(forRep.status).toBe(201);
      expect(forRep.body.task).toMatchObject({ assignee: { id: f.rep1.id }, createdBy: { id: f.manager.id } });
      expect((await create('manager', f.leads.other)).body.task.assignee.id).toBe(f.manager.id);
    });

    it('completes, reopens and edits with the task version; a stale one is 409 with the task and who changed it', async () => {
      const { task } = (await create('rep1', f.leads.own)).body;
      const done = await h.as(f.rep1).patch(`/api/tasks/${task.id}`, { done: true, version: 1 });
      expect(done.status).toBe(200);
      expect(done.body.task).toMatchObject({ version: 2, doneAt: expect.any(String) });
      const stale = await h.as(f.manager).patch(`/api/tasks/${task.id}`, { title: 'Changed', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({
        error: 'version_conflict', current: done.body.task, changedBy: { id: f.rep1.id, name: 'Jordan Rep' }, changedAt: done.body.task.updatedAt,
      });
      const reopened = await h.as(f.manager).patch(`/api/tasks/${task.id}`, {
        done: false, dueAt: '2026-10-22', note: 'Bring TPO samples', type: 'visit', version: 2,
      });
      expect(reopened.body.task).toMatchObject({ version: 3, doneAt: null, dueAt: '2026-10-22T04:00:00.000Z', type: 'visit', note: 'Bring TPO samples' });
      const noop = await h.as(f.rep1).patch(`/api/tasks/${task.id}`, { type: 'visit', note: 'Bring TPO samples', version: 3 });
      expect(noop.body.task.version).toBe(3);

      const rows = await activity();
      expect(rows.map((r) => r.action_type)).toEqual(['task_created', 'task_completed', 'task_updated']);
      expect(rows[1].field_diff).toMatchObject({ changes: { done_at: [null, done.body.task.doneAt] } });
      expect(rows[2].field_diff).toMatchObject({
        type: 'visit',
        changes: {
          done_at: [done.body.task.doneAt, null], due_at: ['2026-10-20T14:00:00.000Z', '2026-10-22T04:00:00.000Z'],
          note: [null, 'Bring TPO samples'], type: ['call', 'visit'],
        },
      });
      const events = await h.outbox();
      expect(events.map((e) => [e.payload.task_action, e.payload.done, e.payload.actor_id])).toEqual([
        ['created', false, f.rep1.id], ['completed', true, f.rep1.id], ['updated', false, f.manager.id],
      ]);
      expect((await h.as(f.rep1).patch(`/api/tasks/${task.id}`, { version: 3 })).status).toBe(400);
    });

    it('lets managers reassign, and the assignee or the lead\'s rep change a task; others get 403 or 404', async () => {
      const onPool = (await create('manager', f.leads.pool, { assigneeId: f.rep1.id })).body.task;
      // The assignee may complete it although the pool lead is not theirs to write; rep2 may only see it.
      expect((await h.as(f.rep2).patch(`/api/tasks/${onPool.id}`, { done: true, version: 1 })).status).toBe(403);
      expect((await h.as(f.rep1).patch(`/api/tasks/${onPool.id}`, { done: true, version: 1 })).status).toBe(200);
      const moved = await h.as(f.manager).patch(`/api/tasks/${onPool.id}`, { assigneeId: f.rep2.id, version: 2 });
      expect(moved.body.task.assignee).toEqual({ id: f.rep2.id, name: 'Priya Rep' });
      expect((await h.outbox()).at(-1)?.payload).toMatchObject({
        task_action: 'updated', assignee_id: f.rep2.id, previous_assignee_id: f.rep1.id,
      });

      const mgrTask = (await create('manager', f.leads.own)).body.task;
      expect((await h.as(f.rep1).patch(`/api/tasks/${mgrTask.id}`, { title: 'Call the owner', version: 1 })).status).toBe(200);
      expect((await h.as(f.rep1).patch(`/api/tasks/${mgrTask.id}`, { assigneeId: f.rep2.id, version: 2 })).status).toBe(403);
      expect((await h.as(f.rep2).patch(`/api/tasks/${mgrTask.id}`, { title: 'x', version: 2 })).status).toBe(404);
      expect((await h.as(f.rep2).delete(`/api/tasks/${mgrTask.id}?version=2`)).status).toBe(404);
      expect((await h.as(f.rep1).patch('/api/tasks/7a1c4c8e-0000-4000-8000-000000000000', { title: 'x', version: 1 })).status).toBe(404);
    });

    it('deletes with the version (query or body), logging task_deleted', async () => {
      const { task } = (await create('rep1', f.leads.own)).body;
      expect((await h.as(f.rep1).delete(`/api/tasks/${task.id}`)).status).toBe(400);
      expect((await h.as(f.rep1).delete(`/api/tasks/${task.id}?version=2`)).status).toBe(409);
      const res = await h.as(f.rep1).delete(`/api/tasks/${task.id}`, { version: 1 });
      expect(res.body).toEqual({ deleted: true, id: task.id });
      expect(await h.all('SELECT id FROM tasks')).toHaveLength(0);
      expect((await activity()).map((r) => r.action_type)).toEqual(['task_created', 'task_deleted']);
      expect((await h.outbox()).at(-1)?.payload).toMatchObject({ task_action: 'deleted', task_id: task.id });
      expect((await h.as(f.rep1).delete(`/api/tasks/${task.id}?version=1`)).status).toBe(404);
    });

    it('moves the previous rep\'s open tasks with a reassigned lead', async () => {
      const open = (await create('rep1', f.leads.own)).body.task;
      const closed = (await create('rep1', f.leads.own)).body.task;
      await h.as(f.rep1).patch(`/api/tasks/${closed.id}`, { done: true, version: 1 });
      const mgr = (await create('manager', f.leads.own)).body.task;
      expect((await h.as(f.manager).post('/api/allocations', { companyIds: [f.leads.own], repId: f.rep2.id })).status).toBe(200);
      const rows = await h.all<{ id: string; assignee_id: string; version: number }>('SELECT id, assignee_id, version FROM tasks');
      const by = new Map(rows.map((r) => [r.id, r]));
      expect(by.get(open.id)).toMatchObject({ assignee_id: f.rep2.id, version: 2 });
      expect(by.get(closed.id)).toMatchObject({ assignee_id: f.rep1.id, version: 2 });
      expect(by.get(mgr.id)).toMatchObject({ assignee_id: f.manager.id, version: 1 });
    });
  });
});
