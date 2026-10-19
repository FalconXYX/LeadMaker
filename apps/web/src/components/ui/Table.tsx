import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { HTMLAttributes, ReactElement, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

/** Scroll container + table. Header cells stick to the top of the container. */
export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...rest}>{children}</table>
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('sticky top-0 z-10 bg-table-head text-left', className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-divider', className)} {...rest} />;
}

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  /** Row is clickable (hover state + pointer). Keep a real link/button inside for keyboard users. */
  interactive?: boolean;
}

export function TR({ className, selected, interactive, ...rest }: TRProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        'bg-surface transition-colors',
        interactive && 'cursor-pointer hover:bg-hover',
        selected && 'bg-accent-soft hover:bg-accent-soft',
        className,
      )}
      {...rest}
    />
  );
}

export interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Makes the header a sort button. */
  sortable?: boolean;
  sortDirection?: 'asc' | 'desc' | null;
  onSort?: () => void;
  align?: 'left' | 'right' | 'center';
  /** What the column means, as a tooltip on the header. */
  hint?: ReactNode;
}

export function TH({ className, children, sortable, sortDirection, onSort, align = 'left', hint, ...rest }: THProps) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  let content: ReactNode = sortable ? (
    <button
      type="button"
      onClick={onSort}
      className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-fg', sortDirection && 'text-fg')}
    >
      {children}
      {sortDirection === 'asc' ? <ArrowUp className="size-3" aria-hidden />
        : sortDirection === 'desc' ? <ArrowDown className="size-3" aria-hidden />
        : <ArrowUpDown className="size-3 opacity-40" aria-hidden />}
    </button>
  ) : children;
  if (hint) {
    content = sortable
      ? <Tooltip content={hint}>{content as ReactElement}</Tooltip>
      : <Tooltip content={hint}><span className="cursor-help underline decoration-border-strong decoration-dotted underline-offset-4">{children}</span></Tooltip>;
  }
  return (
    <th
      scope="col"
      aria-sort={sortable ? (sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none') : undefined}
      className={cn('h-11 border-b border-border px-3.5 text-xs font-semibold whitespace-nowrap text-muted', alignCls, className)}
      {...rest}
    >
      {content}
    </th>
  );
}

export function TD({ className, align = 'left', ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  const alignCls = align === 'right' ? 'text-right tabular' : align === 'center' ? 'text-center' : 'text-left';
  return <td className={cn('px-3.5 py-3.5 align-middle', alignCls, className)} {...rest} />;
}
