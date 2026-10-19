// The My leads / Unallocated / All switch. The URL keeps the LeadFilter scope; a missing scope means the
// role's default view (reps: My leads, managers: All), so links like /leads?unchecked=me stay short.
import type { LeadFilter, SessionUser, UserListItem } from '@/api/types';

export type LeadView = 'mine' | 'unallocated' | 'all' | 'rep';

export function defaultView(isManager: boolean): Exclude<LeadView, 'rep'> {
  return isManager ? 'all' : 'mine';
}

export function viewOf(filter: LeadFilter, isManager: boolean): { view: LeadView; repId?: string } {
  const s = filter.scope;
  if (!s) return { view: defaultView(isManager) };
  if (typeof s === 'object') return { view: 'rep', repId: s.repId };
  return { view: s };
}

/**
 * The scope sent to the API. Reps may not send "all" or {repId}: their "All" is the default visibility
 * (mine + unallocated), and a manager's shared rep link falls back to that too.
 */
export function apiScope(filter: LeadFilter, user: Pick<SessionUser, 'id' | 'role'> | null): LeadFilter['scope'] {
  const isManager = user?.role === 'manager';
  const s = filter.scope;
  if (isManager) return s;
  if (!s) return 'mine';
  if (s === 'all') return undefined;
  if (typeof s === 'object') return s.repId === user?.id ? 'mine' : undefined;
  return s;
}

/** The URL scope for a view: the role default is left out. */
export function scopeForView(view: Exclude<LeadView, 'rep'>, isManager: boolean): LeadFilter['scope'] {
  return view === defaultView(isManager) ? undefined : view;
}

export function viewLabel(
  filter: LeadFilter,
  isManager: boolean,
  reps: readonly Pick<UserListItem, 'id' | 'name'>[] = [],
): string {
  const { view, repId } = viewOf(filter, isManager);
  switch (view) {
    case 'mine':
      return 'My leads';
    case 'unallocated':
      return 'Unallocated';
    case 'all':
      return isManager ? 'All leads' : 'Mine + unallocated';
    case 'rep': {
      if (!isManager) return 'Mine + unallocated';
      const name = reps.find((r) => r.id === repId)?.name;
      return name ? `${name}’s leads` : 'Rep’s leads';
    }
  }
}
