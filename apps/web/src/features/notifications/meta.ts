import {
  AlarmClock, ArrowRightLeft, Bell, CircleCheck, CircleX, ClipboardList, CloudLightning, Inbox, MessageSquareText,
  RefreshCcwDot, UserPlus, type LucideIcon,
} from 'lucide-react';
import type { Role } from '@/api/types';
import { leadsHref } from '@/lib/filterUrl';
import type { NotificationItem, NotificationType } from './types';

interface TypeMeta {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Icon chip colours (tokens only). */
  tone: string;
  /** Who can receive it (the preferences dialog only lists these). */
  roles: Role[];
}

export const TYPE_META: Record<NotificationType, TypeMeta> = {
  allocated: {
    label: 'Leads assigned to you',
    description: 'A manager gives you new leads. Several in a row are grouped into one notification.',
    icon: UserPlus,
    tone: 'bg-accent-soft text-accent',
    roles: ['rep'],
  },
  reassigned_away: {
    label: 'Leads moved away from you',
    description: 'One of your leads goes to another rep or back to the unallocated pool.',
    icon: ArrowRightLeft,
    tone: 'bg-warning-soft text-warning',
    roles: ['rep'],
  },
  manager_note: {
    label: 'Manager notes',
    description: 'A manager leaves a note on one of your leads.',
    icon: MessageSquareText,
    tone: 'bg-info-soft text-info',
    roles: ['rep'],
  },
  storm_alert: {
    label: 'Storm alerts',
    description: 'The National Weather Service issues an alert for a county where you have leads.',
    icon: CloudLightning,
    tone: 'bg-timing-high-soft text-timing-high',
    roles: ['rep', 'manager'],
  },
  pool_grew: {
    label: 'New leads in the pool',
    description: 'A pipeline run adds unallocated leads that are ready to assign.',
    icon: Inbox,
    tone: 'bg-success-soft text-success',
    roles: ['manager'],
  },
  source_changed: {
    label: 'Source changed after your edit',
    description: 'The pipeline finds a new value for a field you corrected by hand.',
    icon: RefreshCcwDot,
    tone: 'bg-warning-soft text-warning',
    roles: ['rep', 'manager'],
  },
  refresh_done: {
    label: 'Area refresh finished',
    description: 'An on-demand refresh you started completes, with its new and changed leads.',
    icon: CircleCheck,
    tone: 'bg-success-soft text-success',
    roles: ['rep', 'manager'],
  },
  refresh_failed: {
    label: 'Area refresh failed',
    description: 'An on-demand refresh you started could not finish. You can start it again.',
    icon: CircleX,
    tone: 'bg-danger-soft text-danger',
    roles: ['rep', 'manager'],
  },
  task_assigned: {
    label: 'Follow-ups assigned to you',
    description: 'Someone else gives you a follow-up on a lead. Several in a row are grouped into one notification.',
    icon: ClipboardList,
    tone: 'bg-accent-soft text-accent',
    roles: ['rep', 'manager'],
  },
  task_due: {
    label: 'Follow-ups due',
    description: 'One of your follow-ups comes due.',
    icon: AlarmClock,
    tone: 'bg-warning-soft text-warning',
    roles: ['rep', 'manager'],
  },
};

const FALLBACK: TypeMeta = { label: 'Notification', description: '', icon: Bell, tone: 'bg-surface-3 text-muted', roles: ['rep', 'manager'] };

export function metaFor(n: Pick<NotificationItem, 'type' | 'data'>): TypeMeta {
  const m = (TYPE_META as Record<string, TypeMeta>)[n.type] ?? FALLBACK;
  if (n.type === 'refresh_done' && n.data?.status === 'failed') return { ...m, icon: CircleX, tone: 'bg-danger-soft text-danger' };
  return m;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The server renders titles; this covers rows without one (and old rows). */
export function titleFor(n: NotificationItem): string {
  if (n.title) return n.title;
  switch (n.type) {
    case 'allocated': return n.count === 1 ? 'New lead allocated to you' : `${n.count} new leads allocated to you`;
    case 'reassigned_away': return n.count === 1 ? 'A lead was reassigned away from you' : `${n.count} leads were reassigned away from you`;
    case 'pool_grew': return `${plural(n.count, 'new lead')} in the unallocated pool`;
    case 'storm_alert': return typeof n.data.event === 'string' ? n.data.event : 'Weather alert';
    case 'manager_note': return 'New manager note';
    case 'source_changed': return 'The source changed a field you edited';
    case 'refresh_done': return 'Refresh finished';
    case 'refresh_failed': return 'Refresh failed';
    case 'task_assigned': return n.count === 1 ? 'A follow-up was assigned to you' : `${n.count} follow-ups assigned to you`;
    case 'task_due': return typeof n.data.title === 'string' ? `Follow-up due: ${n.data.title}` : 'Follow-up due';
    default: return 'Notification';
  }
}

/** Where a click goes: the lead, the list of leads it is about, or the dashboard for weather. */
export function hrefFor(n: NotificationItem, role: Role): string {
  const lead = n.companyId ? `/leads/${n.companyId}` : null;
  switch (n.type) {
    case 'allocated':
      return n.count === 1 && lead ? lead : leadsHref({ scope: 'mine', sort: { by: 'last_change', dir: 'desc' } });
    case 'reassigned_away':
      return n.count === 1 && lead ? lead : leadsHref({ scope: 'mine' });
    case 'manager_note':
    case 'source_changed':
      return lead ?? '/leads';
    case 'pool_grew':
      return role === 'manager' ? '/allocation?new=1' : leadsHref({ scope: 'unallocated' });
    case 'refresh_done':
    case 'refresh_failed': {
      const zip = typeof n.data.postal_code === 'string' && /^\d{5}$/.test(n.data.postal_code) ? n.data.postal_code : null;
      const radius = typeof n.data.radius_miles === 'number' && n.data.radius_miles > 0 ? Math.min(250, n.data.radius_miles) : 10;
      return zip ? leadsHref({ near: { zip, radiusMiles: radius }, sort: { by: 'last_change', dir: 'desc' } }) : '/leads';
    }
    case 'task_assigned':
      return n.count === 1 && lead ? lead : '/tasks';
    case 'task_due':
      return lead ?? '/tasks';
    case 'storm_alert':
      // The dashboard shows active alerts with the affected leads; lists cannot filter by county yet.
      return '/';
    default:
      return lead ?? '/';
  }
}

/** Notification types a role can receive, in display order. */
export function typesFor(role: Role): NotificationType[] {
  const order: NotificationType[] = [
    'allocated', 'reassigned_away', 'task_assigned', 'task_due', 'manager_note', 'pool_grew', 'storm_alert', 'source_changed',
    'refresh_done', 'refresh_failed',
  ];
  return order.filter((t) => TYPE_META[t].roles.includes(role));
}
