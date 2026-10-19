// Role and permission helpers (SystemDesign §5 Permissions). The server is the authority: prefer the
// flags it sends (LeadSummary.canWrite, LeadProfile.permissions) and fall back to the allocation rule.
import type { LeadProfile, LeadSummary, SessionUser, UserRef } from '@/api/types';

type User = Pick<SessionUser, 'id' | 'role'> | null | undefined;

type LeadLike =
  | Pick<LeadSummary, 'canWrite' | 'assignedRep'>
  | Pick<LeadProfile, 'permissions' | 'allocation'>
  | { assignedRep?: UserRef | null; canWrite?: boolean };

export function isManager(user: User): boolean {
  return user?.role === 'manager';
}

export function isRep(user: User): boolean {
  return user?.role === 'rep';
}

/** Allocate / reassign / unallocate: managers only. */
export function canAllocate(user: User): boolean {
  return isManager(user);
}

export function assignedRepOf(lead: LeadLike): UserRef | null {
  if ('allocation' in lead && lead.allocation) return lead.allocation.current?.rep ?? null;
  if ('assignedRep' in lead) return lead.assignedRep ?? null;
  return null;
}

/** Notes, activities, checked/serviced, overrides, custom tags and fields. */
export function canWrite(user: User, lead: LeadLike | null | undefined): boolean {
  if (!user || !lead) return false;
  if ('permissions' in lead && lead.permissions) return lead.permissions.canWrite;
  if ('canWrite' in lead && typeof lead.canWrite === 'boolean') return lead.canWrite;
  if (isManager(user)) return true;
  return assignedRepOf(lead)?.id === user.id;
}

export function isMine(user: User, lead: LeadLike | null | undefined): boolean {
  return !!user && !!lead && assignedRepOf(lead)?.id === user.id;
}

export function isUnallocated(lead: LeadLike | null | undefined): boolean {
  return !!lead && assignedRepOf(lead) === null;
}

/** Why a write control is disabled, for a tooltip; null when the user can write. */
export function readOnlyReason(user: User, lead: LeadLike | null | undefined): string | null {
  if (canWrite(user, lead)) return null;
  if (!lead) return null;
  if (isUnallocated(lead)) return 'Unallocated lead: view only until a manager assigns it to you.';
  return 'Allocated to another rep: view only.';
}
