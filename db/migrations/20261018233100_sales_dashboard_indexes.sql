-- migrate:up
-- Indexes for the sales dashboard and task lists (services/query dashboard.ts, tasks.ts, filter-sql.ts).
-- Team coverage: the named-decision-maker and website-email lead sets as index-only scans. The predicates must
-- stay byte-identical to dashboard.ts NAMED_TARGET / SITE_EMAIL or the planner will not use them.
CREATE INDEX companies_target_named_idx ON companies (assigned_rep_id, id)
    WHERE tag_facets @> '{decision_maker=identified}'::text[]
       OR (tag_facets @> '{decision_maker=weak}'::text[]
           AND system_tags @> '[{"key": "target_contact", "contact": {"named": true}}]'::jsonb);
CREATE INDEX companies_site_email_idx ON companies (assigned_rep_id, id) WHERE tag_facets @> '{direct_email}'::text[];

-- Index-only stage, status, segment and recency counts and per-rep pipelines; replaces the plain stage index.
CREATE INDEX companies_rep_sales_cover_idx ON companies (assigned_rep_id, sales_stage)
    INCLUDE (account_status, segment, last_contacted_at, updated_in_last_poll, stage_changed_at);
DROP INDEX companies_assigned_rep_stage_idx;

-- The team activity window and per-rep weekly counts.
CREATE INDEX activity_logs_created_brin ON activity_logs USING brin (created_at);
-- GET /tasks?status=done (most recently completed first).
CREATE INDEX tasks_done_idx ON tasks (done_at DESC, id DESC) WHERE done_at IS NOT NULL;
-- Sort last_contacted (never contacted counts as oldest).
CREATE INDEX companies_last_contacted_idx ON companies ((COALESCE(last_contacted_at, '-infinity'::timestamptz)), id);

-- migrate:down
DROP INDEX companies_last_contacted_idx;
DROP INDEX tasks_done_idx;
DROP INDEX activity_logs_created_brin;
CREATE INDEX companies_assigned_rep_stage_idx ON companies (assigned_rep_id, sales_stage);
DROP INDEX companies_rep_sales_cover_idx;
DROP INDEX companies_site_email_idx;
DROP INDEX companies_target_named_idx;
