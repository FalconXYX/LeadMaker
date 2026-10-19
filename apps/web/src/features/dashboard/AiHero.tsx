// The dashboard's AI banner, first under the greeting: the territory brief (AI-written when available, otherwise a
// plain summary from the numbers), one quiet weather line, and an Ask AI bar that opens the assistant with a question.
import { ArrowUp, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { SignalsResponse } from '@/api/types';
import { askAssistant } from '@/features/assistant/ask';
import { cn } from '@/lib/cn';
import type { DashboardScope } from './api';
import { TerritoryBrief } from './TerritoryBrief';
import { WeatherLine } from './WeatherCard';

export const ASK_SUGGESTIONS = [
  'Who should I call first today?',
  'Find storm-restoration roofers in Bergen County',
  'Which new leads look best?',
  'What should I pitch to my top lead?',
] as const;

export interface AiHeroProps {
  scope: DashboardScope;
  /** Shown when there is no territory brief worth showing. */
  fallback: string | null;
  signals: SignalsResponse | undefined;
  signalsLoading: boolean;
  signalsError: unknown;
  who: 'your' | 'the team’s';
  now: number;
  className?: string;
}

export function AiHero({ scope, fallback, signals, signalsLoading, signalsError, who, now, className }: AiHeroProps) {
  return (
    <section
      aria-labelledby="ai-briefing-title"
      className={cn('grid gap-x-10 gap-y-5 rounded-2xl bg-accent-soft/70 px-4 py-5 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]', className)}
    >
      <div className="min-w-0">
        <h2 id="ai-briefing-title" className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent uppercase">
          <Sparkles className="size-3.5" aria-hidden />AI briefing
        </h2>
        <TerritoryBrief scope={scope} fallback={fallback} className="mt-2" />
        <WeatherLine className="mt-3" signals={signals} isLoading={signalsLoading} error={signalsError} who={who} now={now} />
      </div>
      <AskBar />
    </section>
  );
}

function AskBar() {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    askAssistant(text);
    setText('');
  };
  return (
    <div className="min-w-0 self-center">
      <form role="search" aria-label="Ask AI about your leads" onSubmit={submit} className="relative">
        <Sparkles className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-accent" aria-hidden />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask AI about your leads..."
          aria-label="Ask AI about your leads"
          className="h-11 w-full rounded-full border border-accent/25 bg-surface pr-12 pl-10 text-sm text-fg shadow-sm placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        <button
          type="submit"
          aria-label="Ask"
          disabled={!text.trim()}
          className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:opacity-40"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </form>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Suggested questions">
        {ASK_SUGGESTIONS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => askAssistant(q)}
              className="inline-flex min-h-8 items-center rounded-full border border-accent/20 bg-surface/70 px-3 py-1 text-left text-xs font-medium text-fg hover:border-accent/50 hover:text-accent"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
