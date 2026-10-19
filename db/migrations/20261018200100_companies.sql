-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'rep' CHECK (role IN ('rep', 'manager')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per real business, whichever source found it (industry-agnostic).
-- The pipeline writes the listing, profile and tag columns (and only lat/lng: location is derived);
-- the CRM Write Service writes assigned_rep_id, custom_fields and team_last_*.
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry VARCHAR(50) NOT NULL DEFAULT 'roofing',
    business_name VARCHAR(255) NOT NULL,
    dba VARCHAR(255),
    legal_name VARCHAR(255),
    contractor_type VARCHAR(32),
    address VARCHAR(512),
    street VARCHAR(255),
    city VARCHAR(128),
    state VARCHAR(8),
    postal_code VARCHAR(16),
    country VARCHAR(8),
    phone VARCHAR(32),
    website_url TEXT,
    website_source VARCHAR(32),
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    location GEOGRAPHY(Point, 4326)
        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
    county_fips CHAR(5),                                     -- joins to regional_signals
    -- Source listing (GAF today)
    rating DOUBLE PRECISION,
    review_count INT NOT NULL DEFAULT 0,
    profile_url TEXT,
    image_url TEXT,
    tier VARCHAR(32),
    tier_rank INT NOT NULL DEFAULT 0,
    certifications JSONB NOT NULL DEFAULT '[]',
    designation_codes JSONB NOT NULL DEFAULT '[]',
    specialties JSONB NOT NULL DEFAULT '[]',
    presidents_club_stars INT NOT NULL DEFAULT 0,
    gaf_leads_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
    google_place_id VARCHAR(128),
    -- Source profile page
    description TEXT,
    in_business_since INT,
    employees_range VARCHAR(64),
    distinctions JSONB NOT NULL DEFAULT '[]',
    profile_details JSONB NOT NULL DEFAULT '{}',
    profile_scraped_at TIMESTAMPTZ,
    profile_error TEXT,
    raw JSONB NOT NULL DEFAULT '{}',                          -- raw source listing
    scraped_attributes JSONB NOT NULL DEFAULT '{}',          -- written only by the pipeline (e.g. LLM slot values)
    -- Rules tagger
    system_tags JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(system_tags) = 'array'),  -- [{key, value, label, category, reason, source}]
    segment VARCHAR(20),
    priority_score NUMERIC(4,1) CHECK (priority_score BETWEEN 0 AND 100),
    tagged_at TIMESTAMPTZ,
    -- CRM
    assigned_rep_id UUID REFERENCES users(id),               -- copy of the open lead_allocations row; NULL = unallocated pool
    account_status VARCHAR(30) NOT NULL DEFAULT 'prospect'
        CHECK (account_status IN ('prospect', 'existing_customer', 'lapsed_customer', 'do_not_contact')),
    custom_fields JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom_fields) = 'object'),  -- written only by the CRM Write Service
    -- Lead state
    updated_in_last_poll BOOLEAN NOT NULL DEFAULT TRUE,
    last_material_change_at TIMESTAMPTZ,
    team_last_checked_at TIMESTAMPTZ,
    team_last_serviced_at TIMESTAMPTZ,
    -- Bookkeeping
    content_hash VARCHAR(64) NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    listing_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),           -- last version bump
    version INT NOT NULL DEFAULT 1
);
CREATE INDEX companies_location_gist ON companies USING GIST (location);
CREATE INDEX companies_system_tags_gin ON companies USING GIN (system_tags jsonb_path_ops);
CREATE INDEX companies_custom_fields_gin ON companies USING GIN (custom_fields jsonb_path_ops);
CREATE INDEX companies_assigned_rep_priority_idx ON companies (assigned_rep_id, priority_score DESC NULLS LAST, id DESC);
CREATE INDEX companies_priority_idx ON companies (priority_score DESC NULLS LAST, id DESC);
CREATE INDEX companies_county_fips_idx ON companies (county_fips);
CREATE INDEX companies_postal_code_idx ON companies (postal_code);
CREATE INDEX companies_state_city_idx ON companies (state, city);
CREATE INDEX companies_business_name_trgm ON companies USING GIN (business_name gin_trgm_ops);

-- Maps each source's ID (GAF, FMCSA, NY DOS, ...) to the internal company ID
CREATE TABLE company_source_ids (
    source VARCHAR(50) NOT NULL,
    external_id VARCHAR(100) NOT NULL,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source, external_id)
);
CREATE INDEX company_source_ids_company_idx ON company_source_ids (company_id);

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_key VARCHAR(64) UNIQUE,                           -- pipeline's stable hash(company, normalised name, source) for idempotent upserts
    name VARCHAR(255),
    title VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(64),
    source VARCHAR(50) NOT NULL,
    source_url TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    email_verified_at TIMESTAMPTZ,
    do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 1
);
CREATE INDEX contacts_company_idx ON contacts (company_id);

-- Version rule (optimistic locking and the immutable 'lead:{id}:v{version}' cache key):
-- an UPDATE that changes a rep-visible column bumps version by one unless the statement already
-- raised version itself (the CRM Write Service's `SET version = version + 1 WHERE version = $seen`),
-- so the pipeline never has to remember. Bookkeeping columns listed below never bump. Version never
-- goes backwards (e.g. an upsert copying EXCLUDED.version), so a version number is never reused.
-- Changes in child tables (contacts, field_overrides, company_custom_tags, company_insights) do not
-- bump companies.version here: their writer bumps it in the same transaction.
CREATE FUNCTION bump_row_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.version <= OLD.version THEN
        NEW.version := OLD.version;
        IF (to_jsonb(NEW) - TG_ARGV::text[]) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV::text[]) THEN
            NEW.version := OLD.version + 1;
        END IF;
    END IF;
    IF NEW.version <> OLD.version THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER companies_bump_version BEFORE UPDATE ON companies FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'location', 'raw', 'content_hash', 'first_seen_at',
                                      'last_seen_at', 'listing_updated_at', 'profile_scraped_at', 'profile_error',
                                      'tagged_at', 'team_last_checked_at', 'team_last_serviced_at');
CREATE TRIGGER contacts_bump_version BEFORE UPDATE ON contacts FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'first_seen_at', 'last_seen_at');

-- migrate:down
DROP TABLE contacts;
DROP TABLE company_source_ids;
DROP TABLE companies;
DROP FUNCTION bump_row_version();
DROP TABLE users;
