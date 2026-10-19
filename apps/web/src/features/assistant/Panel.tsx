// The chat panel: a floating, non-modal region above the launcher on md+ (the page stays usable, so applied
// filters show up behind it), and a full-screen modal overlay on phones. It stays mounted while closed, so
// the draft and scroll position survive; Esc closes it and returns focus to the launcher.
import { ChevronDown, Sparkles, SquarePen, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { AssistantStatusView } from './api';
import { Composer } from './Composer';
import { useAssistant, type Connection } from './context';
import { MessageList, Suggestions, Welcome } from './Messages';
import { placeKey } from './pageContext';
import { UNAVAILABLE_MESSAGE } from './state';

export const PANEL_ID = 'lm-assistant-panel';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function AssistantPanel({ launcherRef }: { launcherRef: RefObject<HTMLButtonElement | null> }) {
  const { open, setOpen, messages, busy, connection, status, page, announcement, reset, send, isOverlay } = useAssistant();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, [setOpen, launcherRef]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Follow the answer as it streams, unless the user scrolled up to read; a new question always jumps down.
  const count = useRef(messages.length);
  useLayoutEffect(() => {
    if (messages.length > count.current) stickToBottom.current = true;
    count.current = messages.length;
    const el = scrollRef.current;
    if (el && open && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation();
      close();
      return;
    }
    // Phones: the overlay is modal, so Tab cycles inside it.
    if (e.key === 'Tab' && isOverlay && panelRef.current) {
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const pick = (prompt: string) => {
    send(prompt);
    inputRef.current?.focus();
  };

  const startOver = () => {
    reset();
    inputRef.current?.focus();
  };

  // A status that says the AI can't answer (no key, no requests left for now): say so up front and
  // don't invite questions that would only fail. A provider hiccup (provider_down) still lets the user try.
  const paused = pausedMessage(status, connection, busy);
  const last = messages.at(-1);
  const lastQuestion = messages.findLast((m) => m.role === 'user');
  // Keep prompts in reach when nothing answered, or when the user has moved to a different page or lead.
  const showSuggestions = messages.length > 0 && !busy && (
    (last?.role === 'assistant' && last.status === 'unavailable')
    || (lastQuestion?.role === 'user' && placeKey(lastQuestion.context) !== page.placeKey)
  );

  return (
    <div
      ref={panelRef}
      id={PANEL_ID}
      // A modal dialog on phones; on md+ a named region (non-modal), so pages that treat an open dialog as
      // "Esc belongs to the dialog" (e.g. the list's clear-selection) keep working while it stays open.
      role={isOverlay ? 'dialog' : 'region'}
      aria-modal={isOverlay || undefined}
      aria-labelledby={titleId}
      hidden={!open}
      onKeyDown={onKeyDown}
      className={cn(
        'lm-panel-in fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface',
        // At most 620 px tall, so on a laptop screen it starts below the profile header's Call and Log call buttons.
        'md:inset-auto md:right-6 md:bottom-24 md:z-40 md:h-[min(620px,calc(100dvh-12rem))] md:w-[400px] md:rounded-2xl md:border md:border-border md:shadow-lg',
      )}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 pt-[max(0.875rem,env(safe-area-inset-top))] pb-3.5 md:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-sm" aria-hidden>
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm leading-tight font-semibold text-fg">AI Assistant</h2>
          <p className="truncate text-xs text-muted" data-testid="assistant-status">{statusLine(busy, connection, status)}</p>
        </div>
        <IconButton label="New conversation" icon={<SquarePen />} size="sm" onClick={startOver} disabled={messages.length === 0} className="max-md:size-11" />
        <IconButton label="Close assistant" icon={isOverlay ? <X /> : <ChevronDown />} size="sm" onClick={close} className="max-md:size-11" />
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-5">
        {messages.length === 0 ? (
          <Welcome onPick={pick} paused={paused} />
        ) : (
          <>
            <MessageList messages={messages} />
            {showSuggestions && !paused && (
              <div className="mt-5">
                <Suggestions compact title={page.suggestionsTitle} items={page.suggestions} onPick={pick} disabled={busy} />
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface px-3.5 pt-3.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:px-4">
        <Composer inputRef={inputRef} pausedReason={paused} />
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{open ? announcement : ''}</p>
    </div>
  );
}

/**
 * Why the composer is closed, or null when the assistant can take a question: the AI can't take requests for now or
 * no provider is set up. Offline (the service not answering) and a provider hiccup keep the box open: a retry can work.
 */
export function pausedMessage(status: AssistantStatusView | null, _connection: Connection, busy: boolean): string | null {
  if (busy || !status || status.available) return null;
  switch (status.reason) {
    case 'quota_exhausted':
      return UNAVAILABLE_MESSAGE;
    case 'not_configured':
      return 'AI isn’t set up on this server. Filters and profiles work as usual.';
    default:
      return null;
  }
}

/**
 * The muted line under the title: what the assistant can do right now. The last request's outcome (offline) wins
 * over GET /api/assistant/status, which is read when the panel opens and again after a failed answer.
 */
export function statusLine(busy: boolean, connection: Connection, status: AssistantStatusView | null): string {
  if (busy) return 'Answering…';
  if (connection === 'unavailable') return 'Offline';
  // A status read from before an answer that just came through is out of date.
  if (status?.reason === 'offline' && connection !== 'connected') return 'Offline';
  switch (status?.reason) {
    case 'not_configured':
      return 'AI isn’t set up on this server';
    case 'quota_exhausted':
      return 'AI answers aren’t available right now';
    case 'provider_down':
      return 'AI temporarily unavailable';
    default:
      return 'Lead Q&A and list filtering';
  }
}
