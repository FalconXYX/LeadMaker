// One overridable value (company field or contact field): effective value, Edited / Source changed badges,
// inline edit with the version the user started from, revert-to-source, and the 409 conflict flow.
import { Pencil, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EffectiveField } from '@/api/types';
import { Button, EditedBadge, IconButton, Input, SourceChangedBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useVersionedWrite } from './conflict';
import { useProfile } from './context';
import { formatValue, sameValue } from './lib';
import { Highlight } from './ui';

export interface EditableValueProps {
  label: string;
  field: EffectiveField<string | null>;
  /** Current version of what the override is checked against (company or contact). */
  version: number;
  validate?: (raw: string) => string | null;
  /** Draft -> value to send (default: trimmed, '' -> null). */
  normalize?: (raw: string) => string | null;
  inputType?: 'text' | 'tel' | 'email' | 'url';
  renderValue?: (value: string) => ReactNode;
  onSave: (value: string | null, version: number) => Promise<unknown>;
  onRevert: (version: number) => Promise<unknown>;
  /** Who the scraped value comes from ("GAF"). */
  sourceName: string;
  /** row: label column + value (company facts); inline: value only (contact cards). */
  layout?: 'row' | 'inline';
  emptyText?: string;
  highlightKey?: string;
  className?: string;
  valueClassName?: string;
  placeholder?: string;
}

interface Draft {
  text: string;
  baseValue: string | null;
  baseVersion: number;
}

export function EditableValue({
  label, field, version, validate, normalize, inputType = 'text', renderValue, onSave, onRevert, sourceName,
  layout = 'row', emptyText = 'Not listed', highlightKey, className, valueClassName, placeholder,
}: EditableValueProps) {
  const { canEdit } = useProfile();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = useVersionedWrite();
  const inputRef = useRef<HTMLInputElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const editing = draft !== null;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft({ text: field.value ?? '', baseValue: field.value, baseVersion: version });
    setError(null);
  };
  const close = (refocus = true) => {
    setDraft(null);
    setError(null);
    if (refocus) requestAnimationFrame(() => editBtn.current?.focus());
  };

  const save = async () => {
    if (!draft) return;
    const problem = validate?.(draft.text) ?? null;
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    const next = normalize ? normalize(draft.text) : draft.text.trim() || null;
    if (sameValue(next, draft.baseValue)) return close();
    await write.run({
      label, base: draft.baseValue, mine: next, version: draft.baseVersion,
      attempt: (v) => onSave(next, v), onDone: () => close(),
    });
  };

  const revert = (fromEditor: boolean) =>
    write.run({
      label, mode: 'revert', base: fromEditor && draft ? draft.baseValue : field.value, mine: field.scraped,
      version: fromEditor && draft ? draft.baseVersion : version,
      attempt: (v) => onRevert(v), onDone: () => close(fromEditor),
    });

  const keepMine = () =>
    write.run({ label, base: field.value, mine: field.value, version, attempt: (v) => onSave(field.value, v), onDone: () => {} });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const remoteChanged = draft !== null && !sameValue(field.value, draft.baseValue);
  const value = field.value;
  const blank = value === null || value.trim() === '';

  const editor = draft && (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          ref={inputRef}
          inputSize="sm"
          type={inputType}
          value={draft.text}
          placeholder={placeholder ?? label}
          aria-label={label}
          invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setDraft({ ...draft, text: e.target.value });
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          className="min-w-[10rem] flex-1"
        />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="primary" loading={write.busy} onClick={() => void save()}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => close()} disabled={write.busy}>Cancel</Button>
        </div>
      </div>
      {error && <p id={errorId} className="text-xs text-danger">{error}</p>}
      {remoteChanged && (
        <p className="text-xs text-warning" role="status">
          Changed to “{formatValue(field.value)}”{field.editedBy ? ` by ${field.editedBy.name}` : ''} while you were editing.
          Saving will ask which value to keep.
        </p>
      )}
      {field.overridden && (
        <button
          type="button"
          onClick={() => void revert(true)}
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          <RotateCcw className="size-3" aria-hidden />
          Revert to {sourceName} value{field.scraped ? ` (“${field.scraped}”)` : ' (empty)'}
        </button>
      )}
    </div>
  );

  const badges = field.overridden && (
    <>
      <EditedBadge by={field.editedBy?.name} at={field.editedAt} />
      {layout === 'row' && field.editedBy && (
        <span className="text-xs text-subtle">
          by {field.editedBy.name}{field.editedAt ? ` · ${formatRelative(field.editedAt)}` : ''}
        </span>
      )}
      {field.sourceChangedSinceEdit && <SourceChangedBadge scraped={formatValue(field.scraped)} />}
    </>
  );

  const sourceNote = field.overridden && field.sourceChangedSinceEdit && !editing && (
    <div role="note" className="mt-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
      <p className="text-fg">
        <span className="font-semibold text-warning">Source changed since your edit:</span>{' '}
        {sourceName} now says “{formatValue(field.scraped)}”.
      </p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void keepMine()} disabled={write.busy}>Keep mine</Button>
          <Button size="sm" variant="ghost" onClick={() => void revert(false)} disabled={write.busy}>Use source</Button>
        </div>
      )}
    </div>
  );

  const display = (
    <div className="flex min-h-7 items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {blank ? (
            canEdit && layout === 'inline' ? (
              <button
                type="button"
                onClick={start}
                className="inline-flex items-center gap-1 text-sm text-subtle hover:text-accent hover:underline"
              >
                <Plus className="size-3.5" aria-hidden />Add {label.toLowerCase()}
              </button>
            ) : (
              <span className="text-sm text-subtle">{emptyText}</span>
            )
          ) : (
            <span className={cn('min-w-0 text-sm break-words text-fg', valueClassName)}>{renderValue ? renderValue(value!) : value}</span>
          )}
          {badges}
        </div>
        {sourceNote}
      </div>
      {canEdit && !(blank && layout === 'inline') && (
        <IconButton
          ref={editBtn}
          size="sm"
          label={`Edit ${label.toLowerCase()}`}
          icon={<Pencil />}
          onClick={start}
          className={cn(
            '-my-0.5 shrink-0 text-subtle',
            // Compact cards reveal the pencil on hover / focus (always visible on touch screens).
            layout === 'inline' && 'pointer-fine:opacity-0 pointer-fine:group-hover/ev:opacity-100 focus-visible:opacity-100',
          )}
        />
      )}
    </div>
  );

  if (layout === 'inline') {
    return (
      <Highlight k={highlightKey} className={cn('group/ev rounded-md', className)}>
        {editing ? editor : display}
        {write.dialog}
      </Highlight>
    );
  }
  return (
    <Highlight
      k={highlightKey}
      className={cn('-mx-2 grid gap-x-5 gap-y-1.5 rounded-lg px-2 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]', className)}
    >
      <dt className="pt-1 text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0">
        {editing ? editor : display}
        {write.dialog}
      </dd>
    </Highlight>
  );
}
