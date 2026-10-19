import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Usually one Button ("Clear filters"). */
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-2 p-7' : 'gap-2.5 px-8 py-16', className)}>
      {icon && (
        <div className="mb-1.5 flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent [&_svg]:size-5">{icon}</div>
      )}
      <p className="text-base font-semibold text-fg">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Inline error block with a retry, for failed queries. */
export function ErrorState({ message, onRetry, className }: { message: ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2.5 px-8 py-12 text-center', className)}>
      <p className="text-base font-semibold text-fg">Couldn’t load this</p>
      <p className="max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-1 text-sm font-medium text-accent hover:underline">Try again</button>
      )}
    </div>
  );
}
