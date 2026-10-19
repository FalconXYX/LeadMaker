-- migrate:up
-- Sales pipeline per lead and follow-up tasks, both written by crm-write. sales_stage moves the lead version
-- (lists and the cached profile show it); last_contacted_at, set by every logged call, email or visit, does not.
ALTER TABLE companies
    ADD COLUMN sales_stage VARCHAR(20) NOT NULL DEFAULT 'new'
        CHECK (sales_stage IN ('new', 'contacted', 'interested', 'quoting', 'won', 'lost')),
    ADD COLUMN stage_changed_at TIMESTAMPTZ,
    ADD COLUMN last_contacted_at TIMESTAMPTZ;
CREATE INDEX companies_assigned_rep_stage_idx ON companies (assigned_rep_id, sales_stage);

DROP TRIGGER companies_bump_version ON companies;
CREATE TRIGGER companies_bump_version BEFORE UPDATE ON companies FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'location', 'raw', 'content_hash', 'first_seen_at',
                                      'last_seen_at', 'listing_updated_at', 'profile_scraped_at', 'profile_error',
                                      'tagged_at', 'team_last_checked_at', 'team_last_serviced_at',
                                      'founded_year', 'tag_facets', 'last_contacted_at');

-- Leads with a logged call, email or visit were contacted.
UPDATE companies c SET last_contacted_at = a.last_at, sales_stage = 'contacted', stage_changed_at = a.first_at
FROM (SELECT company_id, min(created_at) AS first_at, max(created_at) AS last_at FROM activity_logs
      WHERE action_type IN ('call', 'email', 'visit') GROUP BY company_id) a
WHERE c.id = a.company_id;

-- A follow-up on a lead; type is what the follow-up is (todo: anything else). Edits are optimistic-locked on version.
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL CHECK (btrim(title) <> ''),
    type VARCHAR(10) NOT NULL DEFAULT 'todo' CHECK (type IN ('call', 'email', 'visit', 'todo')),
    due_at TIMESTAMPTZ NOT NULL,
    done_at TIMESTAMPTZ,
    note TEXT,
    assignee_id UUID NOT NULL REFERENCES users(id),
    created_by UUID NOT NULL REFERENCES users(id),
    source VARCHAR(20) NOT NULL DEFAULT 'user',              -- user | demo_seed (db/seed/003_demo_activity.sql)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, done_at, due_at);
CREATE INDEX tasks_company_idx ON tasks (company_id, done_at, due_at);
CREATE INDEX tasks_open_due_idx ON tasks (due_at) WHERE done_at IS NULL;  -- the notifier's task_due scan

-- migrate:down
DROP TABLE tasks;
DROP TRIGGER companies_bump_version ON companies;
CREATE TRIGGER companies_bump_version BEFORE UPDATE ON companies FOR EACH ROW
    EXECUTE FUNCTION bump_row_version('version', 'updated_at', 'location', 'raw', 'content_hash', 'first_seen_at',
                                      'last_seen_at', 'listing_updated_at', 'profile_scraped_at', 'profile_error',
                                      'tagged_at', 'team_last_checked_at', 'team_last_serviced_at',
                                      'founded_year', 'tag_facets');
DROP INDEX companies_assigned_rep_stage_idx;
ALTER TABLE companies DROP COLUMN last_contacted_at, DROP COLUMN stage_changed_at, DROP COLUMN sales_stage;
