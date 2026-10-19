// Saved views (saved_views): every user keeps their own; a manager may share one with the team.
import type { LeadFilter } from './filter.ts';
import type { SavedView } from './types.ts';
import type { Viewer } from './visibility.ts';

/** Shared views are visible to everyone; private ones to their owner only. */
export function canSeeView(viewer: Viewer, view: { ownerId: string; isShared: boolean }): boolean {
  return view.ownerId === viewer.id || view.isShared;
}

/** Its owner may change or delete a view; any manager may change or delete a shared one. */
export function canEditView(viewer: Viewer, view: { ownerId: string; isShared: boolean }): boolean {
  return view.ownerId === viewer.id || (view.isShared && viewer.role === 'manager');
}

/** Only managers may share a view with the team. */
export function canShareView(viewer: Viewer): boolean {
  return viewer.role === 'manager';
}

/** A saved_views row joined with its owner's name (u.name AS owner_name), as crm-write and query select it. */
export interface SavedViewRow {
  id: string;
  user_id: string;
  owner_name: string;
  name: string;
  filter: LeadFilter;
  sort: LeadFilter['sort'] | null;
  is_shared: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export function savedViewOut(viewer: Viewer, v: SavedViewRow): SavedView {
  return {
    id: v.id,
    name: v.name,
    filter: v.filter,
    sort: v.sort ?? null,
    isShared: v.is_shared,
    owner: { id: v.user_id, name: v.owner_name },
    mine: v.user_id === viewer.id,
    canEdit: canEditView(viewer, { ownerId: v.user_id, isShared: v.is_shared }),
    createdAt: new Date(v.created_at).toISOString(),
    updatedAt: new Date(v.updated_at).toISOString(),
  };
}
