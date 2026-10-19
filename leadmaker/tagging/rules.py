"""Deterministic, explainable lead tagging, segmentation and priority scoring.

Every tag carries a `reason` citing the fact it came from and a `source`, so a rep
can see *why* a lead is tagged. Works with GAF data alone; enrichment only adds.

Segments (exactly one, first match wins) -- framed for a roofing *distributor*:
  strategic  Master Elite, President's Club, or very high volume (200+ reviews) / large firm.
             Highest material spend; protect or win wallet share.
  growth     Certified Plus, or Certified with real volume (50+ reviews) or 10+ years and a
             solid reputation. Upsell and tier-upgrade candidates (GAF programme support
             is a distributor talking point).
  emerging   Young (<5 yrs) or low-volume certified firms. Cheap to open, may grow with you.
  long_tail  Little evidence of activity (no reviews, no size/age data). Low priority.

priority_score (0-100) = sum of the weighted components below (see WEIGHTS); the
top contributors are emitted as a `priority_drivers` tag.

Target contact is size-aware (see `target_contact`): small/unknown firms -> owner/officer;
medium/large -> purchasing / office / operations / project manager, then owner. With no named
decision-maker the target is the Owner *role* on the company's main phone. Emitted as the
`decision_maker` tag (identified/weak/none, reason says why) and a `target_contact` tag whose
`contact` field carries the chosen person/role for the export and UI.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any

from ..enrich.matching import tokens
from ..enrich.website_crawl import CONTEXT_SERVICES, CONTEXT_TRACES, scan_services
from .taxonomy import (
    COMMERCIAL_SERVICES, CONTACT_ROLE_LABELS, CONTACT_ROLE_PATTERNS, CONTACT_ROLE_PREFERENCE, DECISION_MAKER_ROLES,
    DISTANCE_BANDS, EXPLICIT_TITLE_BONUS, FALLBACK_ROLE, GAF_SPECIALTIES, GENERIC_MANAGEMENT_PATTERN, GENERIC_TITLE_PATTERN,
    IDENTIFIED_CONFIDENCE, MATURITY_BANDS, MIN_TARGET_CONFIDENCE, MULTI_TRADE_SERVICES, NJ_ZIP3, NY_REGIONS, NY_ZIP3,
    NYC_REGIONS, PREMIUM_MATERIALS, QUEENS, REVIEW_BANDS, ROCKLAND, SAME_PERSON_SIMILARITY, SERVICE_IMPLIES,
    SERVICE_LABELS, STATED_OWNER_TITLE_PATTERN, STORM_SERVICES, TIER_LABELS, WESTCHESTER, WORK_TYPES,
)

WEIGHTS = {
    "tier": {"master_elite": 25, "certified_plus": 17, "certified": 10, "none": 0},
    "volume_max": 20,          # log-scaled review count, saturating at ~500
    "reputation": {"excellent": 8, "good": 5},
    "maturity": {"veteran": 8, "established": 6, "young": 3, "new": 1, "unknown": 2},
    "size": {"large": 8, "medium": 5, "small": 2, "unknown": 2},
    "proximity": {"0-5": 10, "5-10": 7, "10-25": 4},
    "decision_maker": {"identified": 8, "weak": 3},
    "direct_email": 3,
    "website": 3,
    # Zero for now: in this data GAF Leads enrolment == Master Elite (85/85), so it would double-count tier
    # (docs/sales-domain-research.md). Re-weight once it varies independently.
    "gaf_leads": 0,
    "presidents_club": 4,
    "nyc_license_active": 2,
}
CURRENT_YEAR = datetime.now(timezone.utc).year


def _tag(key: str, value: Any, label: str, category: str, reason: str, source: str) -> dict[str, Any]:
    return {"key": key, "value": value, "label": label, "category": category, "reason": reason, "source": source}


def _band(value: float, bands: list[tuple[float, str, str]]) -> tuple[str, str]:
    out = bands[0][1:]
    for lo, key, label in bands:
        if value >= lo:
            out = (key, label)
    return out


def _ok(lead: dict[str, Any], source: str) -> dict[str, Any] | None:
    row = (lead.get("enrichment") or {}).get(source)
    if row and row.get("status") == "ok":
        return row.get("data") or {}
    return None


def _year(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, int):
        return v
    s = str(v)
    return int(s[:4]) if s[:4].isdigit() else None


def region_for(lead: dict[str, Any]) -> str | None:
    city = (lead.get("city") or "").strip().lower()
    state = (lead.get("state") or "").upper()
    z3 = str(lead.get("postal_code") or "")[:3]
    if state == "NY":
        if city in NY_REGIONS:
            return NY_REGIONS[city]
        if city in QUEENS:
            return "Queens"
        if city in WESTCHESTER:
            return "Westchester"
        if city in ROCKLAND:
            return "Rockland"
        return NY_ZIP3.get(z3)
    if state == "NJ":
        return NJ_ZIP3.get(z3)
    return None


def _maturity(lead: dict[str, Any]) -> tuple[int | None, str | None]:
    """Oldest credible founding year across sources -> (year, source)."""
    cands: list[tuple[int, str]] = []
    if lead.get("in_business_since"):
        cands.append((int(lead["in_business_since"]), "gaf"))
    if (d := _ok(lead, "ny_dos")) and (y := _year(d.get("initial_filing_date"))):
        cands.append((y, "ny_dos"))
    if (d := _ok(lead, "nyc_dcwp")) and (y := _year(d.get("license_creation_date"))):
        cands.append((y, "nyc_dcwp"))
    if (d := _ok(lead, "bbb")) and (y := _year(d.get("business_start"))):
        cands.append((y, "bbb"))
    if (d := _ok(lead, "website_crawl")) and (y := _year(d.get("founded_year"))):
        cands.append((y, "website"))
    cands = [(y, s) for y, s in cands if 1850 <= y <= CURRENT_YEAR]
    return min(cands) if cands else (None, None)


def _services(lead: dict[str, Any]) -> tuple[set[str], str | None, dict[str, dict[str, str]]]:
    """(service keys, first source that had any, {service: first website evidence {url, snippet}})."""
    found: set[str] = set()
    src = None
    evidence: dict[str, dict[str, str]] = {}
    for source in ("website_crawl", "llm_extract", "bbb"):
        d = _ok(lead, source)
        if not d or (source == "bbb" and d.get("out_of_business")):
            continue
        got = {str(s) for s in d.get("services") or []}
        if source == "website_crawl":
            stored_ev = d.get("service_evidence")
            for svc, evs in (stored_ev or {}).items():
                if isinstance(evs, list) and evs and isinstance(evs[0], dict):
                    evidence.setdefault(svc, evs[0])
            pages = [(str(p.get("url") or ""), str(p.get("text") or "")) for p in d.get("pages") or []
                     if isinstance(p, dict)]
            if pages:
                # Re-scan the stored page text so detectors added after the crawl (tpo_roofing,
                # new_construction, ...) apply without re-crawling.
                rescanned, _, ev = scan_services(pages)
                if stored_ev is None:
                    # The crawl predates page-aware context services (blog / terms pages, "newly built",
                    # bare "hurricane" / "24 hours"). A stored context service the stored text can't
                    # confirm is dropped when that text holds a rejected mention (the likely source of
                    # the old hit); with no mention at all the hit lies in text that wasn't stored
                    # (nav, boilerplate, the size cap), so it is kept, without evidence.
                    text = "\n".join(t for _, t in pages)
                    got -= {s for s in CONTEXT_SERVICES - set(rescanned) if CONTEXT_TRACES[s].search(text)}
                    got |= set(rescanned)
                else:
                    # Page-aware already; the stored text has lost the link context (homepage cards
                    # pointing at /blog/ posts), so only non-context services are re-derived from it.
                    got |= set(rescanned) - CONTEXT_SERVICES
                for svc, evs in ev.items():
                    if svc in got:
                        evidence.setdefault(svc, evs[0])
        if got:
            found |= got
            src = src or {"website_crawl": "website", "llm_extract": "llm", "bbb": "bbb"}[source]
    for s in list(found):
        found |= SERVICE_IMPLIES.get(s, set())
    return found, src, evidence


def _service_reason(svc: str, evidence: dict[str, dict[str, str]]) -> str:
    ev = evidence.get(svc)
    if not ev or not ev.get("snippet"):
        return "listed on company website"
    snippet = ev["snippet"] if len(ev["snippet"]) <= 160 else ev["snippet"][:157].rsplit(" ", 1)[0] + "…"
    return f"website: “{snippet}” ({ev.get('url')})"


def _size(lead: dict[str, Any], reviews: int) -> tuple[str, str]:
    """(size band, reason) from GAF employees range + review volume; website/LLM hints only explain."""
    emp = lead.get("employees_range")
    crawl = _ok(lead, "website_crawl") or {}
    llm = _ok(lead, "llm_extract") or {}
    size = "unknown"
    size_reason = "no size data"
    if reviews >= 200 and emp != "1-5":
        size, size_reason = "large", f"{reviews} reviews (very high job volume); employees: {emp or 'not listed'}"
    elif emp == "More than 5" or reviews >= 200:
        # A 1-5 person firm with 200+ reviews likely subcontracts crews: volume says medium, not large.
        size, size_reason = "medium", f"employees: {emp or 'not listed'}; {reviews} reviews"
    elif emp == "1-5":
        size, size_reason = "small", "1-5 employees (GAF profile)"
    elif reviews >= 50:
        size, size_reason = "medium", f"{reviews} reviews suggests steady volume"
    if crawl.get("team_size_hint"):
        size_reason += f"; website: {crawl['team_size_hint']}"
    if isinstance(llm.get("company_size"), dict) and llm["company_size"].get("employees_estimate_range"):
        size_reason += f"; LLM estimate: {llm['company_size']['employees_estimate_range']}"
    return size, size_reason


_ROLE_RES = {role: re.compile(rx, re.I) for role, rx in CONTACT_ROLE_PATTERNS.items()}
_GENERIC_TITLE = re.compile(GENERIC_TITLE_PATTERN, re.I)
_STATED_OWNER = re.compile(STATED_OWNER_TITLE_PATTERN, re.I)
_GENERIC_MANAGEMENT = re.compile(GENERIC_MANAGEMENT_PATTERN, re.I)
_NAME_SUFFIX = {"jr", "sr", "ii", "iii", "iv"}
_LARGE_PREF_TEXT = "purchasing/office/operations/PM, then owner"
_PREF_TEXT = {"small": "owner", "unknown": "owner", "medium": _LARGE_PREF_TEXT, "large": _LARGE_PREF_TEXT}


def contact_roles(title: str | None) -> set[str]:
    """Every role a title supports ("Owner / Office Manager" -> {owner, office}); {"other"} if none."""
    roles = {role for role, rx in _ROLE_RES.items() if rx.search(title or "")}
    return roles or {"other"}


def explicit_title(title: str | None) -> bool:
    """A stated job title ("President", "Chairman/CEO (NY DOS filing)"), not a generic source note
    ("Company officer (FMCSA MCS-150)", "Business management") or a bare "Vice President"."""
    if not title or _GENERIC_TITLE.search(title):
        return False
    roles = contact_roles(title)
    return roles != {"other"} and (roles != {"owner"} or bool(_STATED_OWNER.search(title)))


def _role_rank(role: str, title: str | None, pref: tuple[str, ...]) -> float:
    rank = float(pref.index(role))
    if role == "operations" and _GENERIC_MANAGEMENT.search(title or ""):
        rank = max(rank, pref.index("owner")) + 0.5  # right after the owner role, at every size
    return rank


def _person_tokens(name: str) -> list[str]:
    return [t for t in tokens(name) if t not in _NAME_SUFFIX]


def same_person(a: str, b: str) -> bool:
    """'Giberto Alas Quijada' == 'Gilberto Alas Quijada'; 'William A. Alas Valdez' == 'William Alexander Alas Valdez'.
    Never merged: different middle initials ('Edward B. Carolan' President / 'Edward P. Carolan' Vice President
    on 1006073), different suffixes (Jr / Sr), or first names that end differently ('Paul' / 'Paula',
    'Antonio' / 'Antonia')."""
    ta, tb = _person_tokens(a), _person_tokens(b)
    if len(ta) < 2 or len(tb) < 2:
        return ta == tb and bool(ta)
    if ta[1:-1] and tb[1:-1] and ta[1][0] != tb[1][0]:
        return False
    sa, sb = ({t for t in tokens(n) if t in _NAME_SUFFIX} for n in (a, b))
    if sa and sb and sa != sb:
        return False
    if ta[0] == tb[0] and ta[-1] == tb[-1]:
        return True
    first_ok = ta[0][-1] == tb[0][-1] and (
        SequenceMatcher(None, ta[0], tb[0]).ratio() >= 0.85
        or (min(len(ta[0]), len(tb[0])) >= 3 and (ta[0].startswith(tb[0]) or tb[0].startswith(ta[0]))))
    return first_ok and SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio() >= SAME_PERSON_SIMILARITY


def dedupe_contacts(contacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per person. The row with a stated title (then the highest confidence) supplies title and
    source; the name is the most common spelling (then the longest); confidence is the group's best;
    email/phone are filled from any row; `also_sources` lists the other sources that named the person."""
    groups: list[list[dict[str, Any]]] = []
    for c in contacts:
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        for g in groups:
            if any(same_person(name, str(o["name"])) for o in g):
                g.append(c)
                break
        else:
            groups.append([c])
    out: list[dict[str, Any]] = []
    for g in groups:
        if len(g) == 1:
            out.append(g[0])
            continue
        best = max(g, key=lambda c: (explicit_title(c.get("title")), float(c.get("confidence") or 0)))
        spellings = Counter(str(c["name"]).strip() for c in g)
        merged = {**best, "name": max(spellings, key=lambda n: (spellings[n], len(n))),
                  "confidence": max(float(c.get("confidence") or 0) for c in g)}
        for k in ("email", "phone"):
            merged[k] = best.get(k) or next((c.get(k) for c in g if c.get(k)), None)
        others = sorted({str(c.get("source")) for c in g if c is not best and c.get("source") != best.get("source")})
        if others:
            merged["also_sources"] = others
        out.append(merged)
    return out


def _role_title(c: dict[str, Any]) -> str | None:
    """Title used for role logic: BBB lists untitled people only under management, so read them as that."""
    return c.get("title") or ("Business management" if c.get("source") == "bbb" else None)


def _who(c: dict[str, Any]) -> str:
    also = f"; also {', '.join(c['also_sources'])}" if c.get("also_sources") else ""
    return f"{c['name']} ({c.get('title') or 'no title'}, {c.get('source')} @ {c.get('confidence')}{also})"


def target_contact(lead: dict[str, Any], size: str = "unknown") -> dict[str, Any]:
    """The person -- or, failing that, the role -- a rep should ask for, given company size.

    Contacts are first merged per person (`dedupe_contacts`), then ranked by confidence tier
    (>= IDENTIFIED_CONFIDENCE, >= MIN_TARGET_CONFIDENCE, below = hint only), then the size's role
    preference (CONTACT_ROLE_PREFERENCE), then confidence, with a stated title (`explicit_title`) winning
    over a generic source note within EXPLICIT_TITLE_BONUS, so a well-sourced officer still beats a
    shaky office-manager guess at a larger firm. If no credible
    contact holds a decision-maker role for this size, the target is the Owner role on the company's
    main phone (`name=None`, `fallback=True`) and the best lead on a name is kept as `hint`.
    `status` is the decision_maker tag value: identified | weak | none.
    """
    pref = CONTACT_ROLE_PREFERENCE.get(size, CONTACT_ROLE_PREFERENCE["unknown"])
    dm_roles = DECISION_MAKER_ROLES.get(size, DECISION_MAKER_ROLES["unknown"])
    ranked: list[tuple[int, float, float, str, dict[str, Any]]] = []
    for c in dedupe_contacts(lead.get("contacts") or []):
        role = min(contact_roles(_role_title(c)), key=pref.index)
        conf = float(c.get("confidence") or 0)
        tier = 0 if conf >= IDENTIFIED_CONFIDENCE else 1 if conf >= MIN_TARGET_CONFIDENCE else 2
        score = conf + (EXPLICIT_TITLE_BONUS if explicit_title(c.get("title")) else 0.0)
        ranked.append((tier, _role_rank(role, _role_title(c), pref), -score, role, c))
    ranked.sort(key=lambda r: r[:3])
    named = [r for r in ranked if r[0] < 2 and r[3] in dm_roles]
    head = f"size={size} → {_PREF_TEXT.get(size, 'owner')}"
    if named:
        tier, rank, _, role, c = named[0]
        status = "identified" if tier == 0 else "weak"
        out: dict[str, Any] = {
            "role": role, "role_label": CONTACT_ROLE_LABELS[role], "name": c["name"], "title": c.get("title"),
            "email": c.get("email"), "phone": c.get("phone") or lead.get("phone"),
            "phone_is_main_line": not c.get("phone"), "source": c.get("source"), "confidence": c.get("confidence"),
            "named": True, "fallback": False,
        }
        why = f"chose {CONTACT_ROLE_LABELS[role].lower()}: {_who(c)}"
        skipped = next((r for r in ranked if r[1] < rank and r[3] in dm_roles), None)
        if skipped is not None:  # a preferred role exists but only at a lower confidence tier
            why += f"; passed over {CONTACT_ROLE_LABELS[skipped[3]].lower()} {_who(skipped[4])} (lower confidence)"
        elif rank > 0:
            why += f"; no {'/'.join(r.replace('project_manager', 'PM') for r in pref[:math.ceil(rank)])} contact found"
    else:
        status = "weak" if ranked else "none"
        out = {
            "role": FALLBACK_ROLE, "role_label": CONTACT_ROLE_LABELS[FALLBACK_ROLE], "name": None, "title": None,
            "email": None, "phone": lead.get("phone"), "phone_is_main_line": True, "source": "fallback",
            "confidence": None, "named": False, "fallback": True,
        }
        why = "no named decision-maker → ask for the Owner on the main line (name unknown)"
        if ranked:
            hint = next((r[4] for r in ranked if r[3] == FALLBACK_ROLE), ranked[0][4])
            out["hint"] = {k: hint.get(k) for k in ("name", "title", "source", "confidence")}
            why += f"; possible contact: {_who(hint)}"
    out.update(size=size, status=status, reason=f"{head}; {why}")
    return out


def tag_lead(lead: dict[str, Any]) -> dict[str, Any]:
    tags: list[dict[str, Any]] = []
    score: dict[str, float] = {}

    # --- certification ------------------------------------------------------
    tier = lead.get("tier") or "none"
    tags.append(_tag("gaf_tier", tier, TIER_LABELS.get(tier, tier), "certification",
                     "GAF residential certification level", "gaf"))
    score["GAF tier"] = WEIGHTS["tier"].get(tier, 0)
    stars = int(lead.get("presidents_club_stars") or 0)
    if stars:
        tags.append(_tag("presidents_club", stars, f"President's Club {stars}★", "certification",
                         "GAF President's Club award (top GAF purchasers)", "gaf"))
        score["President's Club"] = WEIGHTS["presidents_club"]
    if lead.get("gaf_leads_enrolled"):
        tags.append(_tag("gaf_leads", True, "GAF Leads programme", "certification",
                         "enrolled to receive homeowner leads from GAF — steady demand", "gaf"))
        if WEIGHTS["gaf_leads"]:
            score["GAF Leads"] = WEIGHTS["gaf_leads"]
    if lead.get("gaf_recommended"):
        tags.append(_tag("gaf_recommended", lead.get("gaf_recommended_rank"),
                         f"GAF top pick #{lead.get('gaf_recommended_rank')}", "certification",
                         "ranked in GAF's own 'Most Relevant' results for this area", "gaf"))

    # --- reputation & volume -----------------------------------------------
    reviews = int(lead.get("review_count") or 0)
    rkey, rlabel = _band(reviews, REVIEW_BANDS)
    tags.append(_tag("review_volume", rkey, rlabel, "size", f"{reviews} Google reviews on GAF profile", "gaf"))
    score["Review volume"] = WEIGHTS["volume_max"] * min(1.0, math.log10(1 + reviews) / math.log10(501))
    rating = lead.get("rating")
    if rating is not None and reviews >= 5:
        rep = "excellent" if rating >= 4.8 and reviews >= 10 else "good" if rating >= 4.5 else "mixed"
        tags.append(_tag("reputation", rep, f"{rating:.1f}★ ({rep})", "reputation",
                         f"rating {rating} over {reviews} reviews", "gaf"))
        score["Reputation"] = WEIGHTS["reputation"].get(rep, 0)
    dates = [r.get("published_at") for r in lead.get("reviews") or [] if r.get("published_at")]
    if dates:
        latest = max(d if isinstance(d, datetime) else datetime.fromisoformat(str(d)) for d in dates)
        latest = latest if latest.tzinfo else latest.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - latest).days <= 180:
            tags.append(_tag("recent_reviews", True, "Reviewed in last 6 months", "reputation",
                             f"latest review {latest.date()}", "gaf"))

    # --- maturity -----------------------------------------------------------
    year, ysrc = _maturity(lead)
    if year:
        age = CURRENT_YEAR - year
        mkey, mlabel = _band(age, MATURITY_BANDS)
        tags.append(_tag("maturity", mkey, mlabel, "maturity", f"in business since {year} (per {ysrc})", ysrc or "gaf"))
    else:
        mkey = "unknown"
    score["Maturity"] = WEIGHTS["maturity"][mkey]

    # --- size ---------------------------------------------------------------
    emp = lead.get("employees_range")
    crawl = _ok(lead, "website_crawl") or {}
    size, size_reason = _size(lead, reviews)
    if size != "unknown":
        tags.append(_tag("size", size, f"Size: {size}", "size", size_reason, "derived"))
    if emp:
        tags.append(_tag("employees", emp, f"{emp} employees", "size", "GAF profile 'Number of Employees'", "gaf"))
    score["Size"] = WEIGHTS["size"][size]

    # --- geography ----------------------------------------------------------
    dist = lead.get("distance_miles")
    if dist is not None:
        dkey = next((k for hi, k, _ in DISTANCE_BANDS if dist <= hi), "10-25")
        dlabel = next((lbl for hi, k, lbl in DISTANCE_BANDS if k == dkey), dkey)
        tags.append(_tag("distance_band", dkey, dlabel, "geography", f"{dist:.1f} mi from search origin", "derived"))
        score["Proximity"] = WEIGHTS["proximity"][dkey]
    if lead.get("state"):
        tags.append(_tag("state", lead["state"], lead["state"], "geography", "GAF listing address", "gaf"))
    region = region_for(lead)
    if region:
        tags.append(_tag("region", region, region, "geography",
                         f"{lead.get('city')}, {lead.get('state')} {lead.get('postal_code')}", "derived"))

    # --- specialties & services --------------------------------------------
    for code in lead.get("specialties") or []:
        norm = str(code).upper().replace("™", "").replace(" ROOF", "").strip()
        key, label = GAF_SPECIALTIES.get(norm, (norm.lower().replace(" ", "_"), str(code).title()))
        tags.append(_tag(f"specialty:{key}", True, label, "specialty", "GAF-listed specialty", "gaf"))
    services, ssrc, evidence = _services(lead)
    for s in sorted(services):
        if s in SERVICE_LABELS:
            tags.append(_tag(f"service:{s}", True, SERVICE_LABELS[s], "services", _service_reason(s, evidence),
                             ssrc or "website"))
    if services & COMMERCIAL_SERVICES:
        tags.append(_tag("focus", "residential_and_commercial", "Also commercial / flat roofing", "services",
                         "commercial or flat-roof services found", ssrc or "website"))
    if services & STORM_SERVICES:
        tags.append(_tag("storm_insurance", True, "Storm / insurance work", "services",
                         "storm-damage or insurance-claim services found", ssrc or "website"))
    if services & PREMIUM_MATERIALS:
        tags.append(_tag("premium_materials", True, "Slate / metal / tile", "services",
                         "premium roofing materials offered", ssrc or "website"))
    if len(services & MULTI_TRADE_SERVICES) >= 2:
        tags.append(_tag("multi_trade", True, "Multi-trade exterior contractor", "services",
                         "also offers " + ", ".join(sorted(services & MULTI_TRADE_SERVICES)), ssrc or "website"))
    for wkey, (wlabel, wservices, why) in WORK_TYPES.items():
        if services & wservices:
            tags.append(_tag(f"work_type:{wkey}", True, wlabel, "work_type",
                             f"{', '.join(sorted(services & wservices))} found; {why}", ssrc or "website"))

    # --- compliance & registries -------------------------------------------
    dcwp_row = (lead.get("enrichment") or {}).get("nyc_dcwp")
    if dcwp_row and dcwp_row.get("status") == "ok":
        d = dcwp_row.get("data") or {}
        status = str(d.get("license_status") or "unknown").lower()
        tags.append(_tag("nyc_hic_license", status, f"NYC HIC license: {status}", "compliance",
                         f"NYC DCWP license {d.get('license_number')} ({d.get('license_status')})", "nyc_dcwp"))
        if status == "active":
            score["NYC license"] = WEIGHTS["nyc_license_active"]
    elif dcwp_row and dcwp_row.get("status") == "no_match" and region in NYC_REGIONS:
        tags.append(_tag("nyc_hic_license", "not_found", "No NYC HIC license found", "compliance",
                         "NYC-based contractor not found in DCWP licence data — verify before extending credit",
                         "nyc_dcwp"))
    if (d := _ok(lead, "ny_dos")):
        tags.append(_tag("registered_entity", d.get("entity_type") or "registered",
                         f"NY entity: {d.get('entity_name')}", "compliance",
                         f"NY DOS #{d.get('dos_id')}, filed {str(d.get('initial_filing_date') or '')[:10]}", "ny_dos"))

    # --- digital presence ---------------------------------------------------
    if lead.get("website"):
        tags.append(_tag("website", True, "Website found", "digital", lead["website"], lead.get("website_source") or "derived"))
        score["Website"] = WEIGHTS["website"]
    social = crawl.get("social") or {}
    if social:
        tags.append(_tag("social", sorted(social), f"Social: {', '.join(sorted(social))[:60]}", "digital",
                         "social links on website", "website"))

    ws = _ok(lead, "web_signals")
    if ws:
        if ws.get("advertises") or ws.get("ad_pixels"):
            tags.append(_tag("advertises", True, "Runs paid ads", "digital",
                             "ad pixels on site: " + ", ".join(ws.get("ad_pixels") or [])[:80], "website"))
        fin = ws.get("financing") or {}
        if fin.get("offered"):
            prov = ", ".join(fin.get("providers") or []) or "provider not named"
            tags.append(_tag("offers_financing", True, "Offers homeowner financing", "digital", prov, "website"))
        elif ws.get("talking_points"):
            tags.append(_tag("offers_financing", False, "No financing advertised — pitch ours", "digital",
                             "no homeowner financing found on website", "website"))
        brands = [str(b) for b in ws.get("brands") or []]
        rivals = [b for b in brands if "gaf" not in b.lower()]
        if rivals:
            tags.append(_tag("competitor_brands", rivals, "Also shows " + ", ".join(rivals[:3]), "digital",
                             "manufacturer brands featured on website", "website"))
        if ws.get("marketing_score") is not None:
            ms = int(ws["marketing_score"])
            tags.append(_tag("marketing_sophistication", ms, f"Marketing score {ms}/10", "digital",
                             "ads, analytics, CRM, chat, financing, reviews widgets", "website"))

    # --- contactability -----------------------------------------------------
    target = target_contact(lead, size)
    dm_status = target["status"]
    shown = target if target["named"] else target.get("hint") or {}
    if dm_status == "identified":
        dm_label = f"DM: {shown['name']} ({shown.get('title')})"
    elif dm_status == "weak":
        dm_label = f"Possible contact: {shown['name']}"
    else:
        dm_label = "No decision-maker yet — ask for the Owner"
    tags.append(_tag("decision_maker", dm_status, dm_label, "contactability", target["reason"],
                     shown.get("source") or "derived"))
    if dm_status in WEIGHTS["decision_maker"]:
        score["Decision-maker"] = WEIGHTS["decision_maker"][dm_status]
    tc_label = (f"Ask for: {target['name']} ({target['role_label']})" if target["named"]
                else "Ask for: the Owner (name unknown, main line)")
    tc_tag = _tag("target_contact", target["role"], tc_label, "contactability", target["reason"],
                  target["source"] if target["named"] else "derived")
    tc_tag["contact"] = {k: v for k, v in target.items() if k != "reason"}
    tags.append(tc_tag)
    emails = crawl.get("emails") or []
    if emails:
        tags.append(_tag("direct_email", emails[0], "Email available", "contactability", "email on company website", "website"))
        score["Email"] = WEIGHTS["direct_email"]
    has_contact = target["named"] or "hint" in target
    present = [bool(lead.get("phone")), bool(lead.get("website")), has_contact, bool(year),
               size != "unknown", bool(services), bool(emails)]
    completeness = round(100 * sum(present) / len(present))
    tags.append(_tag("data_completeness", completeness, f"Profile {completeness}% complete", "data_quality",
                     "phone, website, contact, age, size, services, email", "derived"))

    # --- segment ------------------------------------------------------------
    age = (CURRENT_YEAR - year) if year else None
    rep_ok = rating is not None and rating >= 4.5
    if tier == "master_elite" or stars or reviews >= 200 or size == "large":
        segment = "strategic"
    elif tier == "certified_plus" or (reviews >= 50 and rep_ok) or (age is not None and age >= 10 and reviews >= 10):
        segment = "growth"
    elif (age is not None and age < 5) or 1 <= reviews < 50:
        segment = "emerging"
    else:
        segment = "long_tail"

    priority = round(min(100.0, sum(score.values())), 1)
    drivers = sorted(((k, v) for k, v in score.items() if v > 0), key=lambda kv: -kv[1])[:3]
    tags.append(_tag("priority_drivers", [k for k, _ in drivers],
                     "Why: " + ", ".join(k for k, _ in drivers), "priority",
                     "; ".join(f"{k} +{v:.0f}" for k, v in drivers), "derived"))
    seen: set[str] = set()
    unique = [t for t in tags if not (t["key"] in seen or seen.add(t["key"]))]  # first tag per key wins
    return {"tags": unique, "segment": segment, "priority_score": priority, "target_contact": target}
