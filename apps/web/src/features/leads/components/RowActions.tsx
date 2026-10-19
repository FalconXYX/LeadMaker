// Quick actions on one lead: call, log a call, add a follow-up, change the stage. The table shows them on row
// hover / focus; cards show them in their footer. Read-only leads keep them focusable with the reason.
import { CalendarPlus, ChevronDown, NotebookPen, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LeadSummary } from '@/api/types';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { stageOf, type SalesStage } from '../sales';
import { FloatingMenu, useMenuAnchor } from './FloatingMenu';
import { StageMenuItems } from './stage';

export interface LeadActions {
  onLogCall: (lead: LeadSummary) => void;
  onFollowUp: (lead: LeadSummary) => void;
  onStage: (lead: LeadSummary, stage: SalesStage) => void;
}

interface Props {
  lead: LeadSummary;
  readOnlyReason: string | null;
  actions: LeadActions;
  variant: 'table' | 'card';
  className?: string;
}

export function RowActions({ lead, readOnlyReason, actions, variant, className }: Props) {
  const menu = useMenuAnchor();
  const card = variant === 'card';
  const stage = stageOf(lead);
  const pick = (s: SalesStage) => {
    menu.close(true);
    if (s !== stage) actions.onStage(lead, s);
  };
  return (
    <div
      role="group"
      aria-label={`Quick actions for ${lead.businessName}`}
      data-no-row-click
      className={cn(
        'flex items-center',
        card ? 'gap-1.5' : 'gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-md',
        className,
      )}
    >
      {lead.phone ? (
        <Tooltip content={`Call ${lead.phone}`} describe={false}>
          <a href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`} aria-label={`Call ${lead.businessName}`} onClick={(e) => e.stopPropagation()} className={itemClass(card)}>
            <Phone aria-hidden />{card && 'Call'}
          </a>
        </Tooltip>
      ) : (
        <Action card={card} label="Call" name={lead.businessName} icon={<Phone />} reason="No phone number on file" />
      )}
      <Action card={card} label="Log call" name={lead.businessName} icon={<NotebookPen />} reason={readOnlyReason} onClick={() => actions.onLogCall(lead)} />
      <Action card={card} label={card ? 'Follow-up' : 'Add follow-up'} name={lead.businessName} icon={<CalendarPlus />} reason={readOnlyReason} onClick={() => actions.onFollowUp(lead)} />
      {!card && (
        readOnlyReason ? (
          <Action card={false} label="Change stage" name={lead.businessName} icon={<StageLabel />} reason={readOnlyReason} wide />
        ) : (
          <>
            <Tooltip content="Change stage" describe={false}>
              <button
                ref={menu.setAnchor}
                type="button"
                aria-haspopup="menu"
                aria-expanded={menu.open}
                aria-label={`Change stage: ${lead.businessName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  menu.setOpen(!menu.open);
                }}
                className={cn(itemClass(false), 'w-auto! px-2')}
              >
                <StageLabel />
              </button>
            </Tooltip>
            <FloatingMenu anchor={menu.anchor} open={menu.open} onClose={menu.close} label={`Stage for ${lead.businessName}`} align="end">
              <StageMenuItems value={stage} onPick={pick} />
            </FloatingMenu>
          </>
        )
      )}
    </div>
  );
}

const itemClass = (card: boolean) => cn(
  'inline-flex items-center justify-center text-muted transition-colors outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus/50',
  card
    ? 'h-8 flex-1 gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-fg [&_svg]:size-3.5'
    : 'size-7 rounded-md [&_svg]:size-4',
);

function StageLabel() {
  return <span className="inline-flex items-center gap-0.5 text-xs font-medium">Stage<ChevronDown className="size-3.5!" aria-hidden /></span>;
}

function Action({
  card, label, name, icon, reason, onClick, wide,
}: { card: boolean; label: string; name: string; icon: ReactNode; reason?: string | null; onClick?: () => void; wide?: boolean }) {
  const disabled = !!reason || !onClick;
  return (
    <Tooltip content={reason ?? label} describe={!!reason}>
      <button
        type="button"
        aria-label={`${label}: ${name}`}
        aria-disabled={disabled || undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onClick?.();
        }}
        className={cn(itemClass(card), wide && 'w-auto! px-2', disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted')}
      >
        {icon}{card && label}
      </button>
    </Tooltip>
  );
}
