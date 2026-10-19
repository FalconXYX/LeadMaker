// "Manage tags": rename or delete the team's custom tags. Each change confirms first with the number of leads
// it touches (GET /api/custom-tags leadCount). Only a tag's creator or a manager may change it; everyone else
// sees the controls disabled, with the reason in a tooltip.
import { Pencil, Search, Tags, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/api/errors';
import { useCustomTags } from '@/api/queries';
import type { CustomTagListItem, SessionUser } from '@/api/types';
import { Button, CustomTagBadge, Dialog, EmptyState, Input, Skeleton, Tooltip, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatNumber, pluralize } from '@/lib/format';
import { useDeleteTag, useRenameTag } from '../queries';
import { isNameTaken } from '../savedViews';

export const TAG_NAME_MAX = 100;

/** The tag's creator or any manager may rename or delete it. */
export function canManageTag(user: Pick<SessionUser, 'id' | 'role'> | null | undefined, tag: Pick<CustomTagListItem, 'createdBy'>): boolean {
  if (!user) return false;
  return user.role === 'manager' || tag.createdBy?.id === user.id;
}

export function manageTagBlockedReason(tag: Pick<CustomTagListItem, 'createdBy'>): string {
  const who = tag.createdBy?.name ? `${tag.createdBy.name} (who created it)` : 'its creator';
  return `Only ${who} or a manager can change this tag`;
}

const leadsText = (n: number) => (n === 0 ? 'no leads' : pluralize(n, 'lead'));

export interface ManageTagsDialogProps {
  open: boolean;
  onClose: () => void;
  user: SessionUser | null;
  /** After a rename: lets the page follow it (filters, hidden chips). */
  onRenamed?: (from: string, to: string) => void;
  onDeleted?: (name: string) => void;
}

type Mode = { kind: 'idle' } | { kind: 'rename'; draft: string; confirming: boolean } | { kind: 'delete' };

export function ManageTagsDialog({ open, onClose, user, onRenamed, onDeleted }: ManageTagsDialogProps) {
  const tagsQuery = useCustomTags();
  const tags = useMemo(() => (Array.isArray(tagsQuery.data?.items) ? tagsQuery.data.items : []), [tagsQuery.data]);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => [...tags].filter((t) => t.name.toLowerCase().includes(q)).sort((a, b) => b.leadCount - a.leadCount || a.name.localeCompare(b.name)),
    [tags, q],
  );
  const mineCount = tags.filter((t) => canManageTag(user, t)).length;

  return (
    <Dialog
      open={open}
      onClose={() => {
        setQuery('');
        onClose();
      }}
      title="Manage tags"
      description={user?.role === 'manager'
        ? 'Rename or delete your team’s custom tags. Changes apply to every lead that carries the tag.'
        : `Rename or delete the tags you created${mineCount ? '' : ' (you haven’t created any yet)'}. Managers can change any tag.`}
      size="md"
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      {tags.length > 6 && (
        <Input
          aria-label="Find a tag"
          inputSize="sm"
          leftIcon={<Search />}
          placeholder="Find a tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-3"
        />
      )}
      {tagsQuery.isPending ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)}
        </div>
      ) : tagsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">{errorMessage(tagsQuery.error)}</p>
      ) : tags.length === 0 ? (
        <EmptyState
          icon={<Tags />}
          title="No custom tags yet"
          description="Select leads in the list and choose Add tag to create one."
        />
      ) : shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No tags match “{query.trim()}”.</p>
      ) : (
        <ul aria-label="Custom tags" className="-mx-1 flex flex-col">
          {shown.map((t) => (
            <TagRow key={t.id} tag={t} all={tags} allowed={canManageTag(user, t)} onRenamed={onRenamed} onDeleted={onDeleted} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TagRow({
  tag, all, allowed, onRenamed, onDeleted,
}: {
  tag: CustomTagListItem;
  all: readonly CustomTagListItem[];
  allowed: boolean;
  onRenamed?: (from: string, to: string) => void;
  onDeleted?: (name: string) => void;
}) {
  const toast = useToast();
  const rename = useRenameTag();
  const remove = useDeleteTag();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const reason = allowed ? null : manageTagBlockedReason(tag);
  const affected = leadsText(tag.leadCount);

  const draft = mode.kind === 'rename' ? mode.draft.trim() : '';
  const clash = mode.kind === 'rename' && !!draft && all.some((t) => t.id !== tag.id && t.name.toLowerCase() === draft.toLowerCase());
  const unchanged = draft === tag.name;
  const fieldError = clash ? `Another tag is already called “${draft}”.` : error;

  const doRename = () => {
    if (!draft || clash || unchanged) return;
    setError(null);
    rename.mutate({ id: tag.id, name: draft }, {
      onSuccess: (res) => {
        const to = res?.tag?.name ?? draft;
        setMode({ kind: 'idle' });
        onRenamed?.(tag.name, to);
        toast.success(`Renamed “${tag.name}” to “${to}”`, `${leadsText(res?.leads?.length ?? tag.leadCount)} updated`);
      },
      onError: (err) => {
        setMode({ kind: 'rename', draft: mode.kind === 'rename' ? mode.draft : draft, confirming: false });
        setError(isNameTaken(err) ? `Another tag is already called “${draft}”.` : errorMessage(err));
      },
    });
  };
  const doDelete = () => {
    setError(null);
    remove.mutate({ id: tag.id, name: tag.name }, {
      onSuccess: (res) => {
        onDeleted?.(tag.name);
        toast.success(`Deleted tag “${tag.name}”`, `Removed from ${leadsText(res?.leads?.length ?? tag.leadCount)}`);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <li className={cn('rounded-lg px-1 py-1', mode.kind !== 'idle' && 'bg-surface-2/70')}>
      {mode.kind === 'rename' && !mode.confirming ? (
        <form
          className="flex flex-col gap-1.5 p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft && !clash && !unchanged) setMode({ ...mode, confirming: true });
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label={`New name for ${tag.name}`}
              inputSize="sm"
              autoFocus
              className="min-w-0 flex-1"
              maxLength={TAG_NAME_MAX}
              value={mode.draft}
              invalid={!!fieldError}
              aria-describedby={fieldError ? `tag-err-${tag.id}` : undefined}
              onChange={(e) => {
                setError(null);
                setMode({ kind: 'rename', draft: e.target.value, confirming: false });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setMode({ kind: 'idle' });
                  setError(null);
                }
              }}
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => { setMode({ kind: 'idle' }); setError(null); }}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" disabled={!draft || clash || unchanged}>Rename…</Button>
          </div>
          {fieldError
            ? <p id={`tag-err-${tag.id}`} role="alert" className="text-xs text-danger">{fieldError}</p>
            : <p className="text-xs text-muted">Changes the tag on {affected} for the whole team.</p>}
        </form>
      ) : mode.kind === 'rename' ? (
        <Confirm
          tone="accent"
          text={<>Rename <b className="font-semibold text-fg">“{tag.name}”</b> to <b className="font-semibold text-fg">“{draft}”</b> on {affected}?</>}
          confirmLabel="Rename tag"
          busy={rename.isPending}
          onBack={() => setMode({ ...mode, confirming: false })}
          onConfirm={doRename}
        />
      ) : mode.kind === 'delete' ? (
        <Confirm
          tone="danger"
          text={<>Delete <b className="font-semibold text-fg">“{tag.name}”</b>? It comes off {affected}{tag.leadCount ? ' and out of any filter that uses it' : ''}. This can’t be undone.</>}
          confirmLabel={tag.leadCount ? `Delete from ${pluralize(tag.leadCount, 'lead')}` : 'Delete tag'}
          busy={remove.isPending}
          error={error}
          onBack={() => { setMode({ kind: 'idle' }); setError(null); }}
          onConfirm={doDelete}
        />
      ) : (
        <div className="flex items-center gap-3 px-1.5 py-1.5">
          <div className="min-w-0 flex-1">
            <CustomTagBadge name={tag.name} className="max-w-full truncate" />
            <p className="mt-1 truncate text-xs text-muted">
              <span className="tabular">{formatNumber(tag.leadCount)}</span> {tag.leadCount === 1 ? 'lead' : 'leads'}
              {tag.createdBy?.name && <> · by {tag.createdBy.name}</>}
            </p>
          </div>
          <TagAction
            label={`Rename tag ${tag.name}`}
            tip={reason ?? 'Rename'}
            disabled={!allowed}
            onClick={() => { setError(null); setMode({ kind: 'rename', draft: tag.name, confirming: false }); }}
          >
            <Pencil className="size-3.5" aria-hidden />
          </TagAction>
          <TagAction
            label={`Delete tag ${tag.name}`}
            tip={reason ?? 'Delete'}
            disabled={!allowed}
            danger
            onClick={() => { setError(null); setMode({ kind: 'delete' }); }}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </TagAction>
        </div>
      )}
    </li>
  );
}

/** aria-disabled (not disabled) so the tooltip still explains why on hover and keyboard focus. */
function TagAction({
  label, tip, disabled, danger, onClick, children,
}: { label: string; tip: string; disabled: boolean; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={tip} describe={disabled}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && onClick()}
        className={cn(
          '-my-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted transition-colors',
          disabled
            ? 'cursor-not-allowed opacity-40'
            : danger ? 'hover:border-danger/20 hover:bg-danger-soft hover:text-danger' : 'hover:border-border hover:bg-surface hover:text-fg',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Confirm({
  text, confirmLabel, tone, busy, error, onBack, onConfirm,
}: {
  text: ReactNode;
  confirmLabel: string;
  tone: 'accent' | 'danger';
  busy: boolean;
  error?: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div role="group" aria-label="Confirm" className="flex flex-col gap-2 p-1.5">
      <p className="text-sm text-muted">{text}</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={busy}>Back</Button>
        <Button size="sm" variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm} data-autofocus autoFocus>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
