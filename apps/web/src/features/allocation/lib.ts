// Pure helpers for allocation: response normalisation, undo plans, batching. Unit-testable, no React.
import type { AllocationByFilterResult, AllocationResult, BulkUnallocateResult, LeadSummary, UserListItem } from '@/api/types';
import { isSegment, SEGMENT_LABELS, SEGMENTS, type Segment } from '@/lib/labels';

/** One lead the server moved, with where it came from (null = the pool). */
export interface MovedLead {
  companyId: string;
  previousRepId: string | null;
}

/** What an allocation call did, whatever shape the server answered in. */
export interface AllocationOutcome {
  repId: string;
  moved: MovedLead[];
  /** Already with that rep: left alone. */
  unchanged: number;
  /** Deleted between the match and the write (by-filter only). */
  missing: number;
  /** by-filter: how many leads the filter matched. */
  matched?: number;
}

/** What an allocation call did (POST /api/allocations or /by-filter), as the toasts and Undo need it. */
export function normalizeOutcome(raw: AllocationResult | AllocationByFilterResult | undefined, repId: string): AllocationOutcome {
  const allocated = Array.isArray(raw?.allocated) ? raw.allocated : [];
  const byFilter = raw && 'matched' in raw ? raw : null;
  return {
    repId: typeof raw?.repId === 'string' ? raw.repId : repId,
    moved: allocated
      .filter((row) => typeof row?.companyId === 'string')
      .map((row) => ({ companyId: row.companyId, previousRepId: row.previousRepId ?? null })),
    unchanged: Array.isArray(raw?.unchanged) ? raw.unchanged.length : 0,
    missing: Array.isArray(byFilter?.missing) ? byFilter.missing.length : 0,
    matched: typeof byFilter?.matched === 'number' ? byFilter.matched : undefined,
  };
}

export function mergeOutcomes(outcomes: AllocationOutcome[], repId: string): AllocationOutcome {
  return {
    repId,
    moved: outcomes.flatMap((o) => o.moved),
    unchanged: outcomes.reduce((n, o) => n + o.unchanged, 0),
    missing: outcomes.reduce((n, o) => n + o.missing, 0),
    matched: outcomes.some((o) => o.matched !== undefined)
      ? outcomes.reduce((n, o) => n + (o.matched ?? 0), 0)
      : undefined,
  };
}

/** What one DELETE /api/allocations did: the leads it moved (with their rep before) and those already in the pool. */
export function normalizeRelease(raw: BulkUnallocateResult | undefined): { moved: MovedLead[]; unchanged: string[] } {
  const rows = Array.isArray(raw?.unallocated) ? raw.unallocated : [];
  return {
    moved: rows
      .filter((row) => typeof row?.companyId === 'string')
      .map((row) => ({ companyId: row.companyId, previousRepId: row.previousRepId ?? null })),
    unchanged: Array.isArray(raw?.unchanged) ? raw.unchanged.filter((id): id is string => typeof id === 'string') : [],
  };
}

/** How to put moved leads back: DELETE the ones that came from the pool, re-allocate the rest per rep. */
export function undoPlan(moved: MovedLead[]): { toPool: string[]; toReps: Map<string, string[]> } {
  const toPool: string[] = [];
  const toReps = new Map<string, string[]>();
  for (const m of moved) {
    if (!m.previousRepId) toPool.push(m.companyId);
    else toReps.set(m.previousRepId, [...(toReps.get(m.previousRepId) ?? []), m.companyId]);
  }
  return { toPool, toReps };
}

/** Splits items into batches of `size` (null: one batch, for when the limit is unknown). */
export function chunk<T>(items: T[], size: number | null): T[][] {
  if (!size || size < 1) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "3 Strategic · 2 Growth", most valuable first. */
export function segmentBreakdown(leads: Pick<LeadSummary, 'segment'>[]): { segment: Segment | null; label: string; count: number }[] {
  const counts = new Map<Segment | null, number>();
  for (const l of leads) {
    const s = isSegment(l.segment) ? l.segment : null;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const order: (Segment | null)[] = [...SEGMENTS, null];
  return order
    .filter((s) => counts.has(s))
    .map((s) => ({ segment: s, label: s ? SEGMENT_LABELS[s] : 'Unscored', count: counts.get(s)! }));
}

export interface RepLoad {
  id: string;
  name: string;
  email: string;
  /** Live (GET /api/users). */
  allocated: number;
  /** From the team KPI view (refreshed every few minutes). */
  unchecked: number | null;
  unserviced: number | null;
  updatedInLastPoll: number | null;
}

export function repsOf(users: UserListItem[] | undefined): UserListItem[] {
  return (users ?? []).filter((u) => u.role === 'rep');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** First name for compact copy ("Sam's load"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
