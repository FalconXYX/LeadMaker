// Small building blocks shared by the profile sections.
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Card, Tooltip, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useProfile } from './context';

export function SectionCard({
  title, description, actions, children, className, bodyClassName, icon, id, highlightKey,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
  id?: string;
  highlightKey?: string;
}) {
  const autoId = useId();
  const headingId = id ? `${id}-heading` : `${autoId}-heading`;
  return (
    <Card className={cn('min-w-0', className)}>
      <section aria-labelledby={headingId} id={id}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && <span className="mt-0.5 text-muted [&_svg]:size-4" aria-hidden="true">{icon}</span>}
            <div className="min-w-0">
              <h2 id={headingId} className="text-sm font-semibold text-fg">{title}</h2>
              {description && <p className="mt-1 text-xs text-muted">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        <Highlight k={highlightKey} className={bodyClassName ?? 'p-4 sm:p-5'}>{children}</Highlight>
      </section>
    </Card>
  );
}

/** Flashes its background when another user just changed this part of the lead. */
export function Highlight({
  k, className, children, as: As = 'div', ...data
}: { k?: string; className?: string; children: ReactNode; as?: 'div' | 'li'; 'data-type'?: string; 'data-testid'?: string }) {
  const ctx = useProfile();
  const on = !!k && ctx.isHighlighted(k);
  return (
    <As
      {...data}
      data-highlighted={on || undefined}
      className={cn('transition-colors duration-700', on && 'bg-warning-soft!', className)}
    >
      {children}
    </As>
  );
}

/** Copies text with a brief check mark; announces the result through a toast. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
      toast({ id: 'profile-copy', title: 'Copied to clipboard', description: value, variant: 'success', duration: 2000 });
    } catch {
      toast.error('Could not copy. Select the text and copy it manually.');
    }
  };
  return (
    <Tooltip content={label} describe={false}>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg',
          className,
        )}
      >
        {done ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
    </Tooltip>
  );
}

/**
 * Wraps a write control: a read-only reason shows as the tooltip of a wrapper (disabled buttons get no pointer
 * events), else the optional hint as the control's own tooltip.
 */
export function ReadOnlyHint({
  reason, hint, children, className,
}: { reason: string | null; hint?: string | null; children: ReactElement; className?: string }) {
  if (!reason) return hint ? <Tooltip content={hint}>{children}</Tooltip> : children;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className={cn('inline-flex cursor-not-allowed rounded-lg', className)}>
        {children}
      </span>
    </Tooltip>
  );
}

/** "Label: value" pair for fact lists. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-fg">{children}</dd>
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-subtle">{children}</span>;
}
