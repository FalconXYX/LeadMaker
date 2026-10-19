import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { Tooltip } from './Tooltip';

export interface PillProps {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** A colour dot (token class, e.g. 'bg-seg-growth') shown while not pressed. */
  dotClassName?: string;
  /** Tooltip, e.g. the full label when it may truncate. */
  title?: string;
  /** Matching-lead count shown after the label (facet counts). */
  count?: number;
  disabled?: boolean;
}

/** Multi-select filter chip (aria-pressed). */
export function Pill({ pressed, onToggle, children, dotClassName, title, count, disabled }: PillProps) {
  const pill = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={count !== undefined && typeof children === 'string' ? `${children}, ${formatNumber(count)} ${count === 1 ? 'lead' : 'leads'}` : undefined}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        pressed
          ? 'border-accent bg-accent-soft text-fg'
          : 'border-border bg-surface text-fg hover:border-border-strong hover:bg-hover',
      )}
    >
      {pressed ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden /> : dotClassName ? <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dotClassName)} /> : null}
      <span className="truncate">{children}</span>
      {count !== undefined && (
        <span aria-hidden className={cn('shrink-0 text-xs tabular', pressed ? 'text-accent' : 'text-muted')}>{formatNumber(count)}</span>
      )}
    </button>
  );
  return title ? <Tooltip content={title} describe={false}>{pill}</Tooltip> : pill;
}
