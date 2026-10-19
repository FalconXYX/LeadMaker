// The persistent AI assistant (SystemDesign §6-§7): a bottom-right launcher and chat panel on every page.
// AppShell renders <AssistantLauncher/> once, outside the routed Outlet, so the conversation lives across
// route changes. The server side is the On-Demand AI Service; see ./api.ts for the contract.
import { ChevronDown, Sparkles } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import './assistant.css';
import { AssistantProvider, useAssistant } from './context';
import { AssistantPanel, PANEL_ID } from './Panel';

export { AssistantProvider, useAssistant } from './context';

export function AssistantLauncher() {
  const launcherRef = useRef<HTMLButtonElement>(null);
  return (
    <AssistantProvider>
      <LauncherButton buttonRef={launcherRef} />
      <AssistantPanel launcherRef={launcherRef} />
    </AssistantProvider>
  );
}

/** "." opens or closes the assistant when focus is not in a field (like "/" for search). */
export const ASSISTANT_SHORTCUT = '.';

function LauncherButton({ buttonRef }: { buttonRef: RefObject<HTMLButtonElement | null> }) {
  const { open, setOpen, unread, busy } = useAssistant();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if (e.key !== ASSISTANT_SHORTCUT || typing || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(!open);
      if (open) buttonRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen, buttonRef]);
  return (
    <Tooltip content={`AI assistant (${ASSISTANT_SHORTCUT})`} describe={false}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={open ? 'Close AI assistant' : unread ? 'Open AI assistant (new reply)' : 'Open AI assistant'}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-keyshortcuts={ASSISTANT_SHORTCUT === '.' ? 'Period' : ASSISTANT_SHORTCUT}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) setOpen(false);
        }}
        className={cn(
          'fixed right-4 bottom-4 z-40 flex size-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg',
          'transition-[transform,background-color] duration-150 hover:scale-105 hover:bg-accent-hover active:scale-95 md:right-6 md:bottom-6',
        )}
      >
        <Sparkles className={cn('absolute size-5 transition-all duration-200', open ? 'scale-50 rotate-45 opacity-0' : 'scale-100 opacity-100')} aria-hidden />
        <ChevronDown className={cn('absolute size-6 transition-all duration-200', open ? 'scale-100 opacity-100' : 'scale-50 -rotate-90 opacity-0')} aria-hidden />
        {!open && busy && <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" aria-hidden />}
        {!open && unread && (
          <span className="absolute top-0.5 right-0.5 size-3 rounded-full bg-danger ring-2 ring-surface" aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}
