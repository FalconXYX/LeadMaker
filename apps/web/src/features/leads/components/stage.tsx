// Sales stage pill and the stage picker (inline in the table, in the row actions and in the bulk bar).
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SALES_STAGES, STAGE_HINTS, STAGE_LABELS, STAGE_TONE, type SalesStage } from '../sales';
import { FloatingMenu, useMenuAnchor } from './FloatingMenu';

export function StageDot({ stage, className }: { stage: SalesStage; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STAGE_TONE[stage].dot, className)} />;
}

export function StagePill({ stage, className, children }: { stage: SalesStage; className?: string; children?: ReactNode }) {
  return (
    <span className={cn('inline-flex h-6 max-w-full items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap', STAGE_TONE[stage].pill, className)}>
      <StageDot stage={stage} />
      <span className="truncate">{STAGE_LABELS[stage]}</span>
      {children}
    </span>
  );
}

export function StageMenuItems({ value, onPick }: { value: SalesStage | null; onPick: (s: SalesStage) => void }) {
  return (
    <>
      {SALES_STAGES.map((s) => (
        <button
          key={s}
          type="button"
          role="menuitemradio"
          aria-checked={s === value}
          tabIndex={-1}
          onClick={() => onPick(s)}
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none hover:bg-hover focus:bg-hover',
            s === 'lost' && 'mt-1 border-t border-border pt-2',
          )}
        >
          <StageDot stage={s} />
          <span className="min-w-0 flex-1">
            <span className={cn('block text-sm text-fg', s === value && 'font-semibold')}>{STAGE_LABELS[s]}</span>
            <span className="block text-[11px] text-muted">{STAGE_HINTS[s]}</span>
          </span>
          {s === value && <Check className="size-4 shrink-0 text-fg" aria-hidden />}
        </button>
      ))}
    </>
  );
}

/** The stage as a pill; writable leads open the picker from it, read-only ones explain why in a tooltip. */
export function StageSelect({
  stage, leadName, readOnlyReason, onChange, className,
}: {
  stage: SalesStage;
  leadName: string;
  readOnlyReason: string | null;
  onChange: (stage: SalesStage) => void;
  className?: string;
}) {
  const menu = useMenuAnchor();
  const { setOpen } = menu;
  const pick = useCallback((s: SalesStage) => {
    setOpen(false);
    menu.anchor?.focus();
    if (s !== stage) onChange(s);
  }, [setOpen, menu.anchor, stage, onChange]);
  if (readOnlyReason) {
    return (
      <Tooltip content={readOnlyReason}>
        <span tabIndex={0} className={cn('inline-flex max-w-full rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus/50', className)}>
          <StagePill stage={stage} />
        </span>
      </Tooltip>
    );
  }
  return (
    <>
      <button
        ref={menu.setAnchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={`Stage: ${STAGE_LABELS[stage]}. Change stage for ${leadName}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!menu.open);
        }}
        className={cn('group/stage inline-flex max-w-full rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus/50', className)}
      >
        <StagePill stage={stage} className="transition-shadow group-hover/stage:shadow-[inset_0_0_0_1px_var(--c-border-strong)]">
          <ChevronDown className="-mr-0.5 size-3 shrink-0 opacity-60" aria-hidden />
        </StagePill>
      </button>
      <FloatingMenu anchor={menu.anchor} open={menu.open} onClose={menu.close} label={`Stage for ${leadName}`}>
        <StageMenuItems value={stage} onPick={pick} />
      </FloatingMenu>
    </>
  );
}
