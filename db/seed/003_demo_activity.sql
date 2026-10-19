-- Demo sales history for the demo reps' allocated leads, so the dashboard, pipeline and task lists have something to
-- show: stages (per rep ~40% new, 25% contacted, 15% interested, 8% quoting, 7% won, 5% not a fit), four weeks of
-- weekday calls, emails and visits by the owning rep with their stage changes (a few contacted leads went cold over
-- 30 days ago), last_contacted_at and the rep's serviced state to match, open tasks (overdue, today, this week, later)
-- and done ones, and ~10% existing or lapsed customers; a lead's only allocation moves back before its first touch.
-- Deterministic per lead; leads that already have sales history (or are do-not-contact) are left alone. Every row it writes is marked: activity_logs.field_diff.demo_seed = true and
-- tasks.source = 'demo_seed'. Writes no outbox events: this is history, not live activity.
-- Runs once (marker: an audit_events row with entity_type 'demo_seed'), and only once the demo reps have leads.
-- SEED_DEMO_ACTIVITY=0 turns it off (the compose seed service passes it as the setting seed.demo_activity; unset = on).
DO $$
DECLARE
    tz CONSTANT text := 'America/New_York';
    setting text := lower(COALESCE(NULLIF(current_setting('seed.demo_activity', true), ''), '1'));
    today date := (now() AT TIME ZONE 'America/New_York')::date;
    seed CONSTANT jsonb := '{"demo_seed": true}';
    manager uuid;
    reps uuid[];
    lead record;
    rs float8[];
    p float8;
    stage text;
    cold boolean;
    lapsed boolean;
    touches int;
    weekdays date[];
    win_lo int;
    win_hi int;
    i int;
    d date;
    ts timestamptz;
    times timestamptz[];
    kinds text[];
    ids uuid[];
    kind text;
    outcome text;
    note text;
    act_id uuid;
    path text[];
    path_at int[];
    prev text;
    changed_at timestamptz;
    task_id uuid;
    task_type text;
    task_title text;
    due timestamptz;
    created timestamptz;
    creator uuid;
    n_leads int := 0;
    n_acts int := 0;
    n_tasks int := 0;
    customers jsonb := '[]';
    call_connected text[] := ARRAY[
        'Spoke with the owner. They buy GAF Timberline HDZ through another yard and are open to a price comparison.',
        'Talked to the estimator: two reroofs in Hackensack next week, needs 60 squares of architectural shingles.',
        'Owner wants pricing on synthetic underlayment and ice & water shield; currently pays list at their supplier.',
        'Connected with the office manager. They run 3 crews, mostly residential tear-offs, and want rooftop delivery.',
        'Good call. Interested in TPO for a strip-mall job; wants 60-mil pricing and seam tape lead times.',
        'Asked about our delivery cutoffs and boom-truck rooftop loading. Sending details by email.',
        'Owner unhappy with late deliveries from their current yard. Wants a credit application.',
        'Discussed fall promo on Duration shingles; they quote a lot of Driftwood and Onyx Black.'];
    call_short text[] := ARRAY[
        'Left a voicemail about fall shingle pricing and our next-day delivery.',
        'No answer at the office line; tried the cell listed on the truck.',
        'Receptionist says the owner is out on a job until Thursday. Call back then.',
        'Left a voicemail with the estimator about the underlayment promo.',
        'Office closed for a storm job; will try again early next week.'];
    email_notes text[] := ARRAY[
        'Sent the October price sheet for architectural shingles, starter strip and ridge cap.',
        'Emailed spec sheets for synthetic underlayment and ice & water shield.',
        'Sent the credit application and our delivery zones map.',
        'Followed up with TPO pricing (60-mil white) and lead times on seam tape and termination bar.',
        'Sent photos of ridge vent options and the drip edge colors we stock.',
        'Emailed a quote for 40 squares of Timberline HDZ in Charcoal with starter and hip & ridge.'];
    email_reply text[] := ARRAY[
        'They replied asking about job-site delivery in Bergen County and rooftop loading.',
        'Owner replied: wants net-30 terms before switching suppliers.',
        'Estimator replied with a takeoff for a 32-square reroof; asked for a price by Friday.'];
    visit_notes text[] := ARRAY[
        'Stopped by the shop and met the foreman. Left ice & water shield and underlayment samples.',
        'Walked a reroof with the owner; they need 40 squares of Duration in Driftwood next month.',
        'Visited with the GAF territory manager; owner interested in Master Elite rewards on our orders.',
        'Dropped off shingle boards and our winter delivery schedule. Yard access is off the side street.',
        'Met the owner at their warehouse job; looked at the flat section, a good fit for TPO.'];
    rep_notes text[] := ARRAY[
        'Owner prefers deliveries before 7am; trucks must stay off the lawn.',
        'Runs 3 crews, mostly residential reroofs. Decision maker is the owner, estimator handles orders.',
        'Pays on time per their other suppliers. Ask for the PO number on every order.',
        'Busy season through November with storm work; best to call after 3pm.',
        'Uses mostly GAF; open to Owens Corning if the price is right.'];
    won_notes text[] := ARRAY[
        'Placed a first order: 32 squares of Timberline HDZ Charcoal plus starter and ridge cap, delivery Thursday.',
        'Account opened. First order is 4 rolls of 60-mil TPO and seam tape for the strip-mall job.',
        'Won them over on delivery times. Standing order for synthetic underlayment every other week.'];
    lost_notes text[] := ARRAY[
        'Buys direct on a volume contract with a national distributor; not switching this year.',
        'Mostly does siding now; very little roofing work. Not a fit.',
        'Only does commercial EPDM, which we do not stock.'];
    task_titles jsonb := '{
        "call": ["Call back about fall shingle pricing", "Follow up on the TPO quote", "Check in once storm work slows down",
                 "Call the owner about opening an account", "Confirm the delivery window for next week''s reroof"],
        "email": ["Email the October price sheet", "Send the credit application", "Email spec sheets for synthetic underlayment",
                  "Send photos of the ridge vent options"],
        "visit": ["Drop off ice & water shield samples", "Stop by the shop with the GAF territory manager",
                  "Walk the warehouse reroof with the foreman", "Bring Duration shingle boards in Driftwood and Onyx Black"],
        "todo": ["Prepare the quote for 40 squares of Timberline HDZ", "Price out 60-mil TPO for the strip-mall job",
                 "Check credit terms with accounting", "Set up the account and delivery preferences"]}';
    task_notes text[] := ARRAY[
        'Ask for Mike, the estimator.', 'Owner is only in the office before 8am.', 'Bring the fall promo flyer.',
        'They want pricing on starter and ridge cap too.'];
BEGIN
    IF setting NOT IN ('1', 'true', 'yes', 'on') THEN
        RAISE NOTICE 'SEED_DEMO_ACTIVITY=%: demo activity skipped', setting;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'demo_seed' AND entity_id = '003_demo_activity') THEN
        RAISE NOTICE 'demo activity already seeded';
        RETURN;
    END IF;
    SELECT id INTO manager FROM users WHERE email = 'manager@demo.local';
    SELECT array_agg(id ORDER BY email) INTO reps FROM users WHERE email IN ('rep1@demo.local', 'rep2@demo.local', 'rep3@demo.local');
    IF manager IS NULL OR NOT EXISTS (SELECT 1 FROM companies WHERE assigned_rep_id = ANY (reps)) THEN
        RAISE NOTICE 'demo reps have no leads yet; demo activity skipped';
        RETURN;
    END IF;
    weekdays := ARRAY(SELECT g::date FROM generate_series(today - 40, today, interval '1 day') g
                      WHERE extract(isodow FROM g) < 6 ORDER BY g);

    FOR lead IN
        SELECT c.id, c.assigned_rep_id AS rep_id, c.account_status,
               row_number() OVER (PARTITION BY c.assigned_rep_id ORDER BY md5(c.id::text || ':stage')) AS rn,
               count(*) OVER (PARTITION BY c.assigned_rep_id) AS n
        FROM companies c
        WHERE c.assigned_rep_id = ANY (reps) AND c.sales_stage = 'new' AND c.last_contacted_at IS NULL
          AND c.account_status <> 'do_not_contact'
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.company_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = c.id
                          AND a.action_type IN ('call', 'email', 'visit', 'note', 'stage_changed'))
        ORDER BY c.assigned_rep_id, rn
    LOOP
        n_leads := n_leads + 1;
        rs := ARRAY(SELECT (hashtextextended(lead.id::text || ':' || g, 0) & 1048575) / 1048576.0 FROM generate_series(1, 64) g);
        p := (lead.rn - 0.5) / lead.n;
        stage := CASE WHEN p < 0.40 THEN 'new' WHEN p < 0.65 THEN 'contacted' WHEN p < 0.80 THEN 'interested'
                      WHEN p < 0.88 THEN 'quoting' WHEN p < 0.95 THEN 'won' ELSE 'lost' END;

        IF stage = 'new' THEN
            -- A quarter of the untouched leads have an intro call planned (some set up by the manager).
            IF rs[55] < 0.25 THEN
                d := today + floor(rs[56] * 5)::int;
                d := d + CASE extract(isodow FROM d) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END;
                due := (d + make_interval(mins => 540 + floor(rs[64] * 16)::int * 30)) AT TIME ZONE tz;
                creator := CASE WHEN rs[58] < 0.3 THEN manager ELSE lead.rep_id END;
                created := now() - make_interval(hours => 20 + floor(rs[57] * 50)::int);
                task_title := (ARRAY['Intro call: our yard, delivery zones and fall pricing',
                                     'Call the owner to introduce our shingle and underlayment lines',
                                     'First call: ask who handles material orders'])[1 + floor(rs[57] * 3)::int];
                INSERT INTO tasks (company_id, title, type, due_at, assignee_id, created_by, source, created_at, updated_at)
                VALUES (lead.id, task_title, 'call', due, lead.rep_id, creator, 'demo_seed', created, created)
                RETURNING id INTO task_id;
                INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
                VALUES (lead.id, 'user', creator, 'task_created', seed || jsonb_build_object(
                    'task_id', task_id, 'title', task_title, 'type', 'call', 'due_at', due, 'assignee_id', lead.rep_id), created);
                n_tasks := n_tasks + 1;
                n_acts := n_acts + 1;
            END IF;
            CONTINUE;
        END IF;

        cold := stage = 'contacted' AND rs[2] < 0.3;
        lapsed := stage IN ('contacted', 'interested') AND rs[3] < 0.08 AND lead.account_status = 'prospect';
        touches := CASE stage WHEN 'contacted' THEN 1 + floor(rs[4] * 2)::int WHEN 'interested' THEN 2 + floor(rs[4] * 3)::int
                              WHEN 'quoting' THEN 3 + floor(rs[4] * 3)::int WHEN 'won' THEN 4 + floor(rs[4] * 3)::int
                              ELSE 1 + floor(rs[4] * 3)::int END;
        -- Touch i of n falls in the i-th of n parts of the window's weekdays (oldest first; recent parts are shorter, so
        -- activity picks up), 8am to 5pm. The window is the last four weeks, or 31-40 days ago for a lead gone cold.
        SELECT min(k), max(k) INTO win_lo, win_hi FROM generate_subscripts(weekdays, 1) k
        WHERE weekdays[k] BETWEEN today - CASE WHEN cold THEN 40 ELSE 27 END AND today - CASE WHEN cold THEN 31 ELSE 0 END;
        times := '{}';
        FOR i IN 1..touches LOOP
            d := weekdays[win_lo + floor(power((i - 1 + rs[4 + i]) / touches, 0.7) * (win_hi - win_lo + 1))::int];
            ts := (d + make_interval(mins => 480 + floor(rs[44 + i] * 108)::int * 5)) AT TIME ZONE tz;
            times := times || LEAST(ts, now() - make_interval(mins => 15 + 45 * (touches - i)));
        END LOOP;
        times := ARRAY(SELECT x FROM unnest(times) x ORDER BY x);

        kinds := '{}';
        ids := '{}';
        FOR i IN 1..touches LOOP
            kind := CASE
                WHEN stage IN ('won', 'lost') AND i = touches THEN 'call'
                WHEN stage IN ('quoting', 'won') AND i = touches - 1 THEN 'visit'
                WHEN i = 1 THEN CASE WHEN rs[14 + i] < 0.7 THEN 'call' ELSE 'email' END
                WHEN rs[14 + i] < 0.45 THEN 'call' WHEN rs[14 + i] < 0.8 THEN 'email' ELSE 'visit' END;
            IF kind = 'call' THEN
                IF stage = 'won' AND i = touches THEN
                    outcome := 'Connected';
                    note := won_notes[1 + floor(rs[34 + i] * array_length(won_notes, 1))::int];
                ELSIF stage = 'lost' AND i = touches THEN
                    outcome := 'Not interested';
                    note := lost_notes[1 + floor(rs[34 + i] * array_length(lost_notes, 1))::int];
                ELSIF rs[24 + i] < 0.5 THEN
                    outcome := 'Connected';
                    note := call_connected[1 + floor(rs[34 + i] * array_length(call_connected, 1))::int];
                ELSE
                    outcome := (ARRAY['Left voicemail', 'No answer', 'Call back later'])[1 + floor((rs[24 + i] - 0.5) * 6)::int];
                    note := call_short[1 + floor(rs[34 + i] * array_length(call_short, 1))::int];
                END IF;
            ELSIF kind = 'email' THEN
                IF rs[24 + i] < 0.3 THEN
                    outcome := 'Replied';
                    note := email_reply[1 + floor(rs[34 + i] * array_length(email_reply, 1))::int];
                ELSE
                    outcome := 'Sent';
                    note := email_notes[1 + floor(rs[34 + i] * array_length(email_notes, 1))::int];
                END IF;
            ELSE
                outcome := (ARRAY['Met decision-maker', 'Dropped off samples', 'Left materials'])[1 + floor(rs[24 + i] * 3)::int];
                note := visit_notes[1 + floor(rs[34 + i] * array_length(visit_notes, 1))::int];
            END IF;
            IF lapsed AND i = 1 THEN
                note := 'Former account, last order spring 2025. Reaching out to win them back with fall pricing.';
            END IF;
            INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, outcome, note_text, field_diff, created_at)
            VALUES (lead.id, 'user', lead.rep_id, kind, outcome, note, seed, times[i])
            RETURNING id INTO act_id;
            kinds := kinds || kind;
            ids := ids || act_id;
            n_acts := n_acts + 1;
        END LOOP;

        -- Stage history: contacted at the first touch (as the live auto-advance does), then on to the final stage.
        path := CASE stage
            WHEN 'contacted' THEN ARRAY['contacted'] WHEN 'interested' THEN ARRAY['contacted', 'interested']
            WHEN 'quoting' THEN ARRAY['contacted', 'interested', 'quoting'] WHEN 'won' THEN ARRAY['contacted', 'interested', 'quoting', 'won']
            ELSE ARRAY['contacted', 'lost'] END;
        path_at := CASE stage
            WHEN 'contacted' THEN ARRAY[1] WHEN 'interested' THEN ARRAY[1, 2] WHEN 'quoting' THEN ARRAY[1, 2, touches]
            WHEN 'won' THEN ARRAY[1, 2, 3, touches] ELSE ARRAY[1, touches] END;
        prev := 'new';
        FOR i IN 1..array_length(path, 1) LOOP
            changed_at := times[path_at[i]] + make_interval(mins => i);
            INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
            VALUES (lead.id, 'user', lead.rep_id, 'stage_changed', seed || jsonb_build_object('sales_stage', jsonb_build_array(prev, path[i]))
                    || CASE WHEN i = 1 THEN jsonb_build_object('auto', true, 'activity_id', ids[1]) ELSE '{}' END, changed_at);
            prev := path[i];
            n_acts := n_acts + 1;
        END LOOP;

        IF stage IN ('interested', 'quoting', 'won') AND rs[60] < 0.5 THEN
            INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, note_text, field_diff, created_at)
            VALUES (lead.id, 'user', lead.rep_id, 'note', rep_notes[1 + floor(rs[61] * array_length(rep_notes, 1))::int], seed,
                    times[1 + floor(rs[61] * touches)::int] + interval '20 minutes');
            n_acts := n_acts + 1;
        END IF;

        -- A follow-up the rep completed at one of the later touches.
        IF touches >= 2 AND rs[59] < 0.5 THEN
            i := 2 + floor(rs[63] * (touches - 1))::int;
            task_type := kinds[i];
            task_title := task_titles -> task_type ->> floor(rs[57] * jsonb_array_length(task_titles -> task_type))::int;
            created := times[i - 1] + interval '10 minutes';
            due := (date_trunc('day', times[i] AT TIME ZONE tz) + interval '9 hours') AT TIME ZONE tz;
            INSERT INTO tasks (company_id, title, type, due_at, done_at, assignee_id, created_by, source, created_at, updated_at, version)
            VALUES (lead.id, task_title, task_type, due, times[i] + interval '5 minutes', lead.rep_id, lead.rep_id, 'demo_seed',
                    created, times[i] + interval '5 minutes', 2)
            RETURNING id INTO task_id;
            INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at) VALUES
                (lead.id, 'user', lead.rep_id, 'task_created', seed || jsonb_build_object(
                    'task_id', task_id, 'title', task_title, 'type', task_type, 'due_at', due, 'assignee_id', lead.rep_id), created),
                (lead.id, 'user', lead.rep_id, 'task_completed', seed || jsonb_build_object(
                    'task_id', task_id, 'title', task_title, 'type', task_type, 'due_at', due, 'assignee_id', lead.rep_id,
                    'changes', jsonb_build_object('done_at', jsonb_build_array(NULL, times[i] + interval '5 minutes'))),
                 times[i] + interval '5 minutes');
            n_tasks := n_tasks + 1;
            n_acts := n_acts + 2;
        END IF;

        -- The next step on open deals: overdue, due today, this week or later (cold leads have none: that is why).
        IF (stage IN ('contacted', 'interested', 'quoting') AND NOT cold AND rs[55] < 0.85) OR (stage = 'won' AND rs[55] < 0.5) THEN
            IF stage = 'won' THEN
                task_type := 'todo';
                task_title := 'Set up the account and delivery preferences';
            ELSIF stage = 'quoting' THEN
                task_type := CASE WHEN rs[57] < 0.5 THEN 'call' ELSE 'todo' END;
                task_title := CASE WHEN task_type = 'call' THEN 'Follow up on the quote' ELSE task_titles -> 'todo' ->> floor(rs[62] * 3)::int END;
            ELSE
                task_type := (ARRAY['call', 'call', 'email', 'visit'])[1 + floor(rs[57] * 4)::int];
                task_title := task_titles -> task_type ->> floor(rs[62] * jsonb_array_length(task_titles -> task_type))::int;
            END IF;
            IF rs[55] < 0.22 THEN
                d := today - 1 - floor(rs[56] * 4)::int;
                d := d - CASE extract(isodow FROM d) WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 0 END;
            ELSIF rs[55] < 0.40 THEN
                d := today;
            ELSIF rs[55] < 0.75 THEN
                d := today + 1 + floor(rs[56] * 6)::int;
                d := d + CASE extract(isodow FROM d) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END;
                IF d > today + 6 THEN d := today + 6 - CASE extract(isodow FROM today + 6) WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 0 END; END IF;
            ELSE
                d := today + 8 + floor(rs[56] * 12)::int;
                d := d + CASE extract(isodow FROM d) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END;
            END IF;
            due := (d + make_interval(mins => 540 + floor(rs[64] * 15)::int * 30)) AT TIME ZONE tz;
            created := times[touches] + interval '10 minutes';
            creator := CASE WHEN rs[58] < 0.1 THEN manager ELSE lead.rep_id END;
            INSERT INTO tasks (company_id, title, type, due_at, note, assignee_id, created_by, source, created_at, updated_at)
            VALUES (lead.id, task_title, task_type, due,
                    CASE WHEN rs[62] < 0.3 THEN task_notes[1 + floor(rs[61] * array_length(task_notes, 1))::int] END,
                    lead.rep_id, creator, 'demo_seed', created, created)
            RETURNING id INTO task_id;
            INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
            VALUES (lead.id, 'user', creator, 'task_created', seed || jsonb_build_object(
                'task_id', task_id, 'title', task_title, 'type', task_type, 'due_at', due, 'assignee_id', lead.rep_id), created);
            n_tasks := n_tasks + 1;
            n_acts := n_acts + 1;
        END IF;

        INSERT INTO lead_rep_state (company_id, user_id, serviced_at, updated_at)
        VALUES (lead.id, lead.rep_id, times[touches], now())
        ON CONFLICT (company_id, user_id) DO UPDATE
            SET serviced_at = GREATEST(lead_rep_state.serviced_at, EXCLUDED.serviced_at), updated_at = now();
        UPDATE companies SET
            sales_stage = stage,
            stage_changed_at = times[path_at[array_length(path_at, 1)]] + make_interval(mins => array_length(path, 1)),
            last_contacted_at = times[touches],
            team_last_serviced_at = GREATEST(team_last_serviced_at, times[touches]),
            account_status = CASE WHEN account_status <> 'prospect' THEN account_status
                                  WHEN stage = 'won' THEN 'existing_customer' WHEN lapsed THEN 'lapsed_customer'
                                  ELSE account_status END
        WHERE id = lead.id;
        IF lead.account_status = 'prospect' AND (stage = 'won' OR lapsed) THEN
            customers := customers || to_jsonb(lead.id);
        END IF;
        -- The lead was the rep's before the history starts: an only allocation moves back before the first touch.
        UPDATE lead_allocations la SET allocated_at = times[1] - make_interval(days => 3 + floor(rs[2] * 10)::int)
        WHERE la.company_id = lead.id AND la.ended_at IS NULL AND la.allocated_at > times[1]
          AND NOT EXISTS (SELECT 1 FROM lead_allocations o WHERE o.company_id = lead.id AND o.id <> la.id);
        IF FOUND THEN
            UPDATE activity_logs SET created_at = times[1] - make_interval(days => 3 + floor(rs[2] * 10)::int)
            WHERE company_id = lead.id AND action_type = 'allocation' AND created_at > times[1];
        END IF;
    END LOOP;

    INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type)
    VALUES ('demo_seed', '003_demo_activity', 'created', jsonb_build_object(
        'leads', n_leads, 'activities', n_acts, 'tasks', n_tasks, 'customers', customers), 'system');
    RAISE NOTICE 'demo activity: % leads, % activity rows, % tasks', n_leads, n_acts, n_tasks;
END $$;
