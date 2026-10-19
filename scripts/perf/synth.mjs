// Synthetic NY/NJ/CT dataset at the SystemDesign §3 scale, generated set-based inside Postgres.
// Usage: node scripts/perf/synth.mjs [--companies 100000] [--reps 2000] [--managers 200]
//   PERF_DATABASE_URL (default postgres://leadmaker:leadmaker@localhost:55432/leadmaker_perf)
// Wipes and refills the target database, so it refuses any database whose name does not end in _perf.
// Ids are deterministic (uid('c'||n)), so the load generator can rebuild them without a lookup.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((a) => a.trim().split(/\s+/)).map(([k, v]) => [k, v ?? '1']));
const COMPANIES = Number(args.companies ?? 100_000);
const REPS = Number(args.reps ?? 2000);
const MANAGERS = Number(args.managers ?? 200);
const URL_ = process.env.PERF_DATABASE_URL ?? 'postgres://leadmaker:leadmaker@localhost:55432/leadmaker_perf';
const dbName = new URL(URL_).pathname.slice(1);
if (!dbName.endsWith('_perf')) throw new Error(`refusing to wipe ${dbName}: the perf database name must end in _perf`);

const zips = readFileSync(new URL('./zips.tsv', import.meta.url), 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));

const SERVICES = [
  // key, label, share of companies (real pipeline output, 424 GAF leads)
  ['general_contracting', 'General contracting', 0.47], ['siding', 'Siding', 0.46], ['roof_replacement', 'Roof replacement', 0.44],
  ['gutters', 'Gutters', 0.44], ['shingle_roofing', 'Shingle roofing', 0.38], ['inspections', 'Inspections', 0.37],
  ['roof_repair', 'Roof repair', 0.37], ['commercial_roofing', 'Commercial roofing', 0.37], ['flat_roofing', 'Flat roofing', 0.3],
  ['windows', 'Windows', 0.27], ['emergency_service', 'Emergency service', 0.27], ['storm_damage', 'Storm damage', 0.25],
  ['chimney', 'Chimney', 0.24], ['metal_roofing', 'Metal roofing', 0.22], ['skylights', 'Skylights', 0.22],
  ['masonry', 'Masonry', 0.21], ['insulation', 'Insulation', 0.19], ['single_ply_roofing', 'Single-ply roofing', 0.18],
  ['slate_roofing', 'Slate roofing', 0.17], ['tpo_roofing', 'TPO roofing', 0.16], ['insurance_claims', 'Insurance claims', 0.16],
  ['waterproofing', 'Waterproofing', 0.15], ['solar', 'Solar', 0.09], ['new_construction', 'New construction', 0.09],
  ['tile_roofing', 'Tile roofing', 0.08],
];

const T0 = Date.now();
const client = new pg.Client({ connectionString: URL_ });
await client.connect();
async function step(name, text, values) {
  const t = Date.now();
  const r = await client.query(text, values);
  console.log(`${name.padEnd(28)} ${String(r.rowCount ?? '').padStart(8)} rows  ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

await step('helpers', `
  CREATE FUNCTION pg_temp.r(n bigint, salt int) RETURNS float8 LANGUAGE sql IMMUTABLE AS
    $$ SELECT (hashint8(n * 7919 + salt) & 2147483647)::float8 / 2147483648 $$;
  CREATE FUNCTION pg_temp.uid(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
    $$ SELECT overlay(overlay(md5(t) placing '4' from 13) placing '8' from 17)::uuid $$;
  CREATE FUNCTION pg_temp.pick(arr text[], x float8) RETURNS text LANGUAGE sql IMMUTABLE AS
    $$ SELECT arr[1 + floor(x * array_length(arr, 1))::int] $$;`);

await step('wipe', `TRUNCATE users, companies, custom_tags, regional_signals, outbox_events, scrape_runs, audit_events,
  jobs, schedules, accounts RESTART IDENTITY CASCADE`);

await step('users', `
  INSERT INTO users (id, name, email, role, created_at)
  SELECT pg_temp.uid('u' || n),
    pg_temp.pick(ARRAY['Alex','Jordan','Sam','Taylor','Morgan','Casey','Riley','Jamie','Avery','Quinn','Drew','Reese'], pg_temp.r(n, 1))
      || ' ' || pg_temp.pick(ARRAY['Rivera','Chen','Patel','Kowalski','Murphy','Nguyen','Cohen','Okafor','Silva','Russo','Kim','Walsh'], pg_temp.r(n, 2))
      || ' ' || n,
    CASE WHEN n <= $1::int THEN format('manager%s@perf.local', lpad(n::text, 4, '0'))
         ELSE format('rep%s@perf.local', lpad((n - $1::int)::text, 4, '0')) END,
    CASE WHEN n <= $1::int THEN 'manager' ELSE 'rep' END,
    now() - interval '400 days'
  FROM generate_series(1, $1::int + $2::int) n`, [MANAGERS, REPS]);

await step('zips', `
  CREATE TEMP TABLE zips AS
  SELECT row_number() OVER (ORDER BY z->>0) AS i, z->>0 AS zip, z->>1 AS state, (z->>2)::float8 AS lat,
         (z->>3)::float8 AS lng, z->>4 AS county_fips, z->>5 AS city,
         CASE WHEN left(z->>0, 3) BETWEEN '100' AND '119' OR left(z->>0, 3) BETWEEN '070' AND '079'
                OR left(z->>0, 3) IN ('068', '069', '064', '065') THEN 4 ELSE 1 END AS weight
  FROM jsonb_array_elements($1::jsonb) z`, [JSON.stringify(zips)]);
await step('zip slots', `
  CREATE TEMP TABLE zipslots AS SELECT row_number() OVER (ORDER BY i, w) AS slot, i FROM zips, generate_series(1, weight) w`);

await step('services', `
  CREATE TEMP TABLE services AS
  SELECT ord::int, s->>0 AS key, s->>1 AS label, (s->>2)::float8 AS p
  FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(s, ord)`, [JSON.stringify(SERVICES)]);

// One row per company with every random draw it needs; allocation in contiguous geographic chunks per rep.
await step('stage', `
  CREATE TEMP TABLE stage AS
  WITH base AS (
    SELECT n, z.*,
      pg_temp.r(n, 10) AS r_tier, pg_temp.r(n, 11) AS r_rev, pg_temp.r(n, 12) AS r_size, pg_temp.r(n, 13) AS r_age,
      pg_temp.r(n, 14) AS r_alloc, pg_temp.r(n, 15) AS r_state, pg_temp.r(n, 16) AS r_rating, pg_temp.r(n, 17) AS r_misc
    FROM generate_series(1, $1::int) n
    JOIN zipslots zs ON zs.slot = 1 + floor(pg_temp.r(n, 3) * (SELECT count(*) FROM zipslots))::int
    JOIN zips z ON z.i = zs.i
  ), alloc AS (
    SELECT b.*, CASE WHEN r_alloc < 0.7
      THEN row_number() OVER (PARTITION BY r_alloc < 0.7 ORDER BY county_fips, zip, n) END AS alloc_rn,
      count(*) FILTER (WHERE r_alloc < 0.7) OVER () AS n_alloc
    FROM base b
  )
  SELECT a.*, pg_temp.uid('c' || n) AS id,
    CASE WHEN alloc_rn IS NOT NULL THEN pg_temp.uid('u' || ($2::int + 1 + ((alloc_rn - 1) * $3::int / n_alloc))) END AS rep_id,
    CASE WHEN r_tier < 0.2 THEN 'master_elite' WHEN r_tier < 0.35 THEN 'certified_plus' WHEN r_tier < 0.9 THEN 'certified' END AS gaf_tier,
    CASE WHEN r_rev < 0.45 THEN 0 ELSE floor(exp(pg_temp.r(n, 20) * 6.2))::int END AS reviews,
    CASE WHEN r_size < 0.45 THEN 'small' WHEN r_size < 0.85 THEN 'medium' ELSE 'large' END AS size,
    2026 - floor(pow(r_age, 1.6) * 60)::int AS founded,
    now() - (pg_temp.r(n, 21) * interval '120 days') AS material_at
  FROM alloc a`, [COMPANIES, MANAGERS, REPS]);

await step('companies', `
  INSERT INTO companies (id, business_name, dba, legal_name, contractor_type, address, street, city, state, postal_code,
    country, phone, website_url, website_source, latitude, longitude, county_fips, rating, review_count, profile_url, tier,
    tier_rank, certifications, designation_codes, specialties, presidents_club_stars, gaf_leads_enrolled, description,
    in_business_since, employees_range, raw, scraped_attributes, system_tags, segment, priority_score, tagged_at,
    assigned_rep_id, account_status, custom_fields, updated_in_last_poll, last_material_change_at, team_last_checked_at,
    team_last_serviced_at, content_hash, first_seen_at, last_seen_at, listing_updated_at)
  SELECT s.id, x.name, CASE WHEN r_misc < 0.08 THEN x.name || ' Exteriors' END, x.name || ' LLC', 'residential',
    x.street || ', ' || s.city || ', ' || s.state || ' ' || s.zip, x.street, s.city, s.state, s.zip, 'US',
    format('(%s) %s-%s', 201 + floor(pg_temp.r(n, 30) * 700)::int, 200 + floor(pg_temp.r(n, 31) * 799)::int,
           lpad(floor(pg_temp.r(n, 32) * 10000)::int::text, 4, '0')),
    CASE WHEN pg_temp.r(n, 33) < 0.6 THEN 'https://www.' || lower(regexp_replace(x.name, '[^A-Za-z]', '', 'g')) || '.com' END,
    CASE WHEN pg_temp.r(n, 33) < 0.6 THEN 'gaf' END,
    s.lat + (pg_temp.r(n, 34) - 0.5) * 0.03, s.lng + (pg_temp.r(n, 35) - 0.5) * 0.04, s.county_fips,
    CASE WHEN s.reviews > 0 THEN round((3.2 + pow(r_rating, 0.4) * 1.8)::numeric, 1)::float8 END, s.reviews,
    'https://www.gaf.com/en-us/roofing-contractors/residential/perf-' || n,
    CASE s.gaf_tier WHEN 'master_elite' THEN 'Master Elite' WHEN 'certified_plus' THEN 'Certified Plus' WHEN 'certified' THEN 'Certified' END,
    CASE s.gaf_tier WHEN 'master_elite' THEN 3 WHEN 'certified_plus' THEN 2 WHEN 'certified' THEN 1 ELSE 0 END,
    CASE WHEN s.gaf_tier IS NULL THEN '[]'::jsonb ELSE jsonb_build_array('GAF ' || initcap(replace(s.gaf_tier, '_', ' ')) || ' - Certification') END,
    CASE WHEN s.gaf_tier IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(upper(s.gaf_tier) || '^_^RESIDENTIAL^_^C') END,
    '[]', CASE WHEN s.gaf_tier = 'master_elite' AND r_misc < 0.15 THEN 1 + floor(r_misc * 20)::int ELSE 0 END,
    COALESCE(s.gaf_tier = 'master_elite' AND r_misc < 0.5, false),
    x.name || ' is a family-owned roofing contractor serving ' || s.city || ' and the surrounding area since ' || s.founded
      || '. We handle roof replacement, repair, gutters and storm damage for residential and light commercial properties.',
    CASE WHEN r_age < 0.7 THEN s.founded END,
    CASE s.size WHEN 'small' THEN '1-5' WHEN 'medium' THEN 'More than 5' ELSE 'More than 20' END,
    jsonb_build_object('perf_n', n, 'name', x.name, 'postalCode', s.zip, 'rating', s.reviews, 'source', 'synthetic'),
    CASE WHEN r_age >= 0.7 AND r_misc < 0.5 THEN jsonb_build_object('founded_year', s.founded::text) ELSE '{}' END,
    tags.t, sc.segment, sc.score, now() - interval '2 days',
    s.rep_id,
    CASE WHEN pg_temp.r(n, 36) < 0.9 THEN 'prospect' WHEN pg_temp.r(n, 36) < 0.96 THEN 'existing_customer'
         WHEN pg_temp.r(n, 36) < 0.99 THEN 'lapsed_customer' ELSE 'do_not_contact' END,
    CASE WHEN pg_temp.r(n, 37) < 0.15 THEN jsonb_build_object(
      'annual_volume_sq', 500 + floor(pg_temp.r(n, 38) * 20000)::int,
      'preferred_supplier', pg_temp.pick(ARRAY['ABC Supply','Beacon','SRS','Home Depot Pro','Local yard'], pg_temp.r(n, 39)),
      'next_followup', to_char(date '2026-10-01' + floor(pg_temp.r(n, 40) * 90)::int, 'YYYY-MM-DD'),
      'uses_metal', pg_temp.r(n, 41) < 0.3) ELSE '{}' END,
    pg_temp.r(n, 42) < 0.1, s.material_at,
    CASE WHEN s.rep_id IS NOT NULL AND r_state < 0.6 THEN s.material_at + (pg_temp.r(n, 43) - 0.35) * interval '30 days' END,
    CASE WHEN s.rep_id IS NOT NULL AND r_state < 0.25 THEN now() - pg_temp.r(n, 44) * interval '90 days' END,
    md5('c' || n), now() - interval '200 days' + pg_temp.r(n, 45) * interval '150 days', now() - interval '2 days',
    now() - interval '2 days'
  FROM stage s
  CROSS JOIN LATERAL (SELECT
    pg_temp.pick(ARRAY['Apex','Summit','Liberty','Empire','Hudson','Garden State','Patriot','Keystone','Atlantic','Precision',
      'Reliable','Pinnacle','Northeast','Ironclad','Eagle','Tri-State','Skyline','Heritage','Shoreline','Bridgeport',
      'Ridgeline','Evergreen','Crown','Statewide','Metro','Valley','Coastal','Brothers','Family','Elite'], pg_temp.r(n, 4))
    || ' ' || pg_temp.pick(ARRAY['Roofing','Roofing & Siding','Exteriors','Home Improvement','Roofing Co','Contracting',
      'Roof Pros','Construction','Roofing Services','Restoration'], pg_temp.r(n, 5))
    || CASE WHEN pg_temp.r(n, 6) < 0.5 THEN '' ELSE ' ' || n END AS name,
    (10 + floor(pg_temp.r(n, 7) * 3990)::int) || ' ' || pg_temp.pick(ARRAY['Main St','Broadway','Route 9','Park Ave',
      'Oak St','Maple Ave','Washington St','Central Ave','Church St','Mill Rd'], pg_temp.r(n, 8)) AS street) x
  CROSS JOIN LATERAL (SELECT
    least(100, round((CASE s.gaf_tier WHEN 'master_elite' THEN 30 WHEN 'certified_plus' THEN 20 WHEN 'certified' THEN 10 ELSE 0 END
      + least(25, ln(1 + s.reviews) * 5) + CASE s.size WHEN 'large' THEN 20 WHEN 'medium' THEN 12 ELSE 4 END
      + pg_temp.r(n, 50) * 25)::numeric, 1)) AS score) p
  CROSS JOIN LATERAL (SELECT p.score,
    CASE WHEN p.score >= 60 THEN 'strategic' WHEN p.score >= 42 THEN 'growth'
         WHEN s.founded >= 2018 THEN 'emerging' ELSE 'long_tail' END AS segment) sc
  CROSS JOIN LATERAL (SELECT
    jsonb_build_array(
      jsonb_build_object('key', 'gaf_tier', 'value', COALESCE(s.gaf_tier, 'none'), 'label', 'GAF ' || COALESCE(s.gaf_tier, 'none'),
        'category', 'certification', 'reason', 'GAF residential certification level', 'source', 'gaf'),
      jsonb_build_object('key', 'review_volume', 'value', CASE WHEN s.reviews = 0 THEN 'none' WHEN s.reviews < 10 THEN 'low'
          WHEN s.reviews < 50 THEN 'moderate' WHEN s.reviews < 200 THEN 'high' ELSE 'very_high' END,
        'label', s.reviews || ' reviews', 'category', 'size', 'reason', s.reviews || ' Google reviews on GAF profile', 'source', 'gaf'),
      jsonb_build_object('key', 'maturity', 'value', CASE WHEN s.founded >= 2021 THEN 'new' WHEN s.founded >= 2014 THEN 'young'
          WHEN s.founded >= 2001 THEN 'established' ELSE 'veteran' END,
        'label', (2026 - s.founded) || ' yrs in business', 'category', 'maturity',
        'reason', 'in business since ' || s.founded || ' (per website)', 'source', 'website'),
      jsonb_build_object('key', 'size', 'value', s.size, 'label', 'Size: ' || s.size, 'category', 'size',
        'reason', 'employees: ' || CASE s.size WHEN 'small' THEN '1-5' ELSE 'More than 5' END || '; ' || s.reviews || ' reviews', 'source', 'derived'),
      jsonb_build_object('key', 'state', 'value', s.state, 'label', s.state, 'category', 'geography', 'reason', 'GAF listing address', 'source', 'gaf'),
      jsonb_build_object('key', 'region', 'value', s.city, 'label', s.city, 'category', 'geography',
        'reason', s.city || ', ' || s.state || ' ' || s.zip, 'source', 'derived'),
      jsonb_build_object('key', 'distance_band', 'value', pg_temp.pick(ARRAY['0-5','5-10','10-25','25-50'], pg_temp.r(n, 51)),
        'label', 'Distance band', 'category', 'geography', 'reason', 'from search origin', 'source', 'derived'),
      jsonb_build_object('key', 'account_status', 'value', 'prospect', 'label', 'Net-new prospect', 'category', 'account',
        'reason', 'no matching account in the imported customer list', 'source', 'crm'),
      jsonb_build_object('key', 'data_completeness', 'value', 14 * (1 + floor(pg_temp.r(n, 52) * 7)::int), 'label', 'Profile completeness',
        'category', 'data_quality', 'reason', 'phone, website, contact, age, size, services, email', 'source', 'derived'),
      jsonb_build_object('key', 'decision_maker', 'value', pg_temp.pick(ARRAY['identified','identified','none','weak'], pg_temp.r(n, 53)),
        'label', 'Decision maker', 'category', 'contactability',
        'reason', 'size=' || s.size || ' -> purchasing/office/operations/PM, then owner; BBB principal listed as Owner', 'source', 'bbb'),
      jsonb_build_object('key', 'target_contact', 'value', CASE WHEN s.size = 'small' THEN 'owner' ELSE 'office_manager' END,
        'label', 'Ask for: the ' || CASE WHEN s.size = 'small' THEN 'Owner' ELSE 'Office Manager' END, 'category', 'contactability',
        'reason', 'size=' || s.size || ' -> owner for small shops, office/purchasing manager for larger ones', 'source', 'derived',
        'contact', jsonb_build_object('role', 'owner', 'name', NULL, 'phone_is_main_line', true, 'fallback', true)),
      jsonb_build_object('key', 'priority_drivers', 'value', jsonb_build_array('GAF tier', 'Review volume', 'Size'),
        'label', 'Why: GAF tier, Review volume, Size', 'category', 'priority', 'reason', 'GAF tier +10; Review volume +15; Size +12', 'source', 'derived'))
    || CASE WHEN s.reviews > 0 THEN jsonb_build_array(jsonb_build_object('key', 'reputation',
         'value', CASE WHEN r_rating > 0.4 THEN 'excellent' WHEN r_rating > 0.15 THEN 'good' ELSE 'mixed' END,
         'label', 'Reputation', 'category', 'reputation', 'reason', 'rating over ' || s.reviews || ' reviews', 'source', 'gaf')) ELSE '[]' END
    || CASE WHEN pg_temp.r(n, 54) < 0.56 THEN jsonb_build_array(jsonb_build_object('key', 'website', 'value', true, 'label', 'Has website',
         'category', 'digital', 'reason', 'website found on GAF profile', 'source', 'gaf')) ELSE '[]' END
    || CASE WHEN pg_temp.r(n, 55) < 0.34 THEN jsonb_build_array(jsonb_build_object('key', 'work_type:storm_emergency', 'value', true,
         'label', 'Storm / emergency repair', 'category', 'work_type',
         'reason', 'emergency_service, insurance_claims found; storm and emergency repair demand spikes during and after severe weather', 'source', 'website'),
         jsonb_build_object('key', 'storm_insurance', 'value', true, 'label', 'Storm / insurance work', 'category', 'services',
         'reason', 'storm-damage or insurance-claim services found', 'source', 'website')) ELSE '[]' END
    || CASE WHEN pg_temp.r(n, 56) < 0.24 THEN jsonb_build_array(jsonb_build_object('key', 'nyc_hic_license', 'value', true,
         'label', 'NYC HIC license', 'category', 'compliance', 'reason', 'NYC DCWP home improvement contractor license active', 'source', 'nyc_dca')) ELSE '[]' END
    || CASE WHEN pg_temp.r(n, 57) < 0.2 THEN jsonb_build_array(jsonb_build_object('key', 'gaf_recommended', 'value', true,
         'label', 'GAF recommended', 'category', 'certification', 'reason', 'listed in GAF recommended results', 'source', 'gaf')) ELSE '[]' END
    || (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', 'service:' || sv.key, 'value', true, 'label', sv.label, 'category', 'services',
          'reason', 'website: "...we specialise in ' || lower(sv.label) || ' for homes and businesses across ' || s.city
            || '. Call today for a free estimate..." (https://www.example-roofer-' || n || '.com/)', 'source', 'website') ORDER BY sv.ord), '[]')
        FROM services sv WHERE pg_temp.r(n, 100 + sv.ord) < sv.p) AS t) tags`);

await step('company_source_ids', `
  INSERT INTO company_source_ids (source, external_id, company_id)
  SELECT 'gaf', 'perf-' || n, id FROM stage
  UNION ALL SELECT 'ny_dos', 'dos-' || n, id FROM stage WHERE state = 'NY' AND pg_temp.r(n, 60) < 0.4
  UNION ALL SELECT 'fmcsa', 'usdot-' || n, id FROM stage WHERE pg_temp.r(n, 61) < 0.15`);

await step('contacts', `
  INSERT INTO contacts (company_id, source_key, name, title, email, phone, source, source_url, confidence)
  SELECT s.id, md5('k' || s.n || '-' || k),
    pg_temp.pick(ARRAY['Michael','Joseph','Maria','John','Anthony','Lisa','Robert','Daniel','Karen','Luis'], pg_temp.r(s.n, 70 + k))
      || ' ' || pg_temp.pick(ARRAY['Esposito','Garcia','Smith','Romano','Brennan','Lopez','Schmidt','Ali','Goldberg','Santos'], pg_temp.r(s.n, 80 + k)),
    pg_temp.pick(ARRAY['Owner','President','Office Manager','Purchasing Manager','Project Manager','Estimator'], pg_temp.r(s.n, 90 + k)),
    CASE WHEN pg_temp.r(s.n, 95 + k) < 0.5 THEN 'contact' || k || '@perf-' || s.n || '.example' END,
    CASE WHEN pg_temp.r(s.n, 96 + k) < 0.4 THEN '(555) 01' || k || '-' || lpad((s.n % 10000)::text, 4, '0') END,
    pg_temp.pick(ARRAY['bbb','website','ny_dos','fmcsa'], pg_temp.r(s.n, 97 + k)), 'https://example.org/perf/' || s.n,
    round((0.3 + pg_temp.r(s.n, 98 + k) * 0.7)::numeric, 2)
  FROM stage s CROSS JOIN LATERAL generate_series(1, 1 + floor(pg_temp.r(s.n, 99) * 2.6)::int) k`);

await step('lead_allocations', `
  INSERT INTO lead_allocations (company_id, rep_id, allocated_by, allocated_at, ended_at, ended_by)
  SELECT id, rep_id, pg_temp.uid('u' || (1 + floor(pg_temp.r(n, 62) * $1::int)::int)), now() - interval '60 days' + pg_temp.r(n, 63) * interval '50 days',
         NULL, NULL
  FROM stage WHERE rep_id IS NOT NULL
  UNION ALL
  SELECT id, pg_temp.uid('u' || ($1::int + 1 + floor(pg_temp.r(n, 64) * $2::int)::int)), pg_temp.uid('u' || (1 + floor(pg_temp.r(n, 62) * $1::int)::int)),
         now() - interval '200 days', now() - interval '61 days', pg_temp.uid('u' || (1 + floor(pg_temp.r(n, 62) * $1::int)::int))
  FROM stage WHERE rep_id IS NOT NULL AND pg_temp.r(n, 65) < 0.12`, [MANAGERS, REPS]);

await step('lead_rep_state', `
  INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at, updated_at)
  SELECT c.id, c.assigned_rep_id, c.team_last_checked_at, c.team_last_serviced_at, now()
  FROM companies c WHERE c.assigned_rep_id IS NOT NULL AND (c.team_last_checked_at IS NOT NULL OR c.team_last_serviced_at IS NOT NULL)
  UNION ALL
  SELECT la.company_id, la.rep_id, la.ended_at - interval '20 days', NULL, la.ended_at FROM lead_allocations la WHERE la.ended_at IS NOT NULL
  ON CONFLICT DO NOTHING`);

await step('activity_logs', `
  INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, outcome, note_text, field_diff, created_at)
  SELECT s.id,
    CASE WHEN kind = 'scraped_change' THEN 'pipeline' ELSE 'user' END,
    CASE WHEN kind = 'scraped_change' THEN NULL ELSE COALESCE(s.rep_id, pg_temp.uid('u' || (1 + floor(pg_temp.r(s.n, 66) * $1::int)::int))) END,
    kind,
    CASE WHEN kind IN ('call', 'email', 'visit') THEN pg_temp.pick(ARRAY['no_answer','left_voicemail','spoke','meeting_set','not_interested'], pg_temp.r(s.n, 200 + a)) END,
    CASE WHEN kind = 'note' THEN 'Spoke with the office about their ' || pg_temp.pick(ARRAY['shingle','metal','flat roof','gutter'], pg_temp.r(s.n, 300 + a))
      || ' volume; they buy from ' || pg_temp.pick(ARRAY['ABC','Beacon','SRS','a local yard'], pg_temp.r(s.n, 400 + a)) || '. Follow up next month.' END,
    CASE WHEN kind = 'scraped_change' THEN jsonb_build_object('rating', jsonb_build_array(4.5, 4.6)) END,
    now() - pg_temp.r(s.n, 500 + a) * interval '180 days'
  FROM stage s
  CROSS JOIN LATERAL generate_series(1, CASE WHEN s.rep_id IS NOT NULL THEN floor(pg_temp.r(s.n, 67) * 6.0)::int ELSE floor(pg_temp.r(s.n, 67) * 2.4)::int END) a
  CROSS JOIN LATERAL (SELECT CASE WHEN s.rep_id IS NULL THEN 'scraped_change'
    ELSE pg_temp.pick(ARRAY['note','call','call','email','visit','checked','scraped_change'], pg_temp.r(s.n, 600 + a)) END AS kind) k`, [MANAGERS + REPS]);

await step('custom_tags', `
  INSERT INTO custom_tags (id, name, created_by)
  SELECT pg_temp.uid('t' || i), pg_temp.pick(ARRAY['hot','follow-up','metal-buyer','storm-zone','price-sensitive','big-account',
    'needs-samples','trade-show','referral','competitor-loyal'], pg_temp.r(i, 1)) || '-' || i, pg_temp.uid('u' || (1 + floor(pg_temp.r(i, 2) * $1::int)::int))
  FROM generate_series(1, 300) i`, [MANAGERS + REPS]);
await step('company_custom_tags', `
  INSERT INTO company_custom_tags (company_id, tag_id, added_by)
  SELECT DISTINCT ON (s.id, t) s.id, pg_temp.uid('t' || t), COALESCE(s.rep_id, pg_temp.uid('u1'))
  FROM stage s CROSS JOIN LATERAL generate_series(1, 1 + floor(pg_temp.r(s.n, 68) * 2.5)::int) k
  CROSS JOIN LATERAL (SELECT 1 + floor(pg_temp.r(s.n, 700 + k) * 300)::int AS t) x
  WHERE pg_temp.r(s.n, 69) < 0.1`);

await step('field_overrides', `
  INSERT INTO field_overrides (company_id, field, value, scraped_value_at_edit, user_id)
  SELECT c.id, 'phone', to_jsonb('(555) 777-' || lpad((s.n % 10000)::text, 4, '0')), to_jsonb(c.phone), COALESCE(c.assigned_rep_id, pg_temp.uid('u1'))
  FROM stage s JOIN companies c ON c.id = s.id WHERE pg_temp.r(s.n, 71) < 0.03`);

await step('company_insights', `
  INSERT INTO company_insights (company_id, business_summary, sales_recommendation, model, prompt_version, input_hash)
  SELECT id, 'Mid-size residential roofer focused on replacements and storm work.', 'Lead with metal and synthetic underlayment bundles.',
    'claude-haiku', 'v1', md5('i' || n)
  FROM stage WHERE pg_temp.r(n, 72) < 0.1`);

await step('enrichments', `
  INSERT INTO enrichments (company_id, source, status, match_confidence, data, website)
  SELECT id, 'website_crawl', 'ok', 0.9, jsonb_build_object('services', jsonb_build_array('roof_replacement', 'gutters')),
    'https://example-roofer-' || n || '.com'
  FROM stage WHERE pg_temp.r(n, 73) < 0.5`);

await step('regional_signals', `
  INSERT INTO regional_signals (county_fips, kind, source, external_id, payload, valid_from, valid_to)
  SELECT f.county_fips, 'storm_history', 'noaa_storm_events', 'perf-storm-' || f.county_fips || '-' || k,
    jsonb_build_object('event_type', pg_temp.pick(ARRAY['Hail','Thunderstorm Wind','High Wind','Winter Storm'], pg_temp.r(k, ascii(f.county_fips))),
                       'magnitude', 1.0 + k % 3, 'damage_property', 10000 * k),
    now() - (k * interval '25 days'), now() - (k * interval '25 days') + interval '1 day'
  FROM (SELECT DISTINCT county_fips FROM zips) f CROSS JOIN generate_series(1, 8) k
  UNION ALL
  SELECT f.county_fips, 'active_alert', 'nws', 'perf-alert-' || f.county_fips,
    jsonb_build_object('event', 'Wind Advisory', 'severity', 'Moderate', 'headline', 'Wind Advisory until 6 PM'),
    now() - interval '2 hours', now() + interval '10 hours'
  FROM (SELECT DISTINCT county_fips FROM zips) f WHERE pg_temp.r(ascii(substr(f.county_fips, 5)), 1) < 0.3`);

await step('refresh team_dashboard_kpis', 'REFRESH MATERIALIZED VIEW team_dashboard_kpis');
await step('vacuum analyze', 'VACUUM (ANALYZE)');
const { rows } = await client.query(`SELECT
  (SELECT count(*) FROM companies) companies, (SELECT count(*) FROM companies WHERE assigned_rep_id IS NOT NULL) allocated,
  (SELECT count(*) FROM contacts) contacts, (SELECT count(*) FROM activity_logs) activity_logs,
  (SELECT count(*) FROM lead_rep_state) lead_rep_state, (SELECT count(*) FROM users) users,
  (SELECT round(avg(jsonb_array_length(system_tags)), 1) FROM companies) avg_tags,
  (SELECT round(avg(pg_column_size(system_tags))) FROM companies) avg_tags_bytes,
  pg_size_pretty(pg_database_size(current_database())) db_size`);
console.log(rows[0]);
console.log(`done in ${((Date.now() - T0) / 1000).toFixed(1)} s`);
await client.end();
