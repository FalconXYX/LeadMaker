import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label; pass `aria-label` instead when the label is elsewhere. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
}

/** On/off switch (role="switch"); Space/Enter toggle it. */
export function Toggle({ checked, onCheckedChange, label, description, disabled, size = 'md', className, ...aria }: ToggleProps) {
  const id = useId();
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const thumb = size === 'sm' ? 'size-3 data-[on=true]:translate-x-3' : 'size-4 data-[on=true]:translate-x-4';
  return (
    <div className={cn('inline-flex items-start gap-2.5', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria['aria-label']}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-border-strong', track,
        )}
      >
        <span data-on={checked} className={cn('rounded-full bg-knob shadow-sm transition-transform', thumb)} />
      </button>
      {(label || description) && (
        <label htmlFor={id} className={cn('select-none', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
          {label && <span className="block text-sm text-fg">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}
