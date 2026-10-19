-- migrate:up
-- Territory briefing (Section 4): the deterministic digest per scope ('team' or 'rep:<user id>'), recomputed by
-- the worker after refreshes and signals runs and on a schedule, and AI rewrites of a digest, cached by
-- (scope, digest_hash, prompt_version, model) so an unchanged digest never calls the model again.
CREATE TABLE territory_briefs (
    scope VARCHAR(64) PRIMARY KEY,                           -- 'team' | 'rep:<uuid>'
    digest JSONB NOT NULL,                                   -- §5.2
    digest_text TEXT NOT NULL,                               -- deterministic text; '' when quiet
    digest_hash VARCHAR(64) NOT NULL,
    quiet BOOLEAN NOT NULL DEFAULT FALSE,
    poll_run_id INT REFERENCES scrape_runs(id) ON DELETE SET NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (scope = 'team' OR scope ~ '^rep:[0-9a-f-]{36}$')
);

CREATE TABLE territory_brief_rewrites (
    scope VARCHAR(64) NOT NULL,
    digest_hash VARCHAR(64) NOT NULL,
    prompt_version VARCHAR(20) NOT NULL,
    model VARCHAR(100) NOT NULL,
    ai_text TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope, digest_hash, prompt_version, model)
);
CREATE INDEX territory_brief_rewrites_scope_idx ON territory_brief_rewrites (scope, generated_at DESC);

-- migrate:down
DROP TABLE territory_brief_rewrites;
DROP TABLE territory_briefs;
