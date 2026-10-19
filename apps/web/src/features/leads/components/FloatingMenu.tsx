// A menu portalled to <body> and pinned to its trigger, so it is never clipped by the scrolling table. Arrow keys
// move between items, Esc closes it (focus goes back to the trigger), outside clicks and Tab close it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

const ITEM = '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])';

export interface FloatingMenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: (restoreFocus: boolean) => void;
  label: string;
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}

export function FloatingMenu({ anchor, open, onClose, label, align = 'start', className, children }: FloatingMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const el = panel.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const m = 8;
      let top = a.bottom + 4;
      if (top + h > window.innerHeight - m && a.top - h - 4 >= m) top = a.top - h - 4;
      const left = align === 'end' ? a.right - w : a.left;
      setPos({ top: Math.round(Math.max(m, top)), left: Math.round(Math.min(Math.max(m, left), window.innerWidth - w - m)) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      const items = [...(panel.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
      (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true });
    });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor?.contains(t)) closeRef.current(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, anchor]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => items[(n + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
    else if (e.key === 'Tab') onClose(false);
  };

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={cn(
        'fixed z-50 min-w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg',
        pos && 'animate-[lm-pop-in_120ms_ease-out]',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Open state + anchor for a FloatingMenu trigger. */
export function useMenuAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchor?.focus();
  }, [anchor]);
  return { anchor, setAnchor, open, setOpen, close };
}
