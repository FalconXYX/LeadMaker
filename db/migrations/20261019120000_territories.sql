-- migrate:up
-- Territories (the manager's Territories page, /api/admin/territories) are schedules of kind 'pipeline':
-- params {postal_code, radius_miles, also_zips?}, enabled as before. every_hours NULL means "manual only"
-- (run from the page, never fired by the worker), so next_run_at is NULL for those too.
ALTER TABLE schedules ALTER COLUMN every_hours DROP NOT NULL;
ALTER TABLE schedules ALTER COLUMN next_run_at DROP NOT NULL;
ALTER TABLE schedules ADD CONSTRAINT schedules_next_run_when_scheduled
    CHECK (every_hours IS NULL OR next_run_at IS NOT NULL);

-- The area every run so far has used (ZIP 10013, 25 mi) shows up as a territory: manual only, so the
-- migration never starts unattended scraping. Skipped when a schedule already covers that ZIP.
INSERT INTO schedules (name, kind, params, every_hours, enabled, next_run_at)
SELECT 'Default area', 'pipeline', '{"postal_code": "10013", "radius_miles": 25}'::jsonb, NULL, TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM schedules WHERE kind IN ('pipeline', 'scrape') AND params->>'postal_code' = '10013')
ON CONFLICT (name) DO NOTHING;

-- migrate:down
DELETE FROM schedules WHERE name = 'Default area' AND every_hours IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.schedule_id = schedules.id);
-- Manual-only territories become disabled daily schedules, which the old columns can hold.
UPDATE schedules SET every_hours = 24, enabled = FALSE, next_run_at = COALESCE(next_run_at, NOW())
    WHERE every_hours IS NULL;
ALTER TABLE schedules DROP CONSTRAINT schedules_next_run_when_scheduled;
ALTER TABLE schedules ALTER COLUMN next_run_at SET NOT NULL;
ALTER TABLE schedules ALTER COLUMN every_hours SET NOT NULL;
