"""Name/locality helpers shared by the public-registry enrichers (ny_dos, nyc_dcwp).

`leadmaker.enrich.matching.normalize_name` (loose mode) strips trade words such as
"roofing"/"construction", which is right for fuzzy *candidate* retrieval but far too
lenient for accepting a name-only match: "Top Roof LLC" and "Top Home Improvement"
both reduce to "top". Registries hold tens of thousands of near-namesakes, so here we
compare names *strictly* (only legal forms removed) and treat locality, legal form and
token rarity as separate evidence.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from .matching import normalize_name, zip5

LEGAL_FORMS = {
    "inc", "incorporated", "llc", "corp", "corporation", "co", "company", "ltd", "limited",
    "lp", "llp", "pllc", "pc",
}
FILLER = {"the", "and", "dba", "of"}
SYNONYMS = {
    "bros": "brothers", "bro": "brother", "constr": "construction", "const": "construction",
    "contr": "contracting", "svcs": "services", "svc": "service", "intl": "international",
    "mgmt": "management", "impr": "improvement", "improv": "improvement", "hm": "home",
    "assoc": "associates", "st": "saint", "mt": "mount",
}
CORP_WORDS = {"inc", "incorporated", "corp", "corporation", "ltd", "limited", "co", "company", "pc"}
LLC_WORDS = {"llc", "pllc", "l.l.c"}

# NYC: GAF lists boroughs/neighbourhoods inconsistently ("Queens" vs "Flushing"), so map
# 5-digit ZIPs to boroughs for a weak same-area signal.
_NYC_ZIP3_BOROUGH = {
    "100": "manhattan", "101": "manhattan", "102": "manhattan", "103": "staten island",
    "104": "bronx", "112": "brooklyn", "111": "queens", "113": "queens",
    "114": "queens", "116": "queens",
}
# 110xx is mostly Nassau County (Floral Park, Great Neck, Port Washington); only these are Queens.
_NYC_ZIP5_BOROUGH = {"11004": "queens", "11005": "queens"}


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def _singular(t: str) -> str:
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
        return t[:-1]
    return t


def strict_tokens(name: str | None) -> list[str]:
    """Tokens with only legal forms / filler removed; apostrophes joined, plurals folded.

    "Four R's Contracting, Inc." -> ['four', 'r', 'contracting']
    "M&J Roofing & Chimney LLC"  -> ['m', 'j', 'roofing', 'chimney']
    """
    if not name:
        return []
    s = name.replace("’", "'").replace("‘", "'")
    s = _ascii(s).lower()
    s = re.sub(r"\bl\.\s?l\.\s?c\b\.?", " llc ", s)  # "L.L.C."
    s = re.sub(r"'s\b", "", s)  # possessive: "tony's" -> "tony"
    s = s.replace("'", "")
    s = s.replace("&", " and ").replace("+", " and ")
    s = re.sub(r"\bd\s*/\s*b\s*/\s*a\b", " dba ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    out: list[str] = []
    for t in s.split():
        t = SYNONYMS.get(t, t)
        if t in LEGAL_FORMS or t in FILLER:
            continue
        out.append(_singular(t))
    # "New York" and "NY" are used interchangeably in business names.
    joined = " ".join(out).replace("new york", "ny").replace("new jersey", "nj")
    return joined.split()


def strict_key(name: str | None) -> str:
    return " ".join(strict_tokens(name))


def strict_similarity(a: str | None, b: str | None) -> float:
    """0..1; 1.0 only when names agree on every non-legal-form word (order-insensitive).

    Shared trade words inflate plain string similarity ("Doda Brothers Construction" vs
    "Cando Brothers Construction" is 0.9 by SequenceMatcher), so when both names have
    distinctive words the score is capped by how well *those* agree.
    """
    ta, tb = strict_tokens(a), strict_tokens(b)
    if not ta or not tb:
        return 0.0
    ka, kb = " ".join(ta), " ".join(tb)
    if ka == kb or sorted(ta) == sorted(tb):
        return 1.0
    # Spacing variants: "skyward" vs "sky ward", "a l best" vs "al best".
    if ka.replace(" ", "") == kb.replace(" ", ""):
        return 0.98
    sa, sb = set(ta), set(tb)
    full = max(SequenceMatcher(None, ka, kb).ratio(), len(sa & sb) / len(sa | sb))
    da, db = _distinct(ta), _distinct(tb)
    if da and db:
        ja, jb = " ".join(da), " ".join(db)
        if ja != jb and ja.replace(" ", "") != jb.replace(" ", "") and sorted(da) != sorted(db):
            dsim = max(SequenceMatcher(None, ja, jb).ratio(),
                       len(set(da) & set(db)) / len(set(da) | set(db)))
            full = min(full, dsim)
    return full


GENERIC = {
    "roofing", "roof", "roofer", "construction", "contracting", "contractor", "home", "improvement",
    "service", "group", "enterprise", "ny", "nj", "usa", "general", "builder", "building", "remodeling",
    "renovation", "exterior", "siding", "window", "gutter", "solution", "pro", "inc", "development",
}


def _distinct(toks: list[str]) -> list[str]:
    return [t for t in toks if t not in GENERIC and (len(t) >= 2 or t.isdigit())]


def distinctive_tokens(name: str | None) -> list[str]:
    """Words that actually identify the business (trade words, legal forms, initials removed)."""
    return _distinct(strict_tokens(name))


def legal_form(name: str | None) -> str | None:
    """'llc' | 'corp' | None, from the name's suffix words."""
    if not name:
        return None
    s = _ascii(name).lower()
    if re.search(r"\bl\.?\s?l\.?\s?c\b", s) or re.search(r"\bpllc\b", s):
        return "llc"
    words = set(re.sub(r"[^a-z0-9]+", " ", s).split())
    if words & CORP_WORDS:
        return "corp"
    return None


def nyc_borough_of_zip(z: str | None) -> str | None:
    z5 = zip5(z)
    return (_NYC_ZIP5_BOROUGH.get(z5) or _NYC_ZIP3_BOROUGH.get(z5[:3])) if z5 else None


def norm_city(c: str | None) -> str:
    s = re.sub(r"[^a-z ]+", " ", _ascii(c or "").lower())
    s = re.sub(r"\bvlg\b", "village", s)
    s = re.sub(r"\bhts\b", "heights", s)
    s = re.sub(r"\btwp\b", "township", s)
    s = re.sub(r"\bmt\b", "mount", s)
    s = re.sub(r"\bs\b", "south", s)
    s = re.sub(r"\bn\b", "north", s)
    s = re.sub(r"\be\b", "east", s)
    s = re.sub(r"\bw\b", "west", s)
    return " ".join(s.split())


@dataclass
class Locality:
    """How close a registry address is to the contractor's GAF address."""

    same_zip: bool = False
    same_city: bool = False
    same_zip3: bool = False
    same_borough: bool = False
    same_state: bool = False
    other_state: bool = False  # address present and in a different state
    distance_miles: float | None = None

    def bonus(self) -> float:
        """Additive confidence adjustment for name-only matches."""
        if self.same_zip or (self.distance_miles is not None and self.distance_miles <= 1.5):
            return 0.3
        if self.same_city or (self.distance_miles is not None and self.distance_miles <= 4):
            return 0.2
        if self.same_borough or self.same_zip3 or (self.distance_miles is not None and self.distance_miles <= 10):
            return 0.1
        if self.same_state:
            return 0.0
        if self.other_state:
            return -0.15
        return 0.0

    def merge(self, other: "Locality") -> "Locality":
        """Best evidence across several addresses of one record."""
        d = [x for x in (self.distance_miles, other.distance_miles) if x is not None]
        return Locality(
            same_zip=self.same_zip or other.same_zip,
            same_city=self.same_city or other.same_city,
            same_zip3=self.same_zip3 or other.same_zip3,
            same_borough=self.same_borough or other.same_borough,
            same_state=self.same_state or other.same_state,
            other_state=(self.other_state or other.other_state) and not (self.same_state or other.same_state),
            distance_miles=min(d) if d else None,
        )

    def describe(self) -> str:
        bits = [k for k in ("same_zip", "same_city", "same_borough", "same_zip3", "same_state", "other_state")
                if getattr(self, k)]
        if self.distance_miles is not None:
            bits.append(f"{self.distance_miles:.1f}mi")
        return ",".join(bits) or "none"


_BOROUGH_CITY = {"queens": "queens", "brooklyn": "brooklyn", "bronx": "bronx", "manhattan": "manhattan",
                 "new york": "manhattan", "staten island": "staten island"}


def compare_locality(contractor: dict[str, Any], *, city: str | None, state: str | None,
                     zip_code: str | None, distance_miles: float | None = None) -> Locality:
    cz, rz = zip5(contractor.get("postal_code")), zip5(zip_code)
    cs = (contractor.get("state") or "").strip().upper()
    rs = (state or "").strip().upper()
    cc, rc = norm_city(contractor.get("city")), norm_city(city)
    cb = nyc_borough_of_zip(cz) or _BOROUGH_CITY.get(cc)
    rb = nyc_borough_of_zip(rz) or _BOROUGH_CITY.get(rc)
    same_borough = bool(cb and rb and cb == rb)
    return Locality(
        same_zip=bool(cz and rz and cz == rz),
        same_city=bool(cc and rc and cc == rc),
        same_zip3=bool(cz and rz and cz[:3] == rz[:3]),
        same_borough=same_borough,
        same_state=bool(cs and rs and cs == rs),
        other_state=bool(cs and rs and len(rs) == 2 and cs != rs),
        distance_miles=distance_miles,
    )


_NAME_PARTICLES = {"de", "del", "della", "da", "di", "van", "von", "der", "la", "le", "dos", "das", "y"}
_SUFFIXES = {"jr": "Jr.", "sr": "Sr.", "ii": "II", "iii": "III", "iv": "IV"}


def _cap_word(w: str, first: bool) -> str:
    lw = w.lower()
    bare = lw.rstrip(".,")
    if bare in _SUFFIXES:
        return _SUFFIXES[bare]
    if not first and lw in _NAME_PARTICLES:
        return lw
    if "-" in w:
        return "-".join(_cap_word(p, True) for p in w.split("-"))
    if "'" in w:  # O'Brien, D'Angelo
        head, _, tail = w.partition("'")
        return _cap_word(head, True) + "'" + _cap_word(tail, True) if tail else _cap_word(head, True) + "'"
    if len(bare) == 1:
        return w.upper() + ("" if w.endswith(".") else "")
    if lw.startswith("mc") and len(lw) > 3:
        return "Mc" + lw[2:].capitalize()
    return lw.capitalize()


def title_case_person(name: str | None) -> str | None:
    """'ANDRES ABADIA' -> 'Andres Abadia'; 'DIAZ JR, ROBERTO' -> 'Roberto Diaz Jr.'."""
    if not name:
        return None
    s = " ".join(name.replace("’", "'").split()).strip(" ,")
    if not s:
        return None
    if s.count(",") == 1:  # "LAST, FIRST" (DCWP individual licensees)
        last, first = (p.strip() for p in s.split(","))
        # "SMITH, JR." is a suffix, not last/first
        if first.lower().rstrip(".") in _SUFFIXES:
            s = f"{last} {first}"
        else:
            suffix = ""
            parts = last.split()
            if len(parts) > 1 and parts[-1].lower().rstrip(".") in _SUFFIXES:
                suffix = " " + parts.pop()
            s = f"{first} {' '.join(parts)}{suffix}"
    words = s.split()
    return " ".join(_cap_word(w, i == 0) for i, w in enumerate(words))


_ORG_WORDS = {
    "llc", "inc", "corp", "corporation", "company", "co", "ltd", "limited", "lp", "llp", "pllc", "pc",
    "services", "service", "agent", "agents", "registered", "corporate", "law", "office", "offices",
    "attorney", "attorneys", "esq", "esquire", "cpa", "accounting", "accountants", "tax", "group",
    "associates", "partners", "the", "trust", "bank", "management", "solutions", "systems", "holdings",
    "enterprises", "international", "national", "authority", "filings", "filing", "incorporating",
    "formations", "registered", "legal", "counsel", "firm", "united", "states", "america", "usa", "ny",
    "nj", "new", "york", "roofing", "construction", "contracting", "realty", "properties", "capital",
    "secretary", "state", "c/o", "care", "president", "corporations",
}


def looks_like_person(name: str | None, entity_name: str | None = None) -> bool:
    """Heuristic: 2-4 alphabetic words, no organisation words, not the entity itself."""
    if not name:
        return False
    s = re.sub(r"^\s*(c/o|attn:?|attention:?)\s+", "", _ascii(name).strip(), flags=re.I)
    if not s or any(ch.isdigit() for ch in s) or "&" in s or re.search(r"\band\b", s, re.I):
        return False  # "AHMUTY DEMERS & MCMANUS" is a law firm, not a person
    words = re.sub(r"[^A-Za-z' ,.-]+", " ", s).replace(",", " ").split()
    words = [w.strip(".") for w in words if w.strip(".")]
    if not 2 <= len(words) <= 4:
        return False
    if any(w.lower().strip("'") in _ORG_WORDS for w in words):
        return False
    if entity_name and strict_similarity(name, entity_name) >= 0.8:
        return False
    return True
