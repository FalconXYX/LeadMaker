import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useFocusTrap, useScrollLock } from './useFocusTrap';

interface ModalFrameProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name; rendered by the caller as the heading with id={titleId}. */
  children: (ids: { titleId: string; descriptionId: string }) => ReactNode;
  panelClassName: string;
  containerClassName: string;
  initialFocus?: RefObject<HTMLElement | null>;
  closeOnOverlayClick?: boolean;
}

/** Shared modal plumbing for Dialog and Drawer: portal, overlay, Esc, focus trap, scroll lock. */
export function ModalFrame({
  open, onClose, children, panelClassName, containerClassName, initialFocus, closeOnOverlayClick = true,
}: ModalFrameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(panel, open, initialFocus);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    };
    const node = panel.current;
    node?.addEventListener('keydown', onKey);
    return () => node?.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className={cn('fixed inset-0 z-50', containerClassName)}>
      <div
        className="absolute inset-0 bg-overlay animate-[lm-fade-in_120ms_ease-out]"
        aria-hidden="true"
        onMouseDown={closeOnOverlayClick ? onClose : undefined}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={cn('relative flex flex-col bg-surface shadow-lg outline-none', panelClassName)}
      >
        {children({ titleId, descriptionId })}
      </div>
    </div>,
    document.body,
  );
}
