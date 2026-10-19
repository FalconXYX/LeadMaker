import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Every page starts with this: title, optional subtitle, actions on the right. */
export function PageHeader({
  title, description, actions, children, className,
}: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-7 flex flex-wrap items-end justify-between gap-4 lg:mb-8', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1.5 text-[15px] text-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

/** Standard page padding + max width: the full window up to a comfortable reading width. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-7 sm:px-8 lg:px-10 lg:py-10', wide ? 'max-w-[1680px]' : 'max-w-[1440px]', className)}>{children}</div>;
}
