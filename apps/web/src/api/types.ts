// Type-only bridge to packages/shared (erased at build time: no runtime dependency on the workspace).
// Every response shape comes from there (packages/shared/src/types.ts); only web-side shapes live here.
export type * from '@shared/types.ts';
export type { LeadFilter, LeadScope, SortField, CustomFieldCondition } from '@shared/filter.ts';
export type { EventType, LeadEvent, EventPayload, ActorType } from '@shared/events.ts';
export type { Role } from '@shared/visibility.ts';
// Named for discoverability (the star export above already carries them): saved views, preferences, config,
// bulk unallocate, tag rename/delete, the activity ?type= values, and notification.created's title/body/actor_name.
export type {
  SavedView, SavedViewsResponse, SavedViewCreate, SavedViewUpdate, SavedViewWritten, SavedViewDeleted,
  UserPreferences, UserPreferencesUpdate, ConfigResponse, BulkUnallocateResult, CustomTagUpdated, CustomTagDeleted,
  TagLeadVersion, ActivityType, NotificationCreatedPayload,
} from '@shared/types.ts';

import type { Role } from '@shared/visibility.ts';
import type { ActivityType, Notification, UserListItem } from '@shared/types.ts';

/** Runtime copy of the shared ACTIVITY_TYPES (the shared package is type-only here); the check fails the typecheck on drift. */
export const ACTIVITY_TYPES = [
  'note', 'call', 'email', 'visit', 'checked', 'serviced', 'override', 'contact', 'allocation', 'custom_tag',
  'custom_field', 'scraped_change', 'stage_changed', 'task_created', 'task_completed', 'task_updated', 'task_deleted',
] as const satisfies readonly ActivityType[];
type MissingActivityType = Exclude<ActivityType, (typeof ACTIVITY_TYPES)[number]>;
const activityTypesExhaustive: MissingActivityType extends never ? true : MissingActivityType = true;
void activityTypesExhaustive;

/** POST /auth/dev-login and GET /api/me. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface DevLoginResponse {
  token: string;
  user: SessionUser;
}

export interface UsersResponse {
  items: UserListItem[];
}

/** POST /api/leads/:id/contacts body. */
export interface ContactInput {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  role?: string;
}

/** One in-app notification (the shared `Notification`, renamed so it never shadows the DOM's). */
export type AppNotification = Notification;

/** POST /api/notifications/read body. */
export type MarkNotificationsRead = { ids: string[] } | { all: true };
