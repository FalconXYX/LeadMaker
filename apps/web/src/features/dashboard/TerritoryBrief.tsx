// The territory briefing: one short muted paragraph at the top of the "Today's briefing" card, above the call list.
// It is the worker's digest of the latest data poll and weather alerts, or the AI rewrite of that digest when one
// matches it. It is optional content, so loading, errors, an empty or quiet brief and a stale one (the worker isn't
// running) all render nothing: no skeleton, no card, no heading.
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { TerritoryBrief as Brief } from '@/api/types';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import type { DashboardScope } from './api';

export const BRIEF_STALE_MS = 10 * 60_000;

/** GET /api/territory-brief for the dashboard's scope (mine, team or rep:<id>; the server maps mine to the viewer). */
export function useTerritoryBrief(scope: DashboardScope) {
  return useQuery({
    queryKey: qk.territoryBrief(scope),
    queryFn: ({ signal }) => ep.getTerritoryBrief(scope, { signal }),
    staleTime: BRIEF_STALE_MS,
  });
}

/** The brief worth showing, or null (nothing to say, stale, or no text). */
export function visibleBrief(brief: Brief | null | undefined): Brief | null {
  if (!brief || brief.quiet || brief.stale || typeof brief.text !== 'string' || !brief.text.trim()) return null;
  return brief;
}

export function briefNote(brief: Brief, now = Date.now()): string {
  if (brief.source !== 'ai') return 'Summary of the latest data poll and weather alerts.';
  const model = brief.model ? brief.model.slice(brief.model.indexOf(':') + 1) : '';
  const when = brief.generatedAt ? formatRelative(brief.generatedAt, now) : '';
  return ['Summary of the latest data poll and weather, written by AI from the facts', model, when].filter(Boolean).join(' · ');
}

/** Phones clamp the brief to 3 lines; one this long gets a "more" to read the rest. */
export const BRIEF_CLAMP_CHARS = 140;

export function TerritoryBrief({ scope, className }: { scope: DashboardScope; className?: string }) {
  const q = useTerritoryBrief(scope);
  const [expanded, setExpanded] = useState(false);
  const brief = visibleBrief(q.isError ? null : q.data?.brief);
  const text = brief ? brief.text.trim() : '';
  // Inside the briefing card the tile is narrow on a phone, so a brief well under BRIEF_CLAMP_CHARS can still be
  // cut at 3 lines: measure the paragraph and offer "Read more" whenever the clamp actually hides text.
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);
  if (!brief) return null;
  const clampable = overflows || text.length > BRIEF_CLAMP_CHARS;
  return (
    <div className={cn('flex items-start gap-1.5 rounded-lg bg-surface-2 px-3 py-2.5 sm:px-4 sm:py-3', className)} data-testid="territory-brief">
      <div className="min-w-0">
        {/* Company names stay plain text: calm, and the call list is where leads are opened. */}
        <p ref={textRef} id="territory-brief-text" className={cn('max-w-3xl text-sm text-muted', !expanded && 'max-sm:line-clamp-3')}>{text}</p>
        {clampable && !expanded && (
          <button
            type="button"
            aria-expanded={false}
            aria-controls="territory-brief-text"
            onClick={() => setExpanded(true)}
            className="min-h-11 text-sm text-muted underline-offset-2 hover:text-fg hover:underline sm:hidden"
          >
            Read more
          </button>
        )}
      </div>
      <InfoTip about="this summary" className="max-sm:size-11 max-sm:-my-3">{briefNote(brief)}</InfoTip>
    </div>
  );
}

/** An ⓘ that says where the brief came from; the text opens on hover and on keyboard focus. */
function InfoTip({ about, children, className }: { about: string; children: string; className?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={`About ${about}`}
        className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg', className)}
      >
        <Info className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}
