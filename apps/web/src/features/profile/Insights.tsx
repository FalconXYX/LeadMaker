// AI insights on the Overview tab: one card that reads top to bottom (the business summary, how to approach them and
// who to ask for, then the talking points) and collapses as a whole from its header; the choice is remembered on this
// device. The batch insights job writes them (Section 4). The header's Refresh regenerates them for this lead from what
// it holds now (tags, notes, logged activity, edits); a lead without any shows the card with Generate.
import { Check, ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Card, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { safeStorage } from '@/lib/storage';
import { useProfile } from './context';
import { REFRESH_ERROR, useInsightsRefresh, type RefreshPhase } from './insightsRefresh';

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
  const { phase, refresh } = useInsightsRefresh(profile.id, ins?.generatedAt);
  const summary = ins?.businessSummary?.trim() ?? '';
  const pitch = ins?.salesRecommendation?.trim() ?? '';
  const sparkle = <span className="flex text-muted"><Sparkles className="size-4" aria-hidden /></span>;
  const updating = phase === 'updating';
  // The worker never sends a do-not-contact lead to the model (crm-write answers 409), so it gets no button.
  const canRefresh = profile.details.accountStatus !== 'do_not_contact';

  if (!ins || (!summary && !pitch)) {
    if (!canRefresh) return null;
    // Nothing to read yet: the same card, with Generate in place of Refresh and nothing to collapse.
    return (
      <Card className="min-w-0">
        <section aria-labelledby={headingId} aria-busy={updating || undefined}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 max-md:min-h-11 sm:px-5 sm:py-3">
            {sparkle}
            <h2 id={headingId} className="min-w-0 flex-1 text-sm font-semibold text-fg">AI insights</h2>
            <RefreshButton phase={phase} onClick={refresh} idleLabel="Generate" busyLabel="Generating…" />
          </div>
          <RefreshProblem phase={phase} />
          <p className={cn('p-4 text-sm leading-6 text-muted transition-opacity sm:p-5', updating && 'opacity-60')}>
            No AI insights for this lead yet. Generate writes a summary and talking points from its profile, tags, notes
            and activity.
          </p>
          <RefreshStatus phase={phase} />
        </section>
      </Card>
    );
  }

  // Older or partial bodies may lack the newer fields: treat them as empty.
  const points = cleanPoints(ins.talkingPoints);
  const contact = ins.targetContact?.name?.trim() ? ins.targetContact : null;
  const updated = ins.generatedAt ? formatRelative(ins.generatedAt) : '';
  const toggle = () => {
    writeOpen(!open);
    setOpen(!open);
  };

  return (
    <Card className="min-w-0">
      <section aria-labelledby={headingId} aria-busy={updating || undefined}>
        {/* Refresh sits over the header's right end, left of the chevron, as the toggle's sibling (its own click target). */}
        <div className="relative">
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
          {canRefresh && (
            <div className="absolute top-1/2 right-10 -translate-y-1/2 sm:right-11">
              <RefreshButton phase={phase} onClick={refresh} idleLabel="Refresh" busyLabel="Updating…" />
            </div>
          )}
        </div>
        <RefreshProblem phase={phase} />
        <div
          id={bodyId}
          hidden={!open}
          className={cn('space-y-5 p-4 transition-opacity sm:p-5', updating && 'opacity-60')}
        >
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
        <RefreshStatus phase={phase} />
      </section>
    </Card>
  );
}

/**
 * Refresh / Generate: a small quiet button. While the new insight is on its way it reads "Updating…" with the icon
 * turning and ignores clicks (it stays focusable); then "Updated" for a moment.
 */
function RefreshButton({ phase, onClick, idleLabel, busyLabel }: {
  phase: RefreshPhase;
  onClick: () => void;
  idleLabel: string;
  busyLabel: string;
}) {
  const updating = phase === 'updating';
  return (
    <button
      type="button"
      onClick={() => {
        if (!updating) onClick();
      }}
      aria-disabled={updating || undefined}
      data-phase={phase}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition-colors max-md:h-11',
        // One color set per state (cn doesn't merge conflicting utilities).
        updating ? 'cursor-progress text-muted'
          : phase === 'updated' ? 'text-success'
            : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      {phase === 'updated'
        ? <Check className="size-3.5" aria-hidden />
        : <RefreshCw className={cn('size-3.5', updating && 'animate-spin')} aria-hidden />}
      {updating ? busyLabel : phase === 'updated' ? 'Updated' : idleLabel}
    </button>
  );
}

/** The failure line, under the header so it shows on a collapsed card too. */
function RefreshProblem({ phase }: { phase: RefreshPhase }) {
  if (phase !== 'error') return null;
  return <p role="alert" className="px-4 pt-3 text-xs text-danger sm:px-5">{REFRESH_ERROR}</p>;
}

/** Screen readers hear the start and the end; the button's own text says the same on screen. */
function RefreshStatus({ phase }: { phase: RefreshPhase }) {
  const text = phase === 'updating' ? 'Updating AI insights…' : phase === 'updated' ? 'AI insights updated.' : '';
  return <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{text}</p>;
}

/** The talking points that have text, trimmed; [] for a missing or malformed list. */
export function cleanPoints(points: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(points)) return [];
  return points.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim());
}
