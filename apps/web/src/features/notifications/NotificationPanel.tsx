import { BellOff, Check, CheckCheck, Settings, X } from 'lucide-react';
import { useMemo } from 'react';
import { NotFoundError } from '@/api/errors';
import { useNotifications } from '@/api/queries';
import { Button, EmptyState, ErrorState, IconButton, Skeleton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { metaFor, titleFor } from './meta';
import { itemsOf, type NotificationItem } from './types';

interface NotificationPanelProps {
  unreadOnly: boolean;
  onUnreadOnlyChange: (v: boolean) => void;
  unreadCount: number;
  onOpenItem: (n: NotificationItem) => void;
  onMarkRead: (n: NotificationItem) => void;
  onMarkAllRead: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
  headingId: string;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The list inside the bell's popover: All / Unread, grouped Today / Earlier, Load more. */
export function NotificationPanel(props: NotificationPanelProps) {
  const { unreadOnly, onUnreadOnlyChange, unreadCount, onOpenItem, onMarkRead, onMarkAllRead, onOpenSettings, onClose, headingId } = props;
  const list = useNotifications({ unreadOnly, limit: 20 });
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap(itemsOf).filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
  }, [list.data]);
  const today = startOfToday();
  const groups = [
    { label: 'Today', items: items.filter((n) => Date.parse(n.updatedAt) >= today) },
    { label: 'Earlier', items: items.filter((n) => !(Date.parse(n.updatedAt) >= today)) },
  ].filter((g) => g.items.length);

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border px-5 pt-3.5 pb-3">
        <h2 id={headingId} className="text-base font-semibold text-fg">Notifications</h2>
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<CheckCheck className="size-3.5" aria-hidden />}
            onClick={onMarkAllRead}
            disabled={unreadCount === 0}
          >
            Mark all read
          </Button>
          <IconButton label="Notification settings" icon={<Settings />} size="sm" onClick={onOpenSettings} />
          <IconButton label="Close notifications" icon={<X />} size="sm" onClick={onClose} className="sm:hidden" />
        </div>
      </div>

      <div className="flex gap-1.5 border-b border-border px-5 py-2.5" role="group" aria-label="Show">
        {[
          { v: false, label: 'All' },
          { v: true, label: 'Unread', count: unreadCount },
        ].map((t) => (
          <button
            key={t.label}
            type="button"
            aria-pressed={unreadOnly === t.v}
            onClick={() => onUnreadOnlyChange(t.v)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
              unreadOnly === t.v ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {t.label}
            {!!t.count && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-4 text-accent-fg tabular">{t.count > 99 ? '99+' : t.count}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.isLoading ? (
          <ul aria-busy="true" aria-label="Loading notifications">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex gap-3 px-5 py-3.5">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5 pt-0.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-full" /><Skeleton className="h-2.5 w-16" /></div>
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <ErrorState
            message={list.error instanceof NotFoundError ? 'Notifications aren’t available on this server yet.' : 'Check your connection and try again.'}
            onRetry={() => void list.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<BellOff />}
            title={unreadOnly ? 'You’re all caught up' : 'No notifications yet'}
            description={unreadOnly ? 'Nothing unread. New allocations, storm alerts and notes show up here.' : 'New allocations, storm alerts and manager notes will show up here.'}
            action={unreadOnly && items.length === 0 ? <Button size="sm" variant="ghost" onClick={() => onUnreadOnlyChange(false)}>Show all</Button> : undefined}
          />
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3 className="sticky top-0 z-10 bg-surface/95 px-5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase backdrop-blur">{g.label}</h3>
                <ul>
                  {g.items.map((n) => <Row key={n.id} n={n} onOpen={() => onOpenItem(n)} onMarkRead={() => onMarkRead(n)} />)}
                </ul>
              </section>
            ))}
            <div className="px-5 py-3.5 text-center">
              {list.hasNextPage ? (
                <Button size="sm" variant="secondary" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} className="w-full">
                  Load more
                </Button>
              ) : (
                <p className="text-xs text-subtle">That’s everything{unreadOnly ? ' unread' : ''}.</p>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Row({ n, onOpen, onMarkRead }: { n: NotificationItem; onOpen: () => void; onMarkRead: () => void }) {
  const meta = metaFor(n);
  const Icon = meta.icon;
  const unread = !n.readAt;
  const title = titleFor(n);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/50',
          unread && 'bg-accent-soft/50',
        )}
      >
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', meta.tone)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 pr-5">
          {unread && <><span className="sr-only">Unread:</span>{' '}</>}
          <span className={cn('block text-sm leading-snug text-fg', unread ? 'font-semibold' : 'font-medium')}>{title}</span>{' '}
          {n.body && <><span className="mt-0.5 line-clamp-2 block text-sm leading-snug text-muted">{n.body}</span>{' '}</>}
          <span className="mt-1.5 flex items-center gap-1.5 text-xs text-subtle">
            <Tooltip content={formatDateTime(n.updatedAt)} describe={false}><time dateTime={n.updatedAt}>{formatRelative(n.updatedAt)}</time></Tooltip>{' '}
            <span aria-hidden="true">·</span>{' '}
            <span>{meta.label}</span>
          </span>
        </span>
      </button>
      {unread && (
        <>
          <span className="pointer-events-none absolute top-4.5 right-5 size-2 rounded-full bg-accent group-focus-within:opacity-0 group-hover:opacity-0 max-sm:hidden" aria-hidden="true" />
          <Tooltip content="Mark as read" describe={false}>
            <button
              type="button"
              onClick={onMarkRead}
              aria-label={`Mark “${title}” as read`}
              className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-md text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100"
            >
              <Check className="size-4" aria-hidden />
            </button>
          </Tooltip>
        </>
      )}
    </li>
  );
}
