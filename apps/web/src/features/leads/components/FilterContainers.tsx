// Where the filter panel lives: a collapsible left column on desktop, a bottom sheet on phones.
import { ListFilter, PanelLeftClose, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, IconButton, ModalFrame, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

export function FilterSidebar({
  activeCount, onClear, onCollapse, children,
}: { activeCount: number; onClear: () => void; onCollapse: () => void; children: ReactNode }) {
  return (
    <aside
      id="leads-filter-panel"
      aria-label="Filters"
      className="flex w-[288px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm animate-[lm-fade-in_120ms_ease-out]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-4">
        <ListFilter className="size-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">Filters</h2>
        {activeCount > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold tabular text-accent">{activeCount}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {activeCount > 0 && (
            <button type="button" onClick={onClear} className="h-7 rounded-md px-2 text-xs font-medium text-accent hover:bg-accent-soft">
              Clear
            </button>
          )}
          <IconButton label="Hide filters" icon={<PanelLeftClose />} size="sm" onClick={onCollapse} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </aside>
  );
}

/** Phones: a bottom sheet. Tablets and small laptops (`side`): a panel from the left over the list. */
export function FilterSheet({
  open, onClose, activeCount, onClear, resultCount, loading, children, side,
}: {
  side?: boolean;
  open: boolean;
  onClose: () => void;
  activeCount: number;
  onClear: () => void;
  resultCount: string | null;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      containerClassName={side ? 'flex justify-start' : 'flex items-end'}
      panelClassName={side
        ? 'h-full w-[340px] max-w-[calc(100vw-3rem)] border-r border-border animate-[lm-slide-in-left_160ms_ease-out]'
        : 'max-h-[88vh] w-full rounded-t-2xl border-t border-border animate-[lm-pop-in_160ms_ease-out]'}
    >
      {({ titleId }) => (
        <>
          {!side && <div className="flex justify-center pt-2" aria-hidden><span className="h-1 w-10 rounded-full bg-border-strong" /></div>}
          <div className={cn('flex items-center gap-2 border-b border-border px-4 pb-3', side ? 'pt-3' : 'pt-1')}>
            <h2 id={titleId} className="text-base font-semibold text-fg">Filters</h2>
            {activeCount > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold tabular text-accent">{activeCount}</span>}
            <div className="ml-auto flex items-center gap-1">
              {activeCount > 0 && (
                <button type="button" onClick={onClear} className="h-8 rounded-md px-2 text-sm font-medium text-accent">Clear all</button>
              )}
              <IconButton label="Close filters" icon={<X />} size="sm" onClick={onClose} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
              {loading ? <Spinner size={16} label="Updating results" /> : null}
              {resultCount ? `Show ${resultCount}` : 'Show results'}
            </Button>
          </div>
        </>
      )}
    </ModalFrame>
  );
}

/** Infinite scroll sentinel plus a visible "Load more" fallback. */
export function LoadMore({
  hasNextPage, fetching, onLoad, root, loaded, total, capped, className,
}: {
  hasNextPage: boolean;
  fetching: boolean;
  onLoad: () => void;
  root: Element | null;
  loaded: number;
  total: number | undefined;
  capped: boolean;
  className?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || fetching || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadRef.current();
    }, { root, rootMargin: '0px 0px 480px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, fetching, root]);

  if (loaded === 0) return null;
  return (
    <div className={cn('flex flex-col items-center gap-2 px-4 py-4', className)}>
      <div ref={sentinel} aria-hidden className="h-px w-full" />
      {hasNextPage ? (
        <Button variant="secondary" size="sm" onClick={onLoad} loading={fetching}>
          {fetching ? 'Loading more…' : 'Load more'}
        </Button>
      ) : (
        <p className="text-xs text-subtle">
          {total !== undefined && loaded >= total && !capped
            ? (loaded === 1 ? 'The only matching lead' : `All ${formatNumber(loaded)} leads loaded`)
            : `${formatNumber(loaded)} leads loaded`}
        </p>
      )}
    </div>
  );
}
