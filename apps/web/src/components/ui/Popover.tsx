import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface PopoverTriggerProps {
  ref: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-haspopup': 'dialog';
}

export interface PopoverProps {
  /** Renders the trigger; spread `props` onto a <button>. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Panel content; `close` returns focus to the trigger. */
  children: (close: () => void) => ReactNode;
  /** Accessible name of the panel. */
  label: string;
  align?: 'start' | 'end';
  className?: string;
  panelClassName?: string;
}

/**
 * Click-to-open, non-modal panel (filters, display settings, saved views): Esc and outside clicks close it,
 * the first control (or [data-autofocus]) gets focus, focus returns to the trigger.
 */
export function Popover({ trigger, children, label, align = 'end', className, panelClassName }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    const raf = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled]), input, select, [tabindex="0"]');
      first?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener('mousedown', onDown);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerEl.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={root} className={cn('relative', className)} onKeyDown={onKeyDown}>
      {trigger({
        ref: (el) => { triggerEl.current = el; },
        onClick: () => setOpen((o) => !o),
        'aria-expanded': open,
        'aria-controls': id,
        'aria-haspopup': 'dialog',
      })}
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          className={cn(
            'absolute top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-border bg-surface shadow-lg animate-[lm-pop-in_120ms_ease-out]',
            align === 'end' ? 'right-0' : 'left-0', panelClassName,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
