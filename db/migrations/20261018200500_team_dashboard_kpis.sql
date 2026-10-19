-- migrate:up
-- Team/manager roll-up, one row per assigned rep (NULL row = unallocated pool). The relay runs
-- REFRESH MATERIALIZED VIEW CONCURRENTLY team_dashboard_kpis every 5 minutes and after pipeline.run_completed.
-- *_count use team-level state (any rep); rep_*_count use the assigned rep's own lead_rep_state,
-- matching that rep's own dashboard. Counts are INT so drivers return numbers, not bigint strings.
CREATE MATERIALIZED VIEW team_dashboard_kpis AS
SELECT
    c.assigned_rep_id,
    COUNT(*)::int AS lead_count,
    (COUNT(*) FILTER (WHERE c.team_last_serviced_at IS NULL))::int AS unserviced_count,
    (COUNT(*) FILTER (WHERE c.team_last_checked_at IS NULL
                         OR c.team_last_checked_at < c.last_material_change_at))::int AS unchecked_count,
    (COUNT(*) FILTER (WHERE c.updated_in_last_poll))::int AS recent_updates_count,
    (COUNT(*) FILTER (WHERE s.serviced_at IS NULL))::int AS rep_unserviced_count,
    (COUNT(*) FILTER (WHERE s.checked_at IS NULL
                         OR s.checked_at < c.last_material_change_at))::int AS rep_unchecked_count,
    NOW() AS refreshed_at
FROM companies c
LEFT JOIN lead_rep_state s ON s.company_id = c.id AND s.user_id = c.assigned_rep_id
GROUP BY c.assigned_rep_id;
CREATE UNIQUE INDEX team_dashboard_kpis_rep_key ON team_dashboard_kpis (assigned_rep_id);  -- required for CONCURRENTLY

-- migrate:down
DROP MATERIALIZED VIEW team_dashboard_kpis;
