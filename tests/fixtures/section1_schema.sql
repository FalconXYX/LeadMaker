-- Section 1 SQLite schema (sqlite3 data/leadmaker.db .schema, 2026-10-18): the input of leadmaker import-sqlite.
CREATE TABLE scrape_runs (
	id INTEGER NOT NULL, 
	kind VARCHAR(32) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	params JSON NOT NULL, 
	stats JSON NOT NULL, 
	error TEXT, 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE TABLE contractors (
	gaf_id VARCHAR(32) NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	dba VARCHAR(255), 
	legal_name VARCHAR(255), 
	contractor_type VARCHAR(32), 
	address VARCHAR(512), 
	street VARCHAR(255), 
	city VARCHAR(128), 
	state VARCHAR(8), 
	postal_code VARCHAR(16), 
	country VARCHAR(8), 
	phone VARCHAR(32), 
	latitude FLOAT, 
	longitude FLOAT, 
	rating FLOAT, 
	review_count INTEGER NOT NULL, 
	profile_url VARCHAR(512) NOT NULL, 
	image_url VARCHAR(512), 
	tier VARCHAR(32) NOT NULL, 
	tier_rank INTEGER NOT NULL, 
	certifications JSON NOT NULL, 
	designation_codes JSON NOT NULL, 
	specialties JSON NOT NULL, 
	presidents_club_stars INTEGER NOT NULL, 
	gaf_leads_enrolled BOOLEAN NOT NULL, 
	google_place_id VARCHAR(128), 
	description TEXT, 
	in_business_since INTEGER, 
	employees_range VARCHAR(64), 
	distinctions JSON NOT NULL, 
	profile_details JSON NOT NULL, 
	profile_scraped_at DATETIME, 
	profile_error TEXT, 
	website VARCHAR(512), 
	website_source VARCHAR(32), 
	tags JSON NOT NULL, 
	segment VARCHAR(64), 
	priority_score FLOAT, 
	tagged_at DATETIME, 
	raw JSON NOT NULL, 
	content_hash VARCHAR(64) NOT NULL, 
	first_seen_at DATETIME NOT NULL, 
	last_seen_at DATETIME NOT NULL, 
	listing_updated_at DATETIME NOT NULL, "county_fips" VARCHAR(5), 
	PRIMARY KEY (gaf_id)
);
CREATE INDEX ix_contractors_tier_rank ON contractors (tier_rank);
CREATE INDEX ix_contractors_state_city ON contractors (state, city);
CREATE INDEX ix_contractors_postal_code ON contractors (postal_code);
CREATE TABLE search_hits (
	id INTEGER NOT NULL, 
	run_id INTEGER NOT NULL, 
	gaf_id VARCHAR(32) NOT NULL, 
	postal_code VARCHAR(16) NOT NULL, 
	radius_miles FLOAT NOT NULL, 
	distance_miles FLOAT, 
	rank INTEGER NOT NULL, 
	gaf_recommended BOOLEAN NOT NULL, 
	gaf_recommended_rank INTEGER, 
	seen_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_search_hits_run_gaf UNIQUE (run_id, gaf_id), 
	FOREIGN KEY(run_id) REFERENCES scrape_runs (id) ON DELETE CASCADE, 
	FOREIGN KEY(gaf_id) REFERENCES contractors (gaf_id) ON DELETE CASCADE
);
CREATE INDEX ix_search_hits_area ON search_hits (postal_code, radius_miles, run_id);
CREATE INDEX ix_search_hits_gaf_id ON search_hits (gaf_id);
CREATE TABLE reviews (
	id VARCHAR(64) NOT NULL, 
	gaf_id VARCHAR(32) NOT NULL, 
	author VARCHAR(255), 
	rating FLOAT, 
	text TEXT, 
	published_at DATETIME, 
	source VARCHAR(64), 
	first_seen_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(gaf_id) REFERENCES contractors (gaf_id) ON DELETE CASCADE
);
CREATE INDEX ix_reviews_gaf_id ON reviews (gaf_id);
CREATE TABLE enrichments (
	gaf_id VARCHAR(32) NOT NULL, 
	source VARCHAR(32) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	confidence FLOAT NOT NULL, 
	data JSON NOT NULL, 
	website VARCHAR(512), 
	source_urls JSON NOT NULL, 
	error TEXT, 
	run_id INTEGER, 
	fetched_at DATETIME NOT NULL, "input_hash" VARCHAR(64), 
	PRIMARY KEY (gaf_id, source), 
	FOREIGN KEY(gaf_id) REFERENCES contractors (gaf_id) ON DELETE CASCADE, 
	FOREIGN KEY(run_id) REFERENCES scrape_runs (id) ON DELETE SET NULL
);
CREATE INDEX ix_enrichments_source_status ON enrichments (source, status);
CREATE TABLE contacts (
	id VARCHAR(64) NOT NULL, 
	gaf_id VARCHAR(32) NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	title VARCHAR(255), 
	email VARCHAR(255), 
	phone VARCHAR(64), 
	source VARCHAR(32) NOT NULL, 
	source_url VARCHAR(512), 
	confidence FLOAT NOT NULL, 
	first_seen_at DATETIME NOT NULL, 
	last_seen_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(gaf_id) REFERENCES contractors (gaf_id) ON DELETE CASCADE
);
CREATE INDEX ix_contacts_gaf_id ON contacts (gaf_id);
CREATE TABLE audit_events (
	id INTEGER NOT NULL, 
	run_id INTEGER, 
	entity_type VARCHAR(32) NOT NULL, 
	entity_id VARCHAR(160) NOT NULL, 
	gaf_id VARCHAR(32), 
	action VARCHAR(16) NOT NULL, 
	changes JSON NOT NULL, 
	at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_gaf_id_at ON audit_events (gaf_id, at);
CREATE INDEX ix_audit_run_id ON audit_events (run_id);
CREATE INDEX ix_audit_at ON audit_events (at);
CREATE TABLE jobs (
	id INTEGER NOT NULL, 
	kind VARCHAR(32) NOT NULL, 
	params JSON NOT NULL, 
	dedupe_key VARCHAR(200), 
	status VARCHAR(16) NOT NULL, 
	priority INTEGER NOT NULL, 
	attempts INTEGER NOT NULL, 
	max_attempts INTEGER NOT NULL, 
	run_after DATETIME NOT NULL, 
	locked_by VARCHAR(64), 
	locked_at DATETIME, 
	result JSON, 
	error TEXT, 
	schedule_id INTEGER, 
	created_at DATETIME NOT NULL, 
	finished_at DATETIME, "requested_by" VARCHAR(128), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_jobs_dedupe ON jobs (dedupe_key, status);
CREATE INDEX ix_jobs_claim ON jobs (status, run_after, priority);
CREATE TABLE schedules (
	id INTEGER NOT NULL, 
	name VARCHAR(128) NOT NULL, 
	kind VARCHAR(32) NOT NULL, 
	params JSON NOT NULL, 
	every_hours FLOAT NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	next_run_at DATETIME NOT NULL, 
	last_enqueued_at DATETIME, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE TABLE accounts (
	account_id VARCHAR(64) NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	phone VARCHAR(64), 
	postal_code VARCHAR(16), 
	city VARCHAR(128), 
	state VARCHAR(8), 
	status VARCHAR(32), 
	owner_rep VARCHAR(128), 
	annual_spend FLOAT, 
	last_order_at DATETIME, 
	extra JSON NOT NULL, 
	gaf_id VARCHAR(32), 
	match_confidence FLOAT, 
	match_method VARCHAR(32), 
	imported_at DATETIME NOT NULL, 
	PRIMARY KEY (account_id), 
	FOREIGN KEY(gaf_id) REFERENCES contractors (gaf_id) ON DELETE SET NULL
);
CREATE INDEX ix_accounts_gaf_id ON accounts (gaf_id);
CREATE TABLE regional_signals (
	id INTEGER NOT NULL, 
	county_fips VARCHAR(5) NOT NULL, 
	kind VARCHAR(32) NOT NULL, 
	source VARCHAR(64) NOT NULL, 
	external_id VARCHAR(512) NOT NULL, 
	payload JSON NOT NULL, 
	valid_from DATETIME, 
	valid_to DATETIME, 
	fetched_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_regional_signals_source_ext UNIQUE (source, external_id, county_fips)
);
CREATE INDEX ix_regional_signals_county_kind ON regional_signals (county_fips, kind, valid_to);
CREATE UNIQUE INDEX uq_jobs_open_dedupe ON jobs (dedupe_key) WHERE status IN ('queued', 'running');
