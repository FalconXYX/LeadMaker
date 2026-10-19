// The caller's saved views (own, then the team's shared ones) and UI preferences; written by crm-write.
import {
  savedViewOut, sql, type SavedView, type SavedViewRow, type SavedViewsResponse, type UserPreferences, type Viewer,
} from '@leadmaker/shared';
import { one, pick, rows, type Db } from './db.ts';

export async function listViews(db: Db, viewer: Viewer, primary: boolean): Promise<SavedView[]> {
  const result = await rows<SavedViewRow>(pick(db, primary), sql`
    SELECT v.id, v.user_id, u.name AS owner_name, v.name, v.filter, v.sort, v.is_shared, v.created_at, v.updated_at
    FROM saved_views v JOIN users u ON u.id = v.user_id
    WHERE v.user_id = ${viewer.id}::uuid OR v.is_shared
    ORDER BY v.user_id = ${viewer.id}::uuid DESC, lower(v.name), v.id`);
  return result.map((v) => savedViewOut(viewer, v)) satisfies SavedViewsResponse['items'];
}

export async function getPreferences(db: Db, viewer: Viewer, primary: boolean): Promise<UserPreferences> {
  const row = await one<{ prefs: Record<string, unknown>; version: number; updated_at: Date }>(pick(db, primary), sql`
    SELECT prefs, version, updated_at FROM user_preferences WHERE user_id = ${viewer.id}::uuid`);
  return row
    ? { prefs: row.prefs, version: row.version, updatedAt: new Date(row.updated_at).toISOString() }
    : { prefs: {}, version: 0, updatedAt: null };
}
