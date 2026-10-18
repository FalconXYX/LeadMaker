# Secondary data sources for LeadMaker: experiment report

Snapshot from 2026-10-18. Every number comes from an artifact under `research/` and is cited as `[family/file]`. Anything nobody ran is marked **UNTESTED**.

- `permits_activity`, `market_demand` and `company_people_data` have no README. Their results come from summary and output files.
- The NJ HIC owner-page experiment was still running during drafting, so its figures are marked **in progress**. The NY assumed-name run finished at 05:14 and the agent did not write it up.

Leads: 424 GAF roofers within 25 mi of 10013: 291 NJ and 133 NY; 85 Master Elite, 63 Certified Plus, 276 Certified.

---

## 1. Executive summary

- **What was tested.** About 35 sources were assessed across six families, and about 18 were actually run. Bulk files were matched against all 424 leads, live lookups ran on stratified samples of 34–84, and county data covered all 17 counties.
- **FMCSA Company Census (USDOT) is the best new decision-maker source in both states.**
  - Strict matching finds 99/424 leads: NY 51/133, NJ 48/291.
  - 98 of the matches have an officer name and 97 have an email. 78 rest on a phone match [company_people_data/strict_summary.json].
  - It is free bulk data. An enricher (`leadmaker/enrich/fmcsa_census.py`) appeared during drafting and was not reviewed here.
- **NYC DOB General Contractor licences are the best NY source.** They match 41/133 NY leads (31%) and give a named registrant and an email [registries_licensing/README.md]. They also join to permits: 18 leads have permits in the last 24 months, and 11 have roof jobs [permits_activity/nyc_match_summary.txt].
- **NJ DCA Home Improvement Contractor (HIC) and NJ DORES searches find most NJ firms.** HIC found 17/20 and DORES 16/20 of the NJ sample, both hand-verified. They give licence status, legal entity and formation date, **but no officers** [registries_licensing/README.md].
- **BBB has the richest people data but is not ToS-clean.**
  - 12/34 sample leads matched (35.3%), and 9/34 had named owners or officers with titles. There were 0 false positives.
  - BBB's Terms allow personal, non-commercial use only. The official API is paid and **UNTESTED** [reviews_directories/README.md].
- **Size and talking points.**
  - PPP matches 74/424 strictly, with jobs-reported quartiles of 2 / 5 / 15 [company_people_data/strict_summary.json].
  - Storm, housing and FEMA data cover all 17 lead counties [market_demand/out/county_summary.csv].
  - `web_signals` gives at least one talking point for 34/35 verified sites [digital_presence/README.md].
- **Integrate next, in order:**
  1. FMCSA
  2. NYC DOB licences + permits
  3. County storm talking points
  4. NJ HIC + DORES
  5. PPP size data
- **Biggest gap: NJ decision-makers.** NJ is 291/424 leads and has no free officer registry. FMCSA (48/291) is the only free, ToS-clean new source we measured that names NJ owners. The owner field on the HIC detail page is unmeasured: it timed out, then returned "link not found" 20/20 [registries_licensing/results_nj_hic_owner.json, in progress].
- **Biggest risk: entity resolution.** Hand-checks caught loose name matches, such as an OSHA "Maspeth" trucking site and "Maspeth Welding". Phone has been the most reliable key.

---

## 2. Rep needs mapped to sources

| Rep need | Already integrated | Measured new sources (match on our leads) | Gaps / untested |
|---|---|---|---|
| **Decision-maker names** | `ny_dos` (NY chairman/CEO), `website_crawl` | FMCSA officers 98/424; NYC DOB GC registrant 41/133 NY; BBB 9/34 sample (needs the API) | NJ officer registry (paid NJ Business Records Service, **UNTESTED**); OpenCorporates (401 without a key) |
| **Direct contact (email/cell)** | `website_crawl` emails | FMCSA email 97/424, plus a cell-phone field; NYC DOB GC business email ("most rows") | Email deliverability not tested; no SMTP probing was done, by design |
| **Services offered** | `website_crawl` | BBB categories 12/12 matched; NYC DOB permit work types (roof, solar); PPP NAICS codes | Houzz/Angi rejected on ToS |
| **Company size** | GAF employee range (partial) | PPP jobs reported 74/424; FMCSA power units and drivers 99/424; NYC permit volume 18/424 | OSHA ITA only 1/424 |
| **Timely talking points** | `web_signals` | NYC DOB permits (latest permit date, roof jobs); NOAA/NWS/FEMA per county (423/424; 1 ZIP unmapped); DORES formation dates; BBB start date | NJ permits **UNTESTED**; Meta Ad Library **UNTESTED** |
| **Web presence** | `website_discovery`, `web_signals`, `osm` | Websites verified for 35/84 sample; CMS, ads, financing, brands; DNS mail provider for 24 domains | Social follower counts need a login (not collected) |
| **Licence / standing** | `nyc_dcwp` | NJ HIC 17/20 NJ sample; NYC DOB GC status; NYS DOL MWBE/debarment flags 16/133 NY | County HIC (Nassau, Suffolk, Westchester, Rockland) **UNTESTED** |

---

## 3. Source scorecard

Match rates are on our leads, with n given. "Strict" means after the second-pass rescoring in `company_people_data/rescore_strict.py`.

| Source | Access & cost | ToS / robots | Tested? | Match rate (n) | Key fields | Recommendation |
|---|---|---|---|---|---|---|
| FMCSA Company Census (data.transportation.gov `az4n-8mr2`) | Open Socrata, free, keyless | Open data; Crawl-delay 1 | Yes, bulk (25,185 NJ/NY rows) | Strict 99/424: NY 51/133, NJ 48/291; 78 by phone [company_people_data/strict_summary.json] | Up to 2 officers, email, phone/cell, power units, drivers, MCS-150 date, status | **Integrate now** |
| NYC DOB License Info, GC (`t8hj-ruu2`) | Open Socrata, free | Open data | Yes, bulk (34,694 rows) | NY 41/133 (25 phone, 13 exact name, 3 name+city, of which 2 look false); NJ 4/291 [registries_licensing/README.md] | Registrant first/last name, email, licence no., status | **Integrate now** |
| NYC DOB permits (DOB NOW `rbx6-tga4`, BIS `ipu4-2q9a`) | Open Socrata, free | Open data; the agent spaced calls 1.5 s apart | Yes, all 424 | 18/424 with any permit in 24 months; 11 roof-related [permits_activity/nyc_match_summary.txt] | Job counts over 12 and 24 months, roof/solar jobs, borough mix, median cost, latest permit | **Integrate now** (bundle with the GC licence matching) |
| NOAA NCEI Storm Events + NWS LSR (via IEM) + OpenFEMA | Free bulk/API | IEM asks Crawl-delay 120, so 1 request per run | Yes, 17 counties | County join for 424 leads (210 ZIPs, 1 unmapped) [market_demand/out/zip_county_summary.json] | Storm events over 12 and 24 months, hail, wind ≥58 kt, damage $, latest NWS report, FEMA declarations | **Integrate now** (county-level) |
| NJ DCA HIC search (newjersey.mylicense.com) | Public HTML form, free | No robots.txt (404); terms not fully reviewed | Yes, 36-lead sample | NJ 17/20 (85%), NY 3/16 [registries_licensing/README.md] | HIC reg no., status, licence type, city | **Next** |
| NJ DORES Business Name Search (njportal.com) | Public HTML form (anti-forgery token), free | No robots.txt (404) | Yes, sample | 16/20 by hand; auto-matcher got 13 right, 3 wrong, missed 4 [registries_licensing/README.md] | Legal name, NJ entity ID, type, **formation date** (no officers) | **Next** |
| SBA PPP loan data (FOIA CSVs) | Free bulk, 13 CSVs, 5.22 GB in total [company_people_data/ppp_ranges.json] | Public FOIA release | Yes, bulk (311,697 NJ/NY rows) | Strict 74/424: NY 28/133, NJ 46/291 [company_people_data/strict_summary.json] | Jobs reported, loan amount (median $46,325), NAICS | **Next** (size proxy; 2020–21 snapshot) |
| BBB public profiles | Free HTML; official API is paid after a 30-day trial (price not captured) | robots allows `/profile/`; **ToS: personal, non-commercial only** | Yes, 34 sample (HTML); API **UNTESTED** | 12/34 (35.3%); names 9/34; 0 FP [reviews_directories/bbb_summary.json] | Owners/officers with titles, start date, licences, categories, rating | **Budget-dependent** (API only) |
| NYS DOL Contractor Registry (`i4jv-zkey`) | Open Socrata, free | Open data | Yes, bulk (14,992 rows) | NY 16/133, NJ 3/291; the only sample hit was a false positive [registries_licensing/README.md] | MWBE, workers' comp, debarment (officers in only 251/14,992 rows) | **Next** (flags only, low priority) |
| Census ACS (bulk summary file), BPS, NYC PLUTO | Free; ACS API now requires a free key | robots allow bulk paths | Yes | 17 counties; PLUTO matched 69/71 NYC lead ZIPs [market_demand/out/pluto_by_contractor_zip.json] | Owner-occupied units, pre-1980 share, median year built, new single-family units | **Next** (territory context) |
| Website discovery + `web_signals` (already integrated) | Free; own HTTP fetches plus Wayback and RDAP | Respect robots per site (1/35 sites disallowed) | Yes, 84 sample | Sites verified 35/84 (42%); talking point on 34/35 [digital_presence/README.md] | CMS, ad tags (20/35), financing, brands, socials, domain age | **Keep**; add Wayback retries |
| DNS / RDAP domain intel | Free | Public DNS; RDAP rate-limits (6/24 HTTP 429) | Yes, 24 domains | MX classified for 21/24 (Google Workspace 8, Microsoft 365 5, others 8); 3 had none [company_people_data/domain_intel.json] | Mail provider, SaaS tools in SPF/TXT, domain age; registrant is privacy-redacted | **Next** (fold into `web_signals`) |
| NY DOS All Filings (`63wc-4exh`), assumed names | Open Socrata | Open data | Yes, 133 NY leads (finished 05:14; not written up by the agent) | 31/133 with DBA filings; 110/133 unverified name hits [registries_licensing/results_nydos_assumed_names_NY.json] | Name history; the DBA cannot be linked to its legal entity (separate ID namespace) | Evaluate |
| USAspending API | Free | Open API | Yes, 36 sample + bulk | 4/424 bulk award matches; 12/36 loans (duplicate PPP) [company_people_data/usaspending_results.json] | Federal awards, agencies | Reject (niche) |
| OSHA ITA injury data | Free bulk | Open | Yes, bulk (25,333 rows) | Strict 1/424; first pass 3, including a false positive [company_people_data/strict_summary.json; osha_ita_results.json] | Annual average employees | **Reject** |
| NY Assumed Name licences (`38mn-ebhr`) | Open | Open | Not run | n/a | Stale (last updated 2018-08) | **Reject** |
| OpenCorporates API | Key needed; commercial use paid | robots disallow `/officers`, `/search` | **UNTESTED** (401) | n/a | Officers where the jurisdiction supplies them | Budget-dependent |
| NJ Business Records Service | Per-document fee (amount not captured) | Government | **UNTESTED** | n/a | NJ officer names | Budget-dependent (only NJ officer source) |
| SAM.gov, Yelp Fusion, Meta Ad Library | Free key / key with display-only terms / identity-verified app | Gov API / ToS bans robots / n/a | **UNTESTED** (SAM 404 without key) | n/a | POC names (expected few); reviews only; ad creatives | Low priority. The GTM pixel check is the ToS-safe ad proxy |
| Angi, HomeAdvisor, Houzz, Thumbtack, Porch, Nextdoor, Facebook, Indeed, LinkedIn | n/a | Cloudflare 403 (Angi, HomeAdvisor); ToS bans scraping or robots `Disallow: /` | Probed or reviewed only | n/a | n/a | **Reject** |
| County HIC licensing (Nassau, Suffolk, Westchester, Rockland) | Unknown | Unknown | **UNTESTED** | n/a | n/a | Investigate |

---

## 4. Experiment details by family

### 4.1 Registries & licensing (README present)
- **Method.** Stratified sample of 36 leads (NJ 20, NY 16). NJ HIC and DORES were queried live with polite form posts. The NYC DOB GC and NYS DOL bulk files were matched against all 424 leads (`bulkmatch.py`: phone, exact strict name, or name plus locality).
- **Results.** See the scorecard. The NJ HIC and DORES sample figures were hand-verified; the bulk NJ matches (DOB 4/291, DOL 3/291) were not.
- **Examples.**
  - DORES formation dates surfaced new entities: All Elite Roofing & Siding LLC (formed 2026-08) and Mega Home Remodeling (2023).
  - "American Roofing, LLC / Nutley" for lead "American Roofing LLC / Belleville" is an exact legal-name match in the neighbouring town, so it was rated plausible.
  - Zicklin Contracting Inc matched DOB GC "ZICKLIN CONTRACTING CORP" by exact name only, with a different city and phone (confidence 0.7) [results_nyc_dob_gc.json].
- **Caveats.**
  - The NJ HIC detail page, which might list an owner, is unmeasured. The first attempt timed out, and the 05:10 re-run logged "link not found" 20/20 [results_nj_hic_owner.json, in progress].
  - On NY assumed-name rows, `corpid_num` belongs to a separate ID namespace, so open data cannot map a DBA to its legal entity [exp_nydos_assumed_names.py docstring].

### 4.2 Reviews & directories (README present)
- **Method.**
  - robots.txt and ToS were fetched for every source.
  - BBB profile URLs came from the robots-advertised sitemap, not from search.
  - 61 profile fetches were made 1.5 s apart.
  - Matches were accepted only at confidence ≥0.9 with phone or address agreement.
- **Results.** BBB matched 12/34, all phone-verified. Among those 12:
  - decision-makers: 9/12
  - start date: 11/12
  - licence numbers: 8/12
  - categories: 12/12
  - accredited: 0/12
- **Examples.**
  - Maspeth Roofing & Siding: President and Director of Marketing named, 33 years in business.
  - Phil-Mar Inc: President and VP named.
  - High Caliber Renovations LLC: Owner named, plus NJ licence 13VH11041800.
- **Caveats.** Most misses were firms with no BBB file or with generic names; RH Development Corp had 239 slug candidates and none verified. The non-commercial ToS blocks production scraping.

### 4.3 Digital presence (README present)
- **Method.** Sample of 84 leads. Websites were verified by phone on the page (26), OSM phone (5), or name plus roofing terms plus locality (4). `web_signals` then read Wayback, RDAP, CMS, the GTM container, schema.org and social links.
- **Results.** 35/84 sites verified (42%). On those sites:
  - Advertising: 20/35. Only 9/35 had tags visible in the HTML; the rest were found in the GTM container.
  - Financing offered: 12/35.
  - Manufacturer brands: 21/35 (GAF 21, CertainTeed 6, Owens Corning 5).
  - Wayback first capture: 27/35, with 6 errors.
  - Ads by tier: Master Elite 10/12, Certified 9/13, Certified Plus 1/9.
- **Examples.**
  - Proven Contracting: Google Ads, financing, five manufacturer brands, online since about 2017.
  - CMNG LLC: domain registered in 2023, while GAF says in business since 2007 [signals_summary.json].
- **Caveat.** schema.org names a founder on only 1/35 sites, so it adds almost nothing for people.

### 4.4 Company & people data (no README; results from summary JSON)
- **Method.** NJ/NY slices of FMCSA (25,185 rows), PPP (311,697) and OSHA ITA (25,333) were matched offline. They were then rescored strictly (`rescore_strict.py`): a phone match (FMCSA), or strict similarity ≥0.97 on a distinctive name plus the same ZIP or city. USAspending was queried for 36 leads (118 requests). DNS and RDAP were checked for 24 domains.
- **Results.**
  - FMCSA strict: 99/424. Of those, 86 active, 98 with an officer, 97 with an email.
  - PPP strict: 74/424, down from 98 under the loose first pass [ppp_match_summary.json].
  - OSHA: 1/424.
  - USAspending: 4 bulk award matches.
- **Examples.**
  - Maspeth Roofing & Siding: FMCSA phone match with 31 power units. PPP lists it as borrower "MASPETH CONTRACTING CORP" with 16 jobs.
  - ADH Group (legal name Makabad Corp): PPP borrower "MAKABAD CORP", 20 jobs. This is a lower-tier match on same borough.
  - Niko K Construction Corp: 11 DOT awards totalling $1,179,980 [usaspending_results.json].
- **Caveats.**
  - PPP is a 2020–21 snapshot, and all its matches are name-only.
  - FMCSA covers only firms that operate qualifying vehicles. In the first pass, 50 of 101 matches had an MCS-150 filed in 2025–26 [fmcsa_summary.json].
  - RDAP registrants are privacy-proxied (Domains By Proxy on 8/24).

### 4.5 Permits & activity (no README; results from `nyc_match_summary.txt`, `nyc_activity_summary.txt`)
- **Method.** Leads were matched to DOB GC licences by phone, name plus ZIP, or exact name. The licence number then joined to DOB NOW and BIS permits for 2024-10-18 to 2026-10-18. Roof jobs were flagged by "ROOF" in the description or work on the roof floor.
- **Results.** 46/424 licences matched (29 by phone): NY 36/133, NJ 10/291. 18 leads had any permit in 24 months and 11 had roof-related permits. NJ had none. The file holds 1,997 permit detail rows.
- **Examples.**
  - Maspeth Roofing & Siding: 58 jobs in 24 months, 26 of them roof jobs, median cost $160,000, latest permit 2026-10-16.
  - POFI Construction Corp: 98 jobs, 22 of them roof jobs.
  - Kamtech Restoration Corp (Master Elite): 1,144 of 1,145 jobs are solar, which is a talking point in itself.
- **Caveats.**
  - NYC only; NJ municipal permits are **UNTESTED**.
  - This agent counts 36 NY licences where the registries agent counts 41, because they use different matchers.
  - 10 more NY leads matched on weak names only and were not counted.

### 4.6 Market demand (no README; results from `out/`)
- **Method.**
  - ZIP mapped to county with the Census ZCTA relationship file.
  - NOAA NCEI Storm Events, with NWS LSRs (via IEM) filling the NCEI lag.
  - OpenFEMA declarations.
  - ACS 2020–24 from bulk summary files, because the keyless API now returns "Missing Key".
  - Census BPS and NYC PLUTO.
  - Per-county talking points generated by `08_county_summary.py`.
- **Results.**
  - 424 leads span 210 ZIPs in 17 counties. 1 ZIP (10113) is unmapped.
  - Point-vs-ZIP county check: 41/45 agree.
  - 158 LSR reports in Jul–Oct 2026, summed across counties.
  - Only 3 hail events in 24 months, so wind is the main storm angle [out/county_summary.csv].
- **Example.** Bergen County has 96 leads and 13 storm events in 24 months. It has 232,025 owner-occupied homes, 73.8% built before 1980, which is about 2,417 owner homes per GAF contractor [out/talking_points_by_county.json].
- **Caveats.**
  - These are county-level points, not contractor-specific.
  - NCEI data runs through 2026-06-30.
  - One Essex County point names "Beaufort", which we could not place in Essex. Spot-check generated text before reps see it.

---

## 5. Entity-resolution lessons

1. **Legal name vs DBA.** GAF's listing name often differs from the registered entity. Examples:
   - ADH Group → Makabad Corp
   - Medal Worthy Roofing & Siding → American Quality Home Improvements LLC
   - Lester Goldsmith Roofing → Lesgold LLC
   - Maspeth Roofing & Siding → Maspeth Contracting Corp

   Always query `legal_name`, `name` and `dba`. Medal Worthy's legal name was still missed among 30 DORES hits. NY DBA-to-entity resolution is not possible from the open filings dataset (§4.1). Legal names come from the strict sample audit [company_people_data/strict_summary.json].
2. **Phone is the strongest key.** It accounts for:
   - 78/99 FMCSA matches
   - 25/41 NYC DOB GC NY matches
   - 12/12 BBB matches, with 0 false positives
   - 26/35 verified websites

   Normalise to 10 digits and also check cell/fax fields.
3. **Generic names cause wrong picks.**
   - RH Development Corp had 239 BBB candidates.
   - "American Roofing" picked "American Roofing & Siding Co., Inc. / Union".
   - All Elite matched to "All Elite Exteriors".
   - A1 Dependable matched to a "Construction Corp" sibling. These last three were DORES auto-matcher errors [registries_licensing/README.md].

   Require a distinctive token plus a locality match.
4. **Loose similarity creates false positives.** The first-pass `name_similarity` strips trade words, so "Excellence Home Improvements" scored 1.0 against "Excellence Contracting" [rescore_strict.py]. Hand-checks found:
   - OSHA "A. Duie Pyle Companies / Maspeth" (a trucking company) matched to Maspeth Roofing.
   - NYS DOL "Maspeth Welding" matched to Maspeth Roofing & Siding.
   - 2 of 3 DOB name+city matches looked false.

   Strict rescoring cut PPP from 98 to 74 and OSHA from 3 to 1.
5. **Normalisation gaps.**
   - Raidex was missed because the "LIMITED LIABILITY COMPANY" suffix was not normalised.
   - Apostrophes likely broke the HIC queries for Wilber's and Westgate (0 hits).
   - Fix: add "LIMITED LIABILITY COMPANY", "L.L.C." and "CORPORATION" to the suffix list.
6. **NJ vs NY coverage.** NYC sources barely reach NJ: DOB GC matched 4/291 NJ against 41/133 NY. FMCSA and PPP are the only state-neutral sources we measured, at NJ 48/291 and 46/291.
7. **Use one matcher.** Two agents matched the same DOB file and got different counts: 41 vs 36 NY. Production should use a single shared matcher (`leadmaker/enrich/_registry_match.py`) that records evidence tiers, and should store only phone-level or strict-plus-locality matches as "verified".

---

## 6. Roadmap

**Now (free, measured, ToS-clean)**
- **FMCSA enricher** (`fmcsa_census.py`): officers, email, cell phone, fleet size. Can be matched offline from bulk; the research run made 0 per-lead requests [company_people_data/fmcsa_summary.json].
- **NYC DOB GC licence + permit activity**, as one enricher that reuses the registries matching logic. The permits agent fetched the data with a few aggregate Socrata calls.
- **County storm and housing talking points.** Join `market_demand/out/talking_points_by_county.json` to leads by ZIP.
- **Shared strict matcher**, phone first, with the suffix fixes above.

**Next**
- NJ HIC + DORES enricher: 2 form posts per lead at 1.2 s spacing, at least 40 minutes per 1k leads (derived from that spacing; response time is extra). Licence status, legal entity and formation date.
- PPP size proxy (offline bulk). NYS DOL MWBE and debarment flags. ACS/PLUTO territory context. DNS mail provider inside `web_signals`. Wayback retries (6/35 errored).
- Retry the NJ HIC detail page for owner names. This remains unmeasured.

**Budget-dependent.** No artifact records a price, so cost per 1k leads cannot be stated for these; get quotes first. Every Now/Next source above has $0 data cost, and the only cost is request time.
- **BBB API:** 30-day free trial, then paid. Gives contact names and titles; our HTML test reached 26.5% of the sample.
- **NJ Business Records Service:** per-document fee. The only NJ officer source.
- **OpenCorporates:** paid for commercial use.
- **Already key-gated:** Google Places, Claude (`llm_extract`).
- **Free but gated:** SAM.gov key, Census API key, Meta Ad Library (identity verification).
- **Yelp Fusion:** no owner names.

**Rejected**
- Angi and HomeAdvisor: Cloudflare-blocked and banned by ToS.
- Houzz, Thumbtack and Porch: ToS bans scraping.
- Nextdoor and Facebook: robots `Disallow: /`.
- BBB HTML scraping: non-commercial ToS.
- Bing and DuckDuckGo scraping: junk results and bot challenges.
- Indeed and LinkedIn: ToS.
- OSHA ITA: 1/424.
- USAspending: 4/424.
- NY Assumed Name `38mn-ebhr`: stale since 2018.

---

## 7. Compliance notes (not legal advice; confirm with counsel)

- **Robots and ToS.**
  - Socrata portals (NYC, NY State, USDOT) and Census and FEMA data are open data meant for API use.
  - Respect stated crawl delays: IEM asks for 120 s, so make 1 request per run. data.transportation.gov and NYC Open Data ask for 1 s.
  - The NJ portals have no robots.txt and their terms were not fully reviewed, so keep volume low and identify the client honestly.
  - Do not load the BBB data from the HTML experiment into production. Use it only as evidence for the API decision.
- **PII.** FMCSA emails and cell phones, DOB registrant emails and BBB names are personal data even though they come from public records. In the FMCSA first pass, 60 of 97 emails were personal domains.
  - Store the source, record ID and fetch date with every contact field.
  - Restrict exports.
  - Do not mix personal-domain emails into bulk email lists without review.
- **CAN-SPAM (email).** Commercial email to these contacts must have:
  - accurate sender and subject lines
  - a physical postal address
  - a working opt-out, honoured promptly and kept on a suppression list across tools
- **TCPA (calls and texts).** FMCSA records include a cell-phone field, so assume some numbers are wireless.
  - Reps should dial manually.
  - No autodialed or prerecorded calls and no marketing texts to cell numbers without prior consent.
  - Scrub against the National DNC list and keep an internal DNC list.
- **Retention.**
  - Refresh registry fields on the source's own cycle (for example, FMCSA's biennial MCS-150) and expire stale contacts.
  - Keep raw bulk downloads out of the repo; the agents already kept them in scratch.
  - Delete a person's data on request.

---

## 8. Appendix: artifact paths (all under `research/`)

- `registries_licensing/`: README.md, sample.json, results_nj_lookups.json, results_nyc_dob_gc.json, results_nysdol_registry.json, results_nj_hic_owner.json (in progress), results_nydos_assumed_names_NY.json (finished 05:14, not written up), exp_*.py, nj_*_probe.py, bulkmatch.py
- `reviews_directories/`: README.md, sample.json, bbb_summary.json, probe_bot_protection.json, bbb_match.py, bbb_sitemap_index.py, tos_grep.py
- `digital_presence/`: README.md, sample.json, websites.json, websites_verified.json, signals_summary.json, signals_raw.json, run02.log, run03.log, 0*_*.py
- `company_people_data/` (no README): strict_summary.json, fmcsa_summary.json, fmcsa_matches_sample.json, ppp_match_summary.json, ppp_matches_sample.json, ppp_ranges.json, osha_ita_results.json, usaspending_results.json, domain_intel.json, rescore_strict.py, sample.json
- `permits_activity/` (no README): nyc_match_summary.txt, nyc_activity_summary.txt, nyc_activity_matched.json, fetch_nyc_dob.py, fetch_dob_licenses.py, match_nyc.py, nyc_activity.py
- `market_demand/` (no README): out/county_summary.csv, out/talking_points_by_county.json, out/zip_county_summary.json, out/storm_summary_by_county.json, out/lsr_summary_by_county.json, out/fema_summary_by_county.json, out/acs_by_county.json, out/acs_by_contractor_zcta.csv, out/bps_by_county.json, out/pluto_by_contractor_zip.json, out/contractor_county.csv, 01–08 scripts
