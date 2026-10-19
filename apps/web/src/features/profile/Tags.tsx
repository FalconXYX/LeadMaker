import { Plus, Tag, Tags as TagsIcon } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useCustomTags } from '@/api/queries';
import { CustomTagBadge, SystemTagBadge, Toggle, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useProfile } from './context';
import { groupTags, sourceLabel } from './lib';
import { SectionCard } from './ui';

export function CustomTagsCard() {
  const { profile, canEdit, m } = useProfile();
  return (
    <SectionCard
      title="Custom tags"
      icon={<Tag />}
      description="Your team’s own labels. Filter the lead list by them."
      highlightKey="tags"
    >
      <div className="flex flex-wrap items-center gap-2">
        {profile.customTags.map((t) => (
          <Tooltip key={t.id} content={`Added by ${t.addedBy.name} ${formatRelative(t.addedAt)}`}>
            <span className="inline-flex">
              <CustomTagBadge
                className="h-6 text-xs"
                name={t.name}
                onRemove={canEdit && !m.removeTag.isPending ? () => m.removeTag.mutate(t.id) : undefined}
              />
            </span>
          </Tooltip>
        ))}
        {profile.customTags.length === 0 && <p className="mr-1 text-sm text-subtle">No custom tags yet.</p>}
        {canEdit && <TagPicker />}
      </div>
    </SectionCard>
  );
}

const TAG_MAX = 100;

/** Combobox: pick an existing tag or create one inline. */
function TagPicker() {
  const { profile, m } = useProfile();
  const catalog = useCustomTags();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const errorId = useId();

  const attached = new Set(profile.customTags.map((t) => t.id));
  const q = text.trim().toLowerCase();
  const options = (() => {
    const items = (catalog.data?.items ?? [])
      .filter((t) => !attached.has(t.id) && (!q || t.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || b.leadCount - a.leadCount)
      .slice(0, 8)
      .map((t) => ({ key: t.id, id: t.id as string | undefined, name: t.name, hint: `${t.leadCount} ${t.leadCount === 1 ? 'lead' : 'leads'}` }));
    const exists = (catalog.data?.items ?? []).some((t) => t.name.toLowerCase() === q)
      || profile.customTags.some((t) => t.name.toLowerCase() === q);
    if (q && !exists) items.push({ key: '__create', id: undefined, name: text.trim(), hint: 'New tag' });
    return items;
  })();

  const choose = (opt: { id?: string; name: string }) => {
    if (opt.name.length > TAG_MAX) return setError(`Keep tag names under ${TAG_MAX} characters.`);
    if (/\p{Cc}/u.test(opt.name)) return setError('Tag names cannot contain control characters.');
    setError(null);
    m.attachTag.mutate({ id: opt.id, name: opt.name }, {
      onSuccess: () => {
        setText('');
        setActive(0);
        inputRef.current?.focus();
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[active] ?? options[0];
      if (opt) choose(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setText('');
      setError(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs font-medium text-muted hover:border-accent hover:text-accent"
      >
        <Plus className="size-3" aria-hidden />Add tag
      </button>
    );
  }

  const activeOpt = options[active];
  return (
    <div className="relative w-full sm:w-72">
      <input
        ref={inputRef}
        role="combobox"
        aria-label="Add a custom tag"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOpt ? `${listId}-${activeOpt.key}` : undefined}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errorId : undefined}
        value={text}
        maxLength={TAG_MAX + 1}
        disabled={m.attachTag.isPending}
        placeholder={catalog.isPending ? 'Loading tags…' : 'Search or create a tag'}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
            setOpen(false);
            setText('');
          }
        }}
        className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-fg shadow-sm placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/40 focus:outline-none"
      />
      {error && <p id={errorId} className="mt-1 text-xs text-danger">{error}</p>}
      {options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tags"
          className="absolute top-full left-0 z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-${o.key}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn('flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm', i === active && 'bg-surface-2')}
            >
              <span className="truncate text-fg">
                {o.id ? o.name : <>Create “<span className="font-medium">{o.name}</span>”</>}
              </span>
              <span className="shrink-0 text-xs text-subtle">{o.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SystemTagsCard() {
  const { profile } = useProfile();
  const [details, setDetails] = useState(false);
  const groups = groupTags(profile.systemTags);
  return (
    <SectionCard
      title={`System tags (${profile.systemTags.length})`}
      icon={<TagsIcon />}
      description="Derived by the pipeline from GAF, company websites and public records. Hover a tag for why."
      actions={<Toggle size="sm" checked={details} onCheckedChange={setDetails} label={<span className="text-xs text-muted">Show reasons</span>} />}
    >
      {groups.length === 0 ? (
        <p className="text-sm text-subtle">No system tags yet.</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                {g.label} <span className="font-normal text-subtle">{g.tags.length}</span>
              </h3>
              {details ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {g.tags.map((t) => (
                    <li key={t.key} className="px-3.5 py-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium text-fg">{t.label}</span>
                        <span className="text-xs text-subtle">{sourceLabel(t.source)}</span>
                      </div>
                      {t.reason && <p className="mt-0.5 text-xs break-words text-muted">{t.reason}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {g.tags.map((t) => (
                    <SystemTagBadge
                      key={t.key}
                      label={t.label}
                      reason={[t.reason, t.source && `Source: ${sourceLabel(t.source)}`].filter(Boolean).join('\n')}
                      className="h-6 max-w-[18rem] text-xs"
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
