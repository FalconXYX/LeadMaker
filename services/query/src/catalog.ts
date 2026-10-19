// Filter vocabularies for the list UI: custom tags and custom field keys, counted over the leads the caller may see.
import {
  visibilitySql, sql, type CustomFieldKey, type CustomFieldValueType, type CustomTagListItem, type Viewer,
} from '@leadmaker/shared';
import { pick, rows, type Db } from './db.ts';
import { iso } from './search.ts';

export const MAX_CUSTOM_FIELD_KEYS = 500;

interface TagRow {
  id: string;
  name: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  lead_count: number;
}

export function customTagsQuery(viewer: Viewer) {
  return sql`
    SELECT t.id, t.name, t.created_by, u.name AS created_by_name, t.created_at, COALESCE(n.lead_count, 0)::int AS lead_count
    FROM custom_tags t JOIN users u ON u.id = t.created_by
    LEFT JOIN (
      SELECT x.tag_id, count(*) AS lead_count
      FROM company_custom_tags x JOIN companies c ON c.id = x.company_id
      WHERE ${visibilitySql(viewer, 'view', 'c')}
      GROUP BY x.tag_id) n ON n.tag_id = t.id
    ORDER BY lower(t.name), t.id`;
}

export async function listCustomTags(db: Db, viewer: Viewer, primary: boolean): Promise<CustomTagListItem[]> {
  const result = await rows<TagRow>(pick(db, primary), customTagsQuery(viewer));
  return result.map((t) => ({
    id: t.id,
    name: t.name,
    createdBy: { id: t.created_by, name: t.created_by_name },
    createdAt: iso(t.created_at)!,
    leadCount: t.lead_count,
  }));
}

interface KeyRow {
  key: string;
  lead_count: number;
  types: string[];
}

// JSON null counts as absent, as in the LeadFilter 'exists' operator.
export function customFieldKeysQuery(viewer: Viewer) {
  return sql`
    SELECT v.key, count(*)::int AS lead_count, array_agg(DISTINCT v.t ORDER BY v.t) AS types
    FROM (
      SELECT k.key, CASE WHEN jsonb_typeof(k.value) = 'string' AND (k.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                         THEN 'date' ELSE jsonb_typeof(k.value) END AS t
      FROM companies c CROSS JOIN LATERAL jsonb_each(c.custom_fields) k
      WHERE c.custom_fields <> '{}'::jsonb AND ${visibilitySql(viewer, 'view', 'c')}) v
    WHERE v.t <> 'null'
    GROUP BY v.key
    ORDER BY lead_count DESC, v.key COLLATE "C"
    LIMIT ${MAX_CUSTOM_FIELD_KEYS}::int`;
}

/** One JSON type across leads, else 'mixed'; dates mixed with other strings are strings. */
export function valueType(types: string[]): CustomFieldValueType {
  if (types.length === 1) return types[0] as CustomFieldValueType;
  if (types.length === 2 && types.includes('date') && types.includes('string')) return 'string';
  return 'mixed';
}

export async function listCustomFieldKeys(db: Db, viewer: Viewer, primary: boolean): Promise<CustomFieldKey[]> {
  const result = await rows<KeyRow>(pick(db, primary), customFieldKeysQuery(viewer));
  return result.map((r) => ({ key: r.key, leadCount: r.lead_count, valueType: valueType(r.types) }));
}
