-- migrate:up
-- Section 4 batch insights. sales_recommendation holds the pitch angle (one sentence). Talking points, the
-- suggested contact, product focus and the facts each claim cites are stored next to it. One row per
-- (company, input_hash); a failed generation is a status='error' row (empty texts) that readers skip.
ALTER TABLE company_insights
    ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
    ADD COLUMN error TEXT,
    ADD COLUMN attempts INT NOT NULL DEFAULT 1,
    ADD COLUMN talking_points JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN target_contact JSONB,
    ADD COLUMN product_focus JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN cited_facts JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN token_usage JSONB NOT NULL DEFAULT '{}';
CREATE INDEX company_insights_ok_latest_idx ON company_insights (company_id, generated_at DESC) WHERE status = 'ok';

-- migrate:down
DROP INDEX company_insights_ok_latest_idx;
DELETE FROM company_insights WHERE status <> 'ok';
ALTER TABLE company_insights
    DROP COLUMN token_usage, DROP COLUMN cited_facts, DROP COLUMN product_focus, DROP COLUMN target_contact,
    DROP COLUMN talking_points, DROP COLUMN attempts, DROP COLUMN error, DROP COLUMN status;
