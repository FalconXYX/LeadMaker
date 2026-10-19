import { CircleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { STATUS_LABELS } from './lib';
import type { RunStatus } from './types';

const CHIP: Record<RunStatus, { variant: BadgeVariant; icon: ReactNode }> = {
  queued: { variant: 'neutral', icon: <Clock aria-hidden /> },
  running: { variant: 'info', icon: <LoaderCircle aria-hidden className="animate-spin" /> },
  succeeded: { variant: 'success', icon: <CircleCheck aria-hidden /> },
  failed: { variant: 'danger', icon: <CircleAlert aria-hidden /> },
};

export function StatusChip({ status, className }: { status: RunStatus; className?: string }) {
  const c = CHIP[status];
  return <Badge variant={c.variant} icon={c.icon} className={className}>{STATUS_LABELS[status]}</Badge>;
}

/** "3 hours ago", with the exact date and time on hover. */
export function When({ iso, fallback = '—', className }: { iso: string | null | undefined; fallback?: string; className?: string }) {
  if (!iso) return <span className={cn('text-subtle', className)}>{fallback}</span>;
  return <time dateTime={iso} title={formatDateTime(iso)} className={className}>{formatRelative(iso)}</time>;
}

/** A small labelled value on a phone card. */
export function CardStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Section title + subtitle (same look as the dashboard's sections). */
export function SectionHeading({ id, title, subtitle, action }: { id: string; title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 lg:mb-4">
      <div className="min-w-0">
        <h2 id={id} className="text-lg leading-tight font-semibold tracking-tight text-fg">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2.5 text-sm">{action}</div>}
    </div>
  );
}
