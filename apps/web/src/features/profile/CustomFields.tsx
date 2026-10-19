import { ListPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useCustomFieldKeys } from '@/api/queries';
import { Button, Field, IconButton, Input, Select } from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';
import { useVersionedWrite } from './conflict';
import { useProfile } from './context';
import { CUSTOM_FIELD_KEY, formatValue, slugifyKey } from './lib';
import { Highlight, ReadOnlyHint, SectionCard } from './ui';

type Scalar = string | number | boolean | null;
type ValueType = 'text' | 'number' | 'boolean' | 'date';

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
] as const satisfies readonly { value: ValueType; label: string }[];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function typeOf(v: unknown): ValueType | null {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return ISO_DATE.test(v) ? 'date' : 'text';
  return null;
}

const dateOnly = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function displayCustomValue(v: unknown): string {
  // A bare YYYY-MM-DD is a calendar date: format it as such, not as UTC midnight (which shifts the day west of UTC).
  const day = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (day) return dateOnly.format(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
  if (typeof v === 'string' && ISO_DATE.test(v)) return formatDate(v);
  if (typeof v === 'number') return new Intl.NumberFormat('en-US').format(v);
  return formatValue(v);
}

/** Draft text -> value for the type; an error string when it does not parse. */
function parseValue(type: ValueType, raw: string): { value: Scalar } | { error: string } {
  const s = raw.trim();
  if (type === 'boolean') return s === 'true' ? { value: true } : s === 'false' ? { value: false } : { error: 'Choose Yes or No.' };
  if (!s) return { error: 'Enter a value (or remove the field).' };
  if (type === 'number') {
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
  }
  if (type === 'date') return ISO_DATE.test(s) && !Number.isNaN(Date.parse(s)) ? { value: s } : { error: 'Pick a date.' };
  return s.length > 1000 ? { error: 'Keep it under 1000 characters.' } : { value: s };
}

function toDraft(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

export function CustomFieldsCard() {
  const { profile, canEdit, readOnlyReason } = useProfile();
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(profile.customFields).sort(([a], [b]) => a.localeCompare(b));
  return (
    <SectionCard
      title="Custom fields"
      icon={<ListPlus />}
      description="Info slots your team fills in. Visible to everyone on this lead."
      actions={
        <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
          <Button size="sm" leftIcon={<Plus className="size-3.5" />} onClick={() => setAdding(true)} disabled={!canEdit || adding}>
            Add field
          </Button>
        </ReadOnlyHint>
      }
      bodyClassName="px-4 py-2 sm:px-5 sm:py-2.5"
    >
      {entries.length > 0 && (
        <dl className="divide-y divide-border">
          {entries.map(([k, v]) => <CustomFieldRow key={k} fieldKey={k} value={v} />)}
        </dl>
      )}
      {entries.length === 0 && !adding && (
        <p className="py-2 text-sm text-subtle">No custom fields yet. Add the details your team tracks, like crew size or current supplier.</p>
      )}
      {adding && <AddFieldForm onDone={() => setAdding(false)} />}
    </SectionCard>
  );
}

function CustomFieldRow({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  const { profile, canEdit, m } = useProfile();
  const type = typeOf(value);
  const [draft, setDraft] = useState<{ text: string; base: unknown; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const write = useVersionedWrite();
  const inputRef = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const errorId = useId();
  const label = humanize(fieldKey);

  const isEditing = draft !== null;
  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const attempt = (next: Scalar) => (version: number) => m.setCustomField.mutateAsync({ key: fieldKey, value: next, version });

  const save = async () => {
    if (!draft || !type) return;
    const parsed = parseValue(type, draft.text);
    if ('error' in parsed) return setError(parsed.error);
    if (parsed.value === draft.base) return setDraft(null);
    await write.run({ label, base: draft.base, mine: parsed.value, version: draft.version, attempt: attempt(parsed.value), onDone: () => setDraft(null) });
  };

  const remove = () =>
    write.run({ label, mode: 'save', base: value, mine: null, version: profile.version, attempt: attempt(null), onDone: () => setConfirmRemove(false) });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
    }
  };

  const remoteChanged = draft !== null && JSON.stringify(value) !== JSON.stringify(draft.base);

  return (
    <Highlight k={`cf:${fieldKey}`} className="-mx-2 grid gap-x-5 gap-y-1.5 rounded-lg px-2 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt className="pt-1 text-xs font-medium break-words text-muted">{label}{label !== fieldKey && <span className="sr-only"> ({fieldKey})</span>}</dt>
      <dd className="min-w-0">
        {draft && type ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {type === 'boolean' ? (
                <Select
                  ref={inputRef}
                  selectSize="sm"
                  aria-label={label}
                  value={draft.text as 'true' | 'false'}
                  onValueChange={(v) => setDraft({ ...draft, text: v })}
                  options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
                  onKeyDown={onKeyDown}
                  className="w-32"
                />
              ) : (
                <Input
                  ref={inputRef}
                  inputSize="sm"
                  type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                  aria-label={label}
                  value={type === 'date' ? draft.text.slice(0, 10) : draft.text}
                  invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, text: e.target.value });
                    setError(null);
                  }}
                  onKeyDown={onKeyDown}
                  className="min-w-[10rem] flex-1"
                />
              )}
              <Button size="sm" variant="primary" loading={write.busy} onClick={() => void save()}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
            {error && <p id={errorId} className="text-xs text-danger">{error}</p>}
            {remoteChanged && (
              <p className="text-xs text-warning" role="status">Changed to “{displayCustomValue(value)}” while you were editing. Saving will ask which to keep.</p>
            )}
          </div>
        ) : confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg">Remove “{label}” from this lead?</span>
            <Button size="sm" variant="danger" loading={write.busy} onClick={() => void remove()}>Remove</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex min-h-7 items-start gap-1">
            <span className="min-w-0 flex-1 pt-0.5 text-sm break-words text-fg">{displayCustomValue(value)}</span>
            {canEdit && type && (
              <IconButton
                size="sm"
                label={`Edit ${label.toLowerCase()}`}
                icon={<Pencil />}
                className="-my-0.5 text-subtle"
                onClick={() => {
                  setDraft({ text: toDraft(value), base: value, version: profile.version });
                  setError(null);
                }}
              />
            )}
            {canEdit && (
              <IconButton size="sm" label={`Remove ${label.toLowerCase()}`} icon={<Trash2 />} className="-my-0.5 text-subtle hover:text-danger" onClick={() => setConfirmRemove(true)} />
            )}
          </div>
        )}
        {write.dialog}
      </dd>
    </Highlight>
  );
}

function AddFieldForm({ onDone }: { onDone: () => void }) {
  const { profile, m } = useProfile();
  const keys = useCustomFieldKeys();
  const write = useVersionedWrite();
  const [name, setName] = useState('');
  const [type, setType] = useState<ValueType>('text');
  const [raw, setRaw] = useState('');
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const listId = useId();
  const key = slugifyKey(name);
  const known = keys.data?.items.find((k) => k.key === key);

  const pickName = (v: string) => {
    setName(v);
    const match = keys.data?.items.find((k) => k.key === slugifyKey(v));
    const t = match && match.valueType === 'string' ? 'text' : match?.valueType;
    if (t === 'text' || t === 'number' || t === 'boolean' || t === 'date') {
      setType(t);
      if (t === 'boolean') setRaw('true');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: { name?: string; value?: string } = {};
    if (!name.trim()) errs.name = 'Give the field a name.';
    else if (!CUSTOM_FIELD_KEY.test(key)) errs.name = 'Start with a letter; use letters, numbers and spaces.';
    else if (Object.hasOwn(profile.customFields, key)) errs.name = 'This lead already has that field. Edit it above.';
    const parsed = parseValue(type, type === 'boolean' && !raw ? 'true' : raw);
    if ('error' in parsed) errs.value = parsed.error;
    setErrors(errs);
    if (Object.keys(errs).length || 'error' in parsed) return;
    await write.run({
      label: humanize(key), base: null, mine: parsed.value, version: profile.version,
      attempt: (version) => m.setCustomField.mutateAsync({ key, value: parsed.value, version }),
      onDone,
    });
  };

  return (
    <form onSubmit={submit} noValidate className="mt-2 rounded-lg border border-border bg-surface-2/60 p-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_8rem_minmax(0,1fr)]">
        <Field label="Field name" error={errors.name} hint={key && !errors.name ? `Saved as ${key}${known ? ` · used on ${known.leadCount} leads` : ''}` : undefined}>
          {(p) => (
            <>
              <Input {...p} inputSize="sm" value={name} list={listId} autoFocus placeholder="e.g. Crew size" onChange={(e) => pickName(e.target.value)} />
              <datalist id={listId}>
                {keys.data?.items.filter((k) => !Object.hasOwn(profile.customFields, k.key)).map((k) => <option key={k.key} value={humanize(k.key)} />)}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Type">
          {(p) => (
            <Select
              {...p}
              selectSize="sm"
              value={type}
              options={TYPE_OPTIONS}
              onValueChange={(t) => {
                setType(t);
                setRaw(t === 'boolean' ? 'true' : '');
                setErrors((x) => ({ ...x, value: undefined }));
              }}
            />
          )}
        </Field>
        <Field label="Value" error={errors.value}>
          {(p) => type === 'boolean' ? (
            <Select {...p} selectSize="sm" value={(raw || 'true') as 'true' | 'false'} onValueChange={setRaw}
              options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
          ) : (
            <Input {...p} inputSize="sm" type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} value={raw}
              placeholder={type === 'number' ? 'e.g. 12' : type === 'text' ? 'e.g. ABC Supply' : undefined}
              onChange={(e) => setRaw(e.target.value)} />
          )}
        </Field>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" loading={write.busy}>Add field</Button>
      </div>
      {write.dialog}
    </form>
  );
}
