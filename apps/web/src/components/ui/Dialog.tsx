import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';
import { ModalFrame } from './Overlay';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned; put the primary action last. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  initialFocus?: RefObject<HTMLElement | null>;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', initialFocus }: DialogProps) {
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      initialFocus={initialFocus}
      containerClassName="flex items-center justify-center p-4"
      panelClassName={cn('w-full max-h-[85vh] rounded-2xl border border-border animate-[lm-pop-in_140ms_ease-out]', SIZES[size])}
    >
      {({ titleId, descriptionId }) => (
        <>
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3.5 sm:px-6 sm:pt-6 sm:pb-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-fg">{title}</h2>
              {description && <p id={descriptionId} className="mt-1.5 text-sm text-muted">{description}</p>}
            </div>
            <IconButton label="Close" icon={<X />} size="sm" onClick={onClose} className="-mt-1 -mr-1" />
          </div>
          {children && <div className="overflow-y-auto px-5 pb-5 text-sm sm:px-6">{children}</div>}
          {footer && <div className="flex flex-wrap items-center justify-end gap-2.5 rounded-b-2xl border-t border-divider bg-surface-2 px-5 py-3.5 sm:px-6 sm:py-4">{footer}</div>}
        </>
      )}
    </ModalFrame>
  );
}
