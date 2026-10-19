// Small building blocks shared by the dashboard cards.
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, ErrorState, Skeleton } from '@/components/ui';
import { errorMessage } from '@/api/errors';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { SalesStage } from './api';
import { STAGE_LABELS } from './sales';
import './dashboard.css';

export function StagePill({ stage, size = 'md', className }: { stage: SalesStage | null | undefined; size?: 'sm' | 'md'; className?: string }) {
  if (!stage) return null;
  return (
    <span
      data-stage={stage}
      className={cn(
        'lm-stage lm-stage-pill inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-2.5 text-[11px]' : 'h-6 px-3 text-xs',
        className,
      )}
    >
      <span className="lm-stage-dot size-1.5 rounded-full" aria-hidden />
      {STAGE_LABELS[stage]}
    </span>
  );
}

/** A card's coloured top bar (theme tokens), so each summary card reads at a glance. */
const SECTION_ACCENT = {
  blue: 'border-t-4 border-t-accent',
  roof: 'border-t-4 border-t-roof',
  green: 'border-t-4 border-t-stage-won-fill',
  violet: 'border-t-4 border-t-stage-interested-fill',
  amber: 'border-t-4 border-t-stage-contacted-fill',
  sky: 'border-t-4 border-t-sky',
  teal: 'border-t-4 border-t-info',
} as const;
export type SectionAccent = keyof typeof SECTION_ACCENT;

export function Section({
  title, description, action, children, className, bodyClassName, id, accent,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  accent?: SectionAccent;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <Card className={cn('flex min-w-0 flex-col', accent && SECTION_ACCENT[accent], className)} aria-labelledby={headingId} role={id ? 'region' : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[15px] leading-tight font-semibold text-fg">{title}</h2>
          {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2.5 text-sm">{action}</div>}
      </div>
      <div className={cn('flex-1 px-4 pt-3.5 pb-5 sm:px-6 sm:pt-4 sm:pb-6', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function MoreLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn('inline-flex items-center gap-0.5 text-sm font-medium text-accent hover:underline', className)}>
      {children}
      <ChevronRight className="size-3.5" aria-hidden />
    </Link>
  );
}

/** A horizontal meter; `value` and `max` in the same unit. */
export function Meter({
  value, max, className, tone = 'accent', label, marker,
}: { value: number; max: number; className?: string; tone?: 'accent' | 'success' | 'muted'; label: string; marker?: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const markerPct = marker !== undefined && max > 0 ? Math.min(100, (marker / max) * 100) : null;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className={cn('relative h-2 overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tone === 'success' ? 'bg-success' : tone === 'muted' ? 'bg-border-strong' : 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
      {markerPct !== null && markerPct > 0 && markerPct < 100 && (
        <span className="absolute inset-y-0 w-0.5 bg-fg/50" style={{ left: `${markerPct}%` }} aria-hidden />
      )}
    </div>
  );
}

/** CountLink tiles: a tinted tile and coloured number per tone (danger is the roof-tile "act now" colour). */
const COUNT_TONE = {
  danger: { tile: 'border-roof/30 bg-roof-soft hover:border-roof/60', value: 'text-roof' },
  warning: { tile: 'border-warning/30 bg-warning-soft hover:border-warning/60', value: 'text-warning' },
  accent: { tile: 'border-accent/25 bg-accent-soft hover:border-accent/50', value: 'text-accent' },
} as const;

/** A labelled number that links to the leads behind it. */
export function CountLink({
  to, value, label, hint, tone = 'default', className,
}: { to: string; value: number; label: ReactNode; hint?: ReactNode; tone?: 'default' | 'danger' | 'warning' | 'accent' | 'muted'; className?: string }) {
  // Tinted only when there is something to act on; an empty tile stays plain.
  const colour = value > 0 && tone in COUNT_TONE ? COUNT_TONE[tone as keyof typeof COUNT_TONE] : null;
  return (
    <Link
      to={to}
      className={cn(
        'group flex min-w-0 flex-col rounded-lg border px-3.5 py-3 transition-colors',
        colour ? colour.tile : 'border-border bg-surface hover:border-border-strong hover:bg-hover',
        className,
      )}
    >
      <span className={cn('text-2xl leading-none font-semibold tabular-nums', colour ? colour.value : tone === 'muted' ? 'text-muted' : 'text-fg')}>
        {formatNumber(value)}
      </span>
      <span className="mt-2 truncate text-sm font-medium text-fg group-hover:text-accent" title={typeof label === 'string' ? label : undefined}>{label}</span>
      {hint && <span className="mt-0.5 truncate text-xs text-muted">{hint}</span>}
    </Link>
  );
}

export function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-7 w-24" />
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cn('h-3', i % 2 ? 'w-2/3' : 'w-full')} />)}
    </div>
  );
}

export function CardError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <ErrorState message={errorMessage(error)} onRetry={onRetry} />;
}

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
