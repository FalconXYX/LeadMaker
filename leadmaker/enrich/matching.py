"""Entity-resolution helpers shared by enrichers."""

from __future__ import annotations

import math
import re
import unicodedata
from difflib import SequenceMatcher

# Legal-form and filler tokens that don't distinguish one business from another.
_STOP = {
    "inc", "incorporated", "llc", "l.l.c", "corp", "corporation", "co", "company", "ltd", "limited",
    "lp", "llp", "pllc", "pc", "the", "and", "of", "dba", "d/b/a", "group", "services", "service",
    "contracting", "contractors", "contractor", "construction", "roofing", "roof", "roofers",
    "home", "improvement", "improvements", "enterprises", "enterprise", "ny", "nj", "usa",
}
# Words kept for "strict" normalisation (only legal forms removed).
_LEGAL = {"inc", "incorporated", "llc", "corp", "corporation", "co", "company", "ltd", "limited",
          "lp", "llp", "pllc", "pc", "the"}


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def tokens(name: str | None) -> list[str]:
    if not name:
        return []
    s = _ascii(name).lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.split()


def normalize_name(name: str | None, strict: bool = False) -> str:
    """'ADH Group, Inc.' -> 'adh' (loose) / 'adh group' (strict)."""
    stop = _LEGAL if strict else _STOP
    toks = [t for t in tokens(name) if t not in stop]
    if not toks:  # name made only of stop words, e.g. "Roofing Company"
        toks = [t for t in tokens(name) if t not in _LEGAL]
    return " ".join(toks)


def name_similarity(a: str | None, b: str | None) -> float:
    """0..1 similarity robust to legal suffixes, word order and filler words."""
    if not a or not b:
        return 0.0
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    sa, sb = set(na.split()), set(nb.split())
    jacc = len(sa & sb) / len(sa | sb)
    seq = SequenceMatcher(None, na, nb).ratio()
    # Token containment ("adh" vs "adh home") is a strong partial signal.
    contain = 1.0 if (sa <= sb or sb <= sa) else 0.0
    return max(seq, jacc, 0.85 * contain if min(len(sa), len(sb)) >= 1 else 0.0)


def phone_digits(phone: str | None) -> str | None:
    """Last 10 digits of a NANP number, or None."""
    if not phone:
        return None
    d = re.sub(r"\D", "", phone)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d if len(d) == 10 else None


def same_phone(a: str | None, b: str | None) -> bool:
    da, db = phone_digits(a), phone_digits(b)
    return bool(da and db and da == db)


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def zip5(z: str | None) -> str | None:
    if not z:
        return None
    m = re.match(r"\s*(\d{5})", str(z))
    return m.group(1) if m else None


def match_confidence(
    *,
    name_sim: float,
    phone_match: bool = False,
    same_zip: bool = False,
    same_city: bool = False,
    distance_miles: float | None = None,
) -> float:
    """Combine evidence into a same-business probability (heuristic, calibrated by eye)."""
    score = 0.0
    if phone_match:
        score = max(score, 0.9)
    if name_sim >= 0.95:
        score = max(score, 0.7)
    elif name_sim >= 0.85:
        score = max(score, 0.55)
    elif name_sim >= 0.7:
        score = max(score, 0.35)
    if name_sim >= 0.7 and (same_zip or (distance_miles is not None and distance_miles <= 1.0)):
        score += 0.2
    elif name_sim >= 0.7 and same_city:
        score += 0.1
    if phone_match and name_sim >= 0.7:
        score += 0.08
    return min(score, 0.99)
