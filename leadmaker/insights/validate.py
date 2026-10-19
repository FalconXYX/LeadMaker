"""Guards on one generated insight item: `validate_item(item, facts) -> violations` (empty = valid).

1. lengths and counts (pydantic for shape, explicit checks for limits, so the messages can be fed back);
2. grounding: every cited id exists in that lead's facts (and summary, pitch and each talking point cite one);
3. certification guard: a certification phrase in the output must occur in the lead's fact texts (not counting
   the contractor's own description); "certified" is grounded by any GAF tier or certification fact;
4. name guard: target_contact.name must appear in the fact texts (llm_extract's word-bounded matcher) and be a
   person, not a bare role ("Owner");
5. no contact data: no email, phone number or URL;
6. weather guard: no forecast / timing words (timing is a separate, rules-based layer), and no season or
   urgency words ("upcoming", "next month", "urgent", "winter") unless a fact uses them;
7. distributor guard: no "we offer / our yard / we can deliver" claims about the distributor unless a fact
   grounds the term (insights/v2; 24% of the v1 batch promised terms nobody had agreed). insights/v3 checks it per
   sentence and lets a question or an offer to check through ("Would rooftop drops help?") unless it also asserts;
8. voice and product: the summary is about the contractor in the third person (v3: the pitch may address the rep),
   the pitch's first sentence is a short headline, it names a product line without stringing products into a
   list, and talking points stay on supply (no financing or marketing advice) with varied openings;
9. injection canaries are covered by 2-8 and by the eval set; cross-lead copying inside one batch call is
   checked by generate() with cross_lead_problems().
Messages are short and model-readable: generate() sends them back for the one retry. repair_item() first fixes
what needs no model: a role-only contact becomes null, product_focus is de-duplicated and cut to 3.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from ..enrich.llm_extract import name_in_text, norm_match
from .facts import LeadFacts
from .prompt import PRODUCT_LINES, WEBSITE_ID

SUMMARY_CHARS = (20, 420)
PITCH_CHARS = (20, 600)
HEADLINE_CHARS = 170  # the pitch's first sentence is the dashboard's one-line AI pitch (prompt asks for <= 150)
POINT_CHARS = (10, 200)
POINTS = (2, 4)
WHY_CHARS = 100
FOCUS = (1, 3)

# Facts written by the contractor about itself: never enough to ground a certification claim.
SELF_DESCRIBED = ("gaf_description:", "website_summary:")
# Longest first, so a message names the phrase the model used ("Master Elite", not "elite").
CERT_PHRASES = ("master elite", "certified plus", "presidents club", "gaf certified", "triple excellence", "elite",
                "certified")
CONTACT_PATTERNS = (
    ("an email address", re.compile(r"\S+@\S+\.\w+")),
    ("a phone number", re.compile(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")),
    ("a URL", re.compile(r"https?://|www\.", re.I)),
)
# A target contact made only of these words is a role ("Owner", "Office Manager"), not a named person.
ROLE_WORDS = frozenset("""
    owner owners co founder cofounder president vice vp ceo coo cfo cto chief officer principal partner managing
    manager management general office operations project sales estimator estimating director head lead senior
    superintendent foreman supervisor admin administrator assistant coordinator contact main line company the
    business representative rep team member staff unknown name
""".split())
WEATHER = re.compile(r"\b(forecast|tomorrow|tonight|this (week|weekend)|next week|weather alert|NWS|warning in effect"
                     r"|watch in effect|advisory)\b", re.I)
# Season and urgency words: allowed only when a fact uses the same word (e.g. a note "needs it before winter").
TIMING_WORDS = re.compile(r"\b(upcoming|seasons?|seasonal|spring|summer|fall|autumn|winter|urgent(?:ly)?|asap"
                          r"|next month|this month|before the rush)\b", re.I)
# First-person plural: the model speaking for the distributor.
WE = re.compile(r"\b(we|we'll|we're|we've|our|ours)\b", re.I)
# What a distributor might promise; each is a word prefix, matched in the normalised text.
# Concrete commitments only: a generic "how can we support their crews?" is a question, not a promise (the first v2
# batch retried 19 of 23 calls; "support" alone accounted for half of the error rows).
DISTRIBUTOR_TERMS = ("provide", "offer", "stock", "carry", "carries", "deliver", "yard", "warehouse", "branch",
                     "location", "pric", "discount", "rebate", "terms", "net 30", "net 60", "credit", "staging",
                     "allocat", "inventory", "program", "truck", "crane", "rooftop", "same day", "next day",
                     "volume", "tier", "reward", "supply", "supplies")
SECOND_PERSON = re.compile(r"\b(you|your|yours|yourself)\b", re.I)
PRODUCT_WORDS = re.compile(
    r"shingle|underlayment|ice (and|&) water|vent|ridge|starter|TPO|EPDM|membrane|modified bitumen|mod[- ]bit|metal"
    r"|panel|slate|tile|gutter|coating|tarp|repair stock|fastener|nail|siding|skylight|insulation|flashing|drip edge"
    r"|seam tape|trim|coil|icewater", re.I)
# insights/v3: a distributor term is fine in a question or an offer to check ("Would rooftop drops help?", "offer to
# check lead times"), but never next to an assertive commitment ("we offer", "our yard", "we can deliver").
CHECK_WORDS = re.compile(r"\b(check|checking|see (if|whether)|find out|look into|ask (if|whether|about)"
                         r"|confirm (if|whether)|whether)\b", re.I)
ASSERTIVE = re.compile(r"(?<!can )(?<!could )(?<!would )(?<!should )(?<!if )(?<!whether )(?<!do )(?<!did )"
                       r"\bwe (can|will|ll|offer|provide|have|carry|stock|deliver|guarantee|give|always|never)\b"
                       r"|\bour (\w+ )?(yard|yards|warehouse|branch|branches|trucks?|prices?|pricing|terms|program|programs"
                       r"|inventory|stock|delivery|deliveries|discounts?|rebates?|credit)\b")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(])")
# Talking points are a supplier talking to a contractor: no consulting on the contractor's own business.
CONSULTING = re.compile(r"\b(financ\w*|marketing|advertis\w*|ads|seo|social media|online presence|branding"
                        r"|lead gen\w*|payment (options?|plans?))\b", re.I)
GROUNDS_CONSULTING = ("note", "activity", "custom_field")  # a rep's own note may raise financing; tags may not
TEMPLATE_OPENERS = ("since", "given")
# Joined product names, so their inner "and" / "&" doesn't split a list item.
_JOINED = ((re.compile(r"ice\s*(and|&)\s*water", re.I), "icewater"), (re.compile(r"hip\s*(and|&)\s*ridge", re.I), "hipridge"),
           (re.compile(r"slate\s*(and|&)\s*tile", re.I), "slatetile"), (re.compile(r"tarps?\s*(and|&)\s*repair", re.I), "tarps repair"))
_LIST_SPLIT = re.compile(r",|;|/|\band\b|\bor\b|\bplus\b|\balongside\b|\bas well as\b|&", re.I)
LIST_RUN = 3  # 3+ product chunks in a row = a comma list of products
# Fact keys that hold one lead's private CRM data (what must never leak into another lead's insight).
PRIVATE_KEYS = ("note", "activity", "custom_field", "custom_tag", "contact", "target_contact")
SHINGLE_WORDS = 5


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class TalkingPoint(_Model):
    text: str
    facts: list[str] = []


class TargetContact(_Model):
    name: str
    title: str = ""
    why: str = ""
    facts: list[str] = []


class InsightItem(_Model):
    lead_ref: str = ""
    summary: str
    summary_facts: list[str] = []
    pitch: str
    pitch_facts: list[str] = []
    talking_points: list[TalkingPoint] = []
    target_contact: TargetContact | None = None
    product_focus: list[str] = []


def _norm(text: str) -> str:
    """Lower-case words for phrase matching: apostrophes, ® and ™ dropped, other punctuation -> spaces."""
    s = unicodedata.normalize("NFKC", text or "").lower()
    s = re.sub(r"['’`´®™]", "", s)
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


def cert_problems(text: str, fact_texts: list[str], has_cert_fact: bool) -> list[str]:
    """A certification phrase must be grounded in GAF data or the distributor's own records: the contractor's
    self-description (gaf_description, website_summary) does not count, since it can be stale or puffed up."""
    out = []
    said = _norm(text)
    facts = _norm(" | ".join(t for t in fact_texts if not t.startswith(SELF_DESCRIBED)))
    for phrase in CERT_PHRASES:
        if f" {phrase} " not in said:
            continue
        if phrase == "certified" and has_cert_fact:
            continue
        if phrase == "gaf certified" and any(f" {t} " in facts for t in ("gaf master elite", "gaf certified plus")):
            continue  # both higher tiers are GAF certifications
        if f" {phrase} " in facts:
            continue
        if any(f" {longer} " in said and phrase in longer for longer in CERT_PHRASES if longer != phrase):
            continue  # "elite" inside an already-reported "master elite"
        shown = {"presidents club": "President's Club"}.get(phrase, phrase.title())
        out.append(f"says '{shown}', which is not in the facts")
    return out


def text_problems(text: str, fact_texts: list[str], has_cert_fact: bool | None = None) -> list[str]:
    """Certification, contact-data and weather guards on one piece of output text."""
    if has_cert_fact is None:
        has_cert_fact = any(t.startswith("certification:") or (t.startswith("gaf_tier:") and "no gaf" not in t.lower())
                            for t in fact_texts)
    out = cert_problems(text, fact_texts, has_cert_fact)
    for what, pat in CONTACT_PATTERNS:
        if pat.search(text):
            out.append(f"contains {what}")
    m = WEATHER.search(text)
    if m:
        out.append(f"mentions weather or timing ('{m.group(0)}')")
    facts_norm = _norm(" | ".join(fact_texts))
    for m in TIMING_WORDS.finditer(text):
        if f" {_norm(m.group(0)).strip()} " not in facts_norm:
            out.append(f"mentions season or urgency ('{m.group(0)}'): timing is a separate layer")
            break
    out += distributor_problems(text, facts_norm)
    return out


def sentences(text: str) -> list[str]:
    return [s for s in SENTENCE_END.split(" ".join((text or "").split())) if s.strip()]


def distributor_problems(text: str, facts_norm: str) -> list[str]:
    """'we offer next-day delivery', 'our yard in Garfield': a claim about the distributor that no fact grounds.
    Checked per sentence; a question or an offer to check is fine unless it also asserts a commitment."""
    for sent in sentences(text):
        m = WE.search(sent)
        if not m:
            continue
        said = _norm(sent)
        term = next((t for t in DISTRIBUTOR_TERMS if f" {t}" in said and f" {t}" not in facts_norm), None)
        if term is None:
            continue
        hedged = sent.rstrip().endswith("?") or CHECK_WORDS.search(sent)
        if hedged and not ASSERTIVE.search(said):
            continue
        return [f"speaks for the distributor ('{m.group(0)} ... {term}'), which no fact supports: ask a question or "
                "offer to check instead of promising terms, stock, delivery or locations"]
    return []


def product_list_problems(pitch: str) -> list[str]:
    """'Lead with tarps, repair stock, and ice & water shield': 3+ short product chunks in a row in one sentence."""
    for sent in sentences(pitch):
        s = sent
        for pat, repl in _JOINED:
            s = pat.sub(repl, s)
        run = 0
        for chunk in _LIST_SPLIT.split(s):
            words = chunk.split()
            if words and len(words) <= 6 and PRODUCT_WORDS.search(chunk):
                run += 1
                if run >= LIST_RUN:
                    return ["pitch strings products together in a list: name at most two or three and give each a "
                            "reason tied to their work"]
            elif words:
                run = 0
    return []


def talking_point_problems(points: list[str], fact_texts: list[str]) -> list[str]:
    """Supplier-to-contractor lines only (no advice on their financing or marketing) with varied openings."""
    out: list[str] = []
    grounded = _norm(" | ".join(t for t in fact_texts if t.startswith(GROUNDS_CONSULTING)))
    for i, p in enumerate(points, start=1):
        m = CONSULTING.search(p)
        if m and f" {_norm(m.group(0)).strip()} " not in grounded:
            out.append(f"talking point {i} is about '{m.group(0)}': stay on supply (their jobs, crews, materials, "
                       "lead times, deliveries, current supplier), not advice on running their business")
    openings = [_norm(p).split()[:2] for p in points]
    firsts = [o[0] for o in openings if o]
    if len({tuple(o) for o in openings}) < len(openings) or sum(f in TEMPLATE_OPENERS for f in firsts) > 1:
        out.append("talking points open the same way: vary how each one starts (no 'Since ...' template)")
    return out


def has_certification(facts: LeadFacts) -> bool:
    """A certification fact, or a GAF tier that is one (Certified / Certified Plus / Master Elite): then the
    generic word "certified" is grounded."""
    return any(f.key == "certification" or (f.key == "gaf_tier" and "no gaf" not in f.text.lower())
               for f in facts.facts)


def is_role_only(name: str) -> bool:
    words = re.findall(r"[a-z]+", unicodedata.normalize("NFKC", name or "").lower())
    return not words or all(w in ROLE_WORDS for w in words)


def _length(label: str, text: str, lo: int, hi: int) -> list[str]:
    n = len(text.strip())
    if n < lo:
        return [f"{label} is {n} characters (min {lo})"]
    if n > hi:
        return [f"{label} is {n} characters (max {hi})"]
    return []


def parse_item(item: Any) -> tuple[InsightItem | None, list[str]]:
    try:
        return InsightItem.model_validate(item), []
    except ValidationError as e:
        errs = "; ".join(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()[:5])
        return None, [f"does not match the schema ({errs})"]


def validate_item(item: Any, facts: LeadFacts) -> list[str]:
    """Violations of one item against its lead's facts; [] when valid."""
    parsed, errors = parse_item(item)
    if parsed is None:
        return errors
    v: list[str] = []
    fact_ids = {f.id for f in facts.facts} | ({WEBSITE_ID} if facts.website_excerpt else set())
    fact_texts = [f.text for f in facts.facts]
    has_cert = has_certification(facts)

    # 1. lengths and counts
    v += _length("summary", parsed.summary, *SUMMARY_CHARS)
    v += _length("pitch", parsed.pitch, *PITCH_CHARS)
    if not POINTS[0] <= len(parsed.talking_points) <= POINTS[1]:
        v.append(f"has {len(parsed.talking_points)} talking points (need {POINTS[0]}-{POINTS[1]})")
    for i, p in enumerate(parsed.talking_points, start=1):
        v += _length(f"talking point {i}", p.text, *POINT_CHARS)
    if parsed.target_contact is not None and len(parsed.target_contact.why.strip()) > WHY_CHARS:
        v.append(f"target_contact.why is {len(parsed.target_contact.why.strip())} characters (max {WHY_CHARS})")
    focus = parsed.product_focus
    if not FOCUS[0] <= len(set(focus)) <= FOCUS[1] or len(set(focus)) != len(focus):
        v.append(f"product_focus needs {FOCUS[0]}-{FOCUS[1]} distinct values (got {focus})")
    unknown = [f for f in focus if f not in PRODUCT_LINES]
    if unknown:
        v.append(f"product_focus has values outside the allowed list: {unknown}")
    if not parsed.summary_facts:
        v.append("summary cites no facts")
    if not parsed.pitch_facts:
        v.append("pitch cites no facts")
    for i, p in enumerate(parsed.talking_points, start=1):
        if not p.facts:
            v.append(f"talking point {i} cites no facts")

    # 2. grounding
    cited = [*parsed.summary_facts, *parsed.pitch_facts, *(x for p in parsed.talking_points for x in p.facts),
             *(parsed.target_contact.facts if parsed.target_contact else [])]
    for fid in dict.fromkeys(cited):
        if fid not in fact_ids:
            v.append(f"cited {fid}, which does not exist")

    # 3, 5, 6. certification, contact data and weather on every text
    texts = [parsed.summary, parsed.pitch, *(p.text for p in parsed.talking_points)]
    if parsed.target_contact is not None:
        texts += [parsed.target_contact.name, parsed.target_contact.title, parsed.target_contact.why]
    for problem in dict.fromkeys(p for t in texts for p in text_problems(t, fact_texts, has_cert)):
        v.append(problem)

    # 8. voice, headline, product line and talking-point focus (insights/v3: the pitch may address the rep as "you")
    m = SECOND_PERSON.search(parsed.summary)
    if m:
        v.append(f"summary says '{m.group(0)}': write about the contractor in the third person (they/their)")
    first = (sentences(parsed.pitch) or [""])[0]
    if len(first) > HEADLINE_CHARS:
        v.append(f"pitch's first sentence is {len(first)} characters (max {HEADLINE_CHARS}): it must stand alone as "
                 "a short headline")
    if not PRODUCT_WORDS.search(parsed.pitch):
        v.append("pitch names no product line")
    v += product_list_problems(parsed.pitch)
    v += talking_point_problems([p.text for p in parsed.talking_points], fact_texts)

    # 4. the contact must be named in the facts
    if parsed.target_contact is not None:
        name = parsed.target_contact.name.strip()
        if is_role_only(name):
            v.append(f"target_contact '{name}' is a role, not a named person (use null when no fact names one)")
        elif not name_in_text(name, norm_match(" | ".join(fact_texts))):
            v.append(f"target_contact '{name}' is not named in the facts")
    return v


def clean_item(item: dict[str, Any], facts: LeadFacts) -> dict[str, Any]:
    """A valid item as stored: trimmed texts, the contact without its fact ids, cited facts in fact order."""
    parsed, _ = parse_item(item)
    assert parsed is not None
    squash = lambda s: " ".join(str(s).split())  # noqa: E731
    cited = set([*parsed.summary_facts, *parsed.pitch_facts, *(x for p in parsed.talking_points for x in p.facts),
                 *(parsed.target_contact.facts if parsed.target_contact else [])])
    tc = parsed.target_contact
    return {
        "summary": squash(parsed.summary),
        "pitch": squash(parsed.pitch),
        "talking_points": [squash(p.text) for p in parsed.talking_points],
        "target_contact": {"name": squash(tc.name), "title": squash(tc.title), "why": squash(tc.why)} if tc else None,
        "product_focus": list(dict.fromkeys(parsed.product_focus)),
        "cited_facts": [{"id": f.id, "text": f.text} for f in facts.facts if f.id in cited]
        + ([{"id": WEBSITE_ID, "text": "website: the company's website"}]
           if WEBSITE_ID in cited and facts.website_excerpt else []),
    }


def repair_item(item: Any) -> Any:
    """Fixes that need no model call (applied before validate_item): a role-only target_contact ("Owner",
    "Unknown") becomes null, product_focus loses duplicates and unknown values (when a known one is left) and is
    cut to 3, and talking points beyond 4 are dropped. Anything else is left for the guards."""
    if not isinstance(item, dict):
        return item
    out = dict(item)
    tc = out.get("target_contact")
    if isinstance(tc, dict) and isinstance(tc.get("name"), str) and is_role_only(tc["name"]):
        out["target_contact"] = None
    focus = out.get("product_focus")
    if isinstance(focus, list):
        uniq = list(dict.fromkeys(f for f in focus if isinstance(f, str)))
        known = [f for f in uniq if f in PRODUCT_LINES]
        out["product_focus"] = (known or uniq)[: FOCUS[1]]
    points = out.get("talking_points")
    if isinstance(points, list) and len(points) > POINTS[1]:
        out["talking_points"] = points[: POINTS[1]]
    return out


def _shingles(text: str, n: int = SHINGLE_WORDS) -> set[str]:
    words = _norm(text).split()
    return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}


def cross_lead_problems(item: Any, own: LeadFacts, others: list[LeadFacts]) -> list[str]:
    """An item that repeats another lead's private CRM data (notes, activity, custom fields and tags, contacts) from
    the same call: any run of 5 words found there and not in the lead's own facts or website. Batches are
    partitioned by owner, so this is defence in depth against a model mixing up items."""
    parsed, _ = parse_item(item)
    if parsed is None or not others:
        return []
    theirs: set[str] = set()
    for o in others:
        for f in o.facts:
            if f.key in PRIVATE_KEYS:
                theirs |= _shingles(f.text.split(":", 1)[-1])
    if not theirs:
        return []
    mine = _shingles(" | ".join(f.text for f in own.facts) + " | " + own.website_excerpt)
    texts = [parsed.summary, parsed.pitch, *(p.text for p in parsed.talking_points)]
    if parsed.target_contact is not None:
        texts += [parsed.target_contact.name, parsed.target_contact.why]
    for t in texts:
        if (_shingles(t) & theirs) - mine:
            return ["repeats another lead's private notes or data: use only this lead's facts"]
    return []


__all__ = ["CERT_PHRASES", "InsightItem", "clean_item", "cross_lead_problems", "distributor_problems",
           "has_certification", "is_role_only", "parse_item", "product_list_problems", "repair_item", "sentences",
           "talking_point_problems", "text_problems", "validate_item"]
