import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import * as ep from '@/api/endpoints';
import { qk, useNotifications } from '@/api/queries';
import { useAuth } from '@/auth/AuthContext';
import { Tooltip, useFocusTrap, useToast } from '@/components/ui';
import { isOwnEvent } from '@/live/eventMap';
import { useLiveEvent, useLiveStatus } from '@/live/useEventStream';
import { cn } from '@/lib/cn';
import { hrefFor, titleFor } from './meta';
import { NotificationPanel } from './NotificationPanel';
import { PreferencesDialog } from './PreferencesDialog';
import { NOTIFICATION_LISTS, bumpUnread, unreadCountOf, useMarkRead } from './queries';
import { itemFromEvent, toItem, type NotificationCreated, type NotificationItem } from './types';
import type { NotificationsPage } from '@/api/types';

const FALLBACK_POLL_MS = 60_000;

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** The full row for a notification id from any cached list (it has the lead id and data a live event lacks). */
function cachedItem(qc: QueryClient, id: string): NotificationItem | null {
  for (const [, data] of qc.getQueriesData<InfiniteData<NotificationsPage, unknown>>({ queryKey: NOTIFICATION_LISTS })) {
    for (const page of data?.pages ?? []) {
      const raw = (page.items ?? []).find((x) => x.id === id);
      if (raw) return toItem(raw);
    }
  }
  return null;
}

/** Top-bar bell: unread badge, popover list (focus-trapped), live toasts and the preferences dialog. */
export function NotificationBell() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const panelId = useId();

  const list = useNotifications({ limit: 20, enabled: !!user });
  const unread = unreadCountOf(list.data);
  const markRead = useMarkRead();

  // ---- live: badge bump + toast with a View action ----------------------------------------
  const openRef = useRef(open);
  openRef.current = open;
  const openItem = useCallback((n: NotificationItem) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    setOpen(false);
    navigate(hrefFor(n, user?.role ?? 'rep'));
  }, [markRead, navigate, user?.role]);

  const showToast = useCallback((n: NotificationItem) => {
    if (openRef.current || document.visibilityState === 'hidden') {
      setAnnouncement(`New notification: ${titleFor(n)}`);
      return;
    }
    toast({
      id: `notification-${n.id}`,
      variant: n.type === 'storm_alert' ? 'warning' : 'info',
      title: titleFor(n),
      description: n.body || undefined,
      duration: n.type === 'storm_alert' ? 10_000 : 6_000,
      // The event has no lead id or data: by click time the list refetch (invalidated above) has the full row.
      action: { label: 'View', onClick: () => openItem(cachedItem(qc, n.id) ?? n) },
    });
  }, [toast, openItem, qc]);

  useLiveEvent('notification.created', (e) => {
    const p = e.payload as Partial<NotificationCreated>;
    if (!user || (p.user_id && p.user_id !== user.id) || isOwnEvent(e, user.id)) return;
    if (typeof p.notification_id === 'string') bumpUnread(qc, p.notification_id);
    void qc.invalidateQueries({ queryKey: qk.notifications.all });
    const id = p.notification_id;
    if (!id) return;
    // Newer events carry the title and body: toast straight away.
    const fromEvent = itemFromEvent(p);
    if (fromEvent) return showToast(fromEvent);
    // Older events carry ids only: fetch the row for its title.
    void ep.getNotifications({ limit: 10 }).then((page) => {
      const raw = (page?.items ?? []).find((x) => x.id === id);
      if (raw) showToast(toItem(raw));
    }, () => {});
  });

  // No live stream (offline, proxy without SSE): poll the unread count instead.
  const live = useLiveStatus();
  useEffect(() => {
    if (!user || live === 'open') return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: qk.notifications.list(false) });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [live, user, qc]);

  // A rising unread count pings the badge and is announced for screen readers (the badge is visual).
  const prevUnread = useRef(unread);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (unread > prevUnread.current && list.isFetched) {
      if (!open) setAnnouncement(`${unread} unread notification${unread === 1 ? '' : 's'}`);
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 2400);
      prevUnread.current = unread;
      return () => clearTimeout(t);
    }
    prevUnread.current = unread;
  }, [unread, open, list.isFetched]);

  // ---- popover plumbing ----------------------------------------------------------------------
  // Focus lands on the panel itself (announced by its heading); Tab moves through it and stays inside.
  useFocusTrap(panel, open);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 64, right: 16 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      if (r) setPos({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      // Clicks inside another dialog (the settings dialog opened from here) keep the panel open.
      if (t instanceof Element && t.closest('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!user) return null;
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <>
      <Tooltip content="Notifications" describe={false}>
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'relative inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg',
            open && 'bg-surface-2 text-fg',
          )}
        >
          <Bell className="size-[18px]" aria-hidden />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-danger-fg tabular ring-2 ring-topbar"
            >
              {pulse && <span className="absolute inset-0 animate-ping rounded-full bg-danger opacity-60" />}
              <span className="relative">{badgeText(unread)}</span>
            </span>
          )}
        </button>
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>

      {open && createPortal(
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          style={{ '--pop-top': `${pos.top}px`, '--pop-right': `${pos.right}px` } as CSSProperties}
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden bg-surface outline-none',
            // Phones: a sheet under the top bar. sm+: a popover anchored under the bell.
            'inset-x-0 top-14 bottom-0 border-t border-border',
            'sm:inset-x-auto sm:top-[var(--pop-top)] sm:right-[var(--pop-right)] sm:bottom-auto sm:max-h-[min(640px,calc(100vh-5rem))] sm:w-[400px] sm:rounded-xl sm:border sm:shadow-lg sm:animate-[lm-pop-in_120ms_ease-out]',
          )}
        >
          <NotificationPanel
            headingId={headingId}
            unreadOnly={unreadOnly}
            onUnreadOnlyChange={setUnreadOnly}
            unreadCount={unread}
            onOpenItem={openItem}
            onMarkRead={(n) => markRead.mutate({ ids: [n.id] })}
            onMarkAllRead={() => markRead.mutate({ all: true })}
            onOpenSettings={() => setPrefsOpen(true)}
            onClose={() => setOpen(false)}
          />
        </div>,
        document.body,
      )}

      <PreferencesDialog open={prefsOpen} onClose={() => setPrefsOpen(false)} role={user.role} />
    </>
  );
}
