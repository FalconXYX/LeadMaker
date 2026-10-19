// The territory briefing: the paragraph in the dashboard's AI briefing banner. It is the worker's sales-first morning
// digest (follow-ups, quiet deals, new leads, pipeline moves, then weather), or the AI rewrite of that digest when one
// matches it. When there is no brief
// worth showing (loading, an error, an empty or quiet brief, or a stale one because the worker isn't running) the
// banner shows the deterministic `fallback` line built from the dashboard's own numbers instead.
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
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
  if (brief.source !== 'ai') return 'Summary of follow-ups, quiet deals, new leads, pipeline moves and weather.';
  const model = brief.model ? brief.model.slice(brief.model.indexOf(':') + 1) : '';
  const when = brief.generatedAt ? formatRelative(brief.generatedAt, now) : '';
  return ['Summary of follow-ups, quiet deals, new leads, pipeline moves and weather, written by AI from the facts', model, when].filter(Boolean).join(' · ');
}

// A dot inside a company or street name ("Smith Bros. Roofing", "MJT & Co. Inc", "St. Louis") is not a sentence
// end. Names often END a sentence ("... Direct Call Construction LLC."), so LLC / Inc / Corp still split.
const ABBREVIATION = /\b(?:bros|st|mt|ft|jr|sr|mr|mrs|ms|dr|no|vs)\.$/i;
const CO_THEN_SUFFIX = /\bco\.$/i;
const SUFFIX = /^(?:inc|llc|corp|ltd)\b/i;

/** [the first sentence, the rest] of a brief; the rest is '' for a one-sentence brief. */
export function splitFirstSentence(text: string): [string, string] {
  const re = /[.!?]\s+(?=[A-Z0-9])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + 1;
    const before = text.slice(Math.max(0, end - 6), end);
    const after = text.slice(m.index + m[0].length);
    if (ABBREVIATION.test(before) || (CO_THEN_SUFFIX.test(before) && SUFFIX.test(after))) continue;
    return [text.slice(0, end), text.slice(end).trim()];
  }
  return [text, ''];
}

/** Phones show the brief's whole first sentence (the most actionable item) and a "Read more" for the rest. */
export function TerritoryBrief({ scope, fallback, className }: { scope: DashboardScope; fallback?: string | null; className?: string }) {
  const q = useTerritoryBrief(scope);
  const [expanded, setExpanded] = useState(false);
  const brief = visibleBrief(q.isError ? null : q.data?.brief);
  const text = brief ? brief.text.trim() : q.isPending ? '' : (fallback ?? '').trim();
  if (!text) return null;
  const [first, rest] = splitFirstSentence(text);
  const clampable = rest !== '';
  return (
    <div className={cn('flex items-start gap-1.5', className)} data-testid={brief ? 'territory-brief' : 'territory-brief-fallback'}>
      <div className="min-w-0">
        {/* Company names stay plain text: calm, and the call list is where leads are opened. */}
        <p id="territory-brief-text" className="max-w-3xl text-[15px] leading-relaxed text-fg">
          {first}
          {rest && <span className={cn(!expanded && 'max-sm:hidden')}> {rest}</span>}
        </p>
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
      {brief && <InfoTip about="this summary" className="max-sm:size-11 max-sm:-my-3">{briefNote(brief)}</InfoTip>}
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
