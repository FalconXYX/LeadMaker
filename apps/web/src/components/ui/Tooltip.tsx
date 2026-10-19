import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ReactElement, type ReactNode, type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

// Focus opens a tooltip only after keyboard use (the :focus-visible heuristic), so a click or a
// programmatic focus never leaves a stray bubble behind.
let keyboardModality = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardModality = true;
  }, true);
  window.addEventListener('pointerdown', () => {
    keyboardModality = false;
  }, true);
}

// One bubble at a time; moving from one trigger to the next skips the delay.
let closeCurrent: (() => void) | null = null;
let lastClosedAt = 0;

export type TooltipSide = 'top' | 'bottom' | 'right';

export interface TooltipProps {
  /** Plain text or short rich text; '\n' breaks lines. Empty content renders the child alone. */
  content: ReactNode;
  /** One element that accepts mouse/focus handlers and aria-describedby (a DOM element or a component that spreads them). */
  children: ReactElement;
  side?: TooltipSide;
  /** Hover delay in ms. */
  delay?: number;
  /** Also expose the content as the trigger's accessible description. Turn off when it repeats the accessible name. */
  describe?: boolean;
  className?: string;
}

type Handler = (e: SyntheticEvent<HTMLElement>) => void;

/**
 * Hover / keyboard-focus tooltip, replacing native `title` (slow, unstyled, invisible to keyboard users).
 * Esc, scrolling, a click or leaving the trigger closes it. The bubble is portalled and kept inside the viewport.
 */
export function Tooltip({ content, children, side = 'top', delay = 450, describe = true, className }: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setAnchor((a) => {
      if (a) lastClosedAt = Date.now();
      return null;
    });
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!anchor) return;
    if (closeCurrent && closeCurrent !== hide) closeCurrent();
    closeCurrent = hide;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey, true);
    return () => {
      if (closeCurrent === hide) closeCurrent = null;
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, hide]);

  if (content == null || content === false || content === '' || !isValidElement(children)) return children;

  const props = children.props as Record<string, unknown>;
  const chain = (name: string, fn: Handler): Handler => (e) => {
    (props[name] as Handler | undefined)?.(e);
    fn(e);
  };
  const descId = `${id}-tip`;
  const describedBy = [props['aria-describedby'], describe ? descId : null].filter(Boolean).join(' ') || undefined;

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    onMouseEnter: chain('onMouseEnter', (e) => {
      const el = e.currentTarget;
      clearTimeout(timer.current);
      const quick = !!closeCurrent || Date.now() - lastClosedAt < 400;
      timer.current = setTimeout(() => setAnchor(el), quick ? 60 : delay);
    }),
    onMouseLeave: chain('onMouseLeave', hide),
    onFocus: chain('onFocus', (e) => {
      if (keyboardModality) setAnchor(e.currentTarget);
    }),
    onBlur: chain('onBlur', hide),
    onPointerDown: chain('onPointerDown', hide),
    'aria-describedby': describedBy,
  });

  return (
    <>
      {trigger}
      {describe && <span id={descId} hidden>{content}</span>}
      {anchor && createPortal(<Bubble anchor={anchor} side={side} className={className}>{content}</Bubble>, document.body)}
    </>
  );
}

function Bubble({ anchor, side, className, children }: { anchor: HTMLElement; side: TooltipSide; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const clampX = (x: number) => Math.min(Math.max(margin, x), window.innerWidth - margin - t.width);
    const clampY = (y: number) => Math.min(Math.max(margin, y), window.innerHeight - margin - t.height);
    let s = side;
    if (s === 'right' && a.right + gap + t.width > window.innerWidth - margin) s = 'top';
    if (s === 'right') {
      setPos({ top: Math.round(clampY(a.top + a.height / 2 - t.height / 2)), left: Math.round(a.right + gap) });
      return;
    }
    if (s === 'top' && a.top - gap - t.height < margin) s = 'bottom';
    else if (s === 'bottom' && a.bottom + gap + t.height > window.innerHeight - margin) s = 'top';
    const top = s === 'top' ? a.top - gap - t.height : a.bottom + gap;
    setPos({ top: Math.round(top), left: Math.round(clampX(a.left + a.width / 2 - t.width / 2)) });
  }, [anchor, side, children]);

  return (
    <div
      ref={ref}
      role="tooltip"
      style={pos ?? { top: 0, left: 0 }}
      className={cn(
        'pointer-events-none fixed z-[70] w-max max-w-[min(300px,calc(100vw-16px))] rounded-md border border-tooltip-border bg-tooltip px-3 py-2',
        'text-xs leading-snug font-normal break-words whitespace-pre-line text-tooltip-fg shadow-md',
        pos ? 'animate-[lm-fade-in_90ms_ease-out]' : 'invisible',
        className,
      )}
    >
      {children}
    </div>
  );
}
