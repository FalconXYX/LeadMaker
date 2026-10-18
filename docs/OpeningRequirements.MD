# B2B Sales Intelligence Platform: System Design & Requirements

## 0. General Requirements & Assumptions

### Functional Requirements

- **Role-Based Access & Lead Allocation:** Sales reps view only the leads allocated to them plus the pool of unallocated leads (view-only), while managers have oversight across all reps and leads and are the only role that can allocate leads. A rep's territory is the set of leads allocated to them.
- **Location Search & Territory Dashboard:** Users can view an overview of their territory (KPIs, map, weather/news) or search by ZIP code and radius.
- **Filtering, Sorting & Custom Tags:** Users can filter and sort leads by system tags (size, age, GAF certifications, roof materials) or create their own custom tags and data slots.
- **Lead Profiles:** Users can click a lead to view business details, size-appropriate target contacts, rep notes, weather context, and AI insights.
- **AI Summary & Recommendations:** Profiles display pre-generated business summaries and actionable sales recommendations tied to real-world signals.
- **Action-Enabled AI Assistant:** Users can ask a chatbot questions about a specific lead or use natural language to automatically filter and sort lead lists.

### Non-Functional Requirements (Scale, Reliability, etc.)

- **High Scalability:** The platform and pipeline must reliably support hundreds to thousands of concurrent sales reps, and data volumes well beyond the initial GAF roofing list as new industries and sources are added.
- **Fast Retrieval:** Lead data and base AI insights are pre-generated and stored so searching, sorting, and dashboard loading feel instant.
- **Data Consistency & Concurrency:** Overlapping location searches return deduplicated contractor records, and concurrent edits by multiple users (the allocated rep and managers) are tracked safely without overwriting each other.

### Business & Persona Assumptions

- **Target User:** An enterprise-scale roofing distributor supplying materials to roofing contractors.
- **Sales Workflow:** Supports account planning for both net-new prospecting and existing account management.
- **Initial Scope:** Scoped to a 25-mile radius around ZIP code 10013 using GAF contractor data as the primary seed source.
- **Single Distributor:** One distributor uses the platform (single tenant), so access control is role-based within that one organization.
- **Industry-Agnostic Design:** Roofing, with GAF as the seed source, is the first industry. Data sources and tag taxonomies are pluggable so the platform can extend to other industries and lead sources.
- **Production Design, Free-Tier Prototype:** Everything is designed as a production system. For the prototype, paid services may be swapped for free tiers or free alternatives (with approval), and each swap notes what production would use instead.

---

## 1. Data Acquisition & Tagging

### Requirements & Goals

- **Scheduled & On-Demand Runs:** The pipeline runs primarily on a recurring schedule, with support for on-demand triggers by reps or managers (e.g., refreshing a territory or searching a new area). Duplicate requests for the same area are merged, and requests are rate-limited per user.
- **Location-Based Extraction:** Given a location and radius, the system collects all roofing contractors, extracts their details, generates tags and notes, and triggers AI summaries.
- **User-Guided Customization:** Reps can create custom tags and information slots. Slots are also passed into the pipeline to guide LLM extraction and insight generation; this is experimental and will be dropped if it doesn't work well.

### Sources & Raw Data Scope

- **Primary Source:** GAF residential contractor directory (ratings, certifications, years in business, location, contact info, roof types).
- **Secondary Business Sources:** Contractor websites and public business listings to extract missing context and size-appropriate decision-makers (e.g., Owner/Boss for smaller shops vs. Office/Purchasing Manager for larger companies), defaulting to the owner when no other decision-maker can be found.
- **Contact Discovery:** Better Business Bureau profiles supply owner and manager names and titles (personal-use profile scraping for the prototype; the paid BBB API in production). Hunter.io email discovery (domain search, email-pattern inference and verification) is planned for later.
- **Contextual Signal Sources:** Weather/Storm APIs and local news feeds to track regional roofing demand drivers.

### Tagging & Categorization Logic

- **Structured Tagging:** Maps raw fields into filterable tags (GAF Master Elite status, rating tiers, years in business).
- **Service & Material Tagging:** Extracts roof material specialties (metal, asphalt shingles, flat/TPO) and work types (new construction vs. storm/emergency repair).
- **Custom User Tagging:** Supports rep-created tags and custom key-value data slots so the team can adapt categorization as business needs evolve.

### Pipeline & Scaling Considerations

- **Incremental Updates:** Avoids re-scraping or re-computing from scratch; only new or changed records, records past their source's refresh window, and records affected by newly added parameters are processed to save compute.
- **Audit Logging:** All data additions, updates, and generated tags are stored with timestamped logs.
- **Rate Limiting & Queuing:** Uses job queues to manage scraping and LLM rate limits safely when scaling across large territories.

---

## 2. Backend Storage & Retrieval

### Requirements & Goals

- **Fast Storage & Retrieval:** Store and retrieve contractor profiles, system/custom tags, and AI insights with structures optimized for fast multi-criteria filtering.
- **Rep Edits & Override Protection:** Allow reps to add notes, create custom fields, and manually edit contact info, differentiating human edits from scraped data so future pipeline runs never overwrite rep changes.
- **Multi-User Collaboration & Attribution:** The allocated rep and managers can work on the same lead at the same time, with clear attribution (user ID and timestamp) for every note, status change, and field edit. Notes are visible to anyone who can view the lead, and notes, edits and history stay with the lead when it is reassigned.
- **Role-Based Access Control (RBAC):** Built-in auth to enforce manager vs. rep permissions and lead allocations: reps can act only on the leads allocated to them and can view (but not act on) unallocated leads, and only managers can allocate or reassign leads.

### Data Schema / Entities

- **Companies (Core Entity):** Stores an internal ID (source IDs such as GAF's live in a separate mapping), canonical business info, location coordinates, assigned rep, `updated_in_last_poll`, team-level last-checked/last-serviced timestamps, and scraped attributes. Per-rep checked/serviced state lives in a separate Lead Rep State table, and `unchecked`/`unserviced` are derived per rep and at the team level from these.
- **Manual Overrides:** Rep edits to company fields and contacts live in a separate table that the pipeline never writes, so re-scrapes can't overwrite them.
- **Contacts:** Stores multiple people per company, each with name, title, email, phone, source, confidence, email-verification status, and a do-not-contact flag.
- **Lead Allocations:** Records which rep each lead is allocated to, which manager allocated it and when, with full history. Leads with no allocation form the shared unallocated pool.
- **Insights, Tags & Custom Fields:** Stores pre-generated AI summaries, sales recommendations, system tags, and user-defined custom fields/tags linked to each contractor.
- **Users, Rep Notes & Audit Trail:** Stores user roles (`rep`, `manager`) and links every note, checked/serviced action, and manual override to a `user_id` and timestamp. Account status (`prospect`, `existing_customer`, `lapsed_customer`, `do_not_contact`) comes from the distributor's CRM import, and each import is logged. Notes are append-only, and edits to shared fields use optimistic locking to prevent concurrent edit conflicts.
- **Ingestion Jobs / Logs:** Tracks scrape timestamps, parameter versions, and pipeline run history.

### Storage & Database Choices

- **PostgreSQL + JSONB:** Use Postgres for relational integrity while leveraging `JSONB` columns for flexible, document-style data (allowing reps to add custom information slots dynamically without schema migrations; rep-created custom tags live in their own relational tables).
- **Microservices:** Expose data and business logic through decoupled services, each owning one area:
  - **API Gateway & Auth:** authentication, rep vs. manager roles, and per-user rate limits.
  - **Core CRM Write Service:** rep notes, checked/serviced status, manual overrides, custom tags, and lead allocations.
  - **Query & Filter Service:** lead lists, filters, and profiles through the cache and read replicas, applying the visibility rule.
  - **On-Demand AI Service:** lead Q&A and natural-language filtering.
  - **Ingestion & AI Pipeline:** the Python workers for scraping, enrichment, tagging, and batch AI insights.
- **Event Bus:** Services communicate through events (e.g., "pipeline updated lead", "rep edited field"), which also drive cache invalidation and dashboard updates.
- **Languages:** User-facing services are written in TypeScript; the ingestion pipeline is written in Python.

### Retrieval, Querying & Caching Strategy

- **SQL Indexing & Materialized Views:** Use Postgres indexes (including GIN indexes for `JSONB` system tags and custom data slots) and materialized views to pre-compute team and manager dashboard KPI roll-ups.
- **Hot-Data Caching:** Cache frequently accessed contractor profiles, popular territory queries, and dashboard KPI counters in an in-memory layer (e.g., Redis) to minimize database hits. Cached entries are invalidated through the event bus whenever the pipeline updates a lead or a rep edits one.
- **Read Replicas & Connection Pooling:** Serve read-heavy traffic from Postgres read replicas behind a connection pooler (e.g., PgBouncer), with per-user rate limits at the API, so peak usage never overloads the primary database.

### Future Scaling (Later)

- **Geographic Partitioning:** Partition database tables by location/region while maintaining a single canonical source of truth so overlapping radius searches do not cause data desync. Deferred until data volumes require it.

---

## 3. Frontend User Interface

### Requirements & Goals

- **Familiar CRM Paradigm:** Designed around a standard CRM layout and workflow so sales reps can adopt it immediately.
- **Role-Based Views:** Sales reps see their allocated leads, the unallocated pool, and their territory metrics, while managers can view and allocate leads across the entire team.
- **Customizable & Uncluttered:** Reps can create custom tags and information slots while toggling which tags are displayed so the UI never becomes overwhelming.

### Core Views & Rep Workflow

- **Territory Dashboard:** Displays KPI counters (unserviced leads, unchecked leads, net-new updates from the latest poll), an interactive lead map, local weather/news summaries, and a territory-level AI briefing.
- **Multi-View Lead Lists:** Filterable and sortable CRM list views where reps can slice leads by system tags, custom tags, certifications, and roof types.
- **Lead Detail View:** Full contractor profile showing scraped company info, size-adjusted target contact (Owner vs. Office/Purchasing Manager), AI insights, rep notes, custom fields, and local weather impact.
- **Lead Allocation View (Managers):** An unallocated queue where new leads from each pipeline run land, bulk assignment of a filtered list to a rep, and allocation suggestions (e.g., by ZIP code) that the manager reviews and approves.
- **Persistent AI Assistant:** A floating chat widget in the bottom-right corner accessible across both the dashboard and individual lead profiles.

### Key Features & Polish

- **Weather & Seasonality Demand Signals:** Pairs local weather forecasts and storm alerts with contractor specialties (e.g., flagging repair/emergency roofers as high priority for supply orders before/after severe storms, while noting weather lulls for new-build contractors).
- **Natural Language UI Control:** Reps can tell the chatbot what kind of companies they are looking for, and the assistant automatically applies the matching filters and sorts to the list view.
- **Update & Activity Highlights:** Visual badges showing what data changed in the most recent pipeline poll and quick toggles to mark leads as checked/serviced.

---

## 4. AI Tools & Insights

### Requirements & Goals

- **Hybrid Execution Model:** Split AI workloads between pre-generated batch insights (computed during data ingestion) and on-demand interactive assistance (triggered by the user in the UI).
- **Actionable Sales Focus:** Move beyond generic company descriptions to provide timing-aware sales recommendations and direct UI control.

### Inputs & Context

- **Contractor Context:** GAF profile attributes, scraped website content, company size, service/material tags, and rep-authored notes/custom fields.
- **Environmental Context:** Local weather forecasts, severe storm alerts, seasonality, and regional roofing news.

### Generated Outputs (Insights, Scoring, Recommendations)

- **Pre-Generated (Pipeline Phase):**
  - **Structured Extraction & Tagging:** Parses unstructured website text to identify target decision-makers, roof material specialties, and custom user-requested fields.
  - **Lead Summaries & Pitch Recommendations:** Generates a concise business overview and a recommended sales angle (e.g., pitching bulk shingles to a high-volume GAF Master Elite roofer, or emergency tarps/repair stock to a storm-restoration contractor); weather timing comes from the separate weather timing layer.
  - **Territory Briefing:** Summarizes major changes from the latest data poll and weather-driven opportunities for the rep's dashboard.
- **On-Demand (Interactive Chatbot Phase):**
  - **Lead Q&A:** Answers specific rep questions about an individual contractor using their stored profile, scraped text, and team notes as context.
  - **Natural Language Filtering (Tool Calling):** Translates conversational requests (e.g., _"Show me Master Elite contractors doing metal roofs near 10013 that I haven't checked yet"_) into structured filter state updates that directly control the UI list view.

### Execution & Cost/Scale Strategy

- **Batch Pre-Computation & Delta Processing:** Run summary and extraction prompts asynchronously during pipeline jobs, and only re-run LLM calls when underlying contractor data, rep notes/custom fields, user-defined parameters, or the prompt/model version actually change.
- **Separate Weather Timing Layer:** Weather and storm context is handled by a cheaper, rules-based timing layer per county that is joined at read time, so weather changes never re-run per-lead LLM calls.
- **Scoped Context & Function Calling:** Keep on-demand chatbot latency and token costs low by scoping lead Q&A strictly to the active contractor's record, and using lightweight LLM tool/function calling to translate natural language search queries into the shared lead filter parameters. The assistant runs with the requesting user's permissions, so it can only see and filter leads that user can view.
- **Provider-Agnostic Models:** One model interface supports multiple LLM providers (e.g., Anthropic Claude, Google Gemini), selected by configuration and API key.
