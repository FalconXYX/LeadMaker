"""Crawl a contractor's own website and extract sales-relevant facts.

Runs after `website_discovery` (uses `LeadContext.best_website()`). Politely
fetches the homepage plus a handful of same-site pages picked by link
text/URL keywords (about, team, services, contact, ...), honouring robots.txt,
and extracts (see the data contract in `leadmaker.enrich.base`):

  pages[{url, title, text}]   cleaned main text, <=4000 chars/page, <=15000 total (LLM input)
  emails, phones              junk-filtered emails (same-domain first), normalised phones
  social{platform: url}       facebook, instagram, linkedin, youtube, x, tiktok, yelp, houzz, ...
  services[]                  canonical service taxonomy (see SERVICE_PATTERNS; incl. tpo_roofing,
                              single_ply_roofing, new_construction)
  service_areas[]             towns / counties / boroughs mentioned near "serving", "service area"
  founded_year                from "since 1998", "established in", "over 25 years" ...
  team_size_hint              e.g. "team of 25", "50+ employees", "10 crews"
  leadership[{name, title, evidence}]   heuristic decision-maker candidates

Extra keys (not part of the contract, informational): service_mentions,
founded_year_evidence, identity{phone_match, name_match}, pages_fetched,
robots_blocked, final_url.

Leadership is extracted with conservative heuristics (explicit name/title
co-occurrence, "founded by", team cards, JSON-LD); every hit keeps the
evidence snippet so a human or the downstream LLM step can verify it.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from typing import Any, ClassVar
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from selectolax.lexbor import LexborHTMLParser

from ..http import HttpClient, HttpError
from ..models import Contact, EnrichmentResult
from .base import Enricher, LeadContext
from .matching import name_similarity, phone_digits

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------------------
MAX_EXTRA_PAGES = 6
PAGE_TEXT_LIMIT = 4000
TOTAL_TEXT_LIMIT = 15000
MAX_HTML_CHARS = 1_500_000
MAX_EMAILS = 10
MAX_PHONES = 8
MAX_SERVICE_AREAS = 40
MAX_LEADERSHIP = 12
FETCH_TIMEOUT_S = 20.0
ROBOTS_UA = "*"

SEP = "\u2029"  # paragraph separator inserted at block boundaries before text extraction

BLOCK_TAGS = (
    "p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,br,tr,td,th,table,section,article,header,footer,nav,main,"
    "aside,address,blockquote,dd,dt,dl,figure,figcaption,form,label,option,button,hr,span.elementor-heading-title"
)
INLINE_SPACED = "a,span,button,strong,b,em,i,small,sup,sub,font,img,label"
DROP_TAGS = ["script", "style", "noscript", "svg", "template", "iframe", "canvas", "select", "object", "embed"]

# --------------------------------------------------------------------------------------
# Link selection
# --------------------------------------------------------------------------------------
# keyword -> (category, weight). Matched against the URL path and the link text.
LINK_KEYWORDS: dict[str, tuple[str, int]] = {
    "our-team": ("team", 12), "our team": ("team", 12), "team": ("team", 10), "staff": ("team", 10),
    "leadership": ("team", 12), "meet": ("team", 11), "owner": ("team", 11), "management": ("team", 9),
    "about-us": ("about", 9), "about us": ("about", 9), "about": ("about", 8), "who-we-are": ("about", 9),
    "who we are": ("about", 9), "our-story": ("about", 9), "our story": ("about", 9), "history": ("about", 7),
    "company": ("about", 6), "why-us": ("about", 4), "why choose": ("about", 4),
    "services": ("services", 7), "service": ("services", 5), "residential": ("services", 4),
    "commercial": ("services", 4), "what-we-do": ("services", 6), "what we do": ("services", 6),
    "roofing": ("services", 3),
    "contact": ("contact", 6), "careers": ("careers", 2), "jobs": ("careers", 1),
    "service-area": ("areas", 5), "service area": ("areas", 5), "areas-we-serve": ("areas", 5),
    "areas we serve": ("areas", 5), "locations": ("areas", 3),
}
# How many pages of each category we are willing to spend the page budget on.
CATEGORY_QUOTA = {"team": 2, "about": 2, "services": 2, "contact": 1, "areas": 1, "careers": 1}
SKIP_EXT = re.compile(r"\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mov|mp3|ico|xml|css|js)(?:$|\?)", re.I)
SKIP_PATH = re.compile(r"/(?:wp-admin|wp-login|cart|checkout|my-account|login|signin|feed|tag|author|category)/", re.I)
FALLBACK_PATHS = ("/about", "/about-us", "/contact", "/contact-us", "/services")

# --------------------------------------------------------------------------------------
# Social profiles
# --------------------------------------------------------------------------------------
SOCIAL_HOSTS: list[tuple[str, str]] = [
    ("facebook.com", "facebook"), ("fb.com", "facebook"), ("instagram.com", "instagram"),
    ("linkedin.com", "linkedin"), ("youtube.com", "youtube"), ("youtu.be", "youtube"),
    ("twitter.com", "x"), ("x.com", "x"), ("tiktok.com", "tiktok"), ("yelp.com", "yelp"),
    ("houzz.com", "houzz"), ("bbb.org", "bbb"), ("g.page", "google"), ("goo.gl", "google"),
    ("maps.app.goo.gl", "google"), ("nextdoor.com", "nextdoor"), ("angi.com", "angi"),
    ("angieslist.com", "angi"), ("homeadvisor.com", "homeadvisor"), ("thumbtack.com", "thumbtack"),
    ("pinterest.com", "pinterest"),
]
SOCIAL_SHARE = re.compile(
    r"sharer|/share|intent/|/dialog/|/plugins/|pin/create|shareArticle|/tr\?|/hashtag/|/watch\?|/embed/|/p/|/reel/|/posts?/",
    re.I,
)

# --------------------------------------------------------------------------------------
# Emails / phones
# --------------------------------------------------------------------------------------
EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,62}\.)+[A-Za-z]{2,24}(?![\w-])")
JUNK_EMAIL_DOMAINS = {
    "example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "yoursite.com", "website.com",
    "test.com", "mysite.com", "company.com", "sentry.io", "wixpress.com", "sentry.wixpress.com",
    "sentry-next.wixpress.com", "wix.com", "squarespace.com", "godaddy.com", "your-domain.com", "address.com",
    "mail.com", "site.com", "yourcompany.com", "ingest.sentry.io",
}
JUNK_EMAIL_LOCALS = {"you", "your", "name", "user", "email", "example", "john.doe", "johndoe", "jane.doe",
                     "firstname.lastname", "first.last", "username", "someone", "test"}
FILE_SUFFIX = re.compile(r"\.(?:png|jpe?g|gif|svg|webp|bmp|ico|css|js|tiff?)$", re.I)
PHONE_RE = re.compile(r"(?<![\d\w])(?:\+?1[\s.\-]?)?(\(?)([2-9]\d{2})(\)?)([\s.\-]{0,2})([2-9]\d{2})([\s.\-])(\d{4})(?![\d])")

# --------------------------------------------------------------------------------------
# Services taxonomy: canonical -> regex (case-insensitive, matched on page text)
# --------------------------------------------------------------------------------------
SERVICE_PATTERNS: dict[str, str] = {
    "roof_replacement": r"roof(?:ing)?\s+replacements?|re-?roof|new roofs?\b|roof(?:ing)?\s+install|full roof|tear[- ]?off",
    "roof_repair": r"roof(?:ing)?\s+repairs?|leak(?:ing)?\s+repairs?|roof leaks?|leaky roof",
    "shingle_roofing": r"asphalt shingles?|shingle roof|\bshingles?\b|architectural shingles?|timberline",
    "flat_roofing": r"flat roof|\bepdm\b|\btpo\b|modified bitumen|built[- ]up roof|rubber roof|torch[- ]?down|low[- ]slope|\bpvc roof",
    # TPO is the commodity single-ply membrane (GAF EverGuard, Carlisle, Firestone); a TPO roofer also
    # lands in single_ply_roofing, which adds EPDM / PVC. Bare "PVC" is mostly trim, gutters and windows
    # on these sites, so it only counts next to "roof"/"membrane" (lists like "TPO, EPDM, PVC" hit anyway).
    "tpo_roofing": r"\btpo\b|thermo-?plastic\s+(?:poly)?olefin",
    "single_ply_roofing": r"single[- ]ply|\bepdm\b|\btpo\b|thermo-?plastic\s+(?:poly)?olefin|rubber (?:roof|membrane)|"
                          r"\bpvc\s+(?:roof|membrane)|duro-?last|sarnafil|hypalon",
    # New-build work, not new roofs on existing homes ("new roof" is roof_replacement). "Builders" alone is
    # usually part of a company name ("Casey Builders") and "home builders" appears in "National
    # Association of Home Builders", so builder/developer work needs "for/with builders" or "custom home".
    "new_construction": r"\bnew[- ]constructions?\b|\bnew[- ]builds?\b|\bnewly[- ](?:built|constructed)\b|"
                        r"\bground[- ]up\s+(?:construction|builds?|projects?)\b|"
                        r"\bnew\s+(?:home|house|residential|commercial|building)\s+construction\b|"
                        r"\bcustom\s+home\s+(?:builders?|building|construction)\b|\bspec\s+homes?\b|"
                        r"\b(?:for|with)\s+(?:local\s+|area\s+)?(?:(?:homeowners?|architects?|contractors?)\s*(?:,|and|&)\s*)?"
                        r"(?:home\s*)?(?:builders|developers)\b|"
                        r"\bbuilders?\s+(?:and|&)\s+developers?\b|\b(?:real estate|property)\s+developers?\b|"
                        r"\bdevelopers?\s+(?:and|&)\s+(?:builders?|general contractors?)\b",
    "slate_roofing": r"\bslate\b",
    "metal_roofing": r"metal roof|standing seam|copper roof",
    "tile_roofing": r"\btile roof|clay tiles?|concrete tiles?|spanish tile",
    "cedar_roofing": r"cedar shakes?|wood shakes?|cedar roof",
    "commercial_roofing": r"commercial roof|commercial (?:projects|properties|buildings|clients|services)|industrial roof",
    "residential_roofing": r"residential roof",
    "siding": r"\bsiding\b|hardie|fiber cement|\bcladding\b",
    "gutters": r"\bgutters?\b|downspouts?|\bleaders?\b(?= and gutters| & gutters|/gutters)",
    "fascia_soffit": r"\bsoffits?\b|\bfascia\b",
    "windows": r"\bwindows?\b(?! cleaning)",
    "doors": r"\b(?:entry|front|storm|patio|garage) doors?\b|\bdoors\b",
    "skylights": r"skylights?",
    "chimney": r"chimney",
    "masonry": r"masonry|\bbrick ?work|\bstucco\b|re-?pointing|tuck ?pointing|\bconcrete\b|sidewalks?|\bstoops?\b",
    "waterproofing": r"waterproof",
    "insulation": r"insulation",
    "ventilation": r"ventilation|ridge vents?|attic fans?",
    "solar": r"\bsolar\b",
    "sheet_metal": r"sheet metal|flashing",
    "storm_damage": r"storm damage|hail damage|wind damage|hurricane",
    "insurance_claims": r"insurance (?:claims?|work|companies|adjusters?)|work with (?:your )?insurance",
    "inspections": r"\binspections?\b|roof assessment",
    "emergency_service": r"emergency|24/7|24 hours?|24-hour",
    "maintenance": r"roof maintenance|preventative maintenance|preventive maintenance|roof coatings?|\bcoatings?\b",
    "general_contracting": r"general contract|renovations?|remodel|home improvement|kitchens?\b|bathrooms?\b|basements?\b|additions?\b(?= to)",
    "decks": r"\bdecks?\b|decking|\bpatios?\b",
    "painting": r"\bpainting\b|\bpainters?\b",
    "carpentry": r"carpentry",
    "financing": r"financing|finance options|\bfinance\b",
}
SERVICE_RES = {k: re.compile(v, re.I) for k, v in SERVICE_PATTERNS.items()}
# Services a site may explicitly rule out ("we do not do new construction"). A match is dropped when
# the few words before it negate it; "not just / not only new construction" still counts.
NEGATABLE_SERVICES = {"new_construction"}
NEGATION_BEFORE = re.compile(r"(?i)(?:\b(?:do|does|will|can)\s+not|n['’]t|\bnot|\bno\s+longer|\bnever)\s+(?:[\w-]+\s+){0,2}$")
NOT_ONLY = re.compile(r"(?i)\b(?:just|only)\s+(?:[\w-]+\s+)?$")

# --------------------------------------------------------------------------------------
# Service areas
# --------------------------------------------------------------------------------------
KNOWN_PLACES = [
    # NYC boroughs and regions
    "Manhattan", "Brooklyn", "Queens", "Bronx", "The Bronx", "Staten Island", "Long Island", "Westchester",
    "Westchester County", "Nassau County", "Suffolk County", "Rockland County", "Orange County",
    "Putnam County", "Five Boroughs", "NYC", "New York City", "Tri-State Area", "Tri-State", "Hudson Valley",
    "North Jersey", "Northern New Jersey", "Central Jersey", "Central New Jersey", "South Jersey", "Jersey Shore",
    # NJ counties
    "Atlantic County", "Bergen County", "Burlington County", "Camden County", "Cape May County",
    "Cumberland County", "Essex County", "Gloucester County", "Hudson County", "Hunterdon County",
    "Mercer County", "Middlesex County", "Monmouth County", "Morris County", "Ocean County", "Passaic County",
    "Salem County", "Somerset County", "Sussex County", "Union County", "Warren County",
    # Fairfield CT (some NY contractors list it)
    "Fairfield County",
]
AREA_TRIGGER = re.compile(
    r"(?i)\b(?:proudly\s+)?(?:serving|serve[sd]?|servicing|service\s+areas?|areas?\s+(?:we\s+)?serve[d]?|"
    r"areas?\s+of\s+service|locations?\s+we\s+serve|communities\s+we\s+serve|throughout|covering)\b"
)
AREA_SPLIT = re.compile(r"\s*(?:,|;|/|•|·|\||\band\b|&|\bas well as\b|\bincluding\b)\s*")
AREA_STOP = {
    "our", "customers", "clients", "homeowners", "home", "homes", "the", "area", "areas", "community", "surrounding",
    "all", "roofing", "roof", "residential", "commercial", "business", "businesses", "property", "properties",
    "free", "estimate", "estimates", "call", "contact", "today", "us", "you", "your", "quality", "service",
    "services", "since", "years", "over", "more", "most", "many", "families", "needs", "satisfaction",
    "excellence", "integrity", "nearby", "towns", "cities", "neighborhoods", "region", "beyond", "entire",
    "state", "local", "with", "for", "from", "in", "of", "inc", "llc", "corp", "gaf", "certified", "master", "elite",
    "privacy", "policy", "terms", "sitemap", "home page", "learn", "read", "click", "here", "menu",
}
AREA_LIST_HEAD = re.compile(r"(?i)^(?:our\s+)?(?:service\s+areas?|areas?\s+(?:we\s+)?serve[d]?|communities\s+we\s+serve|locations?(?:\s+we\s+serve)?)\s*:?$")
PLACE_TOKEN = re.compile(r"^(?:[A-Z][a-zA-Z.'\-]*|of|on|the|upon)(?:\s+(?:[A-Z][a-zA-Z.'\-]*|of|on|the|upon)){0,3}$")
STATE_SUFFIX = re.compile(r",?\s+(?:NJ|NY|CT|PA|New Jersey|New York)\.?$")

# --------------------------------------------------------------------------------------
# Founded year / team size
# --------------------------------------------------------------------------------------
FOUNDED_YEAR_RE = re.compile(
    r"(?i)\b(?:since|established(?:\s+in)?|est\.?|founded(?:\s+in)?|in business since|started(?:\s+in)?|"
    r"opened(?:\s+(?:our\s+doors\s+)?in)?|incorporated(?:\s+in)?|dating back to|founded back in)\s*(?:in\s+)?"
    r"((?:18|19|20)\d{2})\b"
)
YEARS_RE = re.compile(
    r"(?i)\b(?:over|more than|nearly|almost|about|for|celebrating)?\s*(\d{1,3})\+?\s*(?:years?|yrs?)\s+"
    r"(?:of\s+)?(?:experience|in business|serving|in the (?:roofing )?(?:industry|business|trade)|of service|"
    r"of (?:combined )?experience|strong|of excellence|of quality|of roofing)"
)
NUMBER_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "a dozen": 12, "dozens": 24, "hundreds": 100,
}
_NUM = r"(\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a dozen)"
TEAM_SIZE_RES = [
    re.compile(rf"(?i)\bteam\s+of\s+(?:over\s+|more than\s+|nearly\s+)?{_NUM}\+?\s*(?:[a-z\-]+\s+){{0,2}}?"
               r"(?:professionals|employees|experts|roofers|craftsmen|workers|people|members|specialists|technicians|installers|contractors|men|staff)?\b"),
    re.compile(rf"(?i)\b(?:over\s+|more than\s+|nearly\s+)?{_NUM}\+?\s*(?:full[- ]time\s+|skilled\s+|experienced\s+|trained\s+|certified\s+|in-house\s+|dedicated\s+)?"
               r"(?:employees|staff members|workers|roofers|crews|installers|technicians|craftsmen|team members|installation crews|roofing crews|work crews)\b"),
]

# --------------------------------------------------------------------------------------
# Leadership extraction
# --------------------------------------------------------------------------------------
_UP = "A-ZÀ-ÖØ-Þ"
_LO = "a-zß-öø-ÿ"
_TOK = rf"(?:[{_UP}](?:[{_LO}]+|['’][{_UP}][{_LO}]+|[{_LO}]{{1,3}}[{_UP}][{_LO}]+)(?:-[{_UP}][{_LO}]+)?)"
_INIT = r"(?:[A-Z]\.)"
_SUFFIX = r"(?:,?\s+(?:Jr\.?|Sr\.?|II|III|IV))?"
NAME = rf"(?:{_TOK}(?:\s+(?:{_INIT}|{_TOK})){{1,3}}{_SUFFIX})"
_TITLE_ONE = (
    r"co[- ]?owners?|owner(?:\s*/\s*operator)?|co[- ]?founder|founder|president|vice[- ]president|"
    r"chief\s+(?:executive|operating|financial)\s+officer|ceo|coo|cfo|"
    r"vp(?:\s+of\s+(?:operations|sales|production|marketing))?|principal|managing\s+(?:partner|member|director)|partner|"
    r"general\s+manager|operations\s+manager|director\s+of\s+(?:operations|sales|production)|project\s+manager|"
    r"production\s+manager|sales\s+manager|office\s+manager|estimator|senior\s+estimator|chief\s+estimator|"
    r"sales\s+director|superintendent|foreman"
)
TITLES = rf"(?:(?:{_TITLE_ONE})(?:\s*(?:&|and|/|,)\s*(?:{_TITLE_ONE}))*)(?![\w'’])"
TITLE_RE = re.compile(rf"(?i)\b{TITLES}")
TITLE_LINE_RE = re.compile(rf"(?i)^(?:the\s+|our\s+)?(?P<title>{TITLES})(?:\s+(?:of|at)\s+[\w&.,' ]{{2,50}})?\.?$")
NAME_LINE_RE = re.compile(rf"^(?P<name>{NAME})$")
CAPS_NAME_LINE_RE = re.compile(r"^(?P<name>[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’\-]+(?:\s+[A-Z]\.?)?(?:\s+[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’\-]+){1,2})$")
# Quoted nicknames between name tokens: João “John” Souza, Frances "Frankie" Gutierrez, Robert (Bob) Smith.
NICKNAME_RE = re.compile(r"(?<=\w)\s+(?:[“\"‘'(][A-Za-zÀ-ÿ.\- ]{1,15}[”\"’')])\s+(?=[A-ZÀ-Þ])")

_NAME_THEN_TITLE = re.compile(
    rf"(?P<name>{NAME})\s*(?:,|–|—|-|\||:|\(|·|•)\s*(?:(?i:the|our|company|proud)\s+)?(?P<title>(?i:{TITLES}))"
    rf"|(?P<name2>{NAME})\s+(?i:is|was|serves as|has been)\s+(?i:the|our|a)\s+(?P<title2>(?i:{TITLES}))"
)
_TITLE_THEN_NAME = re.compile(rf"(?P<title>(?i:\b{TITLES}))\s*(?::|–|—|-|,)\s*(?P<name>{NAME})")
# "The president of the company John Quaregna", "Owner of ABC Roofing, John Smith"
_TITLE_OF_CO_NAME = re.compile(
    rf"(?P<title>(?i:\b{TITLES}))\s+(?i:of\s+(?:the\s+company|the\s+business|the\s+firm))\s*,?\s*(?P<name>{NAME})"
)
# Sentence-initial bare title followed by a name: "Owner João Souza brings ...", "President John Smith founded ..."
_LEAD_TITLE_NAME = re.compile(rf"(?:^|(?<=[.!?:])\s+)(?P<title>(?i:{TITLES}))\s+(?P<name>{NAME})")
_OUR_TITLE_NAME = re.compile(rf"(?i:\b(?:our|the|company|its)\s+)(?P<title>(?i:{TITLES}))\s+(?P<name>{NAME})")
_FOUNDED_BY = re.compile(
    rf"(?P<verb>(?i:\b(?:founded|started|established|created|owned(?:\s+and\s+operated)?|owned\s+&\s+operated|run|led|operated|headed)"
    rf"(?:\s+in\s+(?:18|19|20)\d{{2}})?\s+by))"
    rf"\s+(?:(?i:the\s+late\s+|brothers\s+|partners\s+))?(?P<name>{NAME})"
)
_NAME_FOUNDED = re.compile(rf"(?P<name>{NAME})\s+(?i:founded|started|established)\s+(?i:the\s+company|the\s+business|[A-Z][a-z]+)")
_MEET = re.compile(rf"(?:(?i:\bmeet)\s+(?:(?i:our\s+\w+,?\s+))?|(?i:\bmy\s+name\s+is)\s+|\bI['’]m\s+|\bI\s+am\s+)(?P<name>{NAME})")

# Tokens that can never be part of a person's name (lower-cased).
NAME_STOP = set(
    """
    roof roofs roofing roofer roofers replacement replacements repair repairs siding gutter gutters window windows door doors
    commercial residential service services construction contracting contractor contractors company co inc llc corp corporation
    group home homes improvement improvements free estimate estimates call contact us our about team the new york jersey
    county street st avenue ave road rd boulevard blvd drive dr lane ln court ct place pl suite highway hwy route rte parkway
    north south east west gaf master elite certified owner owners president manager managers read more learn view click privacy
    policy terms copyright all rights reserved google facebook instagram yelp review reviews best quality insurance storm
    damage emergency project projects gallery years experience family owned operated licensed insured monday tuesday
    wednesday thursday friday saturday sunday january february march april may june july august september october
    november december island city heights beach valley township borough park hills village estates manor
    shingle shingles slate metal flat tile cedar chimney masonry skylight skylights solar insulation waterproofing
    flashing leak leaks inspection inspections maintenance renovation renovations remodeling remodel kitchen bath bathroom
    basement deck decks painting carpentry exterior interior exteriors interiors general sales office operations
    welcome get started request quote quotes now today why choose meet founder founders partner partners principal
    ceo coo cfo vp director estimator foreman superintendent excellence award awards winner president's presidents club
    triple certification certifications accredited business bureau bbb angi homeadvisor houzz energy star owens corning
    certainteed timberline lifetime warranty warranties system systems plus pro pros professional professionals expert experts
    local trusted reliable affordable premier premium elite superior quality top rated leading custom total complete
    brooklyn queens manhattan bronx staten long newark paterson elizabeth clifton bayonne hoboken yonkers westchester bergen
    essex hudson passaic union morris middlesex monmouth nassau suffolk rockland ocean somerset mercer america american
    united states usa nj ny ct pa llc's mr mrs ms dr
    financing finance testimonials testimonial portfolio blog news faq faqs careers jobs apply hiring
    """.split()
)
NAME_STOP_PHRASES = {"real estate", "red bank", "jersey city", "union city", "west new york"}

TITLE_CANON = {"ceo": "CEO", "coo": "COO", "cfo": "CFO", "vp": "VP"}
TITLE_RANK = [
    ("owner", 10), ("founder", 9), ("president", 9), ("ceo", 9), ("chief executive", 9), ("principal", 8),
    ("managing partner", 8), ("managing member", 8), ("partner", 7), ("vice president", 6), ("vp", 6), ("coo", 6),
    ("chief operating", 6), ("cfo", 5), ("chief financial", 5), ("general manager", 5), ("director", 5),
    ("operations manager", 4), ("sales manager", 4), ("production manager", 4), ("project manager", 3),
    ("office manager", 3), ("estimator", 3), ("superintendent", 2), ("foreman", 2),
]
NON_EXEC_PRECEDERS = re.compile(r"(?i)(?:home|property|business|building|house|store|restaurant|land|condo|co-op|happy|satisfied|proud)\s*$")

# Common US first names (incl. names frequent in the NY/NJ trades). Used to weight name confidence,
# never as a hard filter on explicit name+title patterns.
FIRST_NAMES = set(
    """
    aaron abdul abraham adam adrian ahmed al alan albert alberto alejandro alex alexander alexandra alexis alfonso alfred
    alfredo ali alice alicia allen allison amanda amy ana anastasia andre andrea andreas andrew andrzej andy angel angela
    angelo ann anna anne anthony antonio april arnold arthur artur ashley barbara barry ben benjamin bernard beth betty
    bill billy bob bobby bogdan boris brad bradley brandon brenda brendan brian bruce bryan carl carla carlos carmen carmine
    carol caroline catherine charles charlie chris christian christina christine christopher chuck cindy claudia cody colin
    connor craig cristian cynthia dale damian dan dana daniel daniela danny dariusz darren dave david dawn dean debbie
    deborah denis dennis derek diana diane diego dimitri dimitrios domenic domenick dominic dominick don donald donna doug
    douglas dylan earl ed eddie edgar eduardo edward edwin elena eli elias elizabeth ellen emil emily emmanuel enrique eric
    erica erik erin ernest esteban eugene evan evelyn fabio felix fernando filip francesco francis francisco frank frankie
    fred freddy gabriel gail gary gene george georgios gerald gerard gerry gina giovanni giuseppe glenn gloria gonzalo
    grace greg gregory grzegorz gus guy hank harold harry hector heather helen henry hugo ian igor isaac ivan jack jackie
    jacob jaime james jamie jan jane janet jared jason javier jay jean jeff jeffrey jennifer jenny jeremy jerome jerry
    jesse jessica jesus jim jimmy joan joe joel joey john johnny jon jonathan jorge jose joseph josh joshua juan judith
    judy julia julian julie julio justin karen karl kate katherine kathleen kathy keith kelly ken kenneth kenny kevin kim
    kimberly krzysztof kurt kyle larry laura lauren lawrence lee leo leon leonard leonardo lisa liz lou louis lucas luigi
    luis luke lynn manny manuel marc marcin marco marcos marcus maria mariano marie mario mariusz mark marek martin marty
    marvin mary mateo matt matthew maurice max michael michal micheal michelle miguel mike milton mitchell mohamed
    mohammed monica nancy natalie nathan neil nelson nicholas nick nicholas nicola nicole nikolai nikos noah norman oleg
    oliver omar orlando oscar pablo pamela pasquale pat patricia patrick paul paula pawel pedro pete peter phil philip
    phillip piotr rachel rafael ralph ramon randy raul ray raymond rebecca ricardo richard rick ricky rob robert roberto
    robin rocco rodrigo roger roman ron ronald ronnie rosa rose ross roy ruben russell ruth ryan sal salvatore sam samuel
    sandra sandy santiago sara sarah scott sean sebastian sergei sergey sergio seth shane shannon sharon shawn sheila
    simon sophia spiro stan stanley stavros stefan stella stephanie stephen steve steven stuart susan suzanne sylvia
    tadeusz ted teresa terry theodore thomas tim timothy tina todd tom tomas tomasz tommy tony tracy travis troy tyler
    valentin valerie vanessa victor victoria vincent vincenzo vinny vito vladimir walter wayne wendy wesley william willie
    wojciech yuri yusuf zachary zbigniew
    """.split()
)


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------
def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def _bare(host: str) -> str:
    return host[4:] if host.startswith("www.") else host


def same_site(url: str, base_host: str) -> bool:
    h, b = _bare(_host(url)), _bare(base_host)
    return bool(h) and (h == b or h.endswith("." + b) or b.endswith("." + h))


def normalize_site(url: str) -> str:
    url = url.strip()
    if not re.match(r"(?i)^https?://", url):
        url = "https://" + url.lstrip("/")
    parts = urlsplit(url)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", parts.query, ""))


def canonical_url(url: str) -> str:
    url, _ = urldefrag(url)
    p = urlsplit(url)
    path = re.sub(r"/{2,}", "/", p.path or "/")
    if len(path) > 1:
        path = path.rstrip("/")
    return urlunsplit((p.scheme.lower(), _bare(p.netloc.lower()), path.lower(), p.query, ""))


def format_phone(raw: str) -> str | None:
    d = phone_digits(raw)
    if not d or d[0] in "01" or d[3] in "01" or len(set(d)) <= 2:
        return None
    return f"({d[:3]}) {d[3:6]}-{d[6:]}"


def decode_cfemail(hexstr: str) -> str | None:
    """Cloudflare email obfuscation: first byte is the XOR key for the rest."""
    try:
        data = bytes.fromhex(hexstr)
        key = data[0]
        return bytes(b ^ key for b in data[1:]).decode("utf-8")
    except (ValueError, IndexError, UnicodeDecodeError):
        return None


def clean_email(raw: str) -> str | None:
    e = raw.strip().strip(".,;:'\"()<>[]").lower()
    if e.startswith("mailto:"):
        e = e[7:]
    e = e.split("?")[0]
    if not EMAIL_RE.fullmatch(e):
        return None
    local, _, domain = e.rpartition("@")
    if FILE_SUFFIX.search(e) or "@2x" in raw or "@3x" in raw:
        return None
    if domain in JUNK_EMAIL_DOMAINS or any(domain.endswith("." + j) for j in JUNK_EMAIL_DOMAINS):
        return None
    if local in JUNK_EMAIL_LOCALS or re.fullmatch(r"[0-9a-f]{16,}", local):
        return None
    if domain.endswith((".png", ".jpg", ".gif", ".webp")):
        return None
    return e


def _norm_title(t: str) -> str:
    t = re.sub(r"\s+", " ", t.strip(" ,.-–—:|("))
    words = []
    for w in re.split(r"(\s+|/|&)", t):
        lw = w.lower()
        if lw in TITLE_CANON:
            words.append(TITLE_CANON[lw])
        elif lw in {"of", "and"}:
            words.append(lw)
        else:
            words.append(w[:1].upper() + w[1:].lower() if w.strip() else w)
    return "".join(words)


def title_rank(title: str | None) -> int:
    if not title:
        return 0
    t = title.lower()
    best = 0
    for key, r in TITLE_RANK:
        if key in t:
            best = max(best, r)
    if "vice" in t and best == 9:  # "Vice President" contains "president"
        best = 6
    return best


def clean_name(raw: str, strict: bool = False) -> str | None:
    """Trim stop tokens from both ends; return a validated 2-4 token person name or None.

    strict=True (whole-line team-card names): any stop token rejects the line instead of
    being trimmed, so "Licensed Special Rigger" does not become the "name" "Special Rigger".
    """
    raw = re.sub(r"\s+", " ", raw.replace("’", "'")).strip(" ,.-")
    raw = re.sub(r",?\s+(?:Jr\.?|Sr\.?|II|III|IV)$", "", raw)
    toks = raw.split(" ")
    if strict and any(t.lower().strip(".,'") in NAME_STOP for t in toks):
        return None
    while toks and (toks[0].lower().strip(".,'") in NAME_STOP or re.fullmatch(r"[A-Z]\.", toks[0])):
        toks.pop(0)
    while toks and (toks[-1].lower().strip(".,'") in NAME_STOP or re.fullmatch(r"[A-Z]\.?", toks[-1])):
        toks.pop()
    if not 2 <= len(toks) <= 4:
        return None
    if any(t.lower().strip(".,'") in NAME_STOP for t in toks):
        return None
    full = " ".join(toks)
    if any(p in full.lower() for p in NAME_STOP_PHRASES):
        return None
    if not all(re.fullmatch(r"[A-Z][A-Za-z'\-]*\.?", t) for t in toks):
        return None
    if len(toks[0]) < 2 or len(toks[-1]) < 2:
        return None
    return full


def name_key(name: str) -> str:
    toks = [t for t in name.lower().replace(".", "").split() if len(t) > 1]
    return f"{toks[0]} {toks[-1]}" if len(toks) >= 2 else " ".join(toks)


def _snippet(text: str, start: int, end: int, pad: int = 60) -> str:
    s, e = max(0, start - pad), min(len(text), end + pad)
    out = text[s:e].strip()
    return re.sub(r"\s+", " ", out)[:240]


# --------------------------------------------------------------------------------------
# Page parsing
# --------------------------------------------------------------------------------------
@dataclass
class ParsedPage:
    url: str
    title: str = ""
    meta_description: str = ""
    lines: list[str] = field(default_factory=list)  # full visible text (incl. nav/footer), one block per line
    main_lines: list[str] = field(default_factory=list)  # without nav/header/footer boilerplate
    links: list[tuple[str, str]] = field(default_factory=list)  # (absolute url, link text)
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)  # tel: links first, then text matches
    jsonld: list[Any] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def _lines(node: Any) -> list[str]:
    if node is None:
        return []
    raw = node.text(separator="", strip=False)
    out: list[str] = []
    for chunk in raw.split(SEP):
        line = re.sub(r"\s+", " ", chunk).strip()
        if line and re.search(r"[A-Za-z0-9]", line):
            out.append(line)
    return out


def parse_page(html: str, url: str) -> ParsedPage:
    html = html[:MAX_HTML_CHARS]
    tree = LexborHTMLParser(html)
    page = ParsedPage(url=url)
    t = tree.css_first("title")
    page.title = re.sub(r"\s+", " ", t.text()).strip() if t is not None else ""
    for m in tree.css("meta"):
        nm = (m.attributes.get("name") or m.attributes.get("property") or "").lower()
        if nm in ("description", "og:description") and not page.meta_description:
            page.meta_description = re.sub(r"\s+", " ", m.attributes.get("content") or "").strip()

    for s in tree.css('script[type="application/ld+json"]'):
        try:
            page.jsonld.append(json.loads(s.text(), strict=False))
        except (ValueError, TypeError):
            continue

    tel: list[str] = []
    for a in tree.css("a[href]"):
        href = (a.attributes.get("href") or "").strip()
        if not href:
            continue
        low = href.lower()
        if low.startswith("mailto:"):
            e = clean_email(href[7:])
            if e:
                page.emails.append(e)
            continue
        if low.startswith("tel:"):
            p = format_phone(href[4:])
            if p:
                tel.append(p)
            continue
        if low.startswith(("javascript:", "#", "data:", "sms:")):
            continue
        absu = urljoin(url, href)
        if absu.startswith(("http://", "https://")):
            text = re.sub(r"\s+", " ", a.text(separator=" ")).strip()
            page.links.append((absu, text[:100]))
    for node in tree.css("[data-cfemail]"):
        e = decode_cfemail(node.attributes.get("data-cfemail") or "")
        if e and (e := clean_email(e)):
            page.emails.append(e)

    body = tree.body
    if body is None:
        return page
    for tag in DROP_TAGS:
        for n in body.css(tag):
            n.decompose()
    for n in body.css(INLINE_SPACED):
        n.insert_before(" ")
        n.insert_after(" ")
    for n in body.css(BLOCK_TAGS):
        n.insert_before(SEP)
        n.insert_after(SEP)
    page.lines = _lines(body)
    text = "\n".join(page.lines)
    for m in EMAIL_RE.finditer(text):
        e = clean_email(m.group(0))
        if e:
            page.emails.append(e)
    text_phones = [format_phone(m.group(0)) for m in PHONE_RE.finditer(text)]
    page.phones = tel + [p for p in text_phones if p]

    # Boilerplate removal for the LLM-facing text.
    for sel in ("nav", "footer", '[role="navigation"]', '[role="contentinfo"]', "aside",
                ".menu", "#menu", ".navbar", ".nav-menu", ".site-footer", "#footer", ".cookie", "#cookie-notice"):
        for n in body.css(sel):
            n.decompose()
    for n in body.css("header"):
        if len(n.text(strip=True)) < 600:
            n.decompose()
    page.main_lines = _lines(body)
    return page


# --------------------------------------------------------------------------------------
# Extraction over parsed pages
# --------------------------------------------------------------------------------------
def score_link(url: str, text: str) -> tuple[str, int] | None:
    path = urlsplit(url).path.lower()
    hay_path = path.replace("_", "-")
    hay_text = text.lower()
    best: tuple[str, int] | None = None
    for kw, (cat, w) in LINK_KEYWORDS.items():
        hit = (kw in hay_text) or ("-" in kw or " " not in kw) and (kw.replace(" ", "-") in hay_path)
        if hit and (best is None or w > best[1]):
            best = (cat, w)
    if best and path.count("/") > 3:  # deep pages (blog posts etc.) are rarely what we want
        best = (best[0], best[1] - 3)
    return best


def choose_links(page: ParsedPage, base_host: str, limit: int = MAX_EXTRA_PAGES) -> list[tuple[str, str]]:
    """Pick up to `limit` same-site URLs worth fetching -> [(url, category)]."""
    home = canonical_url(page.url)
    scored: dict[str, tuple[int, str, str]] = {}
    for url, text in page.links:
        if not same_site(url, base_host) or SKIP_EXT.search(url) or SKIP_PATH.search(urlsplit(url).path + "/"):
            continue
        cu = canonical_url(url)
        if cu == home or urlsplit(url).query:
            continue
        s = score_link(url, text)
        if s is None:
            continue
        cat, w = s
        if cu not in scored or w > scored[cu][0]:
            scored[cu] = (w, cat, urldefrag(url)[0])
    ranked = sorted(scored.values(), key=lambda x: (-x[0], len(x[2])))
    used: Counter[str] = Counter()
    out: list[tuple[str, str]] = []
    for w, cat, url in ranked:
        if used[cat] >= CATEGORY_QUOTA.get(cat, 1):
            continue
        used[cat] += 1
        out.append((url, cat))
        if len(out) >= limit:
            break
    return out


def extract_social(pages: list[ParsedPage], jsonld_same_as: list[str]) -> dict[str, str]:
    social: dict[str, str] = {}
    candidates = [u for p in pages for u, _ in p.links] + jsonld_same_as
    for url in candidates:
        host = _bare(_host(url))
        if not host:
            continue
        for dom, platform in SOCIAL_HOSTS:
            if host == dom or host.endswith("." + dom):
                break
        else:
            if host.startswith("google.") or host.endswith(".google.com") or host == "google.com":
                if "/maps" in url or "cid=" in url or "/search" in url and "kgmid" in url:
                    platform = "google"
                else:
                    continue
            else:
                continue
        path = urlsplit(url).path
        if platform in social or SOCIAL_SHARE.search(url) and platform not in ("google", "yelp"):
            continue
        if platform != "google" and path.strip("/") == "":
            continue  # bare platform homepage (theme placeholder links)
        if platform == "goo.gl" and "/maps" not in url:
            continue
        social[platform] = url.split("#")[0]
    return social


def _negated(text: str, start: int) -> bool:
    # Same block only: page text is one block per line, so "Prices you can't beat" must not negate
    # a "New Construction" heading on the next line.
    before = text[max(0, start - 40): start].rsplit("\n", 1)[-1]
    return bool(NEGATION_BEFORE.search(before)) and not NOT_ONLY.search(before)


def extract_services(text: str) -> tuple[list[str], dict[str, int]]:
    """Canonical services found in `text` -> (services by mention count, {service: count}).

    Pure over text, so it also runs on the stored `pages[].text` of an old crawl (tagging re-scans
    it, so new patterns apply without re-crawling; recall is lower than a fresh crawl because the
    stored text drops nav/footer boilerplate and is capped at TOTAL_TEXT_LIMIT).
    """
    counts: dict[str, int] = {}
    for svc, rx in SERVICE_RES.items():
        if svc in NEGATABLE_SERVICES:
            n = sum(1 for m in rx.finditer(text) if not _negated(text, m.start()))
        else:
            n = len(rx.findall(text))
        if n:
            counts[svc] = n
    ordered = sorted(counts, key=lambda k: -counts[k])
    return ordered, counts


def _clean_area(part: str) -> str | None:
    p = part.strip(" .:-–—()\"'")
    p = re.sub(r"^(?:the\s+)?(?:towns?|cities|city|areas?|counties|county|boroughs?)\s+of\s+", "", p, flags=re.I)
    p = re.sub(r"^(?:and|or|in|of|all of|all|throughout|across|parts of|nearby)\s+", "", p, flags=re.I)
    p = STATE_SUFFIX.sub("", p).strip(" .,")
    if not p or len(p) < 3 or len(p) > 40:
        return None
    if not PLACE_TOKEN.match(p):
        return None
    toks = p.lower().split()
    if all(t in AREA_STOP for t in toks) or toks[0] in AREA_STOP:
        return None
    if any(t in {"roofing", "roof", "siding", "gutters", "windows", "services", "inc", "llc", "corp", "gaf"} for t in toks):
        return None
    return p


def extract_service_areas(lines: list[str]) -> list[str]:
    areas: list[str] = []
    seen: set[str] = set()

    def add(a: str | None) -> None:
        if a and a.lower() not in seen and len(areas) < MAX_SERVICE_AREAS:
            seen.add(a.lower())
            areas.append(a)

    # 1) Phrases after "serving ..." / "service area: ..."
    for line in lines:
        for m in AREA_TRIGGER.finditer(line):
            tail = line[m.end(): m.end() + 300]
            tail = re.split(r"(?<=[a-z])\.\s|[!?]|\s-\s|\s–\s", tail)[0]
            tail = re.sub(r"^\s*(?:in|the|all of|areas? of|:)\s+", "", tail, flags=re.I)
            for part in AREA_SPLIT.split(tail):
                add(_clean_area(part))
    # 2) Lists under a "Service Areas" heading (one place per line).
    for i, line in enumerate(lines):
        if AREA_LIST_HEAD.match(line):
            for nxt in lines[i + 1: i + 60]:
                if len(nxt) > 40 or AREA_LIST_HEAD.match(nxt):
                    break
                a = _clean_area(nxt)
                if a is None:
                    break
                add(a)
    # 3) Gazetteer: well-known boroughs/counties anywhere near a "serv" word.
    blob = "\n".join(lines)
    for place in KNOWN_PLACES:
        for m in re.finditer(rf"\b{re.escape(place)}\b", blob):
            ctx = blob[max(0, m.start() - 200): m.end() + 200].lower()
            if "serv" in ctx or "area" in ctx:
                add(place)
                break
    # Drop entries that are prefixes of longer ones ("Bergen" vs "Bergen County").
    return [a for a in areas if not any(o != a and o.lower().startswith(a.lower() + " ") for o in areas)]


def extract_founded(text: str, today: date | None = None) -> tuple[int | None, str | None]:
    year_now = (today or date.today()).year
    years: list[tuple[int, str]] = []
    for m in FOUNDED_YEAR_RE.finditer(text):
        y = int(m.group(1))
        if 1850 <= y <= year_now:
            ctx = text[max(0, m.start() - 40): m.start()].lower()
            if "copyright" in ctx or "©" in ctx:
                continue
            years.append((y, _snippet(text, m.start(), m.end(), 40)))
    if years:
        counts = Counter(y for y, _ in years)
        top = max(counts.values())
        best = min(y for y, c in counts.items() if c == top)
        return best, next(s for y, s in years if y == best)
    spans: list[tuple[int, str]] = []
    for m in YEARS_RE.finditer(text):
        n = int(m.group(1))
        if 1 <= n <= 120:
            spans.append((n, _snippet(text, m.start(), m.end(), 40)))
    if spans:
        n, s = max(spans, key=lambda x: x[0])
        return year_now - n, s
    return None, None


def extract_team_size(text: str) -> str | None:
    for rx in TEAM_SIZE_RES:
        for m in rx.finditer(text):
            num = m.group(1).lower()
            n = int(num) if num.isdigit() else NUMBER_WORDS.get(num, 0)
            if not 2 <= n <= 2000:
                continue
            phrase = re.sub(r"\s+", " ", m.group(0)).strip()
            if re.search(r"(?i)years?|stars?|reviews?|projects?|homes?", phrase):
                continue
            return phrase
    return None


@dataclass
class Leader:
    name: str
    title: str | None
    evidence: str
    url: str
    confidence: float


def _add_leader(found: dict[str, Leader], name: str | None, title: str | None, evidence: str, url: str,
                conf: float) -> None:
    if not name:
        return
    first = name.split()[0].lower().strip(".")
    if first not in FIRST_NAMES:
        conf -= 0.15
    if conf <= 0.2:
        return
    title = _norm_title(title) if title else None
    key = name_key(name)
    cur = found.get(key)
    if cur is None:
        found[key] = Leader(name, title, evidence, url, round(conf, 2))
        return
    better_title = title_rank(title) > title_rank(cur.title)
    if conf > cur.confidence or (better_title and conf >= cur.confidence - 0.1):
        cur.evidence, cur.url = (evidence, url) if conf >= cur.confidence else (cur.evidence, cur.url)
        cur.confidence = round(max(conf, cur.confidence), 2)
    if better_title:
        cur.title = title
    if len(name) > len(cur.name) and name_key(name) == key:
        cur.name = name


def _title_ok(text: str, title_start: int) -> bool:
    return not NON_EXEC_PRECEDERS.search(text[max(0, title_start - 14): title_start])


def extract_leadership(pages: list[ParsedPage], company_names: list[str]) -> list[Leader]:
    found: dict[str, Leader] = {}

    def not_company(n: str | None) -> str | None:
        if n and any(name_similarity(n, c) >= 0.9 for c in company_names):
            return None
        return n

    for page in pages:
        lines = page.lines
        for line in lines:
            if len(line) > 1500:
                line = line[:1500]
            for m in _NAME_THEN_TITLE.finditer(line):
                if m.group("name"):
                    raw, title, ts = m.group("name"), m.group("title"), m.start("title")
                else:
                    raw, title, ts = m.group("name2"), m.group("title2"), m.start("title2")
                if not _title_ok(line, ts):
                    continue
                _add_leader(found, not_company(clean_name(raw)), title, _snippet(line, m.start(), m.end()), page.url, 0.6)
            for m in _TITLE_THEN_NAME.finditer(line):
                if not _title_ok(line, m.start("title")):
                    continue
                _add_leader(found, not_company(clean_name(m.group("name"))), m.group("title"),
                            _snippet(line, m.start(), m.end()), page.url, 0.6)
            for m in _OUR_TITLE_NAME.finditer(line):
                _add_leader(found, not_company(clean_name(m.group("name"))), m.group("title"),
                            _snippet(line, m.start(), m.end()), page.url, 0.55)
            for m in _FOUNDED_BY.finditer(line):
                verb = m.group("verb").lower()
                title = "Founder" if re.match(r"(?:founded|started|established|created)", verb) else "Owner"
                conf = 0.55 if title == "Founder" or "owned" in verb else 0.45
                _add_leader(found, not_company(clean_name(m.group("name"))), title,
                            _snippet(line, m.start(), m.end()), page.url, conf)
            for m in _NAME_FOUNDED.finditer(line):
                _add_leader(found, not_company(clean_name(m.group("name"))), "Founder",
                            _snippet(line, m.start(), m.end()), page.url, 0.5)
            for m in _MEET.finditer(line):
                near = line[m.end(): m.end() + 120]
                tm = TITLE_RE.search(near)
                title = tm.group(0) if tm and _title_ok(near, tm.start()) else None
                _add_leader(found, not_company(clean_name(m.group("name"))), title,
                            _snippet(line, m.start(), m.end() + (tm.end() if tm else 0)), page.url,
                            0.5 if title else 0.35)
        # Team cards: a line that is only a name next to a line that is only a title.
        def card_name(k: int) -> tuple[str | None, bool]:
            if not 0 <= k < len(lines):
                return None, False
            ln = lines[k]
            nm = NAME_LINE_RE.match(ln)
            if nm:
                return not_company(clean_name(nm.group("name"), strict=True)), False
            cm = CAPS_NAME_LINE_RE.match(ln)
            if cm:
                cand = " ".join(w.capitalize() for w in cm.group("name").split())
                return not_company(clean_name(cand, strict=True)), True
            return None, False

        def is_title(k: int) -> bool:
            return 0 <= k < len(lines) and len(lines[k]) <= 80 and bool(TITLE_LINE_RE.match(lines[k]))

        # Card orientation for the page, decided on the first name line next to a title line:
        # "Name / Title" (below) or "Title / Name" (above). With both neighbours being titles the
        # first card can only be "above" (in "below" layouts the line above the first name is a
        # section heading). A title then belongs to its own name, never to the neighbouring card.
        below = True
        for i in range(len(lines)):
            if card_name(i)[0] and (is_title(i + 1) or is_title(i - 1)):
                below = not is_title(i - 1)
                break
        for i, line in enumerate(lines):
            name, caps = card_name(i)
            if not name:
                continue
            caps_unknown = caps and name.split()[0].lower() not in FIRST_NAMES
            if below:  # own title is i+1; i-1 only if no name above it, i+2 only if i+1 isn't a name
                order = ((i + 1, None), (i - 1, i - 2), (i + 2, i + 1))
            else:
                order = ((i - 1, None), (i + 1, i + 2), (i - 2, i - 1))
            for j, owner_k in order:
                if caps_unknown and j != (i + 1 if below else i - 1):
                    continue  # unknown first name in caps: only accept the directly paired title
                if owner_k is not None and card_name(owner_k)[0]:
                    continue
                if is_title(j):
                    tm = TITLE_LINE_RE.match(lines[j])
                    ev = f"{line} | {lines[j]}" if j > i else f"{lines[j]} | {line}"
                    _add_leader(found, name, tm.group("title"), ev[:240], page.url, 0.6)
                    break
        # JSON-LD
        for item in _walk_jsonld(page.jsonld):
            types = item.get("@type")
            types = [types] if isinstance(types, str) else (types or [])
            if any(t != "Person" for t in types):
                for key, default_title in (("founder", "Founder"), ("founders", "Founder"), ("employee", None),
                                           ("employees", None), ("member", None), ("owner", "Owner")):
                    val = item.get(key)
                    for person in val if isinstance(val, list) else [val]:
                        if isinstance(person, str):
                            pname, ptitle = person, default_title
                        elif isinstance(person, dict) and isinstance(person.get("name"), str):
                            pname = person["name"]
                            jt = person.get("jobTitle")
                            ptitle = jt if isinstance(jt, str) and jt else default_title
                        else:
                            continue
                        if not ptitle:
                            continue
                        _add_leader(found, not_company(clean_name(pname)), ptitle,
                                    f"JSON-LD {key}: {pname} ({ptitle})"[:240], page.url, 0.6)
            if "Person" in types and isinstance(item.get("name"), str):
                jt = item.get("jobTitle")
                if isinstance(jt, str) and TITLE_RE.search(jt):
                    _add_leader(found, not_company(clean_name(item["name"])), jt,
                                f"JSON-LD Person: {item['name']} ({jt})"[:240], page.url, 0.6)
    leaders = sorted(found.values(), key=lambda l: (-l.confidence, -title_rank(l.title), l.name))
    return leaders[:MAX_LEADERSHIP]


def _walk_jsonld(obj: Any, depth: int = 0) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if depth > 6:
        return out
    if isinstance(obj, list):
        for x in obj:
            out.extend(_walk_jsonld(x, depth + 1))
    elif isinstance(obj, dict):
        out.append(obj)
        for k, v in obj.items():
            if k in ("@graph", "mainEntity", "publisher", "provider", "author", "itemListElement", "about",
                     "founder", "employee", "parentOrganization", "brand", "worksFor"):
                if isinstance(v, (list, dict)):
                    out.extend(_walk_jsonld(v, depth + 1))
    return out


def jsonld_facts(pages: list[ParsedPage]) -> dict[str, Any]:
    """foundingDate, numberOfEmployees, areaServed, sameAs, email, telephone from org JSON-LD."""
    facts: dict[str, Any] = {"same_as": [], "area_served": [], "emails": [], "phones": []}
    for page in pages:
        for item in _walk_jsonld(page.jsonld):
            t = item.get("@type")
            types = [t] if isinstance(t, str) else (t or [])
            if not types or "Person" in types or any(x in ("WebSite", "WebPage", "BreadcrumbList", "ImageObject")
                                                     for x in types):
                continue
            fd = item.get("foundingDate")
            if isinstance(fd, (str, int)) and "founding" not in facts:
                m = re.search(r"(18|19|20)\d{2}", str(fd))
                if m:
                    facts["founding"] = int(m.group(0))
            ne = item.get("numberOfEmployees")
            if ne and "employees" not in facts:
                if isinstance(ne, dict):
                    v = ne.get("value") or (f"{ne.get('minValue')}-{ne.get('maxValue')}" if ne.get("minValue") else None)
                else:
                    v = ne
                if v:
                    facts["employees"] = f"{v} employees (JSON-LD)"
            sa = item.get("sameAs")
            if isinstance(sa, str):
                facts["same_as"].append(sa)
            elif isinstance(sa, list):
                facts["same_as"].extend(x for x in sa if isinstance(x, str))
            ar = item.get("areaServed")
            for a in ar if isinstance(ar, list) else [ar]:
                if isinstance(a, str):
                    facts["area_served"].append(a)
                elif isinstance(a, dict) and isinstance(a.get("name"), str):
                    facts["area_served"].append(a["name"])
            if isinstance(item.get("email"), str):
                facts["emails"].append(item["email"])
            if isinstance(item.get("telephone"), str):
                facts["phones"].append(item["telephone"])
    return facts


def attach_emails(leaders: list[Leader], emails: list[str], site_host: str) -> dict[str, str]:
    """Map leader name -> same-domain email whose local part clearly encodes that person."""
    out: dict[str, str] = {}
    site = _bare(site_host)
    domain_emails = [e for e in emails if e.split("@")[1] == site or e.split("@")[1].endswith("." + site)]
    for l in leaders:
        toks = [t.lower().strip(".") for t in l.name.split() if len(t.strip(".")) > 1]
        if len(toks) < 2:
            continue
        first, last = re.sub(r"[^a-z]", "", toks[0]), re.sub(r"[^a-z]", "", toks[-1])
        variants = {first, f"{first}.{last}", f"{first}{last}", f"{first[0]}{last}", f"{first}_{last}",
                    f"{first[0]}.{last}", f"{first}{last[0]}", last}
        for e in domain_emails:
            local = e.split("@")[0]
            if local in variants and (local != last or len(last) >= 4) and (local != first or len(first) >= 3):
                out[l.name] = e
                break
    return out


def build_page_texts(pages: list[ParsedPage]) -> list[dict[str, str]]:
    """Per-page cleaned text, deduplicating boilerplate lines across pages, within the size budgets."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    total = 0
    for i, p in enumerate(pages):
        lines = p.main_lines or p.lines
        kept: list[str] = []
        if i == 0 and p.meta_description:
            kept.append(p.meta_description)
            seen.add(p.meta_description.lower())
        for ln in lines:
            k = ln.lower()
            if k in seen and len(ln) > 3:
                continue
            seen.add(k)
            kept.append(ln)
        text = "\n".join(kept)
        budget = min(PAGE_TEXT_LIMIT, TOTAL_TEXT_LIMIT - total)
        if budget <= 200:
            break
        if len(text) > budget:
            text = text[:budget].rsplit(" ", 1)[0]
        total += len(text)
        out.append({"url": p.url, "title": p.title[:200], "text": text})
    return out


def extract_all(pages: list[ParsedPage], ctx: LeadContext, site_host: str, today: date | None = None) -> dict[str, Any]:
    """Pure extraction over already-fetched pages (unit-testable without network)."""
    facts = jsonld_facts(pages)
    full_text = "\n".join(p.text for p in pages)
    # Emails: same-domain first, then by frequency.
    ecount: Counter[str] = Counter()
    for p in pages:
        ecount.update(p.emails)
    for e in facts["emails"]:
        ce = clean_email(e)
        if ce:
            ecount[ce] += 1
    site = _bare(site_host)
    emails = sorted(ecount, key=lambda e: (not (e.split("@")[1] == site or e.split("@")[1].endswith("." + site)), -ecount[e], e))[:MAX_EMAILS]
    # Phones: tel: links and frequency.
    pcount: Counter[str] = Counter()
    for p in pages:
        pcount.update(p.phones)
    for ph in facts["phones"]:
        fp = format_phone(ph)
        if fp:
            pcount[fp] += 1
    phones = [p for p, _ in pcount.most_common(MAX_PHONES)]
    social = extract_social(pages, facts["same_as"])
    services, mentions = extract_services(full_text)
    areas = extract_service_areas([ln for p in pages for ln in p.lines])
    for a in facts["area_served"]:
        a = a.strip()
        if a and a.lower() not in {x.lower() for x in areas} and len(areas) < MAX_SERVICE_AREAS and len(a) <= 60:
            areas.append(a)
    founded, founded_ev = extract_founded(full_text, today)
    if facts.get("founding") and (founded is None or "years" in (founded_ev or "")):
        founded, founded_ev = facts["founding"], "JSON-LD foundingDate"
    team_size = extract_team_size(full_text) or facts.get("employees")
    leaders = extract_leadership(pages, ctx.names())
    contractor_digits = phone_digits(ctx.get("phone"))
    phone_match = bool(contractor_digits and any(phone_digits(p) == contractor_digits for p in phones))
    low = full_text.lower()
    name_match = any(n and len(n) > 3 and n.lower() in low for n in ctx.names()) or any(
        name_similarity(n, p.title) >= 0.85 for n in ctx.names() for p in pages[:1] if p.title)
    return {
        "pages": build_page_texts(pages),
        "emails": emails,
        "phones": phones,
        "social": social,
        "services": services,
        "service_areas": areas,
        "founded_year": founded,
        "team_size_hint": team_size,
        "leadership": [{"name": l.name, "title": l.title, "evidence": l.evidence} for l in leaders],
        # informational extras
        "service_mentions": mentions,
        "founded_year_evidence": founded_ev,
        "identity": {"phone_match": phone_match, "name_match": name_match},
        "_leaders": leaders,
    }


# --------------------------------------------------------------------------------------
# The enricher
# --------------------------------------------------------------------------------------
class WebsiteCrawlEnricher(Enricher):
    name: ClassVar[str] = "website_crawl"
    depends_on: ClassVar[tuple[str, ...]] = ("website_discovery",)

    def applies_to(self, ctx: LeadContext) -> bool:
        return True  # "no website" is reported as skipped inside enrich() with a clear reason

    async def _robots(self, http: HttpClient, scheme: str, host: str, cache: dict[str, RobotFileParser | None]) -> RobotFileParser | None:
        if host in cache:
            return cache[host]
        url = f"{scheme}://{host}/robots.txt"
        rp: RobotFileParser | None = RobotFileParser(url)
        try:
            r = await http.get(url, retries=0, timeout=10.0, allow_statuses=tuple(range(300, 600)))
            if r.status in (401, 403):
                rp.disallow_all = True  # stdlib semantics: an access-restricted robots.txt means "keep out"
            elif r.ok and "<html" not in r.text[:500].lower():
                rp.parse(r.text.splitlines())
            else:
                rp = None  # missing / broken robots.txt -> allow
        except Exception:  # fetch failed -> allow
            rp = None
        if rp is not None:
            delay = rp.crawl_delay(ROBOTS_UA)
            if delay:
                http.set_host_interval(host, min(float(delay), 10.0))
        cache[host] = rp
        return rp

    async def _allowed(self, http: HttpClient, url: str, cache: dict[str, RobotFileParser | None]) -> bool:
        p = urlsplit(url)
        rp = await self._robots(http, p.scheme or "https", p.netloc.lower(), cache)
        return True if rp is None else rp.can_fetch(ROBOTS_UA, url)

    async def _fetch_html(self, http: HttpClient, url: str, retries: int = 1) -> tuple[str, str] | None:
        r = await http.get(url, retries=retries, timeout=FETCH_TIMEOUT_S, allow_statuses=(404, 410, 401, 403))
        if not r.ok:
            return None
        ctype = next((v for k, v in r.headers.items() if k.lower() == "content-type"), "")
        if ctype and "html" not in ctype.lower():
            return None
        return r.url, r.text

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        site = ctx.best_website()
        if not site:
            return self.skipped("no website")
        start = normalize_site(site)
        robots: dict[str, RobotFileParser | None] = {}
        source_urls: list[str] = []
        if not await self._allowed(http, start, robots):
            return self.skipped("robots.txt disallows crawling")
        try:
            got = await self._fetch_html(http, start, retries=2)
        except HttpError as e:
            msg = str(e)
            if e.status in (404, 410) or any(s in msg for s in ("Could not resolve", "resolve host", "SSL", "certificate")):
                return self.no_match({"reason": f"website unreachable: {msg[:300]}", "url": start}, [start])
            return self.error(f"homepage fetch failed: {msg}")
        if got is None:
            return self.no_match({"reason": "homepage not HTML or not found", "url": start}, [start])
        final_url, html = got
        source_urls.append(final_url)
        final_host = _host(final_url)
        if _bare(final_host) != _bare(_host(start)) and not await self._allowed(http, final_url, robots):
            return self.skipped("robots.txt disallows crawling (after redirect)")
        home = parse_page(html, final_url)
        pages = [home]
        targets = choose_links(home, final_host)
        if len(targets) < 2:  # JS-heavy homepage: try a few conventional paths
            have = {canonical_url(u) for u, _ in targets}
            for path in FALLBACK_PATHS:
                u = urljoin(final_url, path)
                if canonical_url(u) not in have:
                    targets.append((u, "fallback"))
                    have.add(canonical_url(u))
            targets = targets[:MAX_EXTRA_PAGES]
        blocked = 0
        fetched = {canonical_url(final_url)}
        for url, _cat in targets:
            if not await self._allowed(http, url, robots):
                blocked += 1
                continue
            try:
                res = await self._fetch_html(http, url, retries=0)
            except HttpError as e:
                log.debug("website_crawl: %s failed: %s", url, e)
                continue
            if res is None:
                continue
            furl, fhtml = res
            if canonical_url(furl) in fetched or not same_site(furl, final_host):
                continue
            fetched.add(canonical_url(furl))
            source_urls.append(furl)
            pages.append(parse_page(fhtml, furl))
        data = extract_all(pages, ctx, final_host)
        leaders: list[Leader] = data.pop("_leaders")
        email_map = attach_emails(leaders, data["emails"], final_host)
        contacts = [
            Contact(name=l.name, title=l.title, email=email_map.get(l.name), source="website", source_url=l.url,
                    confidence=l.confidence)
            for l in leaders
        ]
        data["pages_fetched"] = len(pages)
        data["robots_blocked"] = blocked
        data["final_url"] = final_url
        prior = ctx.ok_prior("website_discovery")
        conf = prior.confidence if prior is not None and prior.confidence else 0.6
        if data["identity"]["phone_match"]:
            conf = max(conf, 0.9)
        elif data["identity"]["name_match"]:
            conf = max(conf, 0.75)
        return self.ok(data, conf, contacts=contacts, website=final_url, source_urls=source_urls)
