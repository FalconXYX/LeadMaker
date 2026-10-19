-- migrate:up
-- Weather/storm/news timing layer: per county, rules-based, joined at read time on companies.county_fips
CREATE TABLE regional_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    county_fips CHAR(5) NOT NULL,
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('active_alert', 'storm_history', 'news')),
    source VARCHAR(64) NOT NULL,                             -- nws | noaa_storm_events | gdelt | local_rss
    external_id VARCHAR(512) NOT NULL,                       -- alert id / event id / article URL
    payload JSONB NOT NULL DEFAULT '{}',
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id, county_fips)
);
CREATE INDEX regional_signals_county_kind_idx ON regional_signals (county_fips, kind, valid_to);

-- Written in the same transaction as each change; the relay publishes it to the Redis Stream 'events'
CREATE TABLE outbox_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed',
        'pipeline.run_completed')),
    company_id UUID,                                         -- NULL for multi-lead events (payload.company_ids)
    payload JSONB NOT NULL CHECK (COALESCE(payload->>'actor_type', '') IN ('user', 'pipeline', 'system')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- Wakes a LISTENing relay at commit; the relay still polls, so a missed notification only adds latency.
CREATE FUNCTION outbox_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('outbox_events', '');
    RETURN NULL;
END $$;
CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events
    FOR EACH STATEMENT EXECUTE FUNCTION outbox_events_notify();

-- migrate:down
DROP TABLE outbox_events;
DROP FUNCTION outbox_events_notify();
DROP TABLE regional_signals;
