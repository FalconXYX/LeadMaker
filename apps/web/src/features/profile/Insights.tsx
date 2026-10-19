// AI insights on the Overview tab: one card that reads top to bottom (the business summary, how to approach them and
// who to ask for, then the talking points) and collapses as a whole from its header; the choice is remembered on this
// device. The batch insights job writes them (Section 4); a lead without any shows no card.
import { ChevronDown, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Card, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { safeStorage } from '@/lib/storage';
import { useProfile } from './context';

/** localStorage key for the card's state: "0" collapsed; "1" or nothing expanded. */
export const INSIGHTS_OPEN_KEY = 'leadmaker.profile.insights.open';

function readOpen(): boolean {
  try {
    return safeStorage.get(INSIGHTS_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    safeStorage.set(INSIGHTS_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

export function InsightsCard() {
  const { profile } = useProfile();
  const ins = profile.insights;
  const [open, setOpen] = useState(readOpen);
  const uid = useId();
  const headingId = `${uid}-heading`;
  const bodyId = `${uid}-body`;
  const summary = ins?.businessSummary?.trim() ?? '';
  const pitch = ins?.salesRecommendation?.trim() ?? '';
  if (!ins || (!summary && !pitch)) return null;

  // Older or partial bodies may lack the newer fields: treat them as empty.
  const points = cleanPoints(ins.talkingPoints);
  const contact = ins.targetContact?.name?.trim() ? ins.targetContact : null;
  const updated = ins.generatedAt ? formatRelative(ins.generatedAt) : '';
  const toggle = () => {
    writeOpen(!open);
    setOpen(!open);
  };
  const sparkle = <span className="flex text-muted"><Sparkles className="size-4" aria-hidden /></span>;

  return (
    <Card className="min-w-0">
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="text-sm font-semibold text-fg">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={toggle}
            className={cn(
              'group flex w-full items-center gap-3 px-4 py-3.5 text-left max-md:min-h-11 sm:px-5 sm:py-4',
              open ? 'rounded-t-2xl border-b border-border' : 'rounded-2xl',
            )}
          >
            {updated ? <Tooltip content={`Updated ${updated}`} describe={false}>{sparkle}</Tooltip> : sparkle}
            <span className="min-w-0 flex-1">AI insights</span>
            <ChevronDown
              className={cn('size-4 shrink-0 text-muted transition-transform group-hover:text-fg', !open && '-rotate-90')}
              aria-hidden
            />
          </button>
        </h2>
        <div id={bodyId} hidden={!open} className="space-y-5 p-4 sm:p-5">
          {summary && <p className="max-w-prose text-sm leading-6 whitespace-pre-line text-fg">{summary}</p>}
          {(pitch || contact) && (
            <div>
              <h3 className="text-xs font-semibold text-muted">How to approach</h3>
              <div className="mt-2 max-w-prose space-y-2 border-l-2 border-accent/60 pl-3 text-sm leading-6 text-fg">
                {pitch && <p className="whitespace-pre-line">{pitch}</p>}
                {contact && (
                  <p>
                    <span className="font-medium">Ask for </span>
                    {contact.name}{contact.title?.trim() ? `, ${contact.title.trim()}` : ''}
                    {contact.why?.trim() && <span className="text-muted"> · {contact.why.trim()}</span>}
                  </p>
                )}
              </div>
            </div>
          )}
          {points.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted">Talking points</h3>
              <ul className="mt-2 max-w-prose list-disc space-y-2 pl-5 text-sm leading-6 text-fg marker:text-subtle">
                {points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}
        </div>
      </section>
    </Card>
  );
}

/** The talking points that have text, trimmed; [] for a missing or malformed list. */
export function cleanPoints(points: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(points)) return [];
  return points.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim());
}
