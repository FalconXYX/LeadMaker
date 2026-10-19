import { createContext, use } from 'react';
import type { LeadProfile } from '@/api/types';
import type { LeadMutations } from './queries';

export interface ProfileContextValue {
  profile: LeadProfile;
  /** Server permission flag (LeadProfile.permissions.canWrite). */
  canEdit: boolean;
  /** Tooltip for disabled write controls; null when the user can write. */
  readOnlyReason: string | null;
  m: LeadMutations;
  meId: string | undefined;
  /** Briefly true after another user changed this part of the lead ('field:phone', 'contact:<id>', 'cf:<key>', 'tags', ...). */
  isHighlighted: (key: string) => boolean;
  /** Switch the left column to a tab (e.g. "See all contacts"). */
  openTab: (tab: string) => void;
}

export const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = use(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used inside the lead profile');
  return ctx;
}
