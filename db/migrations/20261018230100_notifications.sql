-- migrate:up
-- In-app notifications, written by services/notifier from the events stream. A repeat with the same
-- dedupe_key merges into the user's unread row (count + 1, new body); once read, the next one starts a new row.
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(40) NOT NULL,                               -- allocated | reassigned_away | storm_alert | source_changed | refresh_done | manager_note | pool_grew
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    county_fips CHAR(5),
    data JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
    dedupe_key VARCHAR(255) NOT NULL,
    count INT NOT NULL DEFAULT 1 CHECK (count > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),           -- last merge; the feed is ordered by it
    read_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX notifications_unread_dedupe ON notifications (user_id, dedupe_key) WHERE read_at IS NULL;
CREATE INDEX notifications_feed_idx ON notifications (user_id, read_at, updated_at DESC, id DESC);

-- Opt-outs per type; a missing row means enabled
CREATE TABLE notification_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(40) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, type)
);

-- Outbox ids the notifier has handled, written in the same transaction as their notifications, so a
-- redelivered stream entry is a no-op. Pruned by age.
CREATE TABLE notifier_processed_events (
    outbox_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notifier_processed_events_at_idx ON notifier_processed_events (processed_at);

-- Small notifier state: the regional_signals watermark, the source value last reported per field override
CREATE TABLE notifier_state (
    key VARCHAR(200) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN (
    'lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed',
    'pipeline.run_completed', 'notification.created'));

-- migrate:down
DELETE FROM outbox_events WHERE event_type = 'notification.created';
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN (
    'lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed',
    'pipeline.run_completed'));
DROP TABLE notifier_state;
DROP TABLE notifier_processed_events;
DROP TABLE notification_preferences;
DROP TABLE notifications;
