-- migrate:up
-- 20261018220000 gained its facet length caps after some databases had applied it; this brings those in
-- line (a no-op where the capped body is already in place) and recomputes the rows the caps change.
CREATE OR REPLACE FUNCTION system_tag_facets(tags JSONB) RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    WITH t AS (
        SELECT e->>'key' AS k, e->'value' AS v
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]' END) e
        WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'key') = 'string' AND e->>'key' ~ '^[A-Za-z0-9_:.-]+$'
          AND length(e->>'key') <= 200
    )
    SELECT COALESCE(array_agg(DISTINCT f COLLATE "C" ORDER BY f COLLATE "C"), '{}') FROM (
        SELECT k AS f FROM t GROUP BY k HAVING NOT COALESCE(bool_or(v = 'false'), FALSE)
        UNION ALL
        SELECT k || op || val FROM (
            SELECT k, CASE jsonb_typeof(v) WHEN 'string' THEN '=' WHEN 'number' THEN '#=' ELSE '?=' END AS op,
                   CASE jsonb_typeof(v) WHEN 'number' THEN trim_scale(v::numeric)::text ELSE v #>> '{}' END AS val
            FROM t WHERE jsonb_typeof(v) IN ('string', 'number', 'boolean')
            UNION ALL
            SELECT t.k, '[]=', x #>> '{}'
            FROM t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.v) = 'array' THEN t.v ELSE '[]' END) x
            WHERE jsonb_typeof(x) = 'string'
        ) kv WHERE length(val) <= 500
    ) facets
$$;

-- tag_facets is recomputed on any UPDATE; system_tags itself is unchanged, so versions do not move.
UPDATE companies SET system_tags = system_tags
WHERE jsonb_typeof(system_tags) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(system_tags) e
    WHERE jsonb_typeof(e) = 'object' AND (
        length(e->>'key') > 200
        OR (jsonb_typeof(e->'value') IN ('string', 'number', 'boolean') AND length(e->'value' #>> '{}') > 500)
        OR (jsonb_typeof(e->'value') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(e->'value') x WHERE jsonb_typeof(x) = 'string' AND length(x #>> '{}') > 500))));

-- migrate:down
-- Rows are not recomputed: an uncapped facet can exceed the GIN key size, and the compiler reads
-- system_tags for over-cap keys and values either way.
CREATE OR REPLACE FUNCTION system_tag_facets(tags JSONB) RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    WITH t AS (
        SELECT e->>'key' AS k, e->'value' AS v
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]' END) e
        WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'key') = 'string' AND e->>'key' ~ '^[A-Za-z0-9_:.-]+$'
    )
    SELECT COALESCE(array_agg(DISTINCT f COLLATE "C" ORDER BY f COLLATE "C"), '{}') FROM (
        SELECT k AS f FROM t GROUP BY k HAVING NOT COALESCE(bool_or(v = 'false'), FALSE)
        UNION ALL
        SELECT k || op || val FROM (
            SELECT k, CASE jsonb_typeof(v) WHEN 'string' THEN '=' WHEN 'number' THEN '#=' ELSE '?=' END AS op,
                   CASE jsonb_typeof(v) WHEN 'number' THEN trim_scale(v::numeric)::text ELSE v #>> '{}' END AS val
            FROM t WHERE jsonb_typeof(v) IN ('string', 'number', 'boolean')
            UNION ALL
            SELECT t.k, '[]=', x #>> '{}'
            FROM t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.v) = 'array' THEN t.v ELSE '[]' END) x
            WHERE jsonb_typeof(x) = 'string'
        ) kv
    ) facets
$$;
