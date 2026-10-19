import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Accessible name when the label is only an icon. */
  ariaLabel?: string;
  /** Tooltip (defaults to ariaLabel for icon-only options). */
  title?: string;
  count?: number;
}

export interface SegmentedProps<V extends string> {
  /** null: nothing selected (e.g. a value chosen elsewhere); the first option stays tabbable. */
  value: V | null;
  onChange: (v: V) => void;
  options: readonly SegmentOption<V>[];
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  fullWidth?: boolean;
}

/** Single-choice button group with radiogroup semantics: arrow keys, Home and End move the choice. */
export function Segmented<V extends string>({
  value, onChange, options, label, size = 'md', className, fullWidth,
}: SegmentedProps<V>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const n = options.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0 : n - 1;
    onChange(options[next]!.value);
    requestAnimationFrame(() => ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus());
  };
  const activeIndex = options.findIndex((o) => o.value === value);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-surface-3 p-0.5',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const button = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            data-value={o.value}
            tabIndex={selected || (activeIndex < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-7 px-3 text-xs [&_svg]:size-3.5' : 'h-8 px-3.5 text-sm [&_svg]:size-4',
              fullWidth && 'flex-1',
              selected ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn('rounded-full px-1.5 text-xs tabular', selected ? 'bg-accent-soft text-accent' : 'bg-surface text-muted')}>
                {o.count}
              </span>
            )}
          </button>
        );
        const tip = o.title ?? (o.ariaLabel && typeof o.label !== 'string' ? o.ariaLabel : undefined);
        return tip ? <Tooltip key={o.value} content={tip} describe={tip !== o.ariaLabel}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
