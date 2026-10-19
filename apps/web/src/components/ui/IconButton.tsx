import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: the accessible name (also shown as a tooltip). */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary';
  size?: 'sm' | 'md';
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon, variant = 'ghost', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <Tooltip content={label} describe={false}>
      <button
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:text-fg',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          variant === 'ghost' ? 'hover:bg-hover' : 'border border-border bg-surface hover:border-border-strong hover:bg-hover shadow-sm',
          size === 'sm' ? 'size-8 [&_svg]:size-4' : 'size-10 [&_svg]:size-[18px]',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
