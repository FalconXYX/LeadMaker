-- migrate:up
-- Rep edits; the pipeline never writes here
CREATE TABLE field_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE, -- NULL = company field
    field VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    scraped_value_at_edit JSONB,                             -- detects "source changed since your edit"
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at TIMESTAMPTZ,                               -- replaced by a newer override, or cleared
    superseded_by UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX field_overrides_one_active ON field_overrides (company_id, contact_id, field) NULLS NOT DISTINCT
    WHERE superseded_at IS NULL;                             -- one active override per field
CREATE INDEX field_overrides_history_idx ON field_overrides (company_id, created_at DESC);

CREATE TABLE lead_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rep_id UUID NOT NULL REFERENCES users(id),
    allocated_by UUID NOT NULL REFERENCES users(id),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    ended_by UUID REFERENCES users(id),
    CHECK (ended_at IS NULL OR ended_at >= allocated_at)
);
CREATE UNIQUE INDEX lead_allocations_one_open ON lead_allocations (company_id) WHERE ended_at IS NULL;
CREATE INDEX lead_allocations_rep_open_idx ON lead_allocations (rep_id) WHERE ended_at IS NULL;
CREATE INDEX lead_allocations_history_idx ON lead_allocations (company_id, allocated_at DESC);

-- Per-user checked/serviced; unchecked = checked_at IS NULL OR checked_at < companies.last_material_change_at
CREATE TABLE lead_rep_state (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    checked_at TIMESTAMPTZ,
    serviced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, user_id)
);
CREATE INDEX lead_rep_state_user_idx ON lead_rep_state (user_id);

CREATE TABLE custom_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL CHECK (btrim(name) <> ''),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX custom_tags_name_ci ON custom_tags (lower(name));

CREATE TABLE company_custom_tags (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES custom_tags(id) ON DELETE CASCADE,
    added_by UUID NOT NULL REFERENCES users(id),
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, tag_id)
);
CREATE INDEX company_custom_tags_tag_idx ON company_custom_tags (tag_id);

-- Stable insights: regenerated only when input_hash changes
CREATE TABLE company_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    business_summary TEXT NOT NULL,
    sales_recommendation TEXT NOT NULL,
    model VARCHAR(100) NOT NULL,
    prompt_version VARCHAR(20) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,                         -- hash of facts, notes, custom fields, prompt version, model
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, input_hash)
);
CREATE INDEX company_insights_latest_idx ON company_insights (company_id, generated_at DESC);

-- Notes (action_type 'note') and every other user/pipeline action on a lead; append-only
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'pipeline', 'system')),
    user_id UUID REFERENCES users(id),                       -- NULL for pipeline events
    action_type VARCHAR(50) NOT NULL,                        -- note | call | email | visit | checked | serviced | override | allocation | custom_tag | custom_field | scraped_change
    outcome VARCHAR(50),                                     -- call/email/visit outcome
    note_text TEXT,
    field_diff JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (actor_type <> 'user' OR user_id IS NOT NULL)
);
CREATE INDEX activity_logs_company_idx ON activity_logs (company_id, created_at DESC);
CREATE INDEX activity_logs_user_idx ON activity_logs (user_id, created_at DESC);

-- migrate:down
DROP TABLE activity_logs;
DROP TABLE company_insights;
DROP TABLE company_custom_tags;
DROP TABLE custom_tags;
DROP TABLE lead_rep_state;
DROP TABLE lead_allocations;
DROP TABLE field_overrides;
