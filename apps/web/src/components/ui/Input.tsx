import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const fieldClasses = (invalid?: boolean, className?: string) =>
  cn(
    'w-full rounded-lg border bg-surface text-sm text-fg placeholder:text-subtle shadow-sm transition-colors',
    'focus:outline-none focus:ring-[3px] focus:ring-accent/35 focus:border-focus',
    'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted',
    invalid ? 'border-danger' : 'border-border hover:border-border-strong',
    className,
  );

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md';
  ref?: Ref<HTMLInputElement>;
}

export function Input({ leftIcon, rightSlot, invalid, inputSize = 'md', className, ...rest }: InputProps) {
  return (
    <div className={cn('relative flex items-center', className)}>
      {leftIcon && (
        <span className="pointer-events-none absolute left-3 text-subtle [&_svg]:size-4" aria-hidden="true">{leftIcon}</span>
      )}
      <input
        aria-invalid={invalid || undefined}
        className={fieldClasses(invalid, cn(inputSize === 'sm' ? 'h-8 px-3' : 'h-10 px-3.5', !!leftIcon && (inputSize === 'sm' ? 'pl-8' : 'pl-9'), !!rightSlot && 'pr-9'))}
        {...rest}
      />
      {rightSlot && <span className="absolute right-1.5 flex items-center">{rightSlot}</span>}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, rows = 3, ...rest }: TextareaProps) {
  return <textarea rows={rows} aria-invalid={invalid || undefined} className={fieldClasses(invalid, cn('px-3.5 py-2.5', className))} {...rest} />;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Renders the control with the generated id wired to the label/hint/error. */
  children: (props: { id: string; 'aria-describedby'?: string; invalid: boolean }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error, accessible by construction. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
      {children({ id, 'aria-describedby': describedBy, invalid: !!error })}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-subtle">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </div>
  );
}
