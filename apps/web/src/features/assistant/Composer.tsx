// The message box: Enter sends, Shift+Enter adds a line, grows with its content; Stop while answering.
import { ArrowUp, Building2, ListFilter, Square } from 'lucide-react';
import { useLayoutEffect, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { viewLabel } from '@/features/leads/scope';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAssistant } from './context';

const MAX_LENGTH = 2000;

/** pausedReason: the AI can't answer right now (unavailable, no key); the box is disabled and says why. */
export function Composer({ inputRef, pausedReason = null }: { inputRef: RefObject<HTMLTextAreaElement | null>; pausedReason?: string | null }) {
  const { send, stop, busy, page, isOverlay } = useAssistant();
  const [draft, setDraft] = useState('');
  const paused = !!pausedReason && !busy;
  const canSend = draft.trim().length > 0 && !busy && !paused;

  // Auto-grow up to ~6 lines, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`;
  }, [draft, inputRef]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    send(draft);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <ContextChip />
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border border-border-strong/70 bg-surface py-1.5 pr-1.5 pl-3.5 shadow-sm transition-shadow',
          'focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15',
        )}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={paused}
          placeholder={paused ? 'AI answers aren’t available right now' : page.placeholder}
          aria-label="Message the assistant"
          aria-describedby={isOverlay ? undefined : 'lm-assistant-keys'}
          // The box shows focus (focus-within), so the field itself has no outline.
          className="max-h-[152px] min-h-[34px] flex-1 resize-none bg-transparent py-[7px] text-[14px] leading-5 text-fg outline-none placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed"
        />
        {busy ? (
          <Tooltip content="Stop" describe={false}>
            <button
              type="button"
              onClick={stop}
              aria-label="Stop answering"
              className="flex size-[34px] shrink-0 items-center justify-center rounded-xl bg-fg text-surface transition-opacity hover:opacity-85 max-md:size-11"
            >
              <Square className="size-3 fill-current" aria-hidden />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="Send (Enter)" describe={false}>
            <button
              type="submit"
              aria-label="Send message"
              disabled={!canSend}
              className={cn(
                'flex size-[34px] shrink-0 items-center justify-center rounded-xl transition-colors max-md:size-11',
                canSend ? 'bg-accent text-accent-fg hover:bg-accent-hover' : 'bg-surface-2 text-subtle',
              )}
            >
              <ArrowUp className="size-4" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      {!isOverlay && (
        <p id="lm-assistant-keys" className="px-1 text-[11px] text-subtle">
          <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
        </p>
      )}
    </form>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1 font-sans text-[10px] text-muted">{children}</kbd>;
}

/** What the next question is about: the open lead, or the list and its filters. */
function ContextChip() {
  const { page } = useAssistant();
  const { isManager } = useAuth();
  if (page.page === 'profile') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 self-start rounded-full bg-accent-soft py-1 pr-2.5 pl-2 text-xs text-accent">
        <Building2 className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          Asking about <strong className="font-semibold">{page.leadName ?? 'this lead'}</strong>
        </span>
      </p>
    );
  }
  if (page.page === 'leads') {
    const n = page.filterCount;
    const view = viewLabel(page.filter ?? {}, isManager);
    return (
      <Tooltip content="The assistant sees the list’s current filters and can refine or replace them.">
        <p
          className="flex items-center gap-1.5 self-start rounded-full bg-surface-2 py-1 pr-2.5 pl-2 text-xs text-muted"
        >
          <ListFilter className="size-3.5 shrink-0" aria-hidden />
          <span>
            Lead list · <span className="text-fg">{view}</span>{n > 0 ? ` · ${n} filter${n === 1 ? '' : 's'}` : ''}
          </span>
        </p>
      </Tooltip>
    );
  }
  return null;
}
