-- Index/column proposals for the slow LeadFilter shapes, measured inside a transaction that is rolled back
-- (nothing persists; never run against a shared database). Each pair is the "matched" CTE of the compiled
-- search (services/query buildSearchQuery) before and after the change, so the delta is the scan cost.
-- Usage: docker exec -i leadmaker-postgres-1 psql -U leadmaker -d leadmaker_perf < scripts/perf/proposals.sql
\timing on
SET jit = off;
BEGIN;

-- P1 certifications -> typed tier_rank instead of jsonb containment on gaf_tier
\echo '== P1 before: certifications via system_tags @> gaf_tier'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c
WHERE (c.system_tags @> '[{"key":"gaf_tier","value":"master_elite"}]' OR c.system_tags @> '[{"key":"gaf_tier","value":"certified_plus"}]')
  AND c.segment = ANY('{strategic,growth}') AND c.rating >= 4.5;
CREATE INDEX companies_tier_segment_rating_idx ON companies (tier_rank, segment, rating);
ANALYZE companies;
\echo '== P1 after: tier_rank IN (2,3) with (tier_rank, segment, rating)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c
WHERE c.tier_rank IN (2, 3) AND c.segment = ANY('{strategic,growth}') AND c.rating >= 4.5;

-- P2 founded year as a stored column (the FOUNDED_YEAR expression re-parses system_tags per row)
\echo '== P2 before: minYearsInBusiness via FOUNDED_YEAR expression'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c
WHERE COALESCE(
  CASE WHEN c.scraped_attributes->>'founded_year' ~ '^[0-9]{4}$' THEN (c.scraped_attributes->>'founded_year')::int END,
  substring(jsonb_path_query_first(c.system_tags, '$[*] ? (@.key == "maturity").reason') #>> '{}' FROM 'since ([0-9]{4})')::int,
  c.in_business_since) <= 2006;
ALTER TABLE companies ADD COLUMN founded_year int GENERATED ALWAYS AS (COALESCE(
  CASE WHEN scraped_attributes->>'founded_year' ~ '^[0-9]{4}$' THEN (scraped_attributes->>'founded_year')::int END,
  substring(jsonb_path_query_first(system_tags, '$[*] ? (@.key == "maturity").reason') #>> '{}' FROM 'since ([0-9]{4})')::int,
  in_business_since)) STORED;
CREATE INDEX companies_founded_year_idx ON companies (founded_year, id);
ANALYZE companies;
\echo '== P2 after: stored founded_year + btree'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c WHERE c.founded_year <= 2006;
\echo '== P2 after: first page sorted by founded_year (no count)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT c.id FROM companies c WHERE c.founded_year <= 2006
ORDER BY c.founded_year ASC NULLS LAST, c.id ASC LIMIT 51;

-- P3 tag keys as a small stored jsonb array (GIN on ~0.5 KB instead of rechecking the ~5 KB system_tags),
-- plus a partial index for the unallocated pool that reps browse
\echo '== P3 before: unallocated + service:metal_roofing + size medium|large'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c
WHERE c.assigned_rep_id IS NULL
  AND (c.system_tags @> '[{"key":"service:metal_roofing"}]' AND NOT c.system_tags @> '[{"key":"service:metal_roofing","value":false}]')
  AND (c.system_tags @> '[{"key":"size","value":"medium"}]' OR c.system_tags @> '[{"key":"size","value":"large"}]');
ALTER TABLE companies ADD COLUMN tag_facets jsonb GENERATED ALWAYS AS (jsonb_path_query_array(system_tags,
  '$[*] ? (@.value != false).key')) STORED;
-- (key list only here; a production column would hold "key" and "key=value" strings written by the tagger)
CREATE INDEX companies_tag_facets_pool_gin ON companies USING GIN (tag_facets) WHERE assigned_rep_id IS NULL;
CREATE INDEX companies_size_pool_idx ON companies ((system_tags @> '[{"key":"size","value":"small"}]')) WHERE assigned_rep_id IS NULL;
ANALYZE companies;
\echo '== P3 after: tag_facets ? key on the unallocated partial GIN'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT count(*) FROM companies c
WHERE c.assigned_rep_id IS NULL AND c.tag_facets @> '["service:metal_roofing"]'
  AND (c.system_tags @> '[{"key":"size","value":"medium"}]' OR c.system_tags @> '[{"key":"size","value":"large"}]');

ROLLBACK;
