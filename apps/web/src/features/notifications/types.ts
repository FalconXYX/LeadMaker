// Notification shapes come from packages/shared (services/notifier). This adds the runtime list of types
// (the shared package is type-only in the web app) and a defensive reader for list rows.
import type { AppNotification, NotificationCreatedPayload, NotificationPreferences, NotificationType, NotificationsPage } from '@/api/types';

export type { NotificationType };

/** Runtime copy of the shared NOTIFICATION_TYPES; the checks below fail the typecheck if they drift. */
export const NOTIFICATION_TYPES = [
  'allocated', 'reassigned_away', 'storm_alert', 'source_changed', 'refresh_done', 'refresh_failed', 'manager_note',
  'pool_grew', 'task_assigned', 'task_due',
] as const satisfies readonly NotificationType[];
type MissingType = Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]>;
const typesExhaustive: MissingType extends never ? true : MissingType = true;
void typesExhaustive;

export const isNotificationType = (v: unknown): v is NotificationType =>
  typeof v === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(v);

/** A list row; `type` stays open so a type added on the server still renders (with a generic icon). */
export interface NotificationItem extends Omit<AppNotification, 'type'> {
  type: NotificationType | (string & {});
}

export type NotificationCreated = NotificationCreatedPayload;
export type NotificationPreferenceItems = NotificationPreferences;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Fills gaps in a row (older rows, a partial cache entry) so rendering never breaks. */
export function toItem(n: AppNotification): NotificationItem {
  const r = n as AppNotification & Record<string, unknown>;
  const createdAt = str(r.createdAt) ?? new Date(0).toISOString();
  return {
    id: String(r.id),
    type: String(r.type),
    title: str(r.title) ?? '',
    body: str(r.body) ?? '',
    companyId: str(r.companyId),
    countyFips: str(r.countyFips),
    data: (typeof r.data === 'object' && r.data !== null ? r.data : {}) as Record<string, unknown>,
    count: typeof r.count === 'number' && r.count > 0 ? r.count : 1,
    createdAt,
    updatedAt: str(r.updatedAt) ?? createdAt,
    readAt: str(r.readAt),
  };
}

/**
 * A toastable item from a notification.created payload, or null when it lacks a title (older events: fetch the row).
 * It has no lead id or data, so a click should prefer the cached row.
 */
export function itemFromEvent(p: Partial<NotificationCreatedPayload>): NotificationItem | null {
  const title = str(p.title);
  if (!title || !str(p.notification_id)) return null;
  const now = new Date().toISOString();
  return {
    id: p.notification_id!,
    type: str(p.type) ?? 'notification',
    title,
    body: str(p.body) ?? '',
    companyId: null,
    countyFips: null,
    data: {},
    count: typeof p.count === 'number' && p.count > 0 ? p.count : 1,
    createdAt: now,
    updatedAt: now,
    readAt: null,
  };
}

export function itemsOf(page: NotificationsPage | undefined): NotificationItem[] {
  return Array.isArray(page?.items) ? page.items.map(toItem) : [];
}

export function prefsOf(raw: NotificationPreferences | undefined): Map<NotificationType, boolean> {
  const m = new Map<NotificationType, boolean>(NOTIFICATION_TYPES.map((t) => [t, true]));
  const items = (raw as { items?: unknown } | undefined)?.items;
  if (Array.isArray(items)) {
    for (const it of items as { type?: unknown; enabled?: unknown }[]) {
      if (isNotificationType(it?.type) && typeof it.enabled === 'boolean') m.set(it.type, it.enabled);
    }
  }
  return m;
}
