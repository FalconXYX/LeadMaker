// The latest touches in the book: the leads contacted most recently, each with its newest call, email, visit or note.
import { History, Mail, MapPin, Phone, StickyNote } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ActivityEntry } from '@/api/types';
import { EmptyState, Skeleton } from '@/components/ui';
import { formatRelative, humanize } from '@/lib/format';
import type { DashboardScope } from './api';
import { CardError, MoreLink, Section, StagePill } from './parts';
import type { RecentTouch } from './queries';
import { salesLeadsHref } from './sales';

const ICONS: Record<string, ReactNode> = {
  call: <Phone aria-hidden />,
  email: <Mail aria-hidden />,
  visit: <MapPin aria-hidden />,
  note: <StickyNote aria-hidden />,
};
const VERBS: Record<string, string> = { call: 'Called', email: 'Emailed', visit: 'Visited', note: 'Note on' };

function actor(entry: ActivityEntry | null, viewerId: string): string | null {
  if (!entry?.user) return null;
  return entry.user.id === viewerId ? null : entry.user.name;
}

export function RecentActivityCard({
  scope, items, isLoading, error, onRetry, viewerId, now, className,
}: {
  scope: DashboardScope;
  items: readonly RecentTouch[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  viewerId: string;
  now: number;
  className?: string;
}) {
  return (
    <Section
      title="Recent activity"
      description={scope === 'team' ? 'The team’s latest calls, emails and visits' : 'The latest calls, emails and visits'}
      className={className}
      accent="teal"
      action={<MoreLink to={salesLeadsHref(scope, { sort: { by: 'last_contacted', dir: 'desc' } })}>All</MoreLink>}
    >
      {isLoading ? (
        <ul className="space-y-4" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex gap-3"><Skeleton className="size-8 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></li>
          ))}
        </ul>
      ) : error && !items.length ? (
        <CardError error={error} onRetry={onRetry} />
      ) : !items.length ? (
        <EmptyState
          compact
          icon={<History />}
          title="No activity yet"
          description="Calls, emails and visits you log show up here. Start with a lead from today’s briefing."
        />
      ) : (
        <ol className="space-y-4">
          {items.map(({ lead, entry, isLoading: entryLoading }) => {
            const type = entry?.type ?? 'call';
            const who = actor(entry, viewerId);
            const text = entry?.text?.trim();
            return (
              <li key={lead.id} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent [&_svg]:size-4">
                  {ICONS[type] ?? <History aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="min-w-0 truncate text-fg">
                      {who && <span className="text-muted">{who.split(/\s+/)[0]} · </span>}
                      {entryLoading ? '' : `${VERBS[type] ?? humanize(type)} `}
                      <Link to={`/leads/${lead.id}`} className="font-semibold hover:text-accent hover:underline">{lead.businessName}</Link>
                    </span>
                    <StagePill stage={lead.salesStage} size="sm" className="ml-auto max-sm:hidden xl:max-2xl:hidden" />
                  </p>
                  <p className="truncate text-xs text-muted">
                    {formatRelative(entry?.createdAt ?? lead.lastContactedAt, now)}
                    {entry?.outcome && <> · {humanize(entry.outcome)}</>}
                    {text && <> · “{text}”</>}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
