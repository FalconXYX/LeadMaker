// Sales stages and tasks: the LeadFilter additions, task permissions and scopes, and (with TEST_DATABASE_URL, inside a
// rolled-back transaction) the day windows against a real Postgres.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  and, canAssignTask, canEditTask, canUseSalesScope, dayStartSql, filterConditions, followUpCondition, leadFilterSchema,
  monthStartSql, NEXT_FOLLOW_UP, parseSalesScope, raw, SALES_STAGE_LABELS, SALES_STAGES, salesScopeString, sql, TASK_DUE,
  TASK_SELECT, taskDueCondition, taskOut, taskScopeConditions, weekStartSql, type Sql, type TaskRow,
} from '../src/index.ts';

const url = process.env.TEST_DATABASE_URL;
const REP = { id: '8ab22707-08e6-40ba-904a-daff2fb62b28', role: 'rep' as const };
const REP2 = { id: 'e1817cb3-f647-416d-9c20-084a9ab62324', role: 'rep' as const };
const MANAGER = { id: '8b974b0a-101c-47cf-bdfe-1aed4786febc', role: 'manager' as const };

describe('LeadFilter sales fields', () => {
  it('accepts stages, followUp, notContactedSince and the new sorts', () => {
    const f = leadFilterSchema.parse({
      stages: ['new', 'quoting', 'lost'], followUp: 'overdue', notContactedSince: '2026-09-18',
      sort: { by: 'next_follow_up', dir: 'asc' },
    });
    expect(f.stages).toEqual(['new', 'quoting', 'lost']);
    expect(leadFilterSchema.parse({ sort: { by: 'last_contacted', dir: 'desc' } }).sort?.by).toBe('last_contacted');
    expect(leadFilterSchema.parse({ notContactedSince: '2026-09-18T09:00:00-04:00' }).notContactedSince).toBeDefined();
  });

  it.each([
    [{ stages: ['closed'] }], [{ stages: 'new' }], [{ stages: [...SALES_STAGES, 'new'] }], [{ followUp: 'tomorrow' }],
    [{ followUp: ['today'] }], [{ notContactedSince: 'last month' }], [{ sort: { by: 'next_task', dir: 'asc' } }],
  ])('rejects %o', (f) => {
    expect(leadFilterSchema.safeParse(f).success).toBe(false);
  });

  it('compiles stages to a bound text[] match and the rest to bound conditions after visibility', () => {
    const [vis, stages, followUp, since] = filterConditions(
      leadFilterSchema.parse({ stages: ['contacted', 'interested'], followUp: 'none', notContactedSince: '2026-09-01' }),
      { viewer: REP },
    ).map((c) => c.compile());
    expect(vis.text).toContain('assigned_rep_id');
    expect(stages).toEqual({ text: 'c.sales_stage = ANY($1::text[])', values: [['contacted', 'interested']] });
    expect(followUp.text).toBe('NOT EXISTS (SELECT 1 FROM tasks t WHERE t.company_id = c.id AND t.done_at IS NULL)');
    expect(since).toEqual({ text: '(c.last_contacted_at IS NULL OR c.last_contacted_at < $1::timestamptz)', values: ['2026-09-01'] });
    expect(filterConditions({ stages: [] }, { viewer: MANAGER })).toHaveLength(1);
  });

  it('binds the time zone and day offsets of the follow-up windows', () => {
    for (const w of ['overdue', 'today', 'week'] as const) {
      const q = followUpCondition(w).compile();
      expect(q.text).toMatch(/^EXISTS \(SELECT 1 FROM tasks t WHERE t\.company_id = c\.id AND t\.done_at IS NULL AND /);
      expect(q.text).not.toContain('America');
      expect(q.values).toContain('America/New_York');
    }
    expect(taskDueCondition('week').compile().values).toEqual(['America/New_York', 0, 'America/New_York', 'America/New_York', 7, 'America/New_York']);
    expect(taskDueCondition('all').compile().text).toBe('TRUE');
  });

  it('labels every stage, "lost" as Not a fit', () => {
    expect(Object.keys(SALES_STAGE_LABELS)).toEqual([...SALES_STAGES]);
    expect(SALES_STAGE_LABELS.lost).toBe('Not a fit');
  });
});

describe('task permissions and scopes', () => {
  it('lets a rep assign only themselves, on their own lead; a manager anyone who can open the lead', () => {
    expect(canAssignTask(REP, REP, REP.id)).toBe(true);
    expect(canAssignTask(REP, REP, null)).toBe(false);
    expect(canAssignTask(REP, REP2, REP.id)).toBe(false);
    expect(canAssignTask(MANAGER, REP2, REP.id)).toBe(false);
    expect(canAssignTask(MANAGER, REP, REP.id)).toBe(true);
    expect(canAssignTask(MANAGER, REP2, null)).toBe(true);
    expect(canAssignTask(MANAGER, MANAGER, REP.id)).toBe(true);
  });

  it('lets managers, the lead\'s rep and the assignee (while they can open the lead) change a task', () => {
    expect(canEditTask(MANAGER, { assigneeId: REP.id }, REP2.id)).toBe(true);
    expect(canEditTask(REP, { assigneeId: MANAGER.id }, REP.id)).toBe(true);
    expect(canEditTask(REP, { assigneeId: REP.id }, null)).toBe(true);
    expect(canEditTask(REP, { assigneeId: REP.id }, REP2.id)).toBe(false);
    expect(canEditTask(REP2, { assigneeId: REP.id }, null)).toBe(false);
  });

  it('parses mine, team and rep:<uuid> and limits team and other reps to managers', () => {
    expect(parseSalesScope('mine')).toEqual({ kind: 'mine' });
    expect(parseSalesScope(`rep:${REP.id.toUpperCase()}`)).toEqual({ kind: 'rep', repId: REP.id });
    for (const bad of ['all', 'rep:', 'rep:x', '', undefined, ['mine']]) expect(parseSalesScope(bad)).toBeNull();
    const team = parseSalesScope('team')!;
    expect([canUseSalesScope(REP, team), canUseSalesScope(MANAGER, team)]).toEqual([false, true]);
    expect(canUseSalesScope(REP, { kind: 'rep', repId: REP.id })).toBe(true);
    expect(canUseSalesScope(REP, { kind: 'rep', repId: REP2.id })).toBe(false);
    expect(salesScopeString({ kind: 'rep', repId: REP.id })).toBe(`rep:${REP.id}`);
  });

  it('scopes task lists by visibility, then assignee or lead owner', () => {
    const [vis, mine] = taskScopeConditions(REP, { kind: 'mine' }).map((c) => c.compile());
    expect(vis.values).toEqual([REP.id]);
    expect(mine).toEqual({ text: '(t.assignee_id = $1::uuid OR c.assigned_rep_id = $2::uuid)', values: [REP.id, REP.id] });
    expect(taskScopeConditions(MANAGER, { kind: 'team' }).map((c) => c.compile().text)).toEqual(['TRUE']);
    expect(taskScopeConditions(MANAGER, { kind: 'rep', repId: REP2.id })[1].compile().values).toEqual([REP2.id, REP2.id]);
    expect(TASK_DUE).toEqual(['overdue', 'today', 'week', 'upcoming', 'all']);
  });

  it('maps a task row to the API shape', () => {
    const row: TaskRow = {
      id: 't1', company_id: 'c1', company_name: 'Acme Roofing', title: 'Call back', type: 'call',
      due_at: new Date('2026-10-19T14:00:00Z'), done_at: null, note: null, assignee_id: REP.id, assignee_name: 'Jordan',
      created_by: MANAGER.id, created_by_name: 'Alex', created_at: '2026-10-18T12:00:00Z', updated_at: '2026-10-18T12:00:00Z', version: 1,
    };
    expect(taskOut(row)).toEqual({
      id: 't1', companyId: 'c1', companyName: 'Acme Roofing', title: 'Call back', type: 'call', dueAt: '2026-10-19T14:00:00.000Z',
      doneAt: null, note: null, assignee: { id: REP.id, name: 'Jordan' }, createdBy: { id: MANAGER.id, name: 'Alex' },
      createdAt: '2026-10-18T12:00:00.000Z', updatedAt: '2026-10-18T12:00:00.000Z', version: 1,
    });
  });
});

describe.skipIf(!url)('sales SQL against Postgres', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    await client.query('BEGIN');
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  const q = async <T extends object>(s: Sql): Promise<T[]> => {
    const c = s.compile();
    return (await client.query(c.text, c.values)).rows as T[];
  };

  it('starts days at midnight and weeks on Monday in New York', async () => {
    const [r] = await q<{ day: string; today: boolean; week: number; wtime: string; month: number }>(sql`SELECT
      to_char(${dayStartSql(0)} AT TIME ZONE 'America/New_York', 'HH24:MI') AS day,
      (${dayStartSql(0)} AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AS today,
      extract(isodow FROM ${weekStartSql(-1)} AT TIME ZONE 'America/New_York')::int AS week,
      to_char(${weekStartSql(0)} AT TIME ZONE 'America/New_York', 'HH24:MI') AS wtime,
      extract(day FROM ${monthStartSql()} AT TIME ZONE 'America/New_York')::int AS month`);
    expect(r).toEqual({ day: '00:00', today: true, week: 1, wtime: '00:00', month: 1 });
  });

  it('puts open tasks in the follow-up windows and orders leads by their next one', async () => {
    const [user] = await q<{ id: string }>(sql`INSERT INTO users (name, email) VALUES ('T', 't@sales.test') RETURNING id`);
    const lead = async (name: string) => (await q<{ id: string }>(sql`
      INSERT INTO companies (business_name, latitude, longitude, content_hash) VALUES (${name}, 40.7, -74, 'h') RETURNING id`))[0].id;
    const ids = { overdue: await lead('Overdue'), today: await lead('Today'), week: await lead('Week'), later: await lead('Later'),
      done: await lead('Done'), none: await lead('None') };
    const task = (company: string, due: Sql, done = false) => q(sql`
      INSERT INTO tasks (company_id, title, due_at, done_at, assignee_id, created_by)
      VALUES (${company}::uuid, 'x', ${due}, ${done ? raw('now()') : raw('NULL')}, ${user.id}::uuid, ${user.id}::uuid)`);
    await task(ids.overdue, sql`${dayStartSql(0)} - interval '1 minute'`);
    await task(ids.today, sql`${dayStartSql(0)} + interval '30 minutes'`);
    await task(ids.today, sql`${dayStartSql(1)} - interval '1 minute'`);
    await task(ids.week, sql`${dayStartSql(7)} - interval '1 minute'`);
    await task(ids.later, dayStartSql(7));
    await task(ids.done, sql`${dayStartSql(0)} - interval '1 day'`, true);
    const names = async (cond: Sql) => (await q<{ business_name: string }>(sql`
      SELECT business_name FROM companies c WHERE ${cond} ORDER BY ${NEXT_FOLLOW_UP} NULLS LAST, business_name`))
      .map((r) => r.business_name);
    expect(await names(followUpCondition('overdue'))).toEqual(['Overdue']);
    expect(await names(followUpCondition('today'))).toEqual(['Today']);
    expect(await names(followUpCondition('week'))).toEqual(['Today', 'Week']);
    expect(await names(followUpCondition('none'))).toEqual(['Done', 'None']);
    expect(await names(raw('TRUE'))).toEqual(['Overdue', 'Today', 'Week', 'Later', 'Done', 'None']);
    const due = async (d: (typeof TASK_DUE)[number]) => (await q<{ company_name: string }>(sql`
      ${TASK_SELECT} WHERE t.done_at IS NULL AND ${taskDueCondition(d)} ORDER BY t.due_at`)).map((r) => r.company_name);
    expect(await due('upcoming')).toEqual(['Week', 'Later']);
    expect(await due('all')).toHaveLength(5);
    const [row] = await q<TaskRow>(sql`${TASK_SELECT} WHERE t.company_id = ${ids.later}::uuid`);
    expect(taskOut(row)).toMatchObject({ companyName: 'Later', assignee: { id: user.id, name: 'T' }, version: 1, doneAt: null });
    await q(sql`INSERT INTO field_overrides (company_id, field, value, user_id)
      VALUES (${ids.later}::uuid, 'business_name', '"Later & Sons"', ${user.id}::uuid)`);
    expect((await q<TaskRow>(sql`${TASK_SELECT} WHERE t.company_id = ${ids.later}::uuid`))[0].company_name).toBe('Later & Sons');
    expect(await names(and(filterConditions({ stages: ['new'], followUp: 'week' }, { viewer: MANAGER })))).toEqual(['Today', 'Week']);
  });
});
