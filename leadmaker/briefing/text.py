"""Deterministic briefing text (render_digest_text) and the untrusted-text fence shared with the AI layer.

The text is what a rep or manager sees when no AI rewrite matches the digest. Neutral voice (never "you" or
"your"), so a manager can read a rep's brief as-is. v3 is a sales-first morning briefing; sentences, in priority
order (the sales ones from digest['sales'], the day's snapshot):

  F  follow-ups overdue / due today    "This morning: 4 follow-ups are overdue and 9 due today, starting with
                                        Carework Construction LLC and Direct Call Roofing."
                                        (team: "...; Jordan Lee is furthest behind with 4 overdue.")
  G  interested / quoting, no touch    "3 interested or quoting leads have gone quiet (no touch in 7 days),
     in 7 days                          including Alpha Roofing and Beta Exteriors."
  N  the best uncalled new lead        "12 uncalled leads were found in the last 14 days; the best is Jersey
                                        Roofing LLC (GAF Master Elite)." (none new: "... have an AI pitch ready")
  M  stage changes, last 7 days        "In the last 7 days: 2 leads moved to quoting, 1 won (Acme Roofing) and
                                        1 lost."
  (team scope: F, M, G, N, so who is behind and the team's wins lead), then P, H and Q below, then at most one
  weather sentence (W/S, else R), then D:

  W  an active alert with book leads   "Severe Thunderstorm Warning in Bergen County until 8 PM: 4 storm-
                                        restoration roofers there may need tarps and repair stock."
     (S, no active alert but storm-response leads from an alert that ended in the last 7 days)
  R  storm-restoration roofers in      "Roof-damaging storms were reported in Bergen County in the last 30 days:
     counties with recent storm         6 storm-restoration roofers there may need repair stock."
     reports (NOAA, last 30 days)       (digest v2, so a normal week is not quiet)
  D  weather_delays_total > 0          "2 new-construction leads may see weather delays."
  P  a fresh poll with changes         "Since Saturday's poll: 3 new leads, 5 changed in this territory."
     H  plus at most one highlight     " Carework Construction LLC is now GAF Master Elite (was GAF Certified)."
  Q  pool.new > 0                      "7 new leads are waiting in the unallocated pool."

At most 3 sentences and 400 characters, dropped lowest priority first: D, R, W, Q, H, P, then the sales sentences
from the last (rep: M, N, G; team: N, G, M); F is never dropped. Times are
America/New_York. A quiet digest renders "". render_units() returns the sentences that survived, by code, so the AI
rewrite is shown only what the text says.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
MAX_SENTENCES = 3
MAX_CHARS = 400
NAME_CHARS = 80  # a company name inside the text (the digest keeps up to 120)

# Zero-width and bidi controls (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF).
_INVISIBLE = re.compile("[​-‏‪-‮⁠-⁩﻿]")
_NEWLINES = re.compile(r"\n{3,}")


# ------------------------------------------------------------------------------------------------- fencing
def fence(text: Any, max_chars: int) -> str:
    """Untrusted text made safe to place inside a prompt block or the brief (spec §4.6): NFKC, no control or
    invisible characters, '<' and '>' replaced so data can never open or close a tag, at most two newlines in
    a row, cut at a word boundary with an ellipsis."""
    s = unicodedata.normalize("NFKC", "" if text is None else str(text))
    s = "".join(ch for ch in s if ch in "\n\t" or unicodedata.category(ch) != "Cc")
    s = _INVISIBLE.sub("", s).replace("<", "‹").replace(">", "›")
    s = _NEWLINES.sub("\n\n", s).strip()
    return truncate(s, max_chars)


def fence_line(text: Any, max_chars: int) -> str:
    """fence() for one-line values (names, event titles): whitespace collapsed to single spaces."""
    return truncate(" ".join(fence(text, 10_000).split()), max_chars)


def truncate(s: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(s) <= max_chars:
        return s
    cut = s[: max_chars - 1]
    space = cut.rfind(" ")
    if space >= max_chars // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "…"


# --------------------------------------------------------------------------------------------------- times
def parse_dt(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def iso(dt: datetime | None) -> str | None:
    """UTC ISO-8601 with a Z, to the second (what the digest stores)."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clock(dt: datetime) -> str:
    hour = dt.hour % 12 or 12
    minutes = f":{dt.minute:02d}" if dt.minute else ""
    return f"{hour}{minutes} {'AM' if dt.hour < 12 else 'PM'}"


def when(ends_at: Any, now: datetime) -> str:
    """'8 PM' later the same ET day, 'Tue 8 AM' on another day, 'further notice' without an end."""
    end = parse_dt(ends_at)
    if end is None:
        return "further notice"
    local, today = end.astimezone(ET), now.astimezone(ET)
    if local.date() == today.date():
        return _clock(local)
    return f"{local:%a} {_clock(local)}"


def weekday(dt: Any) -> str:
    d = parse_dt(dt)
    return f"{d.astimezone(ET):%A}" if d else "the last"


# ------------------------------------------------------------------------------------------------ render
def _s(n: int, one: str = "", many: str = "s") -> str:
    return one if n == 1 else many


def _bare_county(county: str | None, fips: str | None) -> str:
    """'Bergen County, NJ' -> 'Bergen County' (the text drops the state); FIPS when the name is unknown."""
    if county:
        return county.rsplit(", ", 1)[0] if re.search(r", [A-Z]{2}$", county) else county
    return f"county {fips}" if fips else "a county"


def _where(digest: dict[str, Any]) -> str:
    return "across the team" if digest.get("scope") == "team" else "in this territory"


def _weather_sentence(digest: dict[str, Any], now: datetime) -> str | None:
    weather = digest.get("weather") or {}
    alerts = weather.get("alerts") or []
    if alerts:
        top = alerts[0]
        county = _bare_county(top.get("county"), top.get("county_fips"))
        others = max(0, int(weather.get("alert_counties") or len({a.get("county_fips") for a in alerts})) - 1)
        storm = int(weather.get("alert_storm_leads") or 0)
        until = f"until {when(top.get('ends_at'), now)}"
        if others == 0:
            head = f"{top['event']} in {county} {until}"
            there = "there"
        elif all(a.get("event") == top.get("event") for a in alerts):
            head = f"{top['event']} in {county} and {others} other count{_s(others, 'y', 'ies')} {until}"
            there = "there"
        else:
            head = f"{top['event']} in {county} {until}, with alerts in {others} other count{_s(others, 'y', 'ies')}"
            there = "in those counties"
        if storm:
            return f"{head}: {storm} storm-restoration roofer{_s(storm)} {there} may need tarps and repair stock."
        return f"{head}."
    total = int(weather.get("storm_response_total") or 0)
    if total:  # storm-response leads from an alert that has ended (<= 7 days ago)
        return (f"{total} storm-restoration roofer{_s(total)} {_where(digest)} may need tarps and repair stock "
                "after recent storm alerts.")
    return None


def _recent_storm_sentence(digest: dict[str, Any]) -> str | None:
    recent = (digest.get("weather") or {}).get("recent_storm") or {}
    n = int(recent.get("leads") or 0)
    counties = [c for c in recent.get("counties") or [] if c]
    if not n or not counties:
        return None
    first = _bare_county(counties[0], None)
    others = max(0, int(recent.get("county_count") or len(counties)) - 1)
    where = first if not others else f"{first} and {others} other count{_s(others, 'y', 'ies')}"
    there = "there" if not others else "in those counties"
    return (f"Roof-damaging storms were reported in {where} in the last 30 days: {n} storm-restoration roofer{_s(n)} "
            f"{there} may need repair stock.")


def _poll_sentence(digest: dict[str, Any]) -> str | None:
    poll = digest.get("poll") or {}
    if not poll.get("fresh"):
        return None
    new, changed, delisted = (int(poll.get(k) or 0) for k in ("new", "changed", "delisted"))
    if not (new or changed or delisted):
        return None
    parts: list[str] = []
    if new:
        parts.append(f"{new} new lead{_s(new)}")
    if changed:
        parts.append(f"{changed} changed" if parts else f"{changed} lead{_s(changed)} changed")
    if delisted:
        parts.append(f"{delisted} delisted" if parts else f"{delisted} lead{_s(delisted)} delisted")
    return f"Since {weekday(poll.get('finished_at'))}'s poll: {', '.join(parts)} {_where(digest)}."


def _highlight_sentence(digest: dict[str, Any]) -> tuple[str, dict[str, str]] | None:
    highlights = (digest.get("poll") or {}).get("highlights") or []
    if not highlights:
        return None
    h = highlights[0]
    name = fence_line(h.get("name"), NAME_CHARS)
    if not name or not h.get("text"):
        return None
    return f"{name} is {h['text']}.", {"id": str(h.get("company_id")), "name": h.get("name") or name}


def _pool_sentence(digest: dict[str, Any]) -> str | None:
    n = int((digest.get("pool") or {}).get("new") or 0)
    if not n:
        return None
    return f"{n} new lead{_s(n)} {'is' if n == 1 else 'are'} waiting in the unallocated pool."


# ------------------------------------------------------------------------------------------- sales (v3)
def _names_list(leads: list[dict[str, Any]]) -> tuple[str, list[dict[str, str]]]:
    """('A and B', [{id, name}]) of up to two named leads."""
    named = [{"id": str(x.get("company_id")), "name": str(x.get("name"))} for x in leads[:2] if x.get("name")]
    return " and ".join(fence_line(x["name"], NAME_CHARS) for x in named), named


def _focus_sentence(digest: dict[str, Any]) -> tuple[str, list[dict[str, str]]] | None:
    """F: follow-ups overdue / due today, the longest-waiting companies (team: the rep furthest behind)."""
    f = (digest.get("sales") or {}).get("followups") or {}
    overdue, today = int(f.get("overdue") or 0), int(f.get("today") or 0)
    if not (overdue or today):
        return None
    if overdue and today:
        counts = f"{overdue} follow-up{_s(overdue)} {'is' if overdue == 1 else 'are'} overdue and {today} due today"
    elif overdue:
        counts = f"{overdue} follow-up{_s(overdue)} {'is' if overdue == 1 else 'are'} overdue"
    else:
        counts = f"{today} follow-up{_s(today)} {'is' if today == 1 else 'are'} due today"
    team = digest.get("scope") == "team"
    head = f"This morning across the team: {counts}" if team else f"This morning: {counts}"
    behind = f.get("behind") if team else None
    if behind and behind.get("rep") and int(behind.get("overdue") or 0):
        n = int(behind["overdue"])
        return f"{head}; {fence_line(behind['rep'], NAME_CHARS)} is furthest behind with {n} overdue.", []
    names, named = _names_list(f.get("waiting") or [])
    if names:
        return f"{head}, starting with {names}.", named
    return f"{head}.", []


def _quiet_sentence(digest: dict[str, Any]) -> tuple[str, list[dict[str, str]]] | None:
    """G: interested / quoting leads with no touch in 7 days."""
    q = (digest.get("sales") or {}).get("quiet") or {}
    n = int(q.get("count") or 0)
    if not n:
        return None
    leads = q.get("leads") or []
    stages = {x.get("stage") for x in leads if x.get("stage")}
    what = "interested or quoting" if n > len(leads) or len(stages) != 1 else next(iter(stages))
    names, named = _names_list(leads)
    verb = "has" if n == 1 else "have"
    tail = (f", including {names}" if n > len(named) else f": {names}") if names else ""
    return f"{n} {what} lead{_s(n)} {verb} gone quiet (no touch in 7 days){tail}.", named


def _new_sentence(digest: dict[str, Any]) -> tuple[str, list[dict[str, str]]] | None:
    """N: the best uncalled new lead (first seen in the last 14 days), else the best uncalled lead with an AI pitch."""
    new = (digest.get("sales") or {}).get("new") or {}
    n = int(new.get("count") or 0)
    leads = [x for x in new.get("leads") or [] if x.get("name")]
    if not n or not leads:
        return None
    top = leads[0]
    name = fence_line(top["name"], NAME_CHARS)
    best = f"{name} ({top['why']})" if top.get("why") else name
    named = [{"id": str(top.get("company_id")), "name": str(top["name"])}]
    if new.get("kind") == "new":
        if n == 1:
            return f"1 uncalled lead was found in the last 14 days: {best}.", named
        return f"{n} uncalled leads were found in the last 14 days; the best is {best}.", named
    if n == 1:
        return f"1 uncalled lead has an AI pitch ready: {best}.", named
    return f"{n} uncalled leads have an AI pitch ready; the best is {best}.", named


def _moves_sentence(digest: dict[str, Any]) -> tuple[str, list[dict[str, str]]] | None:
    """M: stage advances, wins and losses in the last 7 days."""
    m = (digest.get("sales") or {}).get("moves") or {}
    parts: list[str] = []
    named: list[dict[str, str]] = []
    for stage in ("quoting", "interested"):
        if k := int(m.get(stage) or 0):
            parts.append(f"{k} to {stage}" if parts else f"{k} lead{_s(k)} moved to {stage}")
    if w := int(m.get("won") or 0):
        names, named = _names_list(m.get("won_leads") or [])
        parts.append((f"{w} won ({names})" if w == len(named) else f"{w} won (including {names})") if names
                     else f"{w} won")
    if lost := int(m.get("lost") or 0):
        parts.append(f"{lost} lost")
    if not parts:
        return None
    body = parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"
    return f"In the last 7 days: {body}.", named


def render_units(digest: dict[str, Any]) -> list[tuple[str, str]]:
    """The sentences the text keeps, as (code, sentence) in text order (F, G, N, M, P, H, Q, W/S, R, D); [] when
    quiet."""
    return _render(digest)[0]


def render(digest: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """(text, companies named in it as [{id, name}]). "" when the digest is quiet."""
    units, leads = _render(digest)
    text = " ".join(s for _, s in units)
    if len(text) > MAX_CHARS:  # only a pathological alert title gets here
        text = truncate(text, MAX_CHARS)
    return text, leads


def _render(digest: dict[str, Any]) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    if digest.get("quiet"):
        return [], []
    now = parse_dt(digest.get("as_of")) or datetime.now(timezone.utc)
    units: list[tuple[str, str]] = []  # (code, sentence), in priority order
    named: dict[str, list[dict[str, str]]] = {}
    team = digest.get("scope") == "team"
    # A manager's morning: who is behind and the team's wins come before single leads (team: F, M, G, N).
    sales = (("F", _focus_sentence), ("M", _moves_sentence), ("G", _quiet_sentence), ("N", _new_sentence)) if team \
        else (("F", _focus_sentence), ("G", _quiet_sentence), ("N", _new_sentence), ("M", _moves_sentence))
    for code, make in sales:
        if found := make(digest):
            units.append((code, found[0]))
            named[code] = found[1]
    if p := _poll_sentence(digest):
        units.append(("P", p))
        if h := _highlight_sentence(digest):
            units.append(("H", h[0]))
            named["H"] = [h[1]]
    if q := _pool_sentence(digest):
        units.append(("Q", q))
    if w := _weather_sentence(digest, now):
        units.append(("W", w))
    if r := _recent_storm_sentence(digest):
        units.append(("R", r))
    if d := int((digest.get("weather") or {}).get("weather_delays_total") or 0):
        units.append(("D", f"{d} new-construction lead{_s(d)} may see weather delays."))

    def size(us: list[tuple[str, str]]) -> int:
        return len(" ".join(s for _, s in us))

    # Weather is the lowest priority (and at most one weather sentence), then the pool, the poll, the moves...
    if any(c == "W" for c, _ in units):
        units = [u for u in units if u[0] != "R"]
    for code in ("D", "R", "W", "Q", "H", "P", *(c for c, _ in reversed(sales[1:]))):
        if len(units) <= MAX_SENTENCES and size(units) <= MAX_CHARS:
            break
        units = [u for u in units if u[0] != code]
    leads = [x for c, _ in units for x in named.get(c, [])]
    return units, leads


def render_digest_text(digest: dict[str, Any]) -> str:
    """The deterministic brief for a digest (§5.3); "" when quiet."""
    return render(digest)[0]
