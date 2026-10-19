// The sales reads the dashboard needs (GET /api/dashboard, /api/tasks through the shared endpoints), typed by the
// shared contract. The dashboard body is normalised for rendering, so a partial or older body shows zeros, never a crash.
import * as ep from '@/api/endpoints';
import type { ActivityCounts, DashboardScope, SalesDashboard, SalesStage, Task, TaskDue, TaskStatus, UserRef } from '@/api/types';
import { SALES_STAGES, isSalesStage as isStage } from '@/lib/labels';

export type { DashboardScope, SalesStage, Task };

export const DEFAULT_WEEKLY_GOAL = 25;

export interface TeamRepRow {
  rep: UserRef;
  assigned: number;
  pipeline: Record<SalesStage, number>;
  activityThisWeek: number;
  overdue: number;
  wonThisMonth: number;
}

export interface TopTag {
  key: string;
  label: string;
  count: number;
  kind: string;
}

/** SalesDashboard shaped for rendering: stage counts by stage, one total per day. */
export interface DashboardData {
  scope: string;
  pipeline: Record<SalesStage, number>;
  followUps: SalesDashboard['followUps'];
  activity: { thisWeek: ActivityCounts; lastWeek: ActivityCounts; goalPerWeek: number; daily: { date: string; total: number }[] };
  accounts: SalesDashboard['accounts'];
  coverage: SalesDashboard['coverage'];
  neverContacted: number;
  notContacted30d: number;
  newSinceLastPoll: number;
  topTags: TopTag[];
  segments: { segment: string; count: number }[];
  reps?: TeamRepRow[];
  generatedAt: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Calls + emails + visits (notes are not contact). */
export const activityTotal = (a: ActivityCounts) => a.calls + a.emails + a.visits;

function counts(v: unknown): ActivityCounts {
  const o = obj(v);
  return { calls: n(o.calls), emails: n(o.emails), visits: n(o.visits), notes: n(o.notes) };
}

/** [{stage, count}] (or {stage: count}) -> every stage present. */
function stageCounts(v: unknown): Record<SalesStage, number> {
  const out = Object.fromEntries(SALES_STAGES.map((st) => [st, 0])) as Record<SalesStage, number>;
  if (Array.isArray(v)) {
    for (const row of v) {
      const r = obj(row);
      if (isStage(r.stage)) out[r.stage] += n(r.count);
    }
  } else {
    const o = obj(v);
    for (const st of SALES_STAGES) out[st] = n(o[st]);
  }
  return out;
}

function repRow(v: unknown): TeamRepRow | null {
  const o = obj(v);
  const rep = obj(o.rep);
  if (!s(rep.id)) return null;
  const act = o.activityThisWeek;
  return {
    rep: { id: s(rep.id), name: s(rep.name) || 'Rep' },
    assigned: n(o.assigned),
    pipeline: stageCounts(o.pipeline),
    activityThisWeek: typeof act === 'number' ? act : activityTotal(counts(act)),
    overdue: n(o.overdue),
    wonThisMonth: n(o.wonThisMonth),
  };
}

export function normalizeDashboard(raw: unknown, scope: DashboardScope): DashboardData {
  const d = obj(raw);
  const activity = obj(d.activity);
  const accounts = obj(d.accounts);
  const coverage = obj(d.coverage);
  const followUps = obj(d.followUps);
  return {
    scope: s(d.scope) || scope,
    pipeline: stageCounts(d.pipeline),
    followUps: { overdue: n(followUps.overdue), today: n(followUps.today), week: n(followUps.week) },
    activity: {
      thisWeek: counts(activity.thisWeek),
      lastWeek: counts(activity.lastWeek),
      goalPerWeek: n(activity.goalPerWeek) || DEFAULT_WEEKLY_GOAL,
      daily: list(activity.daily).map((row) => ({ date: s(obj(row).date), total: activityTotal(counts(row)) })),
    },
    accounts: {
      prospect: n(accounts.prospect),
      existing_customer: n(accounts.existing_customer),
      lapsed_customer: n(accounts.lapsed_customer),
      do_not_contact: n(accounts.do_not_contact),
    },
    coverage: {
      total: n(coverage.total),
      withDecisionMaker: n(coverage.withDecisionMaker),
      withEmail: n(coverage.withEmail),
      withPhone: n(coverage.withPhone),
    },
    neverContacted: n(d.neverContacted),
    notContacted30d: n(d.notContacted30d),
    newSinceLastPoll: n(d.newSinceLastPoll),
    topTags: list(d.topTags)
      .map((t) => { const o = obj(t); return { key: s(o.key), label: s(o.label) || s(o.key), count: n(o.count), kind: s(o.kind) }; })
      .filter((t) => t.key && t.count > 0),
    segments: list(d.segments).map((r) => ({ segment: s(obj(r).segment), count: n(obj(r).count) })).filter((x) => x.segment),
    reps: Array.isArray(d.reps) ? d.reps.map(repRow).filter((r): r is TeamRepRow => !!r) : undefined,
    generatedAt: s(d.generatedAt) || new Date().toISOString(),
  };
}

type Opts = { signal?: AbortSignal };

export async function getSalesDashboard(scope: DashboardScope, o?: Opts): Promise<DashboardData> {
  return normalizeDashboard((await ep.getSalesDashboard(scope, o)) as SalesDashboard | undefined, scope);
}

export async function getTasks(q: { scope: DashboardScope; due: TaskDue; status?: TaskStatus; limit?: number }, o?: Opts): Promise<Task[]> {
  const res = await ep.getTasks(q, o);
  return list((res as Partial<typeof res> | undefined)?.items) as Task[];
}
