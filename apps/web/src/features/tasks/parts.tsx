import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Dialog, Field, Input, Menu, type MenuItem, type MenuProps } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { Task, TaskType } from './api';
import { PRESET_LABELS, dueError, formatDay, presetDay, salesDay, today, type DueChoice, type DuePreset } from './dates';
import { TASK_TYPE_META } from './model';

export function TaskTypeIcon({ type, size = 'md', className }: { type: TaskType; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  const meta = TASK_TYPE_META[type] ?? TASK_TYPE_META.todo;
  const Icon = meta.icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        size === 'xs' ? 'size-5 [&_svg]:size-3' : size === 'sm' ? 'size-7 [&_svg]:size-3.5' : 'size-8 [&_svg]:size-4',
        meta.tone, className,
      )}
    >
      <Icon />
    </span>
  );
}

export interface ChipOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Quieter text after the label (e.g. the date a preset means). */
  hint?: ReactNode;
  /** Classes while selected (defaults to the cool-sky fill). */
  selectedClassName?: string;
  /** A marker for the current value (e.g. the lead's stage now). */
  current?: boolean;
}

/**
 * Single-choice chips with radio semantics: arrow keys move and choose, Home/End jump. `allowEmpty` lets a second
 * click on the chosen chip clear the choice (optional answers such as an outcome).
 */
export function ChipGroup<V extends string>({
  label, value, onChange, options, allowEmpty, disabled, className, labelledBy, autoFocus,
}: {
  label?: string;
  labelledBy?: string;
  value: V | null;
  onChange: (v: V | null) => void;
  options: readonly ChipOption<V>[];
  allowEmpty?: boolean;
  disabled?: boolean;
  className?: string;
  /** The tabbable chip takes focus when a dialog opens. */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const i = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const n = buttons.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0 : n - 1;
    buttons[next]?.focus();
    onChange(options[next]!.value);
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const tabbable = selected || (active < 0 && i === 0);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            data-autofocus={autoFocus && tabbable ? '' : undefined}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => onChange(selected && allowEmpty ? null : o.value)}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0',
              selected
                ? (o.selectedClassName ?? 'border-accent bg-accent text-accent-fg shadow-sm')
                : 'border-border bg-surface text-fg hover:border-border-strong hover:bg-hover',
            )}
          >
            {selected && !o.icon ? <Check aria-hidden /> : o.icon}
            {o.label}
            {o.hint && <span className={cn('text-xs font-normal', selected ? 'opacity-80' : 'text-muted')}>{o.hint}</span>}
            {o.current && !selected && <span className="text-xs font-normal text-muted">(now)</span>}
          </button>
        );
      })}
    </div>
  );
}

const shortDay = (day: string) => formatDay(day).replace(/,.*$/, '');

/** Tomorrow / In 3 days / Next week / Pick a date, each with the day it means. */
export function DuePicker({
  value, onChange, presets = ['tomorrow', 'in3', 'nextWeek'], labelledBy, disabled, error,
}: {
  value: DueChoice;
  onChange: (v: DueChoice) => void;
  presets?: readonly DuePreset[];
  labelledBy?: string;
  disabled?: boolean;
  error?: string | null;
}) {
  const dateRef = useRef<HTMLInputElement>(null);
  const [lastDate, setLastDate] = useState(value.preset === 'date' ? value.day : '');
  const options: ChipOption<DuePreset | 'date'>[] = [
    ...presets.map((p) => ({ value: p, label: PRESET_LABELS[p], hint: shortDay(presetDay(p)) })),
    { value: 'date', label: 'Pick a date' },
  ];
  const picking = value.preset === 'date';
  useEffect(() => {
    if (picking) dateRef.current?.focus({ preventScroll: true });
  }, [picking]);
  return (
    <div className="flex flex-col gap-2">
      <ChipGroup
        labelledBy={labelledBy}
        label="When"
        value={value.preset}
        disabled={disabled}
        onChange={(v) => {
          if (!v) return;
          onChange(v === 'date' ? { preset: 'date', day: lastDate } : { preset: v });
        }}
        options={options}
      />
      {picking && (
        <Input
          ref={dateRef}
          type="date"
          aria-label="Follow-up date"
          min={today()}
          value={value.day}
          disabled={disabled}
          invalid={!!error}
          onChange={(e) => {
            setLastDate(e.target.value);
            onChange({ preset: 'date', day: e.target.value });
          }}
          className="w-full sm:w-52"
        />
      )}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

/** The round "done" control at the start of a task row. */
export function CompleteToggle({
  checked, onChange, label, disabled, size = 'md',
}: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'group inline-flex shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'size-5 [&_svg]:size-3' : 'size-[22px] [&_svg]:size-3.5',
        checked
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border-strong bg-surface text-transparent hover:border-accent hover:text-accent',
      )}
    >
      <Check strokeWidth={3} aria-hidden />
    </button>
  );
}

/** Reschedule presets for a task's due date; "Pick a date…" opens a small date dialog. */
export function RescheduleMenu({
  task, onReschedule, trigger, disabled,
}: {
  task: Task;
  onReschedule: (day: string) => void;
  trigger: MenuProps['trigger'];
  disabled?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const current = salesDay(task.dueAt);
  const presets = (['today', 'tomorrow', 'in3', 'nextWeek'] as const).filter((p) => presetDay(p) !== current);
  const items: MenuItem[] = presets.map((p) => ({
    label: PRESET_LABELS[p],
    description: formatDay(presetDay(p)),
    onSelect: () => onReschedule(presetDay(p)),
    disabled,
  }));
  return (
    <>
      <Menu
        align="end"
        trigger={trigger}
        groups={[{ label: 'Move to', items }, { items: [{ label: 'Pick a date…', onSelect: () => setPicking(true), disabled }] }]}
      />
      <PickDateDialog
        open={picking}
        title="Reschedule follow-up"
        description={task.title}
        onClose={() => setPicking(false)}
        onPick={(day) => {
          setPicking(false);
          onReschedule(day);
        }}
      />
    </>
  );
}

export function PickDateDialog({
  open, title, description, onClose, onPick,
}: { open: boolean; title: string; description?: ReactNode; onClose: () => void; onPick: (day: string) => void }) {
  const [day, setDay] = useState(() => presetDay('tomorrow'));
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setDay(presetDay('tomorrow'));
      setTouched(false);
    }
  }, [open]);
  const error = dueError({ preset: 'date', day });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      description={description}
      initialFocus={input}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="lm-pick-date">Move</Button>
        </>
      )}
    >
      <form
        id="lm-pick-date"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!error) onPick(day);
        }}
      >
        <Field label="New due date" error={touched ? error : null}>
          {(p) => <Input {...p} ref={input} type="date" min={today()} value={day} onChange={(e) => setDay(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

/** The due-date button that opens the reschedule menu. */
export function DueButton({
  label, tone, ...props
}: { label: string; tone: 'overdue' | 'today' | 'normal' } & Omit<ComponentProps<'button'>, 'children'>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm font-medium whitespace-nowrap transition-colors hover:bg-hover',
        tone === 'overdue' ? 'text-roof' : tone === 'today' ? 'text-warning' : 'text-muted',
      )}
    >
      {label}
      <ChevronDown className="size-3.5 opacity-70" aria-hidden />
    </button>
  );
}
