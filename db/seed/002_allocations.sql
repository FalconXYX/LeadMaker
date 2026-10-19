-- Gives each demo rep a territory of whole counties and allocates its ~50 highest-priority leads
-- (setting 'seed.per_rep', default 50); every other lead stays in the unallocated pool.
-- Counties are handed out largest pool first: a rep takes counties until its pool holds per_rep
-- leads, then the next rep starts. Runs as the manager, writing lead_allocations,
-- companies.assigned_rep_id, activity_logs and outbox_events together, like the CRM Write Service.
-- Does nothing until companies exist, or once any demo rep already has leads.
DO $$
DECLARE
    per_rep int := COALESCE(NULLIF(current_setting('seed.per_rep', true), '')::int, 50);
    manager uuid;
    reps uuid[];
    rep_idx int := 1;
    pool int := 0;
    county record;
    allocated int;
BEGIN
    SELECT id INTO manager FROM users WHERE email = 'manager@demo.local';
    SELECT array_agg(id ORDER BY email) INTO reps FROM users WHERE email IN ('rep1@demo.local', 'rep2@demo.local', 'rep3@demo.local');
    IF manager IS NULL OR cardinality(reps) IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'demo users missing: run 001_users.sql first';
    END IF;
    IF EXISTS (SELECT 1 FROM lead_allocations WHERE ended_at IS NULL AND rep_id = ANY (reps)) THEN
        RAISE NOTICE 'demo reps already have leads; allocation skipped';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM companies WHERE assigned_rep_id IS NULL) THEN
        RAISE NOTICE 'no unallocated companies yet; import companies, then re-run the seed';
        RETURN;
    END IF;

    CREATE TEMP TABLE seed_territory (county_fips char(5) PRIMARY KEY, rep_id uuid NOT NULL) ON COMMIT DROP;
    FOR county IN
        SELECT county_fips, count(*) AS n FROM companies
        WHERE assigned_rep_id IS NULL AND county_fips IS NOT NULL
        GROUP BY county_fips ORDER BY count(*) DESC, county_fips
    LOOP
        EXIT WHEN rep_idx > cardinality(reps);
        INSERT INTO seed_territory VALUES (county.county_fips, reps[rep_idx]);
        pool := pool + county.n;
        IF pool >= per_rep THEN
            rep_idx := rep_idx + 1;
            pool := 0;
        END IF;
    END LOOP;

    WITH picked AS (
        SELECT c.id AS company_id, t.rep_id,
               row_number() OVER (PARTITION BY t.rep_id ORDER BY c.priority_score DESC NULLS LAST, c.id) AS rn
        FROM companies c JOIN seed_territory t USING (county_fips)
        WHERE c.assigned_rep_id IS NULL
    ), alloc AS (
        INSERT INTO lead_allocations (company_id, rep_id, allocated_by)
        SELECT company_id, rep_id, manager FROM picked WHERE rn <= per_rep
        RETURNING company_id, rep_id
    ), upd AS (
        UPDATE companies c SET assigned_rep_id = alloc.rep_id
        FROM alloc WHERE c.id = alloc.company_id
        RETURNING c.id, c.assigned_rep_id, c.version
    ), act AS (
        INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff)
        SELECT id, 'user', manager, 'allocation', jsonb_build_object('assigned_rep_id', jsonb_build_array(NULL, assigned_rep_id))
        FROM upd
    )
    INSERT INTO outbox_events (event_type, company_id, payload)
    SELECT 'lead.allocated', id, jsonb_build_object(
        'company_id', id, 'rep_id', assigned_rep_id, 'previous_rep_id', NULL,
        'actor_type', 'user', 'actor_id', manager, 'version', version)
    FROM upd;

    GET DIAGNOSTICS allocated = ROW_COUNT;
    RAISE NOTICE 'allocated % leads across % reps', allocated, cardinality(reps);
END $$;
