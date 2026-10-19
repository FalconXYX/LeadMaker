import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-2xl border border-border/80 bg-surface shadow-sm', className)} {...rest} />;
}

export function CardHeader({
  title, description, actions, className, titleAs: Title = 'h2',
}: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; titleAs?: 'h2' | 'h3' }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-divider px-5 py-4 sm:px-6 sm:py-5', className)}>
      <div className="min-w-0">
        <Title className="truncate text-base font-semibold text-fg">{title}</Title>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 sm:p-6', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-end gap-2.5 rounded-b-2xl border-t border-divider bg-surface-2 px-5 py-3.5 sm:px-6 sm:py-4', className)} {...rest} />;
}
