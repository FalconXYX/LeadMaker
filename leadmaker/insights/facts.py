"""Lead facts for the insights prompt, and the input hash that decides when a lead is regenerated.

`build_facts(repo, company_ids)` reads each lead with SQLAlchemy Core (SQLite and Postgres) and emits numbered
facts in a fixed order (SPEC §4.2), every one fenced (`fence`) and scrubbed of email addresses, phone numbers
and URLs: contact details are never sent to a model (D11), and data can never open or close a prompt tag.

Only stable facts go in. Weather and timing (regional_signals, timing badges, geography tags), volatile tags
(recent_reviews, data_completeness, priority_drivers, gaf_recommended's rank), priority_score,
updated_in_last_poll, distance and every timestamp except note and activity dates stay out, and review counts
are bucketed ("400+ reviews"), so a new weather alert, a re-score or one more review never re-runs the model.
One lead's facts and website excerpt are kept under 12,000 characters (fit_budget). `input_hash` covers the facts, the website excerpt, the prompt
version, the model fingerprint and the output schema.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from ..db.repository import as_utc
from ..db.schema import (
    activity_logs, companies, company_custom_tags, contacts, custom_tags, enrichments, field_overrides, users,
)
from ..tagging.taxonomy import SERVICE_LABELS

NY = ZoneInfo("America/New_York")
CHUNK = 200

FACT_CHARS = 400  # one fact line (key prefix included)
DESCRIPTION_CHARS = 600
CUSTOM_FIELD_VALUE_CHARS = 200
ACTIVITY_CHARS = 300
WEBSITE_CHARS = 4000
LEAD_CHARS = 12000  # one lead's facts + website excerpt in the prompt (SPEC §11)
MAX_NOTES = 10
MAX_ACTIVITY = 5
MAX_EXTRA_CONTACTS = 3
MAX_CUSTOM_FIELDS = 20
MAX_CUSTOM_TAGS = 20
MAX_LIST_LABELS = 12

ACTIVITY_TYPES = ("call", "email", "visit")
NOTE_TYPE = "note"
# System-tag categories that become `tag:` facts, and the tags left out (own fact, volatile, or summarised).
TAG_CATEGORIES = ("certification", "services", "compliance", "digital", "reputation", "maturity")
EXCLUDED_TAGS = frozenset({
    "gaf_tier",  # its own fact
    "presidents_club",  # the certification facts carry it
    "gaf_recommended",  # GAF's rank for one search area: changes with every poll
    "recent_reviews", "data_completeness", "priority_drivers",  # volatile
})
# LeadFilter.materials (packages/shared filter.ts): service keys that are roof materials.
MATERIAL_KEYS = ("shingle_roofing", "metal_roofing", "slate_roofing", "tile_roofing", "flat_roofing", "tpo_roofing",
                 "single_ply_roofing")
ACCOUNT_LABELS = {"prospect": "prospect", "existing_customer": "existing customer",
                  "lapsed_customer": "lapsed customer", "do_not_contact": "do not contact"}
TIER_TEXT = {"master_elite": "GAF Master Elite", "certified_plus": "GAF Certified Plus", "certified": "GAF Certified",
             "none": "no GAF certification"}

# --------------------------------------------------------------------------- fencing (shared rules with TS §4.6)

_ZERO_WIDTH_BIDI = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE_RE = re.compile(r"(?<!\w)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)")
URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)


def fence(text: Any, max_chars: int, *, one_line: bool = False) -> str:
    """Untrusted text made safe to place inside a prompt tag: NFKC, no control / zero-width / bidi characters,
    '<' and '>' replaced by '‹' and '›' (data can never open or close a tag), runs of 3+ newlines collapsed
    (one_line: all whitespace collapsed), cut at a word boundary with '…'."""
    s = unicodedata.normalize("NFKC", str(text or ""))
    if one_line:
        s = s.replace("\n", " ").replace("\t", " ")
    s = _CONTROL.sub("", s)
    s = _ZERO_WIDTH_BIDI.sub("", s)
    s = s.replace("<", "‹").replace(">", "›")
    if one_line:
        s = re.sub(r"\s+", " ", s)
    else:
        s = re.sub(r"[ \t]+\n", "\n", s)
        s = re.sub(r"\n{3,}", "\n\n", s)
    s = s.strip()
    return truncate(s, max_chars)


def truncate(s: str, max_chars: int) -> str:
    if len(s) <= max_chars:
        return s
    cut = s[: max(1, max_chars - 1)]
    sp = cut.rfind(" ")
    if sp > max_chars // 2:
        cut = cut[:sp]
    return cut.rstrip(" ,;:.-") + "…"


def scrub(text: str) -> str:
    """Contact details and links out of data sent to a model (D11): '[email]', '[phone]', '[link]'."""
    text = URL_RE.sub("[link]", text)
    text = EMAIL_RE.sub("[email]", text)
    return PHONE_RE.sub("[phone]", text)


def clean(text: Any, max_chars: int, *, one_line: bool = True) -> str:
    return fence(scrub(unicodedata.normalize("NFKC", str(text or ""))), max_chars, one_line=one_line)


# --------------------------------------------------------------------------- data model


@dataclass(frozen=True)
class Fact:
    id: str  # "F1".. (per lead, assigned in a stable order)
    key: str  # e.g. "gaf_tier", "note", "custom_field"
    text: str  # one line, fenced: "<key...>: <value>"


@dataclass
class LeadFacts:
    company_id: str
    business_name: str
    facts: list[Fact]
    website_excerpt: str = ""  # packed website text, <= 4,000 chars, fenced; "" when none
    skip_reason: str | None = None  # "do_not_contact" | "delisted" | None

    def by_id(self) -> dict[str, Fact]:
        return {f.id: f for f in self.facts}


def facts_from_dict(d: dict[str, Any]) -> LeadFacts:
    """{"company_id","business_name","facts":[{"id","key","text"}],"website_excerpt"} -> LeadFacts (eval fixtures).
    Fact ids are kept as given; texts and the excerpt are fenced like build_facts' output. `skip_reason` is taken
    as given, else derived like build_facts: an `account_status: do not contact` fact means "do_not_contact"."""
    facts = [Fact(id=str(f["id"]), key=str(f["key"]), text=clean(f["text"], DESCRIPTION_CHARS + 40))
             for f in d.get("facts") or []]
    skip = d.get("skip_reason")
    if skip is None and any(f.key == "account_status" and re.search(r"do[ _]not[ _]contact", f.text, re.I)
                            for f in facts):
        skip = "do_not_contact"
    return LeadFacts(
        company_id=str(d.get("company_id") or d.get("id") or "fixture"),
        business_name=clean(d.get("business_name") or "", 255),
        facts=facts,
        website_excerpt=clean(d.get("website_excerpt") or "", WEBSITE_CHARS, one_line=False),
        skip_reason=skip,
    )


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def input_hash(facts: LeadFacts, fingerprint: str) -> str:
    """sha256 of the facts (key + text; ids are positional), the website excerpt, the prompt version, the model
    fingerprint ("provider:model") and the output schema."""
    from .prompt import OUTPUT_SCHEMA, PROMPT_VERSION

    return sha256(canonical_json({
        "facts": [[f.key, f.text] for f in facts.facts],
        "website": facts.website_excerpt,
        "prompt_version": PROMPT_VERSION,
        "model": fingerprint,
        "schema": sha256(canonical_json(OUTPUT_SCHEMA)),
    }))


# --------------------------------------------------------------------------- helpers


@lru_cache(maxsize=1)
def county_names() -> dict[str, str]:
    """County FIPS -> "Bergen County" (a copy of packages/shared/data/county-names.tsv, shipped with the package so
    the worker image and the host build the same facts)."""
    out: dict[str, str] = {}
    for line in (Path(__file__).with_name("county_names.tsv")).read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        code, _, name = line.partition("\t")
        out[code.strip()] = name.split(",")[0].strip()
    return out


def short_name(name: str | None) -> str:
    """'Jordan Lee' -> 'Jordan L.'"""
    parts = (name or "").split()
    if not parts:
        return "a rep"
    return parts[0] if len(parts) == 1 else f"{parts[0]} {parts[-1][0]}."


def et_date(dt: Any) -> str:
    d = as_utc(dt) if isinstance(dt, datetime) else None
    return d.astimezone(NY).date().isoformat() if d else "unknown date"


def founded_year(c: dict[str, Any]) -> int | None:
    """Mirror of companies.founded_year (search_performance migration): scraped, else the maturity tag, else GAF."""
    raw = str((c.get("scraped_attributes") or {}).get("founded_year") or "")
    if re.fullmatch(r"\d{4}", raw):
        return int(raw)
    for t in c.get("system_tags") or []:
        if isinstance(t, dict) and t.get("key") == "maturity":
            m = re.search(r"since (\d{4})", str(t.get("reason") or ""))
            if m:
                return int(m.group(1))
    v = c.get("in_business_since")
    return int(v) if isinstance(v, int) or (isinstance(v, str) and v.isdigit()) else None


def review_bucket(n: int) -> str:
    """'7 reviews', '40+ reviews', '400+ reviews': exact below 10, then rounded down (tens below 100, fifties below
    1,000, hundreds above), so one new review on a busy contractor's profile does not change the input hash."""
    if n < 10:
        return f"{n} review{'s' if n != 1 else ''}"
    step = 10 if n < 100 else 50 if n < 1000 else 100
    return f"{n // step * step}+ reviews"


def _labels(items: Sequence[str]) -> str:
    seen: list[str] = []
    for i in items:
        if i and i not in seen:
            seen.append(i)
    return ", ".join(seen[:MAX_LIST_LABELS])


def _norm_name(s: Any) -> str:
    return " ".join(str(s or "").lower().split())


def _cert_text(entry: Any) -> str:
    """'GAF Master Elite® - Certification' -> 'GAF Master Elite' (GAF's kind suffix and marks dropped)."""
    s = str(entry or "").replace("®", "").replace("™", "").strip()
    return re.sub(r"\s+[-–—]\s+(certification|award|distinction)$", "", s, flags=re.I).strip()


def certification_texts(c: dict[str, Any], tier_text: str) -> list[str]:
    """GAF certifications and distinctions, one line each: the tier itself is left out (its own fact), the
    President's Club carries its stars, and a distinction is marked as one ('Solar (GAF distinction)')."""
    stars = int(c.get("presidents_club_stars") or 0)
    club = f"President's Club {stars} star{'s' if stars != 1 else ''}" if stars else "President's Club"
    out: list[str] = []
    seen = {tier_text.lower()} if tier_text else set()
    entries = [(e, False) for e in c.get("certifications") or []] + [(e, True) for e in c.get("distinctions") or []]
    if stars:
        entries.append((club, False))
    for entry, distinction in entries:
        t = _cert_text(entry)
        if re.fullmatch(r"president'?s club", t, re.I):
            t = club
        if not t or t.lower() in seen:
            continue
        seen.add(t.lower())
        out.append(f"{t} (GAF distinction)" if distinction and "gaf" not in t.lower() else t)
    return out


# --------------------------------------------------------------------------- loading


def load_bundles(conn, company_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
    """Everything build_lead_facts needs for these companies, a few statements per chunk."""
    cols = [companies.c[k] for k in (
        "id", "business_name", "city", "state", "postal_code", "county_fips", "tier", "certifications",
        "distinctions", "presidents_club_stars", "rating", "review_count", "in_business_since", "employees_range",
        "contractor_type", "description", "segment", "system_tags", "account_status", "sales_stage",
        "custom_fields", "scraped_attributes",
    )]
    out: dict[str, dict[str, Any]] = {}
    ids = list(dict.fromkeys(company_ids))
    for i in range(0, len(ids), CHUNK):
        part = ids[i:i + CHUNK]
        for r in conn.execute(select(*cols).where(companies.c.id.in_(part))):
            out[r.id] = {"company": dict(r._mapping), "overrides": {}, "contact_overrides": {}, "contacts": [],
                         "custom_tags": [], "notes": [], "activity": [], "enrichment": {}}
        for r in conn.execute(
            select(field_overrides.c.company_id, field_overrides.c.contact_id, field_overrides.c.field,
                   field_overrides.c.value)
            .where(field_overrides.c.company_id.in_(part), field_overrides.c.superseded_at.is_(None))
            .order_by(field_overrides.c.created_at)
        ):
            b = out.get(r.company_id)
            if b is None:
                continue
            if r.contact_id is None:
                b["overrides"][r.field] = r.value
            else:
                b["contact_overrides"].setdefault(r.contact_id, {})[r.field] = r.value
        for r in conn.execute(
            select(contacts.c.id, contacts.c.company_id, contacts.c.name, contacts.c.title,
                   contacts.c.do_not_contact, contacts.c.confidence)
            .where(contacts.c.company_id.in_(part)).order_by(contacts.c.confidence.desc(), contacts.c.id)
        ):
            if r.company_id in out:
                out[r.company_id]["contacts"].append(dict(r._mapping))
        for r in conn.execute(
            select(company_custom_tags.c.company_id, custom_tags.c.name)
            .join(custom_tags, custom_tags.c.id == company_custom_tags.c.tag_id)
            .where(company_custom_tags.c.company_id.in_(part))
        ):
            if r.company_id in out:
                out[r.company_id]["custom_tags"].append(r.name)
        # Newest notes / activity per company, ranked in SQL so a long history is not read in full.
        rn = func.row_number().over(
            partition_by=(activity_logs.c.company_id, activity_logs.c.action_type == NOTE_TYPE),
            order_by=(activity_logs.c.created_at.desc(), activity_logs.c.id.desc()),
        ).label("rn")
        ranked = (
            select(activity_logs.c.company_id, activity_logs.c.action_type, activity_logs.c.outcome,
                   activity_logs.c.note_text, activity_logs.c.created_at, activity_logs.c.id, users.c.name.label("author"), rn)
            .select_from(activity_logs.outerjoin(users, users.c.id == activity_logs.c.user_id))
            .where(activity_logs.c.company_id.in_(part),
                   activity_logs.c.action_type.in_((NOTE_TYPE, *ACTIVITY_TYPES)))
            .subquery()
        )
        for r in conn.execute(
            select(ranked).where(ranked.c.rn <= MAX_NOTES)
            .order_by(ranked.c.company_id, ranked.c.created_at.desc(), ranked.c.id.desc())
        ):
            b = out.get(r.company_id)
            if b is None:
                continue
            if r.action_type == NOTE_TYPE:
                b["notes"].append(dict(r._mapping))
            elif len(b["activity"]) < MAX_ACTIVITY:
                b["activity"].append(dict(r._mapping))
        for r in conn.execute(
            select(enrichments.c.company_id, enrichments.c.source, enrichments.c.status, enrichments.c.data)
            .where(enrichments.c.company_id.in_(part), enrichments.c.source.in_(("website_crawl", "llm_extract")),
                   enrichments.c.status == "ok")
        ):
            if r.company_id in out:
                out[r.company_id]["enrichment"][r.source] = r.data or {}
    return out


def build_facts(repo, company_ids: Sequence[str]) -> list[LeadFacts]:
    """LeadFacts for these companies, in the given order (unknown ids are left out)."""
    with repo.engine.connect() as conn:
        bundles = load_bundles(conn, company_ids)
    return [build_lead_facts(bundles[c]) for c in dict.fromkeys(company_ids) if c in bundles]


# --------------------------------------------------------------------------- facts


def _effective_contacts(b: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in b["contacts"]:
        ov = b["contact_overrides"].get(c["id"], {})
        out.append({
            "id": c["id"],
            "name": ov.get("name", c["name"]),
            "scraped_name": c["name"],
            "title": ov.get("title", c["title"]),
            "do_not_contact": bool(ov.get("do_not_contact", c["do_not_contact"])),
        })
    return out


def build_lead_facts(b: dict[str, Any]) -> LeadFacts:
    c = b["company"]
    ov = b["overrides"]
    tags = [t for t in (c.get("system_tags") or []) if isinstance(t, dict)]
    tag = {t.get("key"): t for t in tags}
    items: list[tuple[str, str]] = []

    def add(key: str, value: Any, cap: int = FACT_CHARS, prefix: str | None = None) -> None:
        value = str(value if value is not None else "").strip()
        if not value:
            return
        text = clean(f"{prefix or key}: {value}", cap)
        if text and text.split(":", 1)[-1].strip():
            items.append((key, text))

    name = str(ov.get("business_name") or c.get("business_name") or "").strip()
    add("business_name", name)

    city, state, zip_ = (ov.get(k, c.get(k)) for k in ("city", "state", "postal_code"))
    place = ", ".join(p for p in (str(city or "").strip(), " ".join(str(x) for x in (state, zip_) if x)) if p)
    county = county_names().get(str(c.get("county_fips") or ""))
    if place or county:
        add("location", f"{place} ({county})" if place and county else place or county)

    tier_text = TIER_TEXT.get(str(c.get("tier") or ""), "")
    add("gaf_tier", tier_text)
    for t in certification_texts(c, tier_text):
        add("certification", t)

    if c.get("rating") is not None:
        add("rating", f"{float(c['rating']):g} stars from {review_bucket(int(c.get('review_count') or 0))}")
    add("in_business_since", founded_year(c))
    add("employees", c.get("employees_range"))
    add("contractor_type", c.get("contractor_type"))
    add("gaf_description", c.get("description"), cap=DESCRIPTION_CHARS)
    size = (tag.get("size") or {}).get("value")
    add("size", size if size and size != "unknown" else "")
    add("segment", c.get("segment"))

    services: list[str] = []
    materials: list[str] = []
    work_types: list[str] = []
    for t in tags:
        key = str(t.get("key") or "")
        label = str(t.get("label") or "").strip()
        if key.startswith("service:"):
            (materials if key.split(":", 1)[1] in MATERIAL_KEYS else services).append(label)
        elif key.startswith("specialty:"):
            materials.append(label)
        elif key.startswith("work_type:"):
            work_types.append(label)
    llm = b["enrichment"].get("llm_extract") or {}
    for s in llm.get("services") or []:
        label = SERVICE_LABELS.get(str(s))
        if label:
            (materials if s in MATERIAL_KEYS else services).append(label)
    add("services", _labels(services))
    add("materials", _labels(materials))
    add("work_types", _labels(work_types))

    for t in tags:
        key = str(t.get("key") or "")
        if (t.get("category") in TAG_CATEGORIES and key not in EXCLUDED_TAGS
                and not key.startswith(("service:", "specialty:", "work_type:"))):
            add("tag", t.get("label"))

    people = _effective_contacts(b)
    skip_reason = "do_not_contact" if c.get("account_status") == "do_not_contact" else None
    target_ids: set[str] = set()
    tc = (tag.get("target_contact") or {})
    tcc = tc.get("contact") if isinstance(tc.get("contact"), dict) else {}
    role = str(tcc.get("role_label") or tc.get("value") or "").strip().capitalize()
    tname = str(tcc.get("name") or "").strip() if tcc.get("named", bool(tcc.get("name"))) else ""
    if tname:
        match = next((p for p in people if _norm_name(tname) in (_norm_name(p["scraped_name"]), _norm_name(p["name"]))),
                     None)
        title = tcc.get("title")
        if match is not None:
            target_ids.add(match["id"])
            tname, title = match["name"] or tname, match["title"] or title
            if match["do_not_contact"]:
                skip_reason = skip_reason or "do_not_contact"
        add("target_contact", f"{role or 'Contact'} — {tname}" + (f", {title}" if title else ""))
    elif role:
        add("target_contact", f"{role} (name unknown; ask on the main line)")
    extra = [p for p in people if p["id"] not in target_ids and p["name"] and not p["do_not_contact"]]
    seen_names = {_norm_name(tname)} if tname else set()
    n = 0
    for p in extra:
        if _norm_name(p["name"]) in seen_names or n >= MAX_EXTRA_CONTACTS:
            continue
        seen_names.add(_norm_name(p["name"]))
        add("contact", f"{p['name']}, {p['title']}" if p["title"] else p["name"])
        n += 1

    add("account_status", ACCOUNT_LABELS.get(str(c.get("account_status") or ""), c.get("account_status")))
    add("sales_stage", c.get("sales_stage"))
    fields = c.get("custom_fields") or {}
    for k in sorted(fields)[:MAX_CUSTOM_FIELDS]:
        v = fields[k]
        if v is None or v == "":
            continue
        sval = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
        add("custom_field", f"{k} = {clean(sval, CUSTOM_FIELD_VALUE_CHARS)}")
    for t in sorted(set(b["custom_tags"]), key=str.lower)[:MAX_CUSTOM_TAGS]:
        add("custom_tag", t)
    for nrow in b["notes"][:MAX_NOTES]:
        add("note", nrow.get("note_text"), prefix=f"note ({short_name(nrow.get('author'))}, {et_date(nrow.get('created_at'))})")
    for a in b["activity"][:MAX_ACTIVITY]:
        head = ", ".join(x for x in (str(a.get("action_type") or ""), str(a.get("outcome") or ""),
                                     et_date(a.get("created_at"))) if x)
        add("activity", a.get("note_text") or "no details logged", cap=ACTIVITY_CHARS, prefix=f"activity ({head})")
    add("website_summary", llm.get("summary"))

    excerpt = website_excerpt((b["enrichment"].get("website_crawl") or {}).get("pages") or [])
    items, excerpt = fit_budget(items, excerpt)
    facts = [Fact(id=f"F{i}", key=k, text=t) for i, (k, t) in enumerate(items, start=1)]
    return LeadFacts(company_id=str(c["id"]), business_name=clean(name, 255), facts=facts, website_excerpt=excerpt,
                     skip_reason=skip_reason)


def fit_budget(items: list[tuple[str, str]], excerpt: str, budget: int = LEAD_CHARS) -> tuple[list[tuple[str, str]], str]:
    """Keep one lead's prompt under `budget` characters: shorten the website excerpt first, then drop the oldest
    activity rows, then the oldest notes (both are listed newest first)."""
    def size() -> int:
        return sum(len(t) + 5 for _, t in items) + len(excerpt)

    if size() <= budget:
        return items, excerpt
    room = budget - sum(len(t) + 5 for _, t in items)
    excerpt = truncate(excerpt, room) if room >= 400 else ""
    items = list(items)
    for key in ("activity", "note"):
        while size() > budget:
            idx = [i for i, (k, _) in enumerate(items) if k == key]
            if not idx:
                break
            del items[idx[-1]]
    return items, excerpt


def website_excerpt(pages: Sequence[Any], budget: int = WEBSITE_CHARS) -> str:
    """The crawled site packed to `budget` with llm_extract's packer (boilerplate removed, about/team pages first),
    without URLs, scrubbed and fenced."""
    if not pages:
        return ""
    from ..enrich.llm_extract import pack_pages

    packed = pack_pages([p for p in pages if isinstance(p, dict)], budget)
    parts = [f"{p.title}\n{p.text}" if p.title else p.text for p in packed.pages]
    return clean("\n\n".join(parts), budget, one_line=False)


__all__ = [
    "Fact", "LeadFacts", "build_facts", "build_lead_facts", "canonical_json", "clean", "county_names", "facts_from_dict",
    "fence", "fit_budget", "input_hash", "load_bundles", "scrub", "website_excerpt",
]
