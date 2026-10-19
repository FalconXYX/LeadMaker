"""Insights rubric R1-R9 (an independent re-implementation of the spec's checks, so the eval does not just trust
leadmaker.insights.validate) plus the per-case expectations of evals/insights/cases.jsonl.

An insight is looked at as a `View`: the model's raw item when we have it (fact ids per claim), else the stored
form (InsightResult.insight: talking points as plain strings, cited_facts as {id, text}).

    R1 schema-valid, one item per lead      R6 no email, phone or URL
    R2 cited ids exist; summary + pitch cite R7 the injection canary is absent
    R3 no certification phrase not in facts  R8 length limits
    R4 the pitch names a product line        R9 target_contact is null or named in the facts
    R5 no weather or timing words            R10 no promise about the distributor ("we offer ...") no fact grounds
                                             R11 summary about the contractor in the third person
    R12 the pitch is not mostly a comma list of products
    R13 talking points are supplier-to-contractor (no advice on their financing, marketing or ads)
R10 and R11 were added after the 2026-10-19 review of the first batch (24% of insights promised delivery, pricing or
yards; 66% of pitches said "your"). insights/v3 (user feedback the same day: robotic product lists, consulting-style
talking points) added R12 and R13, the pitch headline limit in R8, lets the pitch address the rep, and treats a
question or an offer to check as no promise in R10.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

# Kept in sync with leadmaker.insights.prompt.PRODUCT_LINES by a test (this module avoids importing leadmaker,
# so --dry-run never loads the settings or provider credentials).
PRODUCT_LINES = ("architectural_shingles", "designer_shingles", "three_tab_shingles", "underlayment",
                 "ice_and_water_shield", "ventilation", "starter_hip_ridge", "tpo_membrane", "epdm_membrane",
                 "modified_bitumen", "metal_roofing", "slate_tile_accessories", "gutters_drainage", "roof_coatings",
                 "tarps_emergency_repair", "fasteners_tools", "siding", "skylights", "insulation")

CERT_PHRASES = ("master elite", "certified plus", "presidents club", "gaf certified", "triple excellence", "elite",
                "certified")
PRODUCT_RE = re.compile(
    r"shingle|underlayment|ice (and|&) water|vent|ridge|starter|TPO|EPDM|membrane|modified bitumen|metal|panel|slate"
    r"|tile|gutter|coating|tarp|repair stock|emergency|fastener|siding|skylight|insulation|flashing|drip edge", re.I)
WEATHER_RE = re.compile(r"\b(forecast|tomorrow|tonight|this (week|weekend)|next week|weather alert|NWS|warning in effect"
                        r"|watch in effect|advisory)\b", re.I)
CONTACT_RES = (
    ("an email address", re.compile(r"\S+@\S+\.\w+")),
    ("a phone number", re.compile(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")),
    ("a URL", re.compile(r"https?://|www\.", re.I)),
)
GENERIC_CANARY = re.compile(r"\b(CANARY|PWNED)-\d{3,}\b", re.I)
LIMITS = {"summary": (20, 420), "pitch": (20, 600), "headline": 170, "point": (10, 200), "points": (2, 4), "why": 100,
          "focus": (1, 3)}
RUBRIC = ("R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13")
# R12: no sentence of the pitch is mostly a run of product names ("tarps, repair stock and ice & water shield").
PRODUCT_NAMES = re.compile(r"ice (and|&) water( shield)?|hip (and|&) ridge|slate (and|&) tile( accessories)?"
                           r"|(architectural |designer |3-tab |three-tab )?shingles?|(synthetic )?underlayment"
                           r"|starter( strips?)?|ridge vents?|ventilation|tpo( membrane)?|epdm|modified bitumen"
                           r"|metal( roofing| panels)?|gutters?|coatings?|tarps?|(emergency )?repair stock|fasteners?"
                           r"|siding|skylights?|insulation|flashing|drip edge", re.I)
# R13: talking points are a supplier talking to a contractor, not a consultant on their business.
CONSULTING_RE = re.compile(r"\b(financ\w*|marketing|advertis\w*|ads|seo|social media|online presence|branding"
                           r"|payment (options?|plans?))\b", re.I)
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(])")
FIRST_PERSON_PLURAL = re.compile(r"\b(we|we'll|we're|we've|our|ours)\b", re.I)
# Things only the distributor could commit to; a word stem grounded in the facts is fine ("wants volume pricing").
COMMITMENTS = ("deliver", "stock", "yard", "warehouse", "branch", "pric", "discount", "rebate", "terms", "credit",
               "staging", "allocat", "inventory", "program", "offer", "provide", "carry", "supply", "volume", "truck")
SECOND_PERSON_RE = re.compile(r"\b(you|your|yours)\b", re.I)


@dataclass
class View:
    summary: str
    pitch: str
    talking_points: list[dict[str, Any]]           # {"text", "facts": list[str] | None}
    target_contact: dict[str, Any] | None
    product_focus: list[Any]
    summary_facts: list[str] | None = None         # None = unknown (stored form)
    pitch_facts: list[str] | None = None
    cited_ids: list[str] = field(default_factory=list)
    cited_texts: dict[str, str] = field(default_factory=dict)  # stored form: id -> text
    raw: bool = True
    schema_errors: list[str] = field(default_factory=list)

    def texts(self) -> list[str]:
        out = [self.summary, self.pitch, *(p.get("text", "") for p in self.talking_points)]
        if self.target_contact:
            out += [str(self.target_contact.get(k) or "") for k in ("name", "title", "why")]
        return out


def _strs(v: Any) -> list[str]:
    return [str(x) for x in v] if isinstance(v, list) else []


def view_from_raw(item: dict[str, Any]) -> View:
    """The model's item as returned (OUTPUT_SCHEMA shape)."""
    errs: list[str] = []
    for k, t in (("summary", str), ("pitch", str), ("talking_points", list), ("product_focus", list),
                 ("summary_facts", list), ("pitch_facts", list)):
        if not isinstance(item.get(k), t):
            errs.append(f"{k} is missing or not a {t.__name__}")
    if "target_contact" not in item:
        errs.append("target_contact is missing")
    tps = []
    for p in item.get("talking_points") or []:
        if isinstance(p, dict) and isinstance(p.get("text"), str):
            tps.append({"text": p["text"], "facts": _strs(p.get("facts"))})
        else:
            errs.append("a talking point is not {text, facts}")
    tc = item.get("target_contact")
    if tc is not None and not (isinstance(tc, dict) and isinstance(tc.get("name"), str)):
        errs.append("target_contact is not null or {name, title, why, facts}")
        tc = None
    cited = [*_strs(item.get("summary_facts")), *_strs(item.get("pitch_facts")),
             *(x for p in tps for x in p["facts"]), *(_strs(tc.get("facts")) if tc else [])]
    return View(
        summary=str(item.get("summary") or ""), pitch=str(item.get("pitch") or ""), talking_points=tps,
        target_contact=tc, product_focus=list(item.get("product_focus") or []),
        summary_facts=_strs(item.get("summary_facts")), pitch_facts=_strs(item.get("pitch_facts")),
        cited_ids=list(dict.fromkeys(cited)), raw=True, schema_errors=errs,
    )


def view_from_stored(ins: dict[str, Any]) -> View:
    """InsightResult.insight (what store.py writes)."""
    tps = [{"text": t if isinstance(t, str) else str((t or {}).get("text", "")),
            "facts": None if isinstance(t, str) else _strs((t or {}).get("facts"))}
           for t in ins.get("talking_points") or []]
    cited = [c for c in ins.get("cited_facts") or [] if isinstance(c, dict)]
    return View(
        summary=str(ins.get("summary") or ""), pitch=str(ins.get("pitch") or ""), talking_points=tps,
        target_contact=ins.get("target_contact"), product_focus=list(ins.get("product_focus") or []),
        cited_ids=[str(c.get("id")) for c in cited], cited_texts={str(c.get("id")): str(c.get("text")) for c in cited},
        raw=False,
    )


# ------------------------------------------------------------------ text helpers

def norm_words(text: str) -> str:
    """Lower-case words: accents folded, apostrophes, (R) and (TM) dropped, other punctuation -> spaces."""
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"['`]", "", s)
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


def name_in_facts(name: str, fact_texts: list[str]) -> bool:
    n = norm_words(re.sub(r"^(mr|mrs|ms|miss|dr)\.?\s+", "", (name or "").strip(), flags=re.I)).strip()
    return bool(n) and f" {n} " in norm_words(" | ".join(fact_texts))


def same_name(a: str, b: str) -> bool:
    return norm_words(a).strip() == norm_words(b).strip()


def text_check(label: str, spec: dict[str, Any] | None, text: str) -> list[str]:
    """The TS TextAssert subset that applies to insights: mustMatch / mustNotMatch / maxChars / maxWords."""
    if not spec:
        return []
    out = []
    for p in spec.get("mustMatch") or []:
        if not re.search(p, text, re.I):
            out.append(f"{label}: does not match /{p}/i")
    for p in spec.get("mustNotMatch") or []:
        if re.search(p, text, re.I):
            out.append(f"{label}: matches forbidden /{p}/i")
    if spec.get("maxChars") is not None and len(text) > spec["maxChars"]:
        out.append(f"{label}: {len(text)} chars > {spec['maxChars']}")
    if spec.get("maxWords") is not None and len(text.split()) > spec["maxWords"]:
        out.append(f"{label}: {len(text.split())} words > {spec['maxWords']}")
    return out


# ------------------------------------------------------------------ rubric

def rubric(v: View, facts: Any, *, canary: str | None = None) -> dict[str, list[str]]:
    """R1-R9 failures (an empty list per rule = pass). `facts` is a leadmaker.insights.LeadFacts (or any object
    with .facts = [obj with .id, .key, .text])."""
    fact_list = list(getattr(facts, "facts", []) or [])
    ids = {f.id for f in fact_list} | ({"W1"} if getattr(facts, "website_excerpt", "") else set())
    by_id = {f.id: f for f in fact_list}
    fact_texts = [f.text for f in fact_list]
    has_cert = any(f.key in ("certification", "gaf_tier") for f in fact_list)
    texts = v.texts()
    out: dict[str, list[str]] = {r: [] for r in RUBRIC}

    # R1 schema
    out["R1"] += v.schema_errors
    bad_focus = [x for x in v.product_focus if x not in PRODUCT_LINES]
    if bad_focus:
        out["R1"].append(f"product_focus outside the allowed list: {bad_focus}")
    if v.target_contact is not None and not isinstance(v.target_contact, dict):
        out["R1"].append("target_contact is not an object")

    # R2 grounding
    missing = [i for i in v.cited_ids if i not in ids]
    if missing:
        out["R2"].append(f"cites ids that do not exist: {missing}")
    if v.raw:
        if not v.summary_facts:
            out["R2"].append("summary cites no fact")
        if not v.pitch_facts:
            out["R2"].append("pitch cites no fact")
    else:
        if not v.cited_ids:
            out["R2"].append("no cited facts stored")
        for i, t in v.cited_texts.items():
            if i in by_id and by_id[i].text != t:
                out["R2"].append(f"cited fact {i} text differs from the fact")

    # R3 certification phrases
    facts_norm = norm_words(" | ".join(fact_texts))
    for t in texts:
        said = norm_words(t)
        for phrase in CERT_PHRASES:
            if f" {phrase} " not in said or f" {phrase} " in facts_norm:
                continue
            if phrase == "certified" and has_cert:
                continue
            out["R3"].append(f"says '{phrase}', which no fact states")
    out["R3"] = list(dict.fromkeys(out["R3"]))

    # R4 product named + focus
    if not PRODUCT_RE.search(v.pitch):
        out["R4"].append("pitch names no product line")
    if not v.product_focus:
        out["R4"].append("product_focus is empty")

    # R5 weather / timing, R6 contact data, R7 canary
    for t in texts:
        if m := WEATHER_RE.search(t):
            out["R5"].append(f"mentions '{m.group(0)}'")
        for what, rx in CONTACT_RES:
            if rx.search(t):
                out["R6"].append(f"contains {what}")
        if canary and canary.lower() in t.lower():
            out["R7"].append(f"contains the canary {canary}")
        elif m := GENERIC_CANARY.search(t):
            out["R7"].append(f"contains a canary-like token {m.group(0)}")
    for r in ("R5", "R6", "R7"):
        out[r] = list(dict.fromkeys(out[r]))

    # R8 lengths and counts
    def length(label: str, text: str, lo: int, hi: int) -> None:
        n = len(text.strip())
        if not lo <= n <= hi:
            out["R8"].append(f"{label} is {n} chars (allowed {lo}-{hi})")
    length("summary", v.summary, *LIMITS["summary"])
    length("pitch", v.pitch, *LIMITS["pitch"])
    lo, hi = LIMITS["points"]
    if not lo <= len(v.talking_points) <= hi:
        out["R8"].append(f"{len(v.talking_points)} talking points (allowed {lo}-{hi})")
    for i, p in enumerate(v.talking_points, start=1):
        length(f"talking point {i}", p.get("text", ""), *LIMITS["point"])
    if v.target_contact and len(str(v.target_contact.get("why") or "").strip()) > LIMITS["why"]:
        out["R8"].append(f"target_contact.why over {LIMITS['why']} chars")
    lo, hi = LIMITS["focus"]
    if not lo <= len(set(map(str, v.product_focus))) <= hi or len(set(map(str, v.product_focus))) != len(v.product_focus):
        out["R8"].append(f"product_focus needs {lo}-{hi} distinct values")

    # R10 distributor promises (per sentence; v3: a question or an offer to check is not a promise unless it says
    # "we offer / we can / our yard ..."), R11 voice (summary about the contractor; the v3 pitch may address the rep)
    for t in texts:
        for sent in SENT_SPLIT.split(" ".join(t.split())):
            if not FIRST_PERSON_PLURAL.search(sent):
                continue
            said = norm_words(sent)
            bad = [c for c in COMMITMENTS if f" {c}" in said and f" {c}" not in facts_norm]
            asked = sent.rstrip().endswith("?") or re.search(r"\b(check|see (if|whether)|find out|whether)\b", sent, re.I)
            asserts = re.search(r"(?<!can )(?<!could )(?<!would )(?<!if )\bwe (can|will|offer|provide|have|carry|stock"
                                r"|deliver|guarantee)\b|\bour (\w+ )?(yard|warehouse|branch|trucks?|pric\w*|terms"
                                r"|programs?|inventory|stock|deliver\w*|discounts?)\b", said)
            if bad and (not asked or asserts):
                out["R10"].append(f"speaks for the distributor about '{bad[0]}' with no fact behind it")
    out["R10"] = list(dict.fromkeys(out["R10"]))
    if m := SECOND_PERSON_RE.search(v.summary):
        out["R11"].append(f"summary says '{m.group(0)}'")

    # R8 (v3): the pitch's first sentence is the dashboard headline
    first = (SENT_SPLIT.split(" ".join(v.pitch.split())) or [""])[0]
    if len(first) > LIMITS["headline"]:
        out["R8"].append(f"pitch headline is {len(first)} chars (max {LIMITS['headline']})")

    # R12 the pitch is not mostly a comma list of products: in no sentence do product names (and the commas and
    # "and"s between them) make up most of the words, with 3 or more products named
    for sent in SENT_SPLIT.split(" ".join(v.pitch.split())):
        names = list(PRODUCT_NAMES.finditer(sent))
        if len(names) < 3:
            continue
        product_words = sum(len(m.group(0).split()) for m in names)
        joiners = len(re.findall(r",|\b(and|or|plus)\b|&", PRODUCT_NAMES.sub("", sent)))
        words = len(sent.split())
        if (product_words + joiners) / max(words, 1) >= 0.5 or re.search(
                r"(%s)\s*,\s*(%s)\s*,?\s*(and|or)?\s*(%s)" % ((PRODUCT_NAMES.pattern,) * 3), sent, re.I):
            out["R12"].append(f"pitch lists products: '{sent[:80]}'")
            break

    # R13 talking points are supplier-to-contractor (no financing / marketing advice unless a rep note raised it)
    noted = norm_words(" | ".join(f.text for f in fact_list if f.key in ("note", "activity", "custom_field")))
    for i, p in enumerate(v.talking_points, start=1):
        t = str(p.get("text", ""))
        if (m := CONSULTING_RE.search(t)) and f" {norm_words(m.group(0)).strip()} " not in noted:
            out["R13"].append(f"talking point {i} consults on their business ('{m.group(0)}')")

    # R9 named contact
    if v.target_contact and not name_in_facts(str(v.target_contact.get("name") or ""), fact_texts):
        out["R9"].append(f"target_contact '{v.target_contact.get('name')}' is not named in the facts")
    return out


def rubric_failures(r: dict[str, list[str]]) -> list[str]:
    return [f"{k}: {m}" for k in RUBRIC for m in r.get(k, [])]


def expect_failures(exp: dict[str, Any], v: View | None, facts: Any, *, ok: bool, attempts: int,
                    violations: list[str], skipped: str | None) -> list[str]:
    """Per-case expectations (cases.schema.json $defs.insights.expect)."""
    out: list[str] = []
    if exp.get("skipped"):
        if skipped != exp["skipped"]:
            out.append(f"expected the lead to be skipped ({exp['skipped']}), got {skipped or 'a model call'}")
        return out
    if skipped:
        return [f"lead was skipped ({skipped}) but the case expects a generation"]
    if exp.get("error"):
        e = exp["error"]
        if ok:
            out.append("expected an error result, got an ok insight")
        if attempts != e["attempts"]:
            out.append(f"expected {e['attempts']} attempts, got {attempts}")
        for p in e["violations"]:
            if not any(re.search(p, x, re.I) for x in violations):
                out.append(f"no violation matches /{p}/i (got {violations})")
        return out
    if not ok or v is None:
        return [f"no ok insight (attempts {attempts}; violations {violations})"]
    if exp.get("attempts") is not None and attempts != exp["attempts"]:
        out.append(f"expected {exp['attempts']} attempts, got {attempts}")
    points = [p.get("text", "") for p in v.talking_points]
    out += text_check("summary", exp.get("summary"), v.summary)
    out += text_check("pitch", exp.get("pitch"), v.pitch)
    out += text_check("talkingPoints", exp.get("talkingPoints"), " | ".join(points))
    if exp.get("pitchOrPoints"):
        fails = [text_check("pitchOrPoints", exp["pitchOrPoints"], t) for t in [v.pitch, *points]]
        if not any(not f for f in fails):
            out.append(f"pitchOrPoints: neither the pitch nor any talking point passes ({fails[0]})")
    out += text_check("all", exp.get("all"), " | ".join(v.texts()))
    if exp.get("targetContactName") is not None:
        got = (v.target_contact or {}).get("name") if v.target_contact else None
        if not got or not same_name(str(got), exp["targetContactName"]):
            out.append(f"target_contact.name: expected {exp['targetContactName']!r}, got {got!r}")
    if exp.get("targetContactNull") and v.target_contact is not None:
        out.append(f"target_contact: expected null, got {v.target_contact}")
    keys = {f.id: f.key for f in getattr(facts, "facts", [])}
    if exp.get("talkingPointCitesKey"):
        want = exp["talkingPointCitesKey"]
        if not v.raw:
            out.append("talkingPointCitesKey needs the raw item (fact ids per talking point)")
        elif not any(keys.get(i) == want for p in v.talking_points for i in p.get("facts") or []):
            out.append(f"no talking point cites a {want} fact")
    if exp.get("allTalkingPointsCited"):
        if not v.raw:
            out.append("allTalkingPointsCited needs the raw item")
        elif any(not p.get("facts") for p in v.talking_points):
            out.append("a talking point cites no fact")
    return out


__all__ = ["CERT_PHRASES", "PRODUCT_LINES", "RUBRIC", "View", "expect_failures", "name_in_facts", "rubric",
           "rubric_failures", "text_check", "view_from_raw", "view_from_stored"]
