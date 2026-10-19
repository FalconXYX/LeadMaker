-- migrate:up
CREATE EXTENSION IF NOT EXISTS postgis;   -- geography points, radius search
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- LeadFilter.text on business names

-- migrate:down
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS postgis;
