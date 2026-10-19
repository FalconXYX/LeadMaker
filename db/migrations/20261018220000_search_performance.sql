-- migrate:up
-- LeadFilter search columns (packages/shared filter-sql.ts). Both are derived from pipeline-written
-- columns; nobody writes them, PostgreSQL keeps them current.

-- System tags as indexable strings, one per tag key matching the LeadFilter key pattern:
--   "k"      some tag has key k and none has value false
--   "k=v"    string value v              "k[]=v"            array value with the string element v
--   "k#=n"   number value (canonical)    "k?=true|false"    boolean value
-- Keys over 200 and values over 500 characters are left out (a GIN key must fit in about 2.7 KB); the
-- compiler reads system_tags for those (FACET_KEY_MAX / FACET_VALUE_MAX).
CREATE FUNCTION system_tag_facets(tags JSONB) RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
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

ALTER TABLE companies
    -- FOUNDED_YEAR: the pipeline's scraped value, else the maturity tag's year, else GAF's
    ADD COLUMN founded_year INT GENERATED ALWAYS AS (COALESCE(
        CASE WHEN scraped_attributes->>'founded_year' ~ '^[0-9]{4}$' THEN (scraped_attributes->>'founded_year')::int END,
        substring(jsonb_path_query_first(system_tags, '$[*] ? (@.key == "maturity").reason') #>> '{}' FROM 'since ([0-9]{4})')::int,
        in_business_since)) STORED,
    ADD COLUMN tag_facets TEXT[] GENERATED ALWAYS AS (system_tag_facets(system_tags)) STORED;

CREATE INDEX companies_founded_year_idx ON companies (founded_year, id);  -- most years in business first
CREATE INDEX companies_founded_year_desc_idx ON companies (founded_year DESC NULLS LAST, id DESC);
CREATE INDEX companies_tag_facets_gin ON companies USING GIN (tag_facets);
CREATE INDEX companies_tag_facets_pool_gin ON companies USING GIN (tag_facets) WHERE assigned_rep_id IS NULL;

-- Generated columns read as NULL in BEFORE triggers, so they must not count as a change.
DROP TRIGGER companies_bump_version ON companies;
CREATE TRIGGER companies_bump_version BEFORE UPDATE ON companies FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'location', 'raw', 'content_hash', 'first_seen_at',
                                      'last_seen_at', 'listing_updated_at', 'profile_scraped_at', 'profile_error',
                                      'tagged_at', 'team_last_checked_at', 'team_last_serviced_at',
                                      'founded_year', 'tag_facets');

-- JIT compiles the list statements for 30-75 ms and never pays off at this table size.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$;

ANALYZE companies;

-- migrate:down
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET jit', current_database()); END $$;
DROP TRIGGER companies_bump_version ON companies;
CREATE TRIGGER companies_bump_version BEFORE UPDATE ON companies FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'location', 'raw', 'content_hash', 'first_seen_at',
                                      'last_seen_at', 'listing_updated_at', 'profile_scraped_at', 'profile_error',
                                      'tagged_at', 'team_last_checked_at', 'team_last_serviced_at');
ALTER TABLE companies DROP COLUMN tag_facets, DROP COLUMN founded_year;
DROP FUNCTION system_tag_facets(JSONB);
