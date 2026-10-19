// Add / edit one lead-sourcing area: ZIP, radius (1-50 mi), extra ZIPs, schedule, on/off.
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '@/api/errors';
import { Button, Dialog, Field, Input, Segmented, Toggle } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  RADIUS_MAX, RADIUS_MIN, SCHEDULES, changedFields, formFrom, scheduleLabel, toInput, validateArea,
  type AreaErrors, type AreaForm,
} from './lib';
import type { Territory, TerritoryInput } from './types';

export interface AreaDialogProps {
  open: boolean;
  /** null: a new area. */
  territory: Territory | null;
  onClose: () => void;
  onSave: (input: TerritoryInput, patch: Partial<TerritoryInput> | null) => Promise<unknown>;
}

export function AreaDialog(props: AreaDialogProps) {
  // Remount per open so the form always starts from the area being edited.
  if (!props.open) return null;
  return <AreaDialogBody key={props.territory?.id ?? 'new'} {...props} />;
}

function AreaDialogBody({ open, territory, onClose, onSave }: AreaDialogProps) {
  const [form, setForm] = useState<AreaForm>(() => formFrom(territory));
  const [errors, setErrors] = useState<AreaErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const editing = !!territory;

  const set = <K extends keyof AreaForm>(k: K, v: AreaForm[K]) => {
    const next = { ...form, [k]: v };
    setForm(next);
    // After the first save attempt, errors follow the typing so they clear as soon as they are fixed.
    if (submitted) setErrors(validateArea(next));
  };

  const scheduleValue = SCHEDULES.find((s) => s.hours === form.everyHours)?.value ?? 'custom';
  const scheduleOptions = [
    ...SCHEDULES.map((s) => ({ value: s.value as string, label: s.label })),
    // An interval set elsewhere (CLI) stays selectable, so editing the name never changes the schedule.
    ...(scheduleValue === 'custom' ? [{ value: 'custom', label: scheduleLabel(form.everyHours) }] : []),
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const errs = validateArea(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-form="${formId}"] [aria-invalid="true"]`)?.focus());
      return;
    }
    const input = toInput(form);
    const patch = territory ? changedFields(territory, input) : null;
    if (patch && !Object.keys(patch).length) {
      onClose();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await onSave(input, patch);
      onClose();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const radius = Number(form.radius);
  const sliderValue = Number.isFinite(radius) ? Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, radius)) : RADIUS_MIN;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit area' : 'Add area'}
      description="LeadMaker searches for roofing contractors around this ZIP code, then tags them and writes AI insights."
      initialFocus={zipRef}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>{editing ? 'Save changes' : 'Add area'}</Button>
        </>
      )}
    >
      <form id={formId} data-form={formId} noValidate onSubmit={submit} className="space-y-5 pt-1">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="ZIP code" error={errors.zip}>
            {(p) => (
              <Input
                {...p}
                ref={zipRef}
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={5}
                placeholder="10013"
                value={form.zip}
                invalid={p.invalid}
                onChange={(e) => set('zip', e.target.value.replace(/\s/g, ''))}
              />
            )}
          </Field>
          <Field label="Name (optional)" hint="Defaults to the ZIP code">
            {(p) => <Input {...p} placeholder="Manhattan" value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />}
          </Field>
        </div>

        <RadiusField value={form.radius} slider={sliderValue} error={errors.radius} onChange={(v) => set('radius', v)} />

        <Field
          label="Extra ZIP codes (optional)"
          hint="Also search these, each with the same radius. Separate with commas or spaces."
          error={errors.alsoZips}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              placeholder="07030, 11201"
              value={form.alsoZips}
              invalid={p.invalid}
              onChange={(e) => set('alsoZips', e.target.value)}
            />
          )}
        </Field>

        <div className="space-y-2">
          <p className="text-sm font-medium text-fg" aria-hidden>How often</p>
          <Segmented
            label="How often"
            value={scheduleValue}
            options={scheduleOptions}
            onChange={(v) => {
              if (v === 'custom') return;
              set('everyHours', SCHEDULES.find((s) => s.value === v)?.hours ?? null);
            }}
          />
          <p className="text-xs text-subtle">
            {form.everyHours == null ? 'Runs only when you press Run now.' : `Refreshes ${scheduleLabel(form.everyHours).toLowerCase()} on its own. You can still run it any time.`}
          </p>
        </div>

        <Toggle
          checked={form.enabled}
          onCheckedChange={(v) => set('enabled', v)}
          label="Turned on"
          description="When off, scheduled runs pause. Leads already found stay."
        />

        {failure && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{failure}</p>
        )}
      </form>
    </Dialog>
  );
}

function RadiusField({ value, slider, error, onChange }: { value: string; slider: number; error?: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-range`} className="text-sm font-medium text-fg">Search radius</label>
        <div className="flex items-center gap-1.5 text-sm text-muted">
          <Input
            id={`${id}-num`}
            type="number"
            inputSize="sm"
            min={RADIUS_MIN}
            max={RADIUS_MAX}
            step={1}
            aria-label="Search radius in miles"
            aria-describedby={error ? `${id}-error` : undefined}
            invalid={!!error}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-20"
          />
          mi
        </div>
      </div>
      <input
        id={`${id}-range`}
        type="range"
        min={RADIUS_MIN}
        max={RADIUS_MAX}
        step={1}
        value={slider}
        aria-valuetext={`${slider} miles`}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-2 w-full cursor-pointer accent-accent')}
      />
      <div className="flex justify-between text-xs text-subtle" aria-hidden>
        <span>{RADIUS_MIN} mi</span>
        <span>{RADIUS_MAX} mi</span>
      </div>
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </div>
  );
}
