// Notification writes with optimistic cache updates, so the badge and list react instantly.
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { MarkNotificationsRead, NotificationPreferences, NotificationsPage } from '@/api/types';
import { useToast } from '@/components/ui';
import type { NotificationType } from './types';

type Pages = InfiniteData<NotificationsPage, unknown>;

/** Every cached notification list (all / unread-only). */
export const NOTIFICATION_LISTS = ['notifications', 'list'] as const;

function patchLists(qc: QueryClient, fn: (data: Pages) => Pages) {
  for (const [key, data] of qc.getQueriesData<Pages>({ queryKey: NOTIFICATION_LISTS })) {
    if (data?.pages) qc.setQueryData<Pages>(key, fn(data));
  }
}

/** The unread count the server last reported (first page of the "all" list). */
export function unreadCountOf(data: Pages | undefined): number {
  const n = data?.pages?.[0]?.unreadCount;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/** Optimistically counts a just-created notification as unread when it is not in the list yet. */
export function bumpUnread(qc: QueryClient, notificationId: string) {
  const all = qc.getQueryData<Pages>(qk.notifications.list(false));
  const known = all?.pages?.some((p) => (p.items ?? []).some((n) => n.id === notificationId && !n.readAt));
  if (known || !all) return;
  patchLists(qc, (d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, unreadCount: (p.unreadCount ?? 0) + 1 })) }));
}

export function useMarkRead() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: MarkNotificationsRead) => ep.markNotificationsRead(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: NOTIFICATION_LISTS });
      const snapshot = qc.getQueriesData<Pages>({ queryKey: NOTIFICATION_LISTS });
      const now = new Date().toISOString();
      const ids = 'ids' in body ? new Set(body.ids) : null;
      // How many of these were unread (each id once, wherever it is cached).
      const unread = new Set<string>();
      for (const [, data] of snapshot) {
        for (const p of data?.pages ?? []) for (const n of p.items ?? []) if (!n.readAt && (!ids || ids.has(n.id))) unread.add(n.id);
      }
      patchLists(qc, (d) => ({
        ...d,
        pages: d.pages.map((p) => ({
          ...p,
          unreadCount: ids ? Math.max(0, (p.unreadCount ?? 0) - unread.size) : 0,
          items: (p.items ?? []).map((n) => (!n.readAt && (!ids || ids.has(n.id)) ? { ...n, readAt: now } : n)),
        })),
      }));
      return { snapshot };
    },
    onSuccess: (res) => {
      // The server's count wins (another tab may have read more).
      if (typeof res?.unreadCount === 'number') {
        const count = res.unreadCount;
        patchLists(qc, (d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, unreadCount: count })) }));
      }
    },
    onError: (e, _body, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      toast.error(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFICATION_LISTS }),
  });
}

/** Saves one preference at a time (PUT accepts a subset), optimistically. */
export function useSavePreference() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationKey: [...qk.notifications.preferences, 'save'],
    mutationFn: ({ type, enabled }: { type: NotificationType; enabled: boolean }) =>
      ep.putNotificationPreferences([{ type, enabled }]),
    onMutate: async ({ type, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.notifications.preferences });
      const prev = qc.getQueryData<NotificationPreferences>(qk.notifications.preferences);
      const items = (prev?.items ?? []).filter((i) => i.type !== type);
      qc.setQueryData<NotificationPreferences>(qk.notifications.preferences, { items: [...items, { type, enabled }] });
      return { prev };
    },
    onSuccess: (res) => {
      // With several toggles in flight, the last response settles the cache (earlier ones lack later changes).
      const last = qc.isMutating({ mutationKey: [...qk.notifications.preferences, 'save'] }) <= 1;
      if (last && Array.isArray(res?.items)) qc.setQueryData(qk.notifications.preferences, res);
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(qk.notifications.preferences, ctx?.prev);
      toast.error(e);
    },
  });
}
