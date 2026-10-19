# DESIGN.md

## 1. Overview & Initial Approach

When I saw the challenge, I understood it as a customer relationship management (CRM) tool for generating leads for a roofing supply distribution business, which meant there would be four sections involved: the data scraping and collection, the storing, processing, and retrieval of the data, the front-end user layer, and then the AI layer.

I started by creating the initial requirements in `docs/OpeningRequirements.MD`, and as I started asking questions and doing some research, I refined that into `docs/SystemDesign.md`.

## 2. Options Considered, What I Chose, and Why

### Data Scraping & Collection

My opening requirements led me to a system that scrapes data off of GAF and combines it with other sources.I chose to make it run primarily on a schedule (with an option for on-demand runs) and only update what has changed rather than redoing everything from scratch. If new parameters are added, only the things that rely on those parameters get updated, which saves a lot of compute and avoids rate limits.

Because GAF only gives basic info like certifications and ratings, I also chose to pull from contractor websites, Google Maps, the Better Business Bureau, and weather data sources. Depending on how big a company is, we want different contacts: for a smaller shop we just want the boss or owner, while for a bigger company we want an office or purchasing manager. Adding weather data also accounts for demand fluctuations. If there is a big storm, new-build roofing companies might be in a lull, whereas emergency and repair roofing companies will be booming and needing to order supplies beforehand.

### Data Storage, Processing & Retrieval

From there, that data needed to be stored in a database. I considered NoSQL, but most of this data is very relational, and having a single source of ground truth that could be used relationally while inserting some `JSONB` columns for the non-SQL functionality I wanted was why I chose PostgreSQL. I also considered putting a dedicated search engine like Elasticsearch next to it, but Postgres indexes on the `JSONB` and tag columns (plus PostGIS for distance searches) kept filtering fast enough without running and syncing a second data store. Using `JSONB` also lets sales reps add their own custom fields (information slots) without needing to change the database schema, while custom tags live in their own small tables so the whole team can share them and filter by them.

I also had to make sure that when data is re-scraped, it doesn't overwrite changes or notes that the sales team manually made, and that multiple reps can edit or leave notes on the same lead with clear tracking of who did what. To handle that, I separated the scraped data from the manual user edits in the database.

I then created a series of TypeScript services to read, write, and filter the data. I considered keeping everything in one backend server, but splitting reads from writes means the heavy scraping and AI writes never slow down the reps' searches, and each side can scale on its own. Heavy searches also go through a queue that only lets a few run at once, so at peak load a rep might wait up to a second rather than the database getting overwhelmed. Because the system needs to scale to hundreds or thousands of reps, I added a read-only copy of the database alongside caching. At moments like 9:00 a.m. on a weekday, lots of sales reps will be hitting the database all at once trying to read their data, so routing reads to a read-only copy and cache takes that stress off the main database.

### Front-End User Layer

I built a React frontend for the user to interface with the platform. I have previously worked with CRMs peripherally, so I knew generally how they worked. After doing a bit of research, I chose to emulate the layout and workflow of existing CRMs because that is what sales reps are already used to, so it integrates into their workflow more cleanly.

It includes role-based views where a manager can see every lead and the whole team's activity, while an individual rep sees the leads allocated to them plus the unallocated pool, and can only edit their own. Reps start on a dashboard with an AI briefing of their territory, today's calls with a suggested pitch for each, their follow-ups (as a list or a calendar), new leads worth a call, and where their pipeline stands, with the lead map and local weather further down. In the list and profile views, I also made sure reps can create and toggle their own custom tags because they will eventually understand their business needs better than any developer, and I didn't want to overwhelm them with a million default tags.

### AI Layer

For the AI layer, I split the work between pre-generated insights and on-demand chat so we aren't running heavy AI calls every time a page loads. After all of the data is scraped and organized, Gemini goes through it and pre-generates a summary, a recommended pitch, and talking points for each business based on its scraped data, website text, tags, and the reps' notes. I kept weather out of these per-lead calls on purpose: a cheaper rules-based layer turns weather alerts and storm reports into timing badges per county, so a storm never triggers hundreds of new AI calls. Weather does feed into the short AI briefing on each rep's dashboard. To keep the AI from making things up, every insight is checked before it's saved: it has to point to the facts it used, and anything that invents a certification or a contact, or promises something on the distributor's behalf, gets trimmed out or rejected.

I considered using Claude for the AI layer, which is what I'd use in production, but stuck with Gemini's free tier for the prototype and put both behind one model interface so switching is a configuration change rather than a code change.

Then, for the on-demand side, I added a chatbot in the bottom-right corner that has two main jobs: answering specific questions about a lead, and letting the user filter the list view using natural language (like saying "I'm looking for companies that have this trait" and having it control the UI filters for them).

## 3. Limitations & What I'd Do With More Time

When it came to the AI layer, I stuck with using the free version of Gemini, which did limit the quality of some of my insights and responses. With more tuning and a better model, the quality of the insights would greatly improve.

I could also get better data with more expansive search and scraping tools that require some budget, such as tools to find exact verified emails and deeper company information to feed into the large language models.

On the feature side, I would integrate proper notification and email support, as well as existing calendar functionality like Google or Microsoft Calendar. On the system design side, I would implement full geographical partitioning of the database, as well as better durability through automated backups and duplication.
