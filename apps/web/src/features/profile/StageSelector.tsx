import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { Select, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { SALES_STAGES, STAGE_LABELS } from '@/lib/labels';
import { useProfile } from './context';
import { FUNNEL, STAGE_HINTS, salesOf, type SalesStage } from './sales';
import { Highlight, ReadOnlyHint } from './ui';

// Arrow segments: each one notched on the left (except the first) and pointed on the right.
const NOTCH = '[clip-path:polygon(0_0,calc(100%_-_10px)_0,100%_50%,calc(100%_-_10px)_100%,0_100%,10px_50%)]';
const FIRST = '[clip-path:polygon(0_0,calc(100%_-_10px)_0,100%_50%,calc(100%_-_10px)_100%,0_100%)]';

/** Each stage's theme colour: solid for the current step, a tint for the steps behind it. */
const TONE: Record<SalesStage, { solid: string; soft: string; check: string; bar: string }> = {
  new: { solid: 'bg-stage-new text-surface', soft: 'bg-stage-new-soft text-fg', check: 'text-stage-new', bar: 'bg-stage-new' },
  contacted: { solid: 'bg-stage-contacted text-surface', soft: 'bg-stage-contacted-soft text-fg', check: 'text-stage-contacted', bar: 'bg-stage-contacted' },
  interested: { solid: 'bg-stage-interested text-surface', soft: 'bg-stage-interested-soft text-fg', check: 'text-stage-interested', bar: 'bg-stage-interested' },
  quoting: { solid: 'bg-stage-quoting text-surface', soft: 'bg-stage-quoting-soft text-fg', check: 'text-stage-quoting', bar: 'bg-stage-quoting' },
  won: { solid: 'bg-stage-won text-surface', soft: 'bg-stage-won-soft text-fg', check: 'text-stage-won', bar: 'bg-stage-won' },
  lost: { solid: 'bg-stage-lost text-surface', soft: 'bg-stage-lost-soft text-fg', check: 'text-stage-lost', bar: 'bg-stage-lost' },
};

/** The sales path: New → Contacted → Interested → Quoting → Won, and Not a fit beside it. A select on phones. */
export function StageSelector() {
  const { profile, canEdit, readOnlyReason, m } = useProfile();
  const { salesStage: stage, stageChangedAt } = salesOf(profile);
  const group = useRef<HTMLDivElement>(null);
  const reached = stage === 'lost' ? -1 : FUNNEL.indexOf(stage);

  const choose = (next: SalesStage) => {
    if (next === stage || !canEdit) return;
    m.setStage.mutate({ stage: next, version: profile.version });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SALES_STAGES.indexOf(stage);
    const n = SALES_STAGES.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(SALES_STAGES[next]!);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const since = stageChangedAt ? `${STAGE_LABELS[stage]} since ${formatDate(stageChangedAt).replace(/, \d{4}$/, '')}` : null;

  return (
    <Highlight k="stage" className="rounded-lg">
      {/* phones */}
      <div className="md:hidden">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="stage-select" className="text-xs font-semibold tracking-wide text-muted uppercase">Stage</label>
          {since && <span className="text-xs text-muted">{since}</span>}
        </div>
        <div className="mb-2 flex gap-1" aria-hidden="true">
          {FUNNEL.map((s, i) => (
            <span key={s} className={cn('h-1.5 flex-1 rounded-full', i <= reached ? TONE[stage].bar : 'bg-surface-3')} />
          ))}
        </div>
        <ReadOnlyHint reason={canEdit ? null : readOnlyReason} className="w-full">
          <Select
            id="stage-select"
            className="w-full"
            value={stage}
            onValueChange={choose}
            disabled={!canEdit}
            options={SALES_STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
          />
        </ReadOnlyHint>
      </div>

      {/* tablets and up */}
      <div className="hidden items-center gap-3 md:flex">
        <span className="shrink-0 text-xs font-semibold tracking-wide text-muted uppercase">Stage</span>
        <ReadOnlyHint reason={canEdit ? null : readOnlyReason} className="min-w-0 flex-1">
          <div
            ref={group}
            role="radiogroup"
            aria-label="Sales stage"
            aria-busy={m.setStage.isPending || undefined}
            onKeyDown={onKey}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <div className="flex min-w-0 flex-1">
              {FUNNEL.map((s, i) => {
                const current = s === stage;
                const done = i < reached;
                return (
                  <Tooltip key={s} content={STAGE_HINTS[s]} describe={false}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={current}
                      tabIndex={current || (stage === 'lost' && i === 0) ? 0 : -1}
                      disabled={!canEdit}
                      onClick={() => choose(s)}
                      className={cn(
                        'relative -ml-1.5 inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1 pr-3 pl-5 text-sm font-medium transition-colors first:ml-0 first:pl-3',
                        'disabled:cursor-not-allowed',
                        i === 0 ? FIRST : NOTCH,
                        current
                          ? cn(TONE[s].solid, 'font-semibold')
                          : done ? cn(TONE[stage].soft, 'hover:brightness-95') : 'bg-surface-2 text-muted hover:bg-hover hover:text-fg',
                      )}
                    >
                      {done && <Check className={cn('size-3.5 shrink-0', TONE[stage].check)} aria-hidden />}
                      <span className="truncate">{STAGE_LABELS[s]}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
            <Tooltip content={STAGE_HINTS.lost} describe={false}>
              <button
                type="button"
                role="radio"
                aria-checked={stage === 'lost'}
                tabIndex={stage === 'lost' ? 0 : -1}
                disabled={!canEdit}
                onClick={() => choose('lost')}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed',
                  stage === 'lost' ? cn('border-transparent', TONE.lost.solid) : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {STAGE_LABELS.lost}
              </button>
            </Tooltip>
          </div>
        </ReadOnlyHint>
        {since && <span className="hidden shrink-0 text-xs text-muted xl:inline">{since}</span>}
      </div>
    </Highlight>
  );
}
