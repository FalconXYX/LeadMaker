import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** An active filter above a list ("Segment: Growth ×"); the same in the lead list and the allocation queue. */
export function FilterChip({
  facet, label, onRemove, icon, className,
}: { facet?: string; label: string; onRemove: () => void; icon?: ReactNode; className?: string }) {
  const name = facet ? `${facet}: ${label}` : label;
  return (
    <span className={cn('inline-flex h-8 max-w-[280px] items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft pr-1 pl-3.5 text-sm', className)}>
      {icon}
      {facet && <span className="shrink-0 text-muted">{facet}:</span>}
      <span className="truncate font-medium text-fg">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${name}`}
        className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-accent/30 hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/** "Clear all" after a row of filter chips. */
export function ClearFiltersButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('ml-1.5 h-8 rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft', className)}>
      Clear all
    </button>
  );
}
