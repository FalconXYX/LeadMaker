import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';
import { ModalFrame } from './Overlay';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Panel width; full width on small screens. */
  width?: 'sm' | 'md' | 'lg';
  initialFocus?: RefObject<HTMLElement | null>;
}

const WIDTHS = { sm: 'sm:w-[360px]', md: 'sm:w-[480px]', lg: 'sm:w-[640px]' };

/** Right-side panel for secondary tasks (filters, quick view, notifications). */
export function Drawer({ open, onClose, title, description, children, footer, width = 'md', initialFocus }: DrawerProps) {
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      initialFocus={initialFocus}
      containerClassName="flex justify-end"
      panelClassName={cn('h-full w-full border-l border-border animate-[lm-slide-in-right_160ms_ease-out]', WIDTHS[width])}
    >
      {({ titleId, descriptionId }) => (
        <>
          <div className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4 sm:px-6 sm:py-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-fg">{title}</h2>
              {description && <p id={descriptionId} className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <IconButton label="Close" icon={<X />} size="sm" onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-divider bg-surface-2 px-5 py-3.5 sm:px-6 sm:py-4">{footer}</div>}
        </>
      )}
    </ModalFrame>
  );
}
