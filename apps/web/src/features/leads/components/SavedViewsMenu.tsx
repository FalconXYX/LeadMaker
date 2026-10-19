// Saved views menu: the four presets, the user's own server views and the team's shared ones. Rename happens
// inline (a clash shows under the field), delete is undoable from a toast, managers can share a view.
import { Bookmark, BookmarkPlus, Check, ChevronDown, Pencil, Trash2, Users, UsersRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '@/api/errors';
import type { SavedView } from '@/api/types';
import { Button, Dialog, Input, Popover, Spinner, Toggle, Tooltip, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';
import { isNameTaken } from '../savedViews';
import { PRESETS, type PresetId } from '../views';

export const VIEW_NAME_MAX = 60;

export interface SavedViewsMenuProps {
  activeName: string | null;
  mine: readonly SavedView[];
  shared: readonly SavedView[];
  loading?: boolean;
  isManager: boolean;
  onPreset: (id: PresetId) => void;
  onApply: (view: SavedView) => void;
  /** Rejects with the API error; name_taken is shown inline. */
  onSave: (name: string, isShared: boolean) => Promise<unknown>;
  onRename: (view: SavedView, name: string) => Promise<unknown>;
  onShare: (view: SavedView, shared: boolean) => void;
  onDelete: (view: SavedView) => void;
  canSave: boolean;
  compact?: boolean;
}

const takenMessage = (name: string) => `You already have a view named “${name}”.`;

export function SavedViewsMenu({
  activeName, mine, shared, loading, isManager, onPreset, onApply, onSave, onRename, onShare, onDelete, canSave, compact,
}: SavedViewsMenuProps) {
  const [naming, setNaming] = useState(false);

  return (
    <>
      <Popover
        label="Saved views"
        align="end"
        panelClassName="w-[min(360px,calc(100vw-2rem))]"
        trigger={(p) => (
          <button
            {...p}
            type="button"
            aria-label={activeName ? `Saved views (current: ${activeName})` : 'Saved views'}
            className={buttonClasses('secondary', 'sm', cn('h-8 max-w-[240px]', compact && 'w-8 px-0!', activeName && !compact && 'border-accent/40 text-accent'))}
          >
            <Bookmark className={cn('size-3.5', activeName && 'fill-current')} aria-hidden />
            {!compact && <span className="truncate">{activeName ?? 'Views'}</span>}
            {!compact && <ChevronDown className="size-3.5 text-subtle" aria-hidden />}
          </button>
        )}
      >
        {(close) => (
          <div className="max-h-[min(560px,72vh)] overflow-y-auto py-1.5">
            <SectionLabel>Presets</SectionLabel>
            <ul>
              {PRESETS.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPreset(p.id);
                      close();
                    }}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                  >
                    <span className="mt-0.5 size-4 shrink-0 text-accent">{activeName === p.name ? <Check className="size-4" aria-hidden /> : null}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg">{p.name}</span>
                      <span className="block text-xs text-muted">{p.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <SectionLabel divider>My views</SectionLabel>
            {loading ? (
              <p className="flex items-center gap-2 px-3 pb-2 text-xs text-muted"><Spinner size={14} />Loading views…</p>
            ) : mine.length === 0 ? (
              <p className="px-3 pb-2 text-xs text-muted">Save the filters you use often to get back to them in one click.</p>
            ) : (
              <ul aria-label="My views">
                {mine.map((v) => (
                  <ViewRow
                    key={v.id}
                    view={v}
                    active={activeName === v.name}
                    isManager={isManager}
                    siblings={mine}
                    onApply={() => {
                      onApply(v);
                      close();
                    }}
                    onRename={onRename}
                    onShare={onShare}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            )}

            {shared.length > 0 && (
              <>
                <SectionLabel divider icon={<UsersRound className="size-3" aria-hidden />}>Shared with team</SectionLabel>
                <ul aria-label="Shared with team">
                  {shared.map((v) => (
                    <ViewRow
                      key={v.id}
                      view={v}
                      active={activeName === v.name}
                      isManager={isManager}
                      siblings={shared.filter((s) => s.owner.id === v.owner.id)}
                      onApply={() => {
                        onApply(v);
                        close();
                      }}
                      onRename={onRename}
                      onShare={onShare}
                      onDelete={onDelete}
                    />
                  ))}
                </ul>
              </>
            )}

            <div className="mt-1 border-t border-border px-1.5 pt-1.5">
              <button
                type="button"
                disabled={!canSave}
                onClick={() => {
                  close();
                  setNaming(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left text-sm font-medium text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-transparent"
              >
                <BookmarkPlus className="size-4" aria-hidden />
                Save current view…
              </button>
              {!canSave && <p className="px-1.5 pb-1.5 text-xs text-subtle">Set a filter, view or sort first.</p>}
            </div>
          </div>
        )}
      </Popover>
      <SaveViewDialog open={naming} onClose={() => setNaming(false)} mine={mine} isManager={isManager} onSave={onSave} />
    </>
  );
}

function SectionLabel({ children, divider, icon }: { children: ReactNode; divider?: boolean; icon?: ReactNode }) {
  return (
    <p className={cn(
      'flex items-center gap-1.5 px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase',
      divider ? 'mt-1 border-t border-border pt-2.5' : 'pt-1',
    )}
    >
      {icon}{children}
    </p>
  );
}

function ViewRow({
  view, active, isManager, siblings, onApply, onRename, onShare, onDelete,
}: {
  view: SavedView;
  active: boolean;
  isManager: boolean;
  /** Views whose names this one must not repeat (the same owner's). */
  siblings: readonly SavedView[];
  onApply: () => void;
  onRename: (view: SavedView, name: string) => Promise<unknown>;
  onShare: (view: SavedView, shared: boolean) => void;
  onDelete: (view: SavedView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const clash = siblings.some((s) => s.id !== view.id && s.name.toLowerCase() === trimmed.toLowerCase());
  const shownError = clash ? takenMessage(trimmed) : error;

  const submit = async () => {
    if (!trimmed || clash || busy) return;
    if (trimmed === view.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(view, trimmed);
      setEditing(false);
    } catch (err) {
      setError(isNameTaken(err) ? takenMessage(trimmed) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="px-3 py-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-center gap-1.5"
        >
          <Input
            aria-label={`Rename view ${view.name}`}
            inputSize="sm"
            autoFocus
            className="min-w-0 flex-1"
            value={name}
            maxLength={VIEW_NAME_MAX}
            invalid={!!shownError}
            aria-describedby={shownError ? `view-err-${view.id}` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!trimmed || clash}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
        {shownError && <p id={`view-err-${view.id}`} role="alert" className="mt-1 text-xs text-danger">{shownError}</p>}
      </li>
    );
  }

  const ownedByOther = !view.mine;
  return (
    <li className="group flex items-center hover:bg-hover">
      <button
        type="button"
        onClick={onApply}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm text-fg focus-visible:bg-hover focus-visible:outline-none"
      >
        <span className="size-4 shrink-0 text-accent">{active ? <Check className="size-4" aria-hidden /> : null}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{view.name}</span>
          {ownedByOther && <span className="block truncate text-xs text-muted">by {view.owner.name}</span>}
        </span>
        {view.mine && view.isShared && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            <Users className="size-3" aria-hidden />Shared
          </span>
        )}
      </button>
      {view.canEdit && (
        // Mouse: the actions appear on hover / focus so names get the room; touch: always shown.
        <div className="mr-1.5 flex shrink-0 items-center [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-focus-within:flex">
          <RowAction label={`Rename view ${view.name}`} tip="Rename" onClick={() => { setName(view.name); setError(null); setEditing(true); }}>
            <Pencil className="size-3.5" aria-hidden />
          </RowAction>
          {isManager && (
            <RowAction
              label={view.isShared ? `Stop sharing ${view.name}` : `Share ${view.name} with team`}
              tip={view.isShared ? 'Stop sharing with team' : 'Share with team'}
              pressed={view.isShared}
              onClick={() => onShare(view, !view.isShared)}
            >
              <Users className="size-3.5" aria-hidden />
            </RowAction>
          )}
          <RowAction label={`Delete view ${view.name}`} tip="Delete view" danger onClick={() => onDelete(view)}>
            <Trash2 className="size-3.5" aria-hidden />
          </RowAction>
        </div>
      )}
    </li>
  );
}

function RowAction({
  label, tip, onClick, danger, pressed, children,
}: { label: string; tip: string; onClick: () => void; danger?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={tip} describe={false}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          'rounded-md p-1.5 text-subtle hover:bg-surface-3',
          danger ? 'hover:text-danger' : 'hover:text-fg',
          pressed && 'text-accent',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function SaveViewDialog({
  open, onClose, mine, isManager, onSave,
}: {
  open: boolean;
  onClose: () => void;
  mine: readonly SavedView[];
  isManager: boolean;
  onSave: (name: string, isShared: boolean) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const duplicate = mine.some((v) => v.name.toLowerCase() === trimmed.toLowerCase());
  const shownError = duplicate ? takenMessage(trimmed) : error;

  const close = () => {
    setName('');
    setShare(false);
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!trimmed || duplicate || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed, isManager && share);
      close();
    } catch (err) {
      setError(isNameTaken(err) ? takenMessage(trimmed) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Save view"
      description="Keeps the current view, filters and sort under a name, on any device you sign in on."
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!trimmed || duplicate} onClick={() => void submit()}>Save view</Button>
        </>
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="save-view-name" className="mb-1.5 block text-xs font-medium text-muted">Name</label>
          <Input
            id="save-view-name"
            data-autofocus
            value={name}
            maxLength={VIEW_NAME_MAX}
            placeholder="e.g. Brooklyn storm follow-ups"
            invalid={!!shownError}
            aria-describedby={shownError ? 'save-view-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          {shownError && <p id="save-view-error" role="alert" className="mt-1.5 text-xs text-danger">{shownError}</p>}
        </div>
        {isManager && (
          <Toggle
            size="sm"
            checked={share}
            onCheckedChange={setShare}
            label="Shared with team"
            description="Every rep sees it under Shared with team. Only managers can change it."
          />
        )}
      </form>
    </Dialog>
  );
}
