import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle' | 'roof';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg font-semibold hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-border hover:border-border-strong hover:bg-hover shadow-sm',
  ghost: 'text-fg hover:bg-hover',
  subtle: 'bg-accent-soft text-accent hover:bg-accent/15',
  /** The warm roof-tile action: the main Call / Log call on a lead. */
  roof: 'bg-roof text-roof-fg font-semibold hover:bg-roof-hover shadow-sm',
  danger: 'bg-danger text-danger-fg font-semibold hover:brightness-110 shadow-sm',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3.5 text-sm gap-1.5 rounded-lg',
  md: 'h-10 px-4.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-6 text-base gap-2 rounded-xl',
};

export const buttonClasses = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) =>
  cn(
    'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none transition-colors',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
    VARIANTS[variant], SIZES[size], className,
  );

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary', size = 'md', loading, leftIcon, rightIcon, className, children, disabled, type = 'button', ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} label="Working" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}
