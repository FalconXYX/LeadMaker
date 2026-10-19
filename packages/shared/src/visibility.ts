// The one visibility rule (SystemDesign §5 Permissions), used by query, crm-write and the SSE stream:
//   rep:     views companies allocated to them or unallocated; writes only those allocated to them
//   manager: views and writes everything (allocating/reassigning is a separate manager-only check)
import { ident, raw, sql, type Sql } from './sql.ts';

export const ROLES = ['rep', 'manager'] as const;
export type Role = (typeof ROLES)[number];

export interface Viewer {
  id: string;
  role: Role;
}

export type Access = 'view' | 'write';

export function isManager(viewer: Viewer): boolean {
  return viewer.role === 'manager';
}

export function canView(viewer: Viewer, assignedRepId: string | null | undefined): boolean {
  return viewer.role === 'manager' || assignedRepId == null || assignedRepId === viewer.id;
}

export function canWrite(viewer: Viewer, assignedRepId: string | null | undefined): boolean {
  return viewer.role === 'manager' || (assignedRepId != null && assignedRepId === viewer.id);
}

export function canAllocate(viewer: Viewer): boolean {
  return viewer.role === 'manager';
}

/**
 * WHERE condition over `companies` (aliased `alias`) for what the viewer may view or write.
 * Parameterised: the user id is a bound value.
 */
export function visibilitySql(viewer: Viewer, access: Access = 'view', alias = 'c'): Sql {
  if (viewer.role === 'manager') return raw('TRUE');
  if (viewer.role !== 'rep') return raw('FALSE');
  const col = sql`${ident(alias)}.assigned_rep_id`;
  return access === 'write'
    ? sql`(${col} = ${viewer.id}::uuid)`
    : sql`(${col} = ${viewer.id}::uuid OR ${col} IS NULL)`;
}
