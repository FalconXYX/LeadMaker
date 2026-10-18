# Sales-domain research: what a roofing-distributor rep actually needs

> **Note (2026-10-18):** this doc mentions `02-backend.md`, `03-frontend.md`, `02`/`03` and `prompts/account_brief.system.md`. Those were draft design docs and have since been deleted, so treat those references as historical. The domain research itself stands on its own.

> **Purpose.** This is domain research meant to shape **tagging, scoring, UI and AI outputs**. It covers how US roofing distribution works, what makes a contractor a valuable account, what GAF certification tells a distributor, how reps plan accounts and get measured, and what is seasonal about NY/NJ. Each section ends in something we can build.
> **Status:** research and recommendations only. No code was changed. Written 2026-10-18. Red-team reviewed 05:15 EDT: brought into line with the *current* `tagging/rules.py`, `db/schema.py` (`accounts`, `audit_events`) and `02-backend.md`. External facts were spot-checked (§Sources). See §9 for open risks.
> **Evidence labels:** `[S#]` = cited source (list at the end). `[DB]` = our own `data/leadmaker.db` (queried on a copy). `[MD]` = our `research/market_demand/out/*` (NOAA/NWS/FEMA/Census pulls). **`ASSUMPTION`** = industry convention or my estimate. These are labelled so they can be swapped for the distributor's real numbers on day one.

---

## 0. TL;DR: ten things that should change the product

1. **GAF tier still dominates the ranking.** 20% of our 424 leads are Master Elite (85/424) `[DB]`. Today's `leadmaker/tagging/rules.py` adds weighted points up to 100. Tier is worth 25 points, and a Master Elite also collects +4 for GAF Leads and +4 for President's Club where it applies. The result is that **44 of the top 50 leads by `priority_score` are Master Elite, and all 85 MEs land in the `strategic` segment** `[DB]`. Those are also the accounts every competitor is already chasing. Tier should be **one input to a Capacity axis**, not a large flat bonus.
2. **`gaf_leads_enrolled` counts tier twice.** It is true for exactly the 85 Master Elites and nobody else `[DB]`, yet `WEIGHTS["gaf_leads"] = 4`. Set it to 0 until the field varies.
3. **Group the existing score components into axes and show the reasons:** *Capacity* (how much they could buy), *Fit* (residential re-roof, inside our delivery radius, buys whole systems), *Timing* (why now), *Reachability* (we have a named decision-maker). Subtract *Risk* (credit, entity status, stale listing). Most of the components already exist in `rules.py`, so this mainly regroups and re-weights them (§7.1). Each axis becomes a chip in the UI. The `priority_drivers` tag already lists the top 3 components.
4. **Add a Riser list next to the strategic list.** The code's `strategic` segment matches what this doc calls **"whales"**: large incumbents where taking share from an entrenched supplier is slow, so the play is wallet share. **"Risers"** are Certified and Certified Plus firms that are large for their tier, growing fast, recently upgraded or new to the directory. They are easier to win and worth more over their lifetime. Today they are spread across `growth` and `emerging`. Keep the four segment names that `02`/`03` already use, and add `riser` and `watch` as tags (§7.1.2) instead of renaming segments.
5. **NY/NJ is a wind, tree-fall and age-of-housing market, not a hail market.** Across our 17 counties NOAA logged **3 hail events against 265 wind ≥58 kt events** in 24 months `[MD]`. The median home was built between 1944 and 1982. Between 46% (Somerset) and 85% (Nassau) of homes predate 1980, and 16 of the 17 counties are at 57% or higher `[MD]`. Steady re-roof demand matters more than storm chasing, so "storm/insurance restoration" should be a **tag**, not a big score boost. Storm reports should drive *timing* (refresh the list after a wind event), not *fit*.
6. **The GAF Rewards rate is a ready-made talking point that differs by tier.** Master Elite earns **1.5%** back on qualifying GAF purchases, Certified and Certified Plus earn **1.0%**, and non-certified contractors earn **0.5%**. A **GAF-approved distributor can submit proofs of purchase on the contractor's behalf** (GAF calls the distributor programme "auto-submit"). The deadline is **March 31 of the year after purchase, or earlier for special promotions** `[S7]`. The brief should say "we submit your Rewards proofs for you" when that is true, which needs a `seller.*` fact. A contractor who moves to Master Elite gets a 50% higher rewards rate, which is a natural reason for the rep to get in touch.
7. **Show estimated annual wallet as a labelled range.** Use squares per year × materials $ per square, with the assumptions visible (§2.3). Never show a single number. Wallet share, the KPI a rep is measured on, means nothing without a denominator.
8. **The account brief should answer the questions a contractor actually picks a distributor on.** Beacon's 10-K lists the competitive factors as availability, technical know-how, **delivery** and digital tools, price, and **credit** `[S1]`. Every brief needs a delivery angle (rooftop or boom delivery, and NYC job sites with tight staging), a credit angle (always "subject to approval"), a GAF-programme angle, and **discovery questions for what we cannot see**: current supplier, squares per year, crews, terms.
9. **Use the calendar.** Q1 is the trough and the planning window. Beacon reports Q1 as its weakest quarter, and past-due receivables rise in winter `[S1]`. Shingles need roughly 50 °F or warmer to seal `[S9]`. Recommended rhythm: **Jan–Mar** for new-account and credit-application pushes plus the Rewards-proof hook, **Apr–Nov** for in-season service and storm-response plays, and **Nov–Dec** for pre-buy ahead of price increases and next-year planning.
10. **Track the funnel from lead to opened account, then to wallet share.** At prospect stage the product can measure time to first touch, contact rate, credit applications and first orders. With ERP data it can add first-90-day revenue, wallet share and reactivation. The DDL is in §7.3. Without these numbers we cannot tune the score weights. With them, the weights can be learned (§7.1.5).

---

## 1. How US roofing distribution works

### 1.1 Market structure

| Fact | Value | Source |
|---|---|---|
| US + Canada roofing distribution market | **> $35B/yr**, about **70% residential**, 30% non-residential | Beacon FY2024 10-K `[S1]` |
| Complementary products (siding, waterproofing, OSB, windows/doors) | **> $25B/yr** | `[S1]` |
| What drives roofing demand | **Re-roofing is about 80%**, new construction about 20% | `[S1]` |
| Who sits between whom | "a small number of manufacturers and thousands of local, regional, and national contractors" | `[S1]` |
| Beacon's own customer count | about **110,000** residential + non-residential customers, 135,000+ SKUs | `[S1]` |
| Beacon bad-debt expense | about **0.12% of net sales** (3-year average). Past-due receivables share **rises in winter** | `[S1]` |

**The Big 3 (all have consolidated sharply since 2024):**

| Distributor | Owner | Footprint | Notes | Source |
|---|---|---|---|---|
| **ABC Supply** | Private (Hendricks family) | ~970 branches (year not stated in source), ~$20.4B revenue (2023) | "Largest roofing and vinyl siding wholesale distributor in the US". Bought Bradco in 2010 | `[S3]` |
| **SRS Distribution** | **Home Depot** (deal announced Mar 2024, **$18.25B**, closed 2024-06-18). SRS bought **GMS**: agreed June 2025, ~$4.3B, closed Sept 2025 | **>1,250 locations** including GMS at end of FY2025. Four lines of business: roofing & building products, interior, landscape, pool | Gives Home Depot a Pro / job-site channel | `[S2]` `[S5]` |
| **Beacon** | **QXO** (closed Apr 2025, ~$11B). QXO later bought Kodiak Building Partners (closed Apr 2026, $2.25B) and TopBuild (closed Jul 2026, ~$17B) | 586 branches at end of 2024. QXO ~1,150 locations after TopBuild | 2,408 CDL trucks, most with truck-mounted forklifts, cranes, booms or conveyors. Private label **TRI-BUILT** ("higher margins") | `[S1]` `[S4]` |

**Local consolidation in NY/NJ (talking-point relevant).** Beacon bought **Passaic Metal & Building Supplies** (9 branches in NJ and NY) in **Aug 2024**, and **Garvin Construction Products** (5 branches in MD/NY/CT/NJ/MA) in Oct 2023. It also owns Allied Building Products, a former NJ-based distributor `[S1]`. *Inference:* contractors whose local yard changed owner recently may be open to a second supplier. Treat this as a "worth asking" discovery question, never a claim.

**Manufacturers.** GAF calls itself "North America's largest roofing manufacturer" `[S10]` (Wikipedia: "the leading roofing and waterproofing manufacturer in North America" `[S6]`). It sells through distributors and retailers such as ABC Supply, Home Depot and Lowe's `[S6]`. Beacon's largest suppliers include Owens Corning, GAF, CertainTeed, IKO and TAMKO `[S1]`. A distributor needs certified GAF contractors because those contractors buy whole GAF systems through it (§3).

### 1.2 Branch model and how reps are organised

```
                 ┌──────────────── Region / Area VP ────────────────┐
                 │                                                   │
          Branch (P&L unit)                                  Branch (P&L unit)
  ┌───────────────┼───────────────────┐
  Branch Mgr   Outside Sales Reps   Inside Sales / Counter   Credit Mgr (often regional)
               (own a territory     (order desk, quotes,     (credit apps, terms,
                ≈ branch delivery    will-call, delivery      past-due follow-up)
                radius; field        scheduling)
                visits, new logos)
                       ▲
                       │ co-sell / joint calls
               Manufacturer territory managers (e.g. GAF), who own contractor
               certification relationships, rebates and promotions
```

| Element | What it means for the product | Basis |
|---|---|---|
| **Branch = inventory + fleet + P&L** | Leads must be tied to a **serving branch**. Score must include **distance or drive time to the nearest branch**. Today the GAF search centre (ZIP 10013) stands in for a branch, which is wrong for a 25-mile radius that spans five boroughs plus NJ | `[S1]` (branch counts, networked branches sharing fleet and inventory, "OTC Network"). Territory-by-radius is an **ASSUMPTION** (industry convention) |
| **Outside reps own territories** | Lead lists are filtered to `owner_rep_id` or territory polygon by default. Hand-off between reps needs an audit trail | **ASSUMPTION** |
| **Inside sales / counter** | They need the same account page in "phone mode": who this is, last touch, open quotes | **ASSUMPTION** |
| **Credit is a gate to the first order** | "Credit application sent / approved" is a funnel stage. Credit-risk signals are a first-class part of the score. Beacon "require[s] payment from most customers within 30 days" (60 days for non-residential), which gives a reference for terms, but the brief only quotes `seller.credit` | `[S1]` (credit named as a competitive factor; terms; bad-debt and winter receivables notes) |
| **Delivery is a key differentiator** | Boom, conveyor and rooftop delivery, small-lot drops and NYC constraints (narrow streets, attached row houses, little staging space) belong in talking points | `[S1]` (fleet capabilities). NYC specifics are **ASSUMPTION / inference** |
| **Manufacturer reps co-sell** | A "share with GAF TM" or "joint call" action is a plausible later feature | **ASSUMPTION** |
| **Rep compensation usually tracks gross margin $** | Brief should also flag high-margin opportunities: private label, accessories, complementary lines | **ASSUMPTION** (common distributor practice. Beacon notes TRI-BUILT carries higher margins `[S1]`) |

---

## 2. What makes a contractor a valuable distributor account

### 2.1 Value drivers and how we can see them

| Driver | Why the distributor cares | Public proxy we can collect | Coverage today |
|---|---|---|---|
| **Volume (squares/yr)** | Revenue and margin $ | Crew count, employee range, review count and velocity, years in business, permit counts (future) | `employees_range` 37% filled (`1-5` = 86, `More than 5` = 68) `[DB]`. `review_count` 100%. Google Places matched 235 |
| **Residential re-roof vs new construction** | Re-roof is 80% of demand `[S1]`, less tied to the housing cycle, and pays faster than builder work (**ASSUMPTION**) | Website services text (LLM extraction) | website crawled 182 / 424 |
| **Storm / insurance restoration** | Spiky, high-volume, time-critical demand. Needs stock and fast delivery. Higher credit risk for out-of-area "storm chasers" | Website keywords ("insurance claims", "storm damage"), entity age, out-of-area address | via LLM extraction |
| **Full exterior (roof + siding + gutters + windows)** | Bigger wallet for a full-line distributor. Complementary products are a >$25B market `[S1]` | Services extraction. GAF `specialties` (Solar, Metal, FORTIFIED) | specialties sparse (8/424) `[DB]` |
| **System buyer (whole GAF system)** | Accessory attach rate (underlayment, leak barrier, ridge cap, vents) is margin. Enhanced warranties "require the use of a minimum amount of GAF products" `[S8]` | GAF tier (Certified tiers can offer enhanced warranties), warranty mentions on website | tier 100% |
| **Credit-worthiness** | The first order depends on it. Winter past-dues rise `[S1]` | Years in business (242/424 filled), NY DOS entity status / filing date, NYC DCWP licence status, rating/complaints. Future: liens, judgments, UCC filings, D&B | partial (NY only for DOS/DCWP) |
| **Programme loyalty** | Rewards and warranties tie the contractor to GAF *product*, but **not to any distributor**. A distributor can win them on service, credit and Rewards admin | Tier, President's Club stars (12 MEs: 10×1★, 2×2★) `[DB]`. The `competitor_brands` tag from `web_signals` shows when a firm also features other manufacturers | 100% (competitor brands: 15 sites so far) |
| **Proximity** | Delivery cost and service level | Geocode → drive time to nearest seller branch | lat/lng 100%. **Seller branches missing** |
| **Growth trajectory** | Lifetime value. A Riser is cheaper to win before a competitor locks them in | Δ review count between scrapes, `first_seen_at` (new to directory), tier upgrade, new website/services, hiring | Infrastructure exists. `audit_events` already logs field-level `{field: [old, new]}` changes and `delisted`. But it holds only `created` rows (2,753) because there has been one scrape so far. **A second scheduled scrape is all this needs** |

### 2.2 Sample-wide facts that should temper the score

| Observation `[DB]` | Implication |
|---|---|
| ME 85 (20%), Certified Plus 63 (15%), Certified 276 (65%) | Tier alone splits the list into only 3 buckets. It needs other signals to break ties |
| Avg review count: ME 161, Certified Plus 66, Certified 46. **184 of 276** Certified firms have <10 GAF reviews | Review volume separates "big Certified" from "tiny Certified". Use `log(reviews)` |
| 43 of 85 MEs have ≥100 reviews | The "whale" set is about 40–50 firms, a manageable named-account list |
| `gaf_leads_enrolled` = exactly the 85 MEs | Redundant with tier in this data. Zero weight |
| `employees_range` "More than 5": ME 22, Certified Plus 11, Certified 35 | Size crosses tiers: 35 Certified firms say they have more than 5 staff, and those are Riser candidates |

### 2.3 Wallet estimate (shown as a range, assumptions visible)

```
squares_per_year ≈ crews × roofs_per_crew_week × squares_per_roof × season_weeks
annual_wallet    ≈ squares_per_year × materials_$_per_square
```

| Parameter | Default (ASSUMPTION; replace with seller data) | Signal that moves it |
|---|---|---|
| `crews` | `1-5` employees → 1. `More than 5` → 2–3. ME → +1 (ASSUMPTION: higher volume, unverified). Unknown → 1–2 | employees_range, LLM "crews" extraction, hiring posts |
| `roofs_per_crew_week` | 1–2 for residential tear-off and re-roof | — |
| `squares_per_roof` | 25–35 (1 square = 100 sq ft. NYC attached homes are smaller) | ACS/PLUTO building size in service ZIPs `[MD]` |
| `season_weeks` | ~32 (Apr–Nov), since shingles need ≥50 °F to seal `[S9]` | — |
| `materials_$_per_square` | $150–$250 incl. accessories (architectural shingle system, 2026) | **Replace with the distributor's actual average $/square** (`seller.avg_ticket_per_square`) |

The worked range for a 2-crew contractor is 2 × 1–2 × 25–35 × 32 ≈ 1,600–4,500 sq/yr, or roughly **$0.25–1.1M/yr materials**. The width of that range is the reason to show bands. Show it as **bands** (S < $150k, M $150–500k, L $0.5–1.5M, XL > $1.5M) with a "how we estimated this" popover. The LLM brief may cite the band only as `basis: inferred`. The band is the contractor's **total** roofing-materials spend across all brands and suppliers, not GAF spend and not the share we could win. If an imported `accounts` row has `annual_spend`, show that figure next to the band as "our share today".

---

## 3. The GAF certification ladder and why a distributor cares

### 3.1 The ladder (verified against gaf.com on 2026-10-18 unless marked)

| Level | What GAF says | Warranties | GAF Rewards rate | In our 25-mi slice `[DB]` |
|---|---|---|---|---|
| **President's Club** (award, 1–3★) | "GAF entrusts a select few Master Elite® contractors" with President's Club status. **3★ winners are "the best of the best among Master Elite"** and can offer the President's Club Limited Warranty `[S8]` | President's Club LW (3★) | (as ME) | 12 (10×1★, 2×2★) |
| **Master Elite®** | Can offer "our strongest warranties including the Golden Pledge® Limited Warranty" `[S8]` | Golden Pledge®, Silver Pledge™, System Plus | **1.5%** `[S7]` | 85 |
| **Certified Plus™** (newer middle tier) | Can offer "System Plus® Limited Warranty and Silver Pledge™ Limited Warranty" `[S8]` | Silver Pledge™, System Plus | **1.0%** `[S7]` | 63 |
| **Certified™** | Can offer "one of GAF's enhanced warranties, the System Plus Limited Warranty" `[S8]` | System Plus | **1.0%** `[S7]` | 276 |
| Not certified / builders / remodelers | — | Standard only | **0.5%** `[S7]` | (not in directory) |

**Benefits of certification (GAF's own list) `[S10]`:** access to enhanced warranties (up to 50 years non-prorated coverage), more Rewards points, at least **40% off GAF WeatherHub** (a storm-tracking sales tool powered by Predictive Sales AI), and discounted QuickMeasure / ScopeConnect services. Contractors "may receive benefits, such as loyalty rewards points and discounts on marketing tools… for… offering GAF enhanced warranties, which require the use of a minimum amount of GAF products" `[S8]`.

**Claims I could not verify this session:**
- **"Master Elite = top 2% of roofing contractors."** This figure circulates widely in contractor marketing. I could not find it on the gaf.com pages I fetched (locator, certification, Rewards, verify, a sample profile). Even if it is true, it means 2% **of all roofing contractors**, not of GAF's directory: in our slice MEs are 20% of listed firms. **Do not put "top 2%" in briefs** unless a `seller.*` or cited GAF fact supports it.
- **ME entry requirements** (state licensing where required, minimum insurance, reputation/complaint screening, ongoing training) are commonly described this way, but **I did not verify them on gaf.com in this session.** In the product, phrase them as "GAF-certified contractors must meet GAF licensing, insurance and training requirements (see gaf.com)". Do not list specifics.
- **National tier mix:** GAF's index holds about 12,800 residential contractors. We can get the true national ME share cheaply with a Coveo **facet query on tier** using the existing search key, which gives a real percentile instead of the "2%" folklore. *Recommended 15-minute task.*

### 3.2 Why a distributor cares (and what the rep should say)

| Mechanism | Distributor angle | Talking-point template (needs `seller.*` fact) |
|---|---|---|
| Rewards are earned on **qualifying GAF purchases** with proof of purchase. Proofs are due **3/31 of the following year** (earlier for some promotions). A **GAF-approved distributor can submit them** on the contractor's behalf `[S7]` | Admin relief and points not left on the table, at **no price concession** | "We're on GAF's distributor auto-submit list, so your Rewards proofs go in automatically." (only if `seller.gaf_rewards` says the distributor is approved) |
| Rate gap: ME 1.5% vs Certified 1.0% `[S7]` | On a $500k/yr GAF spend the ME uplift is about **$2.5k/yr** (arithmetic on the cited rates). Helping a Certified Plus firm toward ME is relationship capital | "Many of our Certified Plus customers are working toward Master Elite. Happy to connect you with our GAF territory manager." (inferred, `seller.gaf_tm_partnership`) |
| Enhanced warranties need a **minimum amount of GAF product** `[S8]` | Sell the **whole system** (shingles + underlayment + leak barrier + ridge + ventilation) and protect attach rate and margin | "We stock the full GAF system for Golden Pledge / System Plus jobs at {{branch}}." (`seller.stock.gaf`) |
| WeatherHub discount for certified firms `[S10]` | Certified firms are tooled for storm response, so after an event they need **fast stock and delivery** | Storm-trigger script (§5) |
| President's Club stars are awarded on performance | Strong proof of high volume (**inferred**). Treat stars as a top-decile Capacity signal | — |

---

## 4. The rep's account-planning workflow and KPIs

### 4.1 Weekly loop (what the UI should mirror)

```
 Mon AM  ── Territory review ──►  "My list": new leads, Risers, triggers fired since last week
         ── Prioritise ────────►  pick ~10–15 accounts (whales to advance, risers to open, lapsed to reactivate)
 Mon–Thu ── Research (5 min/acct) ► account brief: who, why-now, decision-maker, talking points, unknowns
         ── Touch ────────────►  call / email / drop-in visit (often with GAF TM); log outcome in 1 click
         ── Advance ──────────►  credit app → first quote → first order → recurring
 Fri     ── Pipeline review ───►  stage changes, wins/losses (+reason), next steps
 Monthly ── Branch/manager ───►  new accounts opened, wallet-share movers, reactivations, rep activity
```
(The loop is an **ASSUMPTION**, synthesised from common B2B distributor practice. Validate with one real rep interview.)

### 4.2 KPIs a distributor rep is typically measured on (**ASSUMPTION**, standard distribution metrics)

| KPI | Definition | Can our product compute it? |
|---|---|---|
| **New accounts opened** | First order (or approved credit) from a never-purchased account in period | Yes, if reps log stages. Better with an ERP/CRM sync |
| **Wallet share** | Our sales to account ÷ est. annual materials wallet (§2.3) | Denominator now (estimate). Numerator needs ERP |
| **Reactivation** | Lapsed → ordering again. `accounts.py` currently treats an account as lapsed after 365 days with no order (`LAPSED_AFTER`). Many distributors use 90–180 days (ASSUMPTION), so the cutoff should be a per-seller setting | Partly now: the CRM CSV import (`leadmaker/accounts.py`) already marks existing and lapsed accounts. Full tracking needs ERP |
| **Sales $ / gross margin $ and %** | Standard | ERP |
| **Mix / attach** | Accessories $ per square, complementary lines, private label share | ERP. Brief can *suggest* attach plays |
| **Credit health** | Past-due %, DSO of rep's book (rises in winter `[S1]`) | ERP. Product shows risk flags pre-sale |
| **Activity** | Touches/week, visits, time to first touch on assigned leads | **Yes, natively** (activity log, §7.3) |

---

## 5. Buying triggers and talking points

| Trigger | Signal / source (in repo or addable) | When | What the rep says or does |
|---|---|---|---|
| **Wind / severe storm in the contractor's service counties** | NWS Local Storm Reports and NOAA Storm Events by county `[MD]` (e.g. Union County: 29 roof-relevant events in 24 months, last LSR 2026-08-07) | Within 72 h of event | "Saw the wind damage reports around {{town}}. We have {{product}} in stock at {{branch}} with next-day job-site delivery." (stock and delivery are `seller.*` facts) |
| **Season ramp** | Calendar (Mar–Apr) | Pre-season | Set up or refresh credit **before** the rush. Confirm delivery windows |
| **Rewards proof deadline** | Calendar (Jan–Mar; deadline 3/31 `[S7]`) | Q1 | Auto-submit offer (if true) |
| **Manufacturer price increase** | Manual or seller feed (`seller.price_notice`) | Usually announced weeks ahead (**ASSUMPTION**) | Pre-buy / lock-in offer. Distributors usually pass increases through `[S1]` |
| **Product shortage / allocation** | Seller feed | Irregular (2021–22 was the last big wave `[S1]`) | "We have allocation on X". Highest-conversion moment for switching (**inferred**) |
| **New branch, acquisition or competitor change** | Seller feed + public M&A (e.g. Passaic Metal → Beacon, Aug 2024 `[S1]`) | When it happens | "Now delivering to {{area}} from our new {{branch}}" / discovery question about current supplier |
| **Tier upgrade or President's Club award** | `audit_events` rows with `action='updated'` whose `changes` include `tier` or `presidents_club_stars` (needs a second scrape) | On detection | Congratulate, mention the rewards-rate change (cited), offer system stock |
| **New to GAF directory** | `first_seen_at` within 90 days | On detection | Early-relationship play before a competitor locks them in |
| **Review velocity spike** | Δ `review_count` / Δ Google `user_ratings_total` per month | Monthly | Growth signal. Raise Capacity and Timing |
| **Hiring / new services / new trucks** | Website diff, job boards (future) | Monthly | "Expanding into {{service}}? We stock it." |
| **Entity or licence change** | NY DOS / NYC DCWP refresh | Monthly | Status change → risk re-check before credit |

**Objections the brief should prepare for (ASSUMPTION, typical):** "Happy with my current supplier" (→ ask to be the **second source** for shortages and storm surges). "You're more expensive" (→ total cost: delivery, rooftop loading, Rewards admin, no price claims). "I have a credit line elsewhere" (→ a second line is insurance for peak season, subject to approval). "My supplier already delivers to the roof" (→ ask about lead times in peak season and small-lot or NYC drops).

---

## 6. Seasonality in NY/NJ

```
        Jan   Feb   Mar   Apr   May   Jun   Jul   Aug   Sep   Oct   Nov   Dec
Demand  ▁     ▁     ▂     ▄     ▆     ▇     ▇     ▇     ▇     ▆     ▄     ▂
Install  cold: shingles need ≥50°F to seal [S9] ──►  peak re-roof season  ──► wind-down
Storms  nor'easters ─────────►            thunderstorm wind ──────────► tropical remnants / nor'easters
Rep     PLAN + OPEN ACCOUNTS  ──► service, storm response, share gains ──► pre-buy, next-yr plan
Hooks   Rewards proofs due 3/31 [S7] · credit setup · pre-season stock   · price-increase pre-buys
```

| Fact | Source | Product implication |
|---|---|---|
| Distributor sales and income peak in Q2–Q4. **Q1 is lowest**, and past-due receivables rise in winter | `[S1]` | Default list sort in Q1 = "open new accounts / credit apps". Risk weight up in winter |
| **3 hail vs 265 wind (≥58 kt) events** across 17 counties, 24 months. 319 roof-relevant events in total. 158 NWS storm reports Jul–Oct 2026 | `[MD]` (NOAA NCEI, IEM LSR) | Storm = **timing** trigger, not a segment boost. Restoration is a tag |
| Last federal weather disaster in most counties: **Hurricane Ida remnants, Sept 2021**. Nassau, Westchester, Kings: Jan 2024 storm/flood | `[MD]` (FEMA) | Use for context, not urgency |
| Housing stock: 46–85% pre-1980 homes (16 of 17 counties ≥57%; Somerset is the outlier at 46%), median year built 1944–1982 | `[MD]` (ACS) | Constant re-roof demand. Typical asphalt roof life is ~25 years `[S9]` |
| Competitive density: owner-occupied homes per GAF contractor ranges from **~2.4k** (Bergen, Essex, Passaic) to **~21–24k** (Kings, Bronx, Rockland, Somerset). Manhattan is an outlier at ~97k, with 2 firms | `[MD]` | Show a "territory saturation" metric. Under-served areas suggest contractors with room to grow. **Caveat:** this counts contractors by HQ county, not by where they work. Bergen-based firms clearly work across the river |

---

## 7. Recommendations

### 7.1 Signals to add or weight in tagging and priority score

**Current state (read 05:15).** `leadmaker/tagging/rules.py` has a full rule set:
- **Tags:** about 25 kinds, each with `reason` and `source`.
- **Segments:** four (`strategic | growth | emerging | long_tail`).
- **Score:** an additive 0–100 `priority_score` from `WEIGHTS`: tier 25/17/10, log(reviews) up to 20, proximity up to 10, maturity, size and decision-maker up to 8 each, reputation up to 8, GAF Leads 4, President's Club 4, website 3, email 3, NYC licence 2.
- **Reasons:** the top-3 contributors go into a `priority_drivers` tag.
- **Tuning:** `custom_tags.py` already lets sales ops add rules with a `priority_boost` without a deploy.

So the proposal below is **a re-weighting and regrouping of the existing components, not a rewrite**. Five deltas:
- (a) Group the components into axes so the chips are meaningful.
- (b) `gaf_leads` → 0.
- (c) Shrink the flat tier bonus and add Winnability, so Risers can compete with MEs.
- (d) Add Timing and Risk, which are mostly missing today.
- (e) Move `WEIGHTS` into the same JSON/YAML file mechanism that `custom_tags` uses, keyed per seller or branch.

#### 7.1.1 Score shape

```
priority = 100 × clamp( 0.30·Capacity + 0.25·Fit + 0.20·Timing + 0.15·Reach + 0.10·Winnability − RiskPenalty , 0, 1)
```
Each axis is between 0 and 1. Each axis keeps its contributing components with a `reason` string, the way the existing tag dict already has `reason`. Weights live in YAML per **seller/branch** so they can be tuned without a deploy.

**How components combine within an axis.** The original draft left this unspecified. Use a weighted mean of the components, with bonuses added on top and the total capped at 1. For Capacity: `min(1, 0.35·tier + 0.30·reviews + 0.20·size + 0.15·tenure + 0.10·stars + 0.15·full_exterior)`. **Missing data counts as neutral 0.5 and the chip says "unknown"**, never 0. Otherwise every lead loses the same Fit points until seller branches exist, and NJ firms are penalised for having no NY DOS or DCWP record. **Sanity check on our DB `[DB]`**, using this Capacity and the segment rules in §7.1.2:
- `whale` (Capacity ≥0.75) = **55** firms: 49 ME, 5 Certified Plus, 1 Certified.
- `riser` (not ME and Capacity ≥0.5) = **107** firms: 69 Certified, 44 Certified Plus.

The whale list is the size of a manageable named-account list. The riser list is a quarter of all leads, so show it **sorted by score with a page size of 10**, not as a short list.

| Axis | Component (0–1) | Formula / mapping | Data source | Available now? |
|---|---|---|---|---|
| **Capacity** (0.30) | tier | ME 1.0 · Certified Plus 0.65 · Certified 0.4 | GAF | ✅ |
| | President's Club | +0.1 per star (cap 0.3), added on top of tier | GAF | ✅ |
| | review volume | `min(1, log10(1+n)/log10(500))` over max(GAF, Google) count | GAF, Google Places | ✅ |
| | size | `More than 5` 1.0 · `1-5` 0.35 · unknown 0.5 | GAF profile | ✅ (37%) |
| | tenure | `min(1, years/15)` | GAF `in_business_since`, NY DOS filing date | ✅ partial |
| | full exterior | +0.15 if services include siding/gutters/windows | website + LLM | ✅ partial |
| **Fit** (0.25) | residential re-roof focus | 1.0 residential re-roof · 0.6 mixed · 0.3 commercial-only/new-build | LLM services | ✅ partial |
| | proximity | drive time to nearest **seller branch**: ≤20 min 1.0 · 20–40 0.6 · >40 0.2. Case-study fallback: haversine miles to branch lat/lng, ×1.3 for road distance | seller branches + routing | ❌ need `seller.branches`. Today `rules.py` scores distance from the **search origin** (10013), which is the wrong anchor |
| | system buyer | 1.0 if warranty/enhanced-warranty language on site or tier ≥ Certified Plus | website, GAF | ✅ |
| | specialty fit | +0.1 if Metal/Solar/FORTIFIED **and** seller stocks it | GAF specialties | ✅ (sparse) |
| **Timing** (0.20) | storm | wind/hail LSR in service counties in last 14 d → 1.0, 15–60 d → 0.5 | `[MD]` | ✅ (county level) |
| | listing change | tier upgrade / new stars / new to directory ≤90 d → 1.0 | `audit_events` | ⚠️ need a 2nd scrape |
| | growth | review velocity ≥ 2× territory median → 1.0 | scrape history | ⚠️ need ≥2 snapshots |
| | season | Jan–Mar: +0.2 to **net-new prospects only** (per `accounts` match). A flat boost to every prospect would not change their order among themselves. It only moves prospects above existing customers in Q1 | calendar + `accounts` | ✅ |
| **Reach** (0.15) | named decision-maker | owner/officer with confidence ≥0.6 → 1.0. Generic → 0.3. Mirrors the current `decision_maker` identified/weak tag | NY DOS, website, LLM | ✅ partial (138 contacts on 102 firms) |
| | direct channel | direct email or mobile 1.0 · main line 0.5 | website | ✅ partial |
| **Winnability** (0.10) | not a whale | Certified/Certified Plus with Capacity ≥0.5 → 1.0 (Riser). ME with ≥100 reviews → 0.4 (entrenched) | derived | ✅ |
| **Risk** (penalty ≤0.4) | entity inactive/dissolved | −0.4 | NY DOS | ✅ NY only |
| | very new + unlicensed | <2 yrs and no DCWP licence in NYC → −0.2 | DOS/DCWP | ✅ NYC only |
| | reputation | rating <4.0 with ≥20 reviews → −0.15 | GAF/Google | ✅ |
| | stale listing | not seen in latest scrape → −0.3 and flag "may have lost certification" | `last_seen_at` | ✅ |
| | out-of-area storm chaser | mailing address >100 mi and entity <1 yr → −0.2 | DOS + geocode | ⚠️ |

#### 7.1.2 Tags and segments (one primary segment drives the playbook, tags stack)

Keep the code's segment **names**, which `02-backend` and `03-frontend` already use, and change the **rules**. Add `riser` and `watch` as tags that work as list filters, so no schema, API or UI enum changes.

| Segment / tag | Rule (proposed) | Default play |
|---|---|---|
| `strategic` (= "whale") | Capacity ≥0.75 (typically ME, ≥100 reviews, >5 staff). **Not** "any ME", which is today's rule | Wallet-share expansion, second-source positioning, joint call with GAF TM |
| tag `riser` | Not ME, and (Capacity ≥0.5 or review velocity high or tier upgrade or new ≤90 d) | Open the account early: credit app, Rewards help, path to the next tier |
| `growth` / `emerging` / `long_tail` | Current rules, minus strategic | Standard nurture. Seasonal hooks |
| tag `watch` (overlay on any segment) | Risk ≥0.2 | Verify before credit. No outbound until checked. Hidden from the default list |

Stackable tags (many already exist in `rules.py` under other keys: `storm_insurance`, `multi_trade`, `premium_materials`, `specialty:*`, `decision_maker`, `state`. Reuse those keys rather than add synonyms): `storm_restoration`, `full_exterior`, `solar`, `metal`, `fortified`, `nyc_jobsite` (Manhattan/Brooklyn/Queens/Bronx means a delivery-constraint talking point), `presidents_club`, `tier_upgrade`, `new_in_directory`, `decision_maker_known`, `no_contact`, `stale_listing`, `nj` / `ny` (licensing regimes differ).

#### 7.1.3 Config sketch

```yaml
# config/scoring/seller_default.yaml  (versioned; score_version stored on each lead)
weights: {capacity: 0.30, fit: 0.25, timing: 0.20, reach: 0.15, winnability: 0.10}
capacity:
  tier: {master_elite: 1.0, certified_plus: 0.65, certified: 0.40}
  presidents_club_per_star: 0.10
  reviews_log_cap: 500
  size: {"More than 5": 1.0, "1-5": 0.35, null: 0.5}
  tenure_full_years: 15
timing:
  storm_days_hot: 14
  storm_days_warm: 60
  season_boost: {months: [1, 2, 3], value: 0.2}
risk:
  entity_inactive: -0.4
  stale_listing: -0.3
  low_rating: {below: 4.0, min_reviews: 20, value: -0.15}
segments:
  strategic: "capacity >= 0.75"
tags:
  riser: "tier != 'master_elite' and (capacity >= 0.5 or tier_upgraded_90d or new_in_directory_90d)"
  watch: "risk >= 0.2"
missing_value: 0.5             # neutral, shown as "unknown"
ignore: [gaf_leads_enrolled]   # == tier in current data; today WEIGHTS gives it +4
# Case study: evaluate these expressions with a tiny whitelist evaluator or reuse
# custom_tags.py's condition DSL ({"field","gte"}, {"all":[...]}), never eval().
```

#### 7.1.4 Explainability contract

Store `score_components: [{axis, key, value, weight, contribution, reason, evidence_ids[]}]` per lead. In the case study this fits in the existing `contractors.tags` JSON as a richer `priority_drivers` tag, so no migration is needed. The UI shows the top 3 positive and top 1 negative contributors as chips, e.g. "▲ Master Elite + 2★ President's Club", "▲ Wind reports in Union County, 9 days ago", "▼ No named decision-maker".

#### 7.1.5 Evolving to a learned model (production)

Once §7.3 logs about 200 or more opened/lost outcomes per region, fit a logistic or gradient-boosted model on the same components (features stay explainable), and **calibrate per branch**. Keep the rules score as a fallback and as a sanity check (AUC on a holdout). Version every change (`score_version`).

### 7.2 What the account brief and talking points should contain

The draft prompt (`docs/next-steps/prompts/account_brief.system.md`) already frames material availability, job-site delivery, credit and GAF benefits, and its grounding rules are strong. Domain additions:

| Brief section | Content | Grounding |
|---|---|---|
| **Header strip** | Name, tier + stars, segment chip (strategic/growth/emerging/long_tail, plus `riser`/`watch` badges), score with top-3 reasons, distance/drive time to serving branch, **est. wallet band** | facts + `score.component.*` + `seller.branches` |
| **Who they are (2–3 lines)** | Services (re-roof / restoration / full exterior / solar / metal), years in business, size band, service area | `x.services`, `gaf.*`, `dos.*` |
| **Why now** (0–3 items) | Fired triggers from §5 with date and source | `trigger.*` facts (add to fact sheet) |
| **Why us** (3 talking points) | One each on **delivery**, **availability/system stock** and **programme/credit**, chosen by segment. Example: riser → Rewards auto-submit + credit setup. Whale → second-source for peak/storm + rooftop delivery. `nyc_jobsite` → small-lot or rooftop drops | `seller.*` facts only |
| **GAF angle** | Tier-specific: their Rewards rate (cited), warranty they can offer, path to next tier | `gaf.tier`, `ref.gaf_rewards_rates` (add a static reference fact with a URL) |
| **Decision-maker + first touch** | Named owner/officer (confidence ≥0.6) or target role. Channel. Goal of the first touch (usually: 10-minute intro + credit app) | `contact.*` |
| **Discovery questions** (always) | Current supplier(s)? Squares/yr or roofs/week? Crews? Share of insurance work? Delivery pain (lead time, rooftop, NYC staging)? Credit terms today? Who submits your GAF Rewards proofs? Any manufacturer besides GAF? | from `missing` + domain list |
| **Objections + answers** | 2–3 from §5 list, tailored to segment | `seller.*` |
| **Risks / unknowns** | Stale listing, entity status, low rating, no contact, out-of-state address | `risk.*` |
| **Seasonal note** | One line keyed to month (Q1 open accounts / in-season storm / Q4 pre-buy) | `ref.calendar` |

**Seller profile facts the brief needs.** Without these the brief must fall back to discovery questions.
- **Already in the example `SELLER_PROFILE`** in `prompts/account_brief.system.md` (reuse these ids exactly): `seller.branches`, `seller.coverage`, `seller.delivery.rooftop`, `seller.delivery.window`, `seller.delivery.tracking`, `seller.stock.gaf`, `seller.stock.specialty`, `seller.credit` (always "subject to approval"), `seller.gaf_rewards` (auto-submit status).
- **Add:**
  - `seller.branches[].lat/lng`: structured data for the proximity axis, not just text.
  - `seller.delivery.nyc_small_lot`
  - `seller.gaf_tm_partnership`
  - `seller.credit.application_url`
  - `seller.digital` (online ordering)
  - `seller.private_label`
  - `seller.avg_ticket_per_square` (for the wallet band)
  - `seller.lapsed_after_days` (replaces the hard-coded 365)

**Hard "never say" list** (add to the validator): "top 2%" (unverified), any price or discount, any guaranteed credit outcome, claims about the contractor's current supplier, and the "storm chaser" label in customer-facing drafts (keep it as an internal risk flag only).

### 7.3 KPIs the product should track

**Three layers:**

| Layer | KPI | Definition | Source |
|---|---|---|---|
| **Adoption** | Weekly active reps; briefs opened/rep/week; median time spent on brief; 👍/👎 per brief section | Usage | app events |
| **Funnel** (prospect → account) | Time to first touch (assigned → first logged touch); contact rate; meeting rate; **credit apps sent / approved**; **new accounts opened** (first order); win rate by segment and by score decile; dismissal reasons | Stage changes | `lead_activity` + `lead_stage` (case study) → `activities`, `lead_states` (prod) |
| **Outcome** (needs ERP) | First-90-day revenue of opened accounts; **wallet share** (ERP sales ÷ est. wallet midpoint); reactivations; GM $ from product-originated accounts; attach rate | ERP sync | `account_metrics_monthly` |
| **Model health** | AUC / precision@20 of `priority` vs opened; calibration by branch; % leads with named DM; data freshness (days since last scrape/enrich); brief validator reject rate | Offline jobs | scores + outcomes |

**Reconcile with what exists.** The original draft proposed new `account_status` and `lead_activity` tables keyed on `contractors(id)`. That FK is wrong: the PK is `contractors.gaf_id` text. The tables also duplicated three designs that already exist:
- `accounts` in `db/schema.py`: the CRM import, with status, `owner_rep`, `annual_spend` and `last_order_at`.
- `lead_states` and `activities` in `02-backend.md` §3.
- `tenant_accounts` in `02-backend.md` §3.

**Use those, with the deltas below.**

```sql
-- PRODUCTION (02-backend schema; uuid ids, tenant-scoped). Deltas only.
-- 1. Funnel stages: extend lead_states.status (02 has new→researching→contacted→qualified→customer/disqualified/nurture)
ALTER TABLE lead_states DROP CONSTRAINT IF EXISTS lead_states_status_check;
ALTER TABLE lead_states ADD CONSTRAINT lead_states_status_check CHECK (status IN
  ('new','researching','contacted','engaged','credit_app_sent','credit_approved','opened',  -- opened = first order
   'disqualified','nurture'));
ALTER TABLE lead_states ADD COLUMN stage_changed_at timestamptz NOT NULL DEFAULT now(),
                        ADD COLUMN score_at_assign numeric, ADD COLUMN score_version text,
                        ADD COLUMN est_wallet_band text, ADD COLUMN est_wallet_basis jsonb;
-- 2. activities.kind gains: brief_opened, visit, joint_call, credit_app_sent, credit_app_approved,
--    first_order, dismissed(reason), brief_feedback(payload: {section, thumbs})
-- 3. New, ERP-fed:
CREATE TABLE account_metrics_monthly (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, month date NOT NULL,
  sales numeric, gross_margin numeric, squares numeric, accessory_sales numeric, past_due numeric,
  PRIMARY KEY (tenant_id, company_id, month)
);
```

```sql
-- CASE STUDY (SQLite/Postgres via SQLAlchemy Core, next to existing tables). One table + 3 columns.
CREATE TABLE lead_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gaf_id      VARCHAR(32) NOT NULL REFERENCES contractors(gaf_id) ON DELETE CASCADE,
  rep         VARCHAR(128) NOT NULL,      -- free text until auth exists
  kind        VARCHAR(32)  NOT NULL,      -- call|email|visit|credit_app_sent|credit_approved|first_order|dismissed|brief_feedback|stage_change
  outcome     VARCHAR(32),                -- connected|voicemail|no_answer|meeting_set|not_interested
  reason      VARCHAR(64),                -- dismissal/loss reason (enum in app)
  payload     JSON,                       -- {stage_from, stage_to, score, section, thumbs}
  occurred_at TIMESTAMP NOT NULL
);
CREATE INDEX ix_lead_activity_gaf ON lead_activity (gaf_id, occurred_at);
-- contractors gains: lead_stage VARCHAR(32) DEFAULT 'new', lead_owner VARCHAR(128), stage_changed_at TIMESTAMP
-- (or a 1:1 lead_states table). "Existing / lapsed / net-new" comes from the accounts match, not a new column.
```

**Case-study scope (1–2 days):** the table and columns above, one-click logging in the UI, and a small "My week" panel showing touches, credit apps and opened accounts. Note in the README that the ERP-dependent KPIs light up once `account_metrics_monthly` is synced.

---

## 8. Open questions to validate with a real rep (30-minute interview)

1. How are territories cut: branch radius, ZIP lists, or named accounts? Do whales sit with key-account managers?
2. What does "opened account" mean in their CRM: approved credit, or first invoice?
3. Real average $ per square and typical squares per job in NYC vs suburban NJ?
4. Is the distributor on GAF's Rewards auto-submit list? Do they co-sell with GAF territory managers?
5. Which signal predicts a win best in their experience: tier, size, relationship with the owner, or a recent supplier failure?
6. NYC delivery reality: rooftop loading on attached homes, permits, and the time-of-day restrictions that matter?

## 9. Open questions & risks (red-team, 05:20 EDT)

| # | Risk / open question | Why it matters | Mitigation |
|---|---|---|---|
| 1 | **Every weight and threshold here is hand-set and unvalidated.** That includes the axis weights, the 0.75/0.5 cutoffs and the $/square figures | A confident-looking score could still be wrong. With 424 leads and no outcomes, the case study cannot measure accuracy | Show reasons, not just the number. Store `score_version`. Log outcomes from day one (§7.3). Make it explicit that the score is a ranking aid, not a prediction |
| 2 | **Three docs model lead status three ways**: `accounts` in code, `lead_states`/`tenant_accounts` in `02`, and this doc's original DDL | Building against the wrong one means rework | §7.3 now treats `02`'s design as canonical and keeps only deltas. Whoever implements must pick one, either `contractors` columns or a 1:1 table, for the SQLite build |
| 3 | **Re-scoring changes the ranking reps already see**. Today 44 of the top 50 are ME, and after the change MEs will fall below Risers | A demo reviewer may read "Master Elite isn't on top" as a bug | Show both lists (Strategic, Risers) in separate tabs. Add a "why this rank" popover and, for a demo, a before/after comparison |
| 4 | **Timing and Growth signals need history**: a second scrape, review deltas and storm refreshes | In the case study the Timing axis is mostly calendar plus county storms, so it is weak | Schedule a re-scrape (the `schedules` table exists). Until then, label Timing "limited data" rather than hide it |
| 5 | **The storm signal is by county and by HQ.** Contractors work outside their HQ county, and LSR wind reports are point events | Two firms in the same county get identical Timing. The boost may fire for a firm that doesn't work where the storm hit | Production: use a service-area polygon (website ZIP lists plus review locations) and a distance-weighted LSR count |
| 6 | **Coverage for risk signals is uneven by state.** NY DOS and NYC DCWP cover NY only, and 291 of the 424 leads are in NJ | NJ firms escape risk penalties, or are penalised for missing data if unknown counts as 0 | Unknown = neutral (§7.1.1). Add NJ sources: the NJ Division of Consumer Affairs HIC registration and NJ business entity status |
| 7 | **Wallet band inputs** (crews, roofs/week, $/square) are assumptions with roughly 4× spread | Reps may anchor on the band | Always show it as a band with the method popover. Overwrite it with `accounts.annual_spend` or rep input when known |
| 8 | **The "top 2%" claim and ME entry criteria are unverified** (gaf.com certification page checked 05:15; neither appears there) | An LLM brief could repeat folklore | Keep them on the validator's never-say list until a GAF URL is cited |
| 9 | **Using GAF Rewards as a talking point depends on the seller being GAF-approved for auto-submit** | It is a false promise if the seller is not approved | Gate it on `seller.gaf_rewards`. The prompt already requires a `seller.` citation for any promise |
| 10 | **Rep and territory model** (radius vs ZIP list vs named accounts) is an ASSUMPTION | It decides the default list filter and how Riser/Strategic lists are split between reps | This is §8 Q1. Until then, default to "nearest branch" assignment |

## Sources

- `[S1]` Beacon Roofing Supply (now QXO Building Products), Form 10-K for FY2024 (filed 2025-02-27): market size, re-roof share, customers, fleet, competitive factors, seasonality, bad debt, NJ/NY acquisitions. https://www.sec.gov/Archives/edgar/data/1124941/000112494125000021/becn-20241231.htm
- `[S2]` The Home Depot, Form 10-K for FY2025 (filed 2026-03-18): SRS >1,250 locations incl. GMS. SRS lines of business. Acquisition dates. https://www.sec.gov/Archives/edgar/data/354950/000162828026019436/hd-20260201.htm
- `[S3]` Wikipedia, "ABC Supply": ~970 branches (2024), $20.4B revenue (2023), largest roofing and siding wholesale distributor. https://en.wikipedia.org/wiki/ABC_Supply
- `[S4]` Wikipedia, "Beacon Roofing Supply" / "QXO": QXO acquisition Apr 2025 (~$11B), Kodiak (closed Apr 2026, $2.25B), TopBuild (closed Jul 2026, ~$17B), ~1,150 locations. https://en.wikipedia.org/wiki/Beacon_Roofing_Supply and https://en.wikipedia.org/wiki/QXO
- `[S5]` Wikipedia, "Home Depot": SRS acquisition ($18.25B, Mar 2024). GMS acquisition (~$4.3B, 2025). https://en.wikipedia.org/wiki/Home_Depot
- `[S6]` Wikipedia, "GAF Materials Corporation": leading North American roofing manufacturer. Sold via ABC Supply, Home Depot, Lowe's. https://en.wikipedia.org/wiki/GAF_Materials_Corporation
- `[S7]` GAF, "GAF Rewards": rates by tier (1.5% / 1.0% / 0.5%), proof deadline "March 31st of the year following the purchase date, or earlier for special promotions", "have a GAF-approved distributor submit them on your behalf", distributor "auto-submit" sign-up. https://www.gaf.com/en-us/for-pros/contractors/rewards (fetched 2026-10-18; re-verified by red-team 05:15)

**Red-team spot-checks (05:15 EDT).** Verified verbatim:
- `[S1]`: >$35B market, ~70/30 residential split, re-roofing ~80%, >$25B complementary products, ~110,000 customers, bad debt 0.12% of net sales, payment within 30 days (60 for non-residential), past-due receivables rising in winter, Passaic Metal (Aug 1 2024, NJ and NY, 9 branches).
- `[S7]`: rates and deadline.
- `[S9]`: 50 °F / 10 °C and ~25-year life.
- `[S10]`: ≥40% off WeatherHub and 50-year non-prorated coverage. The certification page also does not contain "2%".
- `[S3]`: 970 locations and $20.4B for 2023. The year of the branch count is not stated.
- `[S5]`: GMS ~$4.3B, closed Sept 2025.
- `[MD]`: 3 hail / 265 wind events confirmed. The pre-1980 range was corrected from 57–85% to 46–85%.
- `[DB]`: tier counts, average reviews, 43 of 85 MEs with ≥100 reviews, 184 of 276 Certified with <10 reviews, and `gaf_leads` = ME were all confirmed. Coverage counts were refreshed, since enrichment is still running.
- `[S8]` GAF residential contractor locator: tier and award definitions, warranty entitlements, "minimum amount of GAF products" disclosure. https://www.gaf.com/en-us/roofing-contractors/residential (fetched 2026-10-18)
- `[S9]` Wikipedia, "Asphalt shingle": ≥50 °F (10 °C) application for sealing, ~25-year typical life. https://en.wikipedia.org/wiki/Asphalt_shingle
- `[S10]` GAF, "Become a GAF Certified Roofer": certification benefits (Rewards, enhanced warranties, ≥40% off WeatherHub, QuickMeasure/ScopeConnect pricing). https://www.gaf.com/en-us/for-pros/contractors/roofer-certification (fetched 2026-10-18)
- `[DB]` `data/leadmaker.db` (queried on a scratch copy): 424 contractors, tier, stars, reviews, employee range, enrichment counts.
- `[MD]` `research/market_demand/out/county_summary.csv` and `talking_points_by_county.json`: NOAA NCEI Storm Events, IEM/NWS Local Storm Reports, FEMA declarations, Census ACS, Census BPS for the 17 counties in the search radius.
