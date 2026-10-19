import { describe, expect, it } from 'vitest';
import { canAllocate, canWrite, readOnlyReason } from '@/auth/permissions';

const rep = { id: 'r1', role: 'rep' as const };
const manager = { id: 'm1', role: 'manager' as const };

describe('permissions', () => {
  it('prefers the server flag, then falls back to the allocation rule', () => {
    expect(canWrite(rep, { canWrite: false, assignedRep: { id: 'r1', name: 'Me' } })).toBe(false);
    expect(canWrite(rep, { assignedRep: { id: 'r1', name: 'Me' } })).toBe(true);
    expect(canWrite(rep, { assignedRep: { id: 'r2', name: 'Other' } })).toBe(false);
    expect(canWrite(rep, { assignedRep: null })).toBe(false);
    expect(canWrite(manager, { assignedRep: null })).toBe(true);
    expect(canWrite(null, { assignedRep: null })).toBe(false);
  });

  it('uses LeadProfile.permissions when present', () => {
    const profile = { permissions: { canWrite: true, canAllocate: false }, allocation: { current: null, history: [] } };
    expect(canWrite(rep, profile)).toBe(true);
  });

  it('explains read-only leads and gates allocation to managers', () => {
    expect(readOnlyReason(rep, { assignedRep: null })).toMatch(/Unallocated/);
    expect(readOnlyReason(rep, { assignedRep: { id: 'r1', name: 'Me' } })).toBeNull();
    expect(canAllocate(rep)).toBe(false);
    expect(canAllocate(manager)).toBe(true);
  });
});
