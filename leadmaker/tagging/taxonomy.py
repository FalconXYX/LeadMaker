"""Lookups and thresholds for tagging. Calibrated on the 424 GAF leads around 10013 (Oct 2026):

reviews: 0 -> 196, 1-9 -> 27, 10-49 -> 61, 50-199 -> 98, 200+ -> 42
tiers:   Master Elite 85 (avg 161 reviews), Certified Plus 63 (66), Certified 276 (46)
age:     242 known; median ~12 yrs; 43 under 5 yrs
GAF contractor-id magnitude was tested as a "recently listed" proxy and rejected
(ids >= 7M average 28 years in business), so it is not used.
"""

from __future__ import annotations

REVIEW_BANDS = [(0, "none", "No reviews"), (1, "low", "1-9 reviews"), (10, "moderate", "10-49 reviews"),
                (50, "high", "50-199 reviews"), (200, "very_high", "200+ reviews")]

MATURITY_BANDS = [(0, "new", "New (<3 yrs)"), (3, "young", "3-9 yrs in business"),
                  (10, "established", "10-24 yrs in business"), (25, "veteran", "25+ yrs in business")]

DISTANCE_BANDS = [(5, "0-5", "Within 5 mi"), (10, "5-10", "5-10 mi"), (25, "10-25", "10-25 mi")]

TIER_LABELS = {"master_elite": "GAF Master Elite", "certified_plus": "GAF Certified Plus",
               "certified": "GAF Certified", "none": "Not GAF certified"}

GAF_SPECIALTIES = {"SOLAR": ("solar", "Solar"), "METAL": ("metal_roofing", "Metal roofing"),
                   "FORTIFIED": ("fortified", "FORTIFIED roofs (storm-rated)")}

SERVICE_LABELS = {
    "roof_replacement": "Roof replacement", "roof_repair": "Roof repair", "flat_roofing": "Flat roofing",
    "slate_roofing": "Slate", "metal_roofing": "Metal roofing", "tile_roofing": "Tile roofing",
    "shingle_roofing": "Shingles", "siding": "Siding", "gutters": "Gutters", "windows": "Windows",
    "skylights": "Skylights", "chimney": "Chimney", "masonry": "Masonry", "waterproofing": "Waterproofing",
    "insulation": "Insulation", "solar": "Solar", "commercial_roofing": "Commercial roofing",
    "storm_damage": "Storm damage", "insurance_claims": "Insurance claims", "inspections": "Inspections",
    "emergency_service": "Emergency service", "general_contracting": "General contracting",
    "tpo_roofing": "TPO roofing", "single_ply_roofing": "Single-ply (TPO / EPDM / PVC)",
    "new_construction": "New construction",
}
# A service that implies broader ones (TPO is a single-ply membrane, single-ply is low-slope), so the
# LLM path, which may emit only the narrow key, still lands in the broader filters.
SERVICE_IMPLIES = {"tpo_roofing": {"single_ply_roofing", "flat_roofing"}, "single_ply_roofing": {"flat_roofing"}}
COMMERCIAL_SERVICES = {"commercial_roofing", "flat_roofing", "tpo_roofing", "single_ply_roofing"}
STORM_SERVICES = {"storm_damage", "insurance_claims", "emergency_service"}
MULTI_TRADE_SERVICES = {"siding", "gutters", "windows", "masonry", "general_contracting", "skylights"}
PREMIUM_MATERIALS = {"slate_roofing", "metal_roofing", "tile_roofing"}

# Work types, emitted as stackable `work_type:<key>` tags for the weather timing layer:
# new-build crews lose days to rain/cold lulls; storm/emergency crews get busy after severe weather.
# key -> (label, services that imply it, why it matters for timing)
WORK_TYPES = {
    "new_construction": ("New-build work", {"new_construction"},
                         "new construction is weather-sensitive: lulls delay schedules and material orders"),
    "storm_emergency": ("Storm / emergency repair", STORM_SERVICES,
                        "storm and emergency repair demand spikes during and after severe weather"),
}

# NYC boroughs and nearby NY regions by city name as GAF lists it.
QUEENS = {"astoria", "flushing", "jamaica", "long island city", "little neck", "bayside", "maspeth",
          "ridgewood", "woodside", "corona", "elmhurst", "jackson heights", "forest hills", "rego park",
          "howard beach", "ozone park", "richmond hill", "south richmond hill", "fresh meadows",
          "college point", "whitestone", "far rockaway", "rockaway park", "queens village", "hollis",
          "st. albans", "saint albans", "springfield gardens", "cambria heights", "rosedale", "laurelton",
          "kew gardens", "middle village", "glendale", "east elmhurst", "woodhaven", "oakland gardens",
          "bellerose", "glen oaks", "arverne", "south ozone park"}
NY_REGIONS = {"brooklyn": "Brooklyn", "bronx": "Bronx", "staten island": "Staten Island",
              "new york": "Manhattan", "manhattan": "Manhattan"}
WESTCHESTER = {"yonkers", "new rochelle", "mount vernon", "white plains", "scarsdale", "mamaroneck",
               "port chester", "rye", "harrison", "eastchester", "tuckahoe", "pelham", "bronxville",
               "ardsley", "dobbs ferry", "hastings on hudson", "elmsford", "tarrytown", "larchmont"}
ROCKLAND = {"tappan", "nyack", "orangeburg", "pearl river", "nanuet", "spring valley", "new city",
            "west nyack", "blauvelt", "sparkill", "piermont", "valley cottage", "congers", "suffern"}
NY_ZIP3 = {"110": "Nassau County (LI)", "115": "Nassau County (LI)", "118": "Nassau County (LI)",
           "117": "Suffolk County (LI)", "119": "Suffolk County (LI)", "104": "Bronx", "112": "Brooklyn",
           "103": "Staten Island", "100": "Manhattan", "101": "Manhattan", "102": "Manhattan",
           "113": "Queens", "114": "Queens", "116": "Queens", "105": "Westchester", "106": "Westchester",
           "107": "Westchester", "108": "Westchester", "109": "Rockland/Orange"}
# NJ by USPS sectional center (approximate county areas).
NJ_ZIP3 = {"070": "Essex/south Bergen area", "071": "Essex/Newark area", "072": "Union/Elizabeth area",
           "073": "Hudson/Jersey City area", "074": "Passaic area", "075": "Passaic/Paterson area",
           "076": "Bergen/Hackensack area", "077": "Monmouth area", "078": "Morris/Sussex area",
           "079": "Morris/Union (Summit) area", "080": "South Jersey", "081": "South Jersey",
           "085": "Mercer/Trenton area", "086": "Mercer/Trenton area", "087": "Ocean area",
           "088": "Middlesex/Somerset area", "089": "Middlesex/New Brunswick area"}
NYC_REGIONS = {"Manhattan", "Brooklyn", "Bronx", "Queens", "Staten Island"}

# Legacy title list (kept for importers); rules.py now classifies contacts with CONTACT_ROLE_PATTERNS.
DECISION_MAKER_TITLES = ("owner", "co-owner", "founder", "co-founder", "president", "ceo", "chairman",
                         "principal", "partner", "managing member", "general manager", "vice president", "coo",
                         "company officer")

# Contact roles by title (matched case-insensitively on the full title, including source notes such
# as "Company officer (FMCSA MCS-150)" or "Service-of-process contact (NY DOS filing; often the LLC's
# owner)"). A title can carry several roles ("Owner / Office Manager"); the most preferred one for the
# company's size wins.
# "Vice President of Sales" is sales, not owner, and a COO is operations, not a generic "officer".
CONTACT_ROLE_PATTERNS = {
    "owner": r"owner|founder|(?<!vice )(?<!vice-)\bpresident\b|\bceo\b|chief executive|chairman|principal|\bpartner\b"
             r"|managing (?:member|partner|director)|proprietor|\bofficer\b(?<!operating officer)"
             r"|\b(?:vice[- ]president|vp)\b(?!\s+(?:of|for)\b)",
    "purchasing": r"purchas|procurement|\bbuyer\b|materials? (?:manager|coordinator)|supply",
    # "Account Manager" is a sales title; only accounts payable/receivable/accounting is office work.
    "office": r"\boffice\b|admin|bookkeep|controller|accounts? (?:payable|receivable)|accounts manager|accounting"
              r"|\bcfo\b|chief financial",
    "operations": r"operations|\bops\b|\bcoo\b|chief operating|general manager|production manager",
    "project_manager": r"project (?:manager|coordinator)|estimator|superintendent|foreman|site manager|field manager",
    "sales": r"sales|marketing|business development|account (?:manager|executive)",
}
CONTACT_ROLE_LABELS = {
    "owner": "Owner", "purchasing": "Purchasing manager", "office": "Office manager",
    "operations": "Operations manager", "project_manager": "Project manager", "sales": "Sales", "other": "Other contact",
}
# Who a distributor rep should ask for, by company size. Small shops: the owner buys. Larger firms:
# purchasing / office (credit application, account setup) / operations / PMs place the orders, with the
# owner/officer as the next choice. Unknown size is treated as small.
_SMALL_PREF = ("owner", "operations", "office", "purchasing", "project_manager", "sales", "other")
_LARGE_PREF = ("purchasing", "office", "operations", "project_manager", "owner", "sales", "other")
CONTACT_ROLE_PREFERENCE = {"small": _SMALL_PREF, "unknown": _SMALL_PREF, "medium": _LARGE_PREF, "large": _LARGE_PREF}
# Roles that count as a decision-maker for the `decision_maker` tag (identified/weak/none), by size.
DECISION_MAKER_ROLES = {"small": {"owner", "operations"}, "unknown": {"owner", "operations"},
                        "medium": {"purchasing", "office", "operations", "project_manager", "owner"},
                        "large": {"purchasing", "office", "operations", "project_manager", "owner"}}
# Below this match confidence a contact is only a hint, never the chosen target.
MIN_TARGET_CONFIDENCE = 0.45
IDENTIFIED_CONFIDENCE = 0.6  # the existing "identified" bar
FALLBACK_ROLE = "owner"  # no named decision-maker -> ask for the owner on the company's main line
