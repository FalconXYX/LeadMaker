-- migrate:up
-- Saved lead lists and UI preferences, kept per user on the server (written by crm-write, read by query).
-- filter is a LeadFilter and sort its {by, dir}, both validated by crm-write on every write.
CREATE TABLE saved_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
    filter JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filter) = 'object'),
    sort JSONB CHECK (sort IS NULL OR jsonb_typeof(sort) = 'object'),
    is_shared BOOLEAN NOT NULL DEFAULT FALSE,                -- set by a manager: every user sees it
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);
CREATE INDEX saved_views_shared_idx ON saved_views (name) WHERE is_shared;

-- One JSON document per user; PUT sends the version it read (optimistic locking)
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(prefs) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 1 CHECK (version > 0)
);

-- migrate:down
DROP TABLE user_preferences;
DROP TABLE saved_views;
