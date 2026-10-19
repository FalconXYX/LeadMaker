import { createContext, use, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface TabsCtx {
  value: string;
  onValueChange: (v: string) => void;
  baseId: string;
  variant: 'underline' | 'pill';
}

const Ctx = createContext<TabsCtx | null>(null);
const useTabs = () => {
  const c = use(Ctx);
  if (!c) throw new Error('Tab components must be inside <Tabs>');
  return c;
};

/**
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabList aria-label="Lead sections"><Tab value="overview">Overview</Tab>...</TabList>
 *   <TabPanel value="overview">...</TabPanel>
 * </Tabs>
 * Arrow keys / Home / End move between tabs (automatic activation).
 */
export function Tabs({
  value, onValueChange, children, variant = 'underline', className,
}: { value: string; onValueChange: (v: string) => void; children: ReactNode; variant?: 'underline' | 'pill'; className?: string }) {
  const baseId = useId();
  return (
    <Ctx value={{ value, onValueChange, baseId, variant }}>
      <div className={className}>{children}</div>
    </Ctx>
  );
}

export function TabList({ children, className, 'aria-label': ariaLabel }: { children: ReactNode; className?: string; 'aria-label': string }) {
  const { variant } = useTabs();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? [])];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length]
      : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === 'Home' ? tabs[0]
      : e.key === 'End' ? tabs[tabs.length - 1]
      : undefined;
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'flex items-center',
        variant === 'underline' ? 'gap-6 border-b border-divider sm:gap-7' : 'gap-1 rounded-xl bg-surface-3 p-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children, count, disabled }: { value: string; children: ReactNode; count?: number; disabled?: boolean }) {
  const t = useTabs();
  const selected = t.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${t.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${t.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => t.onValueChange(value)}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        t.variant === 'underline'
          ? cn('-mb-px border-b-[3px] px-0.5 pt-1 pb-3', selected ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:border-border hover:text-fg')
          : cn('h-8 rounded-lg px-3.5', selected ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg'),
      )}
    >
      {children}
      {count !== undefined && (
        <span className={cn('rounded-full px-1.5 text-xs tabular', selected ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted')}>
          {count}
        </span>
      )}
    </button>
  );
}

export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const t = useTabs();
  if (t.value !== value) return null;
  return (
    <div role="tabpanel" id={`${t.baseId}-panel-${value}`} aria-labelledby={`${t.baseId}-tab-${value}`} tabIndex={0} className={cn('outline-none', className)}>
      {children}
    </div>
  );
}
