import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

export interface CheckboxProps {
  checked: boolean;
  /** Mixed state (some rows selected); shown only while unchecked. */
  indeterminate?: boolean;
  /** shiftKey: for range selection. */
  onChange: (checked: boolean, shiftKey: boolean) => void;
  /** Accessible name (row checkboxes have no visible label). */
  label: string;
  className?: string;
  disabled?: boolean;
}

/** Native checkbox with the tri-state wired up; clicks don't bubble to clickable rows. */
export function Checkbox({ checked, indeterminate, onChange, label, className, disabled }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      // Handled on click (not change) to read the Shift key for range selection.
      onClick={(e) => {
        e.stopPropagation();
        onChange((e.target as HTMLInputElement).checked, e.shiftKey);
      }}
      onChange={() => {}}
      className={cn('size-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent disabled:cursor-not-allowed', className)}
    />
  );
}
