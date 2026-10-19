import { AlertTriangle, CloudLightning, PencilLine, X } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import type { TimingBadge as TimingBadgeData } from '@/api/types';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { SEGMENT_LABELS, STAGE_LABELS, isSalesStage, isSegment, readableWeatherText, type Segment } from '@/lib/labels';
import { Tooltip } from './Tooltip';

export type BadgeVariant =
  | 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'hot'
  | 'system' | 'custom' | 'edited' | 'source-changed' | 'new'
  | 'timing-high' | 'timing-medium' | 'timing-low' | 'timing-info'
  | 'seg-strategic' | 'seg-growth' | 'seg-emerging' | 'seg-long-tail'
  | 'stage-new' | 'stage-contacted' | 'stage-interested' | 'stage-quoting' | 'stage-won' | 'stage-lost';

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-3 text-fg border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  /** Hot / high-priority lead: roof-tile. */
  hot: 'bg-roof-soft text-roof border-roof/30',
  /** Pipeline-derived tag: quiet, outlined. */
  system: 'bg-surface-2 text-fg border-border',
  /** Rep-created tag: filled with the accent so it reads as "yours". */
  custom: 'bg-accent-soft text-accent border-accent/25',
  edited: 'bg-surface-2 text-muted border-dashed border-border-strong',
  'source-changed': 'bg-warning-soft text-warning border-warning/30',
  new: 'bg-info-soft text-info border-info/30',
  'timing-high': 'bg-timing-high-soft text-timing-high border-timing-high/30',
  'timing-medium': 'bg-timing-medium-soft text-timing-medium border-timing-medium/30',
  'timing-low': 'bg-timing-low-soft text-timing-low border-timing-low/30',
  'timing-info': 'bg-timing-info-soft text-timing-info border-timing-info/30',
  'seg-strategic': 'bg-seg-strategic-soft text-seg-strategic border-seg-strategic/25',
  'seg-growth': 'bg-seg-growth-soft text-seg-growth border-seg-growth/25',
  'seg-emerging': 'bg-seg-emerging-soft text-seg-emerging border-seg-emerging/25',
  'seg-long-tail': 'bg-seg-long-tail-soft text-seg-long-tail border-seg-long-tail/25',
  'stage-new': 'bg-stage-new-soft text-stage-new border-stage-new/25',
  'stage-contacted': 'bg-stage-contacted-soft text-stage-contacted border-stage-contacted/25',
  'stage-interested': 'bg-stage-interested-soft text-stage-interested border-stage-interested/25',
  'stage-quoting': 'bg-stage-quoting-soft text-stage-quoting border-stage-quoting/25',
  'stage-won': 'bg-stage-won-soft text-stage-won border-stage-won/25',
  'stage-lost': 'bg-stage-lost-soft text-stage-lost border-stage-lost/25',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  /** Hover / focus tooltip (also the accessible description). */
  tooltip?: ReactNode;
}

export function Badge({ variant = 'neutral', icon, size = 'sm', tooltip, className, children, ...rest }: BadgeProps) {
  const badge = (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border font-medium whitespace-nowrap [&_svg]:shrink-0',
        size === 'sm' ? 'h-[22px] px-2.5 text-xs [&_svg]:size-3' : 'h-7 px-3 text-sm [&_svg]:size-3.5',
        VARIANTS[variant], className,
      )}
      {...rest}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{badge}</Tooltip> : badge;
}

export const segmentVariant = (s: Segment): BadgeVariant => (s === 'long_tail' ? 'seg-long-tail' : `seg-${s}`);

/** Priority segment chip; renders nothing for unknown/null segments. */
export function SegmentBadge({ segment, className }: { segment: string | null | undefined; className?: string }) {
  if (!isSegment(segment)) return null;
  return <Badge variant={segmentVariant(segment)} className={className}>{SEGMENT_LABELS[segment]}</Badge>;
}

/** Sales stage chip (New, Contacted, ... Not a fit); renders nothing for an unknown stage. */
export function StageBadge({ stage, size, className }: { stage: string | null | undefined; size?: 'sm' | 'md'; className?: string }) {
  if (!isSalesStage(stage)) return null;
  return <Badge variant={`stage-${stage}`} size={size} className={className}>{STAGE_LABELS[stage]}</Badge>;
}

/** Weather/seasonality timing badge; the reason is the tooltip. */
export function TimingBadge({ badge, className }: { badge: Pick<TimingBadgeData, 'label' | 'reason' | 'severity'>; className?: string }) {
  return (
    <Badge variant={`timing-${badge.severity}`} icon={<CloudLightning aria-hidden />} tooltip={readableWeatherText(badge.reason)} className={className}>
      {badge.label}
    </Badge>
  );
}

export function SystemTagBadge({ label, reason, className }: { label: string; reason?: string; className?: string }) {
  return <Badge variant="system" tooltip={reason} className={className}>{label}</Badge>;
}

export function CustomTagBadge({ name, onRemove, className }: { name: string; onRemove?: () => void; className?: string }) {
  return (
    <Badge variant="custom" className={cn(!!onRemove && 'pr-0.5', className)}>
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove tag ${name}`}
          className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-accent/25"
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </Badge>
  );
}

/** "Edited" marker on a rep-overridden field. */
export function EditedBadge({ by, at, className }: { by?: string | null; at?: string | null; className?: string }) {
  const title = by ? `Edited by ${by}${at ? ` ${formatRelative(at)}` : ''}` : 'Edited by a rep';
  return <Badge variant="edited" icon={<PencilLine aria-hidden />} tooltip={title} className={className}>Edited</Badge>;
}

/** The scraped value changed after a rep's edit. */
export function SourceChangedBadge({ scraped, className }: { scraped?: string | null; className?: string }) {
  const title = scraped != null ? `Source now says: ${scraped}` : 'The source changed after this was edited';
  return (
    <Badge variant="source-changed" icon={<AlertTriangle aria-hidden />} tooltip={title} className={className}>
      Source changed
    </Badge>
  );
}

/** Changed in the most recent pipeline poll. */
export function UpdatedBadge({ className }: { className?: string }) {
  return <Badge variant="new" tooltip="New or changed in the latest pipeline run" className={className}>Updated</Badge>;
}
