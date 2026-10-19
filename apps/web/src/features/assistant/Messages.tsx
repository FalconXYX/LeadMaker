// The conversation: user bubbles, streamed answers (markdown-lite), tool cards, sources, and the states
// around them (typing, stopped, cut off, error, not connected), plus the welcome screen and suggestions.
import {
  Clock, CloudLightning, FileText, RotateCcw, Search, Sparkles, Target, TriangleAlert, Unplug, UserRound, type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/cn';
import { useAssistant } from './context';
import { Markdown } from './markdown';
import type { Suggestion, SuggestionIcon } from './pageContext';
import { replyErrorText, type AssistantMessage, type ChatMessage, type UserMessage } from './state';
import { FilterCard, InvalidFilterCard, OpenLeadCard, Sources } from './ToolCards';

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const { page } = useAssistant();
  return (
    <div role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation" className="flex flex-col gap-5">
      {messages.map((m) => (m.role === 'user'
        ? <UserBubble key={m.id} message={m} currentLeadName={page.page === 'profile' ? page.leadName ?? null : null} />
        : <AssistantReply key={m.id} message={m} />))}
    </div>
  );
}

function UserBubble({ message, currentLeadName }: { message: UserMessage; currentLeadName: string | null }) {
  // "About Acme Roofing" once the user is somewhere else, so a long conversation stays legible.
  const showContext = !!message.contextLabel && message.contextLabel !== currentLeadName;
  return (
    <div className="flex flex-col items-end gap-1 pl-10">
      <p className="sr-only">You said:</p>
      <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-accent-fg shadow-sm">
        {message.content}
      </div>
      {showContext && <p className="text-[11px] text-subtle">About {message.contextLabel}</p>}
    </div>
  );
}

function AssistantReply({ message }: { message: AssistantMessage }) {
  const { retry, busy, onNavigate, page } = useAssistant();
  const streaming = message.status === 'streaming';

  if (message.status === 'unavailable') return <NotConnectedNotice onRetry={busy ? undefined : () => retry(message.id)} />;

  const hasText = message.parts.some((p) => p.kind === 'text' && p.text.trim());
  const lastPart = message.parts.at(-1);
  // The card already shows how many leads matched: the server's "12 leads match." bubble would say it twice.
  const counted = message.parts.some((p) => p.kind === 'filter' && p.matchCount !== undefined && p.matchCount > 0);
  return (
    <div className="flex gap-2.5 pr-4" aria-busy={streaming || undefined}>
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="sr-only">Assistant said:</p>
        {message.parts.map((p) => {
          switch (p.kind) {
            case 'text':
              return p.text.trim() && !(counted && isMatchSentence(p.text)) ? (
                <div key={p.id} className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2 text-[14px] leading-relaxed text-fg">
                  <Markdown text={p.text} onLeadLink={onNavigate} trailing={streaming && p === lastPart ? <Caret /> : null} />
                </div>
              ) : null;
            case 'filter':
              return <FilterCard key={p.id} part={p} />;
            case 'filter-invalid':
              return <InvalidFilterCard key={p.id} part={p} />;
            case 'open-lead':
              return <OpenLeadCard key={p.id} part={p} />;
          }
        })}
        {streaming && (!hasText || lastPart?.kind !== 'text') && <TypingIndicator label={message.progress} />}
        {message.citations.length > 0 && <Sources citations={message.citations} currentLeadId={page.leadId} />}
        {message.status === 'stopped' && <p className="text-xs text-subtle">{hasText ? 'Stopped.' : 'Stopped before an answer.'}</p>}
        {(message.status === 'error' || message.status === 'interrupted') && (
          <ReplyProblem message={message} onRetry={busy ? undefined : () => retry(message.id)} />
        )}
      </div>
    </div>
  );
}

/**
 * Codes that are a limit or a setup state, not a failure: a neutral note (no red), since nothing broke. The server
 * marks the ones a retry can't fix with retryable:false (no key, no AI requests left for now).
 */
const LIMIT_CODES = new Set(['ai_not_configured', 'ai_quota_exhausted', 'user_daily_limit', 'ai_rate_limited', 'rate_limited']);

function ReplyProblem({ message, onRetry }: { message: AssistantMessage; onRetry?: () => void }) {
  const cutOff = message.status === 'interrupted';
  const limit = !cutOff && !!message.errorCode && LIMIT_CODES.has(message.errorCode);
  const canRetry = cutOff || message.retryable !== false;
  const text = cutOff ? 'The answer was cut off.' : replyErrorText(message.errorCode, message.error) ?? 'The assistant couldn’t answer.';
  return (
    <div
      role={limit ? 'status' : 'alert'}
      data-tone={limit ? 'limit' : 'error'}
      className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px] text-fg', limit ? 'border-border bg-surface-2' : 'border-danger/25 bg-danger-soft')}
    >
      {limit
        ? <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        {canRetry && onRetry && (
          <button type="button" onClick={onRetry} className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
            <RotateCcw className="size-3.5" aria-hidden /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
      <Sparkles className="size-3.5" />
    </span>
  );
}

function Caret() {
  return <span className="lm-caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] rounded-full bg-accent align-baseline" aria-hidden />;
}

/** The server's sentence after an applied filter ("12 leads match."), which the filter card already shows. */
export function isMatchSentence(text: string): boolean {
  return /^\s*(?:Over )?[\d,]+ leads? match(?:es)?\.\s*$/.test(text);
}

/** After this long without text, the dots say it is still working (free-tier answers can take 10-45 s). */
export const SLOW_MS = 8000;

export function TypingIndicator({ label }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);
  const text = slow ? 'Still working on it…' : label;
  return (
    // Announced by the panel's status region ("The assistant is replying"), so hidden from the log here.
    <div className="flex h-9 w-fit max-w-full items-center gap-2 rounded-2xl rounded-tl-md bg-surface-2 px-3.5" aria-hidden data-testid="typing">
      <span className="flex items-center gap-1">
        {[0, 160, 320].map((d) => (
          <span key={d} className="lm-typing-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${d}ms` }} aria-hidden />
        ))}
      </span>
      {text && <span className="truncate text-xs text-muted" data-testid="typing-label">{text}</span>}
    </div>
  );
}

function NotConnectedNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex gap-3 rounded-xl border border-border bg-surface-2 p-3.5" role="note">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-muted shadow-sm" aria-hidden>
        <Unplug className="size-4" />
      </span>
      <div className="min-w-0 flex-1 text-[13px]">
        <p className="text-fg">The assistant is offline right now. Nothing was answered or made up.</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-0.5 inline-flex items-center gap-1 font-medium text-accent hover:underline">
            <RotateCcw className="size-3.5" aria-hidden /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

// ---- welcome + suggestions ---------------------------------------------------------------------------

const ICONS: Record<SuggestionIcon, LucideIcon> = {
  summary: FileText,
  contact: UserRound,
  storm: CloudLightning,
  search: Search,
  priority: Target,
};

export function Suggestions({ title, items, onPick, disabled, compact }: {
  title: string;
  items: Suggestion[];
  onPick: (prompt: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <section aria-label={title} className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
      <h3 className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((s) => {
          const Icon = ICONS[s.icon];
          return (
            <li key={s.prompt}>
              <button
                type="button"
                onClick={() => onPick(s.prompt)}
                disabled={disabled}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-xl border border-border bg-surface text-left text-[13px] text-fg shadow-sm transition-colors max-md:min-h-11',
                  'hover:border-accent/40 hover:bg-accent-soft/60 disabled:cursor-not-allowed disabled:opacity-60',
                  compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
                )}
              >
                <Icon className="size-4 shrink-0 text-muted transition-colors group-hover:text-accent" aria-hidden />
                <span className="min-w-0 flex-1">{s.prompt}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Welcome({ onPick, paused }: { onPick: (prompt: string) => void; paused?: string | null }) {
  const { page, busy } = useAssistant();
  const { user } = useAuth();
  const first = user?.name.split(' ')[0];
  if (paused) {
    // Nothing to invite: one neutral line, and the way forward that still works.
    return (
      <div className="flex gap-2.5 pt-2" role="note" data-testid="assistant-paused">
        <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <p className="text-[13px] leading-relaxed text-muted">{paused}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6 pt-2">
      <div className="flex flex-col items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-2xl bg-accent-soft text-accent" aria-hidden>
          <Sparkles className="size-5" />
        </span>
        <div>
          <p className="text-[17px] font-semibold tracking-tight text-fg">{first ? `Hi ${first}, how can I help?` : 'How can I help?'}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Ask about a contractor, or describe the leads you want and I’ll filter the list for you.
            I only see leads you can see.
          </p>
        </div>
      </div>
      <Suggestions title={page.suggestionsTitle} items={page.suggestions} onPick={onPick} disabled={busy} />
    </div>
  );
}
