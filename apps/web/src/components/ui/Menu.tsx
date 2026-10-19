import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  /** A second, quieter line under the label. */
  description?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the current choice in a list of options (a check on the right). */
  checked?: boolean;
}

export interface MenuGroup {
  /** Small heading above the group. */
  label?: ReactNode;
  items: MenuItem[];
}

export interface MenuProps {
  /** Renders the trigger; spread `props` onto a <button>. */
  trigger: (props: {
    ref: (el: HTMLButtonElement | null) => void;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
  }) => ReactNode;
  items?: MenuItem[];
  /** Items in labelled groups, separated by dividers (instead of, or after, `items`). */
  groups?: MenuGroup[];
  /** Non-interactive content above the items (e.g. the signed-in user). */
  header?: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

/** Dropdown menu: arrow keys, Home/End, Esc and outside click close; focus returns to the trigger. */
export function Menu({ trigger, items = [], groups = [], header, align = 'end', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const focusItem = (index: number) => {
    const els = [...(menuEl.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
    if (els.length) els[(index + els.length) % els.length]!.focus();
  };

  useEffect(() => {
    if (!open) return;
    // The current choice (a checked item) takes focus first, like a native select.
    requestAnimationFrame(() => {
      const checked = menuEl.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not([disabled])');
      if (checked) checked.focus();
      else focusItem(0);
    });
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerEl.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const els = [...(menuEl.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const all: MenuGroup[] = [...(items.length ? [{ items }] : []), ...groups];

  const renderItem = (item: MenuItem, key: string) => (
    <button
      key={key}
      type="button"
      role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={item.checked}
      tabIndex={-1}
      disabled={item.disabled}
      onClick={() => {
        close();
        item.onSelect();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm outline-none [&_svg]:size-4',
        'hover:bg-hover focus:bg-hover disabled:opacity-50',
        item.danger ? 'text-danger' : 'text-fg',
      )}
    >
      {item.icon && <span className="flex shrink-0 text-muted" aria-hidden="true">{item.icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', item.checked && 'font-semibold')}>{item.label}</span>
        {item.description && <span className="block truncate text-xs text-muted">{item.description}</span>}
      </span>
      {item.checked && <Check className="shrink-0 text-accent" aria-hidden />}
    </button>
  );

  return (
    <div ref={root} className="relative">
      {trigger({
        ref: (el) => { triggerEl.current = el; },
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
      })}
      {open && (
        <div
          ref={menuEl}
          id={id}
          role="menu"
          onKeyDown={onMenuKey}
          className={cn(
            'absolute top-full z-40 mt-1.5 min-w-56 overflow-hidden rounded-xl border border-border bg-surface py-1.5 text-fg shadow-lg animate-[lm-pop-in_120ms_ease-out]',
            align === 'end' ? 'right-0' : 'left-0', className,
          )}
        >
          {header && <div className="border-b border-divider px-3.5 py-3.5">{header}</div>}
          {all.map((group, g) => (
            <div key={g} role="group" aria-label={typeof group.label === 'string' ? group.label : undefined} className={cn(g > 0 && 'mt-1.5 border-t border-divider pt-1.5')}>
              {group.label && <div className="px-3.5 pt-2.5 pb-1 text-xs font-semibold text-muted">{group.label}</div>}
              {group.items.map((item, i) => renderItem(item, `${g}-${i}`))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
